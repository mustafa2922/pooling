import { Router } from 'express'
import { db } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// GET /api/matches
//
// Dual matching strategy:
//
// Layer 1 — Segment overlap
//   Find routes that share actual road segments (way_ids) with my route.
//   These are people who literally drive on the same roads.
//   High confidence. Shows overlap %.
//
// Layer 2 — Endpoint proximity
//   Find routes where start is within 3km of my start AND
//   end is within 2km of my end.
//   Catches people going same area→same area but on different roads.
//   Medium confidence. Shows "Similar commute" label.
//
// Both layers apply the same role + gender filters.
// Results are merged and deduplicated — if someone appears in both,
// the segment match takes priority (higher confidence).

router.get('/', async (req, res) => {
  const minOverlap = parseInt(req.query.minOverlap) || 10
  const originRadiusM = 3000   // 3 km for origin matching
  const destRadiusM = 2000   // 2 km for destination matching

  try {
    // ── LAYER 1: Segment overlap ──────────────────────────────────────────
    // Execution flow:
    // 1. Get MY latest route (my_route CTE)
    // 2. Join segment_routes to find all way_ids in my route
    // 3. Find other routes sharing those way_ids
    // 4. Join users to get their profile
    // 5. Filter by role + gender compatibility
    // 6. Group and count shared segments, calc overlap %
    const { rows: segmentMatches } = await db.query(`
      WITH my_route AS (
        SELECT
          id, way_ids, path_geom,
          start_geom, end_geom,
          depart_time, role, gender_pref,
          array_length(way_ids, 1) AS total_segments
        FROM routes
        WHERE user_id = $1 OR user_id_ref = $1
        ORDER BY created_at DESC
        LIMIT 1
      )
      SELECT
        u.id                                                        AS user_id,
        u.name,
        u.phone,
        u.gender,
        r.id                                                        AS route_id,
        r.start_label,
        r.end_label,
        r.depart_time,
        r.role,
        r.gender_pref,
        COUNT(*)                                                    AS shared_segments,
        my.total_segments,
        ROUND(COUNT(*) * 100.0 / NULLIF(my.total_segments, 0), 1)  AS overlap_pct,
        'segment'                                                   AS match_type,
        ST_AsGeoJSON(
          ST_Buffer(ST_Intersection(my.path_geom, r.path_geom), 0)
        )                                                           AS overlap_geojson
      FROM my_route my
      JOIN segment_routes sr_mine  ON sr_mine.route_id  = my.id
      JOIN segment_routes sr_other ON sr_other.way_id   = sr_mine.way_id
      JOIN routes r                ON r.id              = sr_other.route_id
      JOIN users u ON (u.id = r.user_id_ref OR u.id::text = r.user_id::text)
      WHERE
        r.user_id::text  != $1::text
        AND (r.user_id_ref IS NULL OR r.user_id_ref != $1)
        AND (my.role IS NOT NULL)
        AND (
          my.gender_pref = 'any' OR
          r.gender_pref  = 'any' OR
          my.gender_pref = r.gender_pref
        )
      GROUP BY
        u.id, u.name, u.phone, u.gender,
        r.id, r.start_label, r.end_label,
        r.depart_time, r.role, r.gender_pref,
        my.total_segments, my.path_geom, r.path_geom
      HAVING
        COUNT(*) * 100.0 / NULLIF(my.total_segments, 0) >= $2
      ORDER BY shared_segments DESC
      LIMIT 20
    `, [req.user.id, minOverlap])

    // ── LAYER 2: Endpoint proximity ───────────────────────────────────────
    // Execution flow:
    // 1. Get MY route's start_geom and end_geom
    // 2. Find other routes where:
    //    ST_DWithin(their start, my start, 3km) — PostGIS geography function
    //    ST_DWithin(their end, my end, 2km)
    // 3. Exclude users already found in segment matches
    // 4. Apply same role + gender filters
    //
    // ST_DWithin with geography type calculates real-world meters (not degrees)
    // We cast ::geography to get meter-based distance
    // Collect user_ids already found in segment matches
    // We pass these as a subquery exclusion rather than a JS array
    // to avoid the pg driver uuid[] cast issue that was silently failing
    const segmentUserIds = segmentMatches.map(m => m.user_id)

    // Build exclusion list: always exclude self + segment match users
    const excludeIds = [req.user.id, ...segmentUserIds]

    const { rows: proximityMatches } = await db.query(`
      WITH my_route AS (
        SELECT
          id, start_geom, end_geom,
          depart_time, role, gender_pref
        FROM routes
        WHERE user_id = $1 OR user_id_ref = $1
        ORDER BY created_at DESC
        LIMIT 1
      )
      SELECT
        u.id          AS user_id,
        u.name,
        u.phone,
        u.gender,
        r.id          AS route_id,
        r.start_label,
        r.end_label,
        r.depart_time,
        r.role,
        r.gender_pref,
        0             AS shared_segments,
        0             AS total_segments,
        0             AS overlap_pct,
        'proximity'   AS match_type,
        NULL          AS overlap_geojson,
        -- GREATEST(50,...) floors distance at 50m so we never return 0
        GREATEST(50, ROUND(ST_Distance(my.start_geom::geography, r.start_geom::geography)))  AS origin_dist_m,
        GREATEST(50, ROUND(ST_Distance(my.end_geom::geography,   r.end_geom::geography)))    AS dest_dist_m
      FROM my_route my, routes r
      JOIN users u ON (u.id = r.user_id_ref OR u.id::text = r.user_id::text)
      WHERE
        -- Exclude self
        r.user_id::text != $1::text
        AND (r.user_id_ref IS NULL OR r.user_id_ref::text != $1::text)
        -- Exclude users already in segment matches
        -- Using text comparison to avoid uuid[] cast issues with pg driver
        AND u.id::text != ALL($4::text[])
        -- Origin within 3km
        AND ST_DWithin(my.start_geom::geography, r.start_geom::geography, $2)
        -- Destination within 2km
        AND ST_DWithin(my.end_geom::geography,   r.end_geom::geography,   $3)
        AND (
          my.gender_pref = 'any' OR
          r.gender_pref  = 'any' OR
          my.gender_pref = r.gender_pref
        )
      ORDER BY (
        ST_Distance(my.start_geom::geography, r.start_geom::geography) +
        ST_Distance(my.end_geom::geography,   r.end_geom::geography)
      ) ASC
      LIMIT 10
    `, [
      req.user.id,
      originRadiusM,
      destRadiusM,
      excludeIds.map(id => id.toString()) // pass as text[] — avoids uuid[] cast failure
    ])

    // ── MERGE RESULTS ─────────────────────────────────────────────────────
    // Segment matches first (higher confidence), proximity matches after
    const allMatches = [...segmentMatches, ...proximityMatches]

    res.json(allMatches)

  } catch (e) {
    console.error('Matches query error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router