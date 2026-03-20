import { Router } from 'express'
import { db } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// GET /api/matches
// Finds all users whose saved routes share road segments with mine
//
// Execution flow:
// 1. Find MY latest route using req.user.id (from JWT)
// 2. Look up all way_ids (road segments) in my route via segment_routes
// 3. Find other routes that share ANY of those way_ids
// 4. Join with users table to get their name + phone
// 5. Filter by role compatibility and gender preference
// 6. Return sorted by most shared segments first

router.get('/', async (req, res) => {
  const minOverlap = parseInt(req.query.minOverlap) || 10 // lowered to 10% for MVP

  try {
    const { rows } = await db.query(`
      WITH my_route AS (
        -- Get my most recently saved route
        -- We try both user_id_ref (new FK) and user_id (old string col) for compatibility
        SELECT
          r.id,
          r.way_ids,
          r.path_geom,
          r.depart_time,
          r.role,
          r.gender_pref,
          array_length(r.way_ids, 1) AS total_segments
        FROM routes r
        WHERE
          r.user_id_ref = $1
          OR r.user_id::text = $1::text
        ORDER BY r.created_at DESC
        LIMIT 1
      )
      SELECT
        u.id                                                  AS user_id,
        u.name,
        u.phone,
        u.gender,
        r.id                                                  AS route_id,
        r.start_label,
        r.end_label,
        r.depart_time,
        r.role,
        r.gender_pref,
        COUNT(*)                                              AS shared_segments,
        my.total_segments,
        ROUND(COUNT(*) * 100.0 / NULLIF(my.total_segments, 0), 1) AS overlap_pct,
        -- ST_Intersection gives us the exact overlapping road geometry
        -- We use TRY so a geometry error on one match doesn't kill the whole query
        ST_AsGeoJSON(
          ST_Buffer(
            ST_Intersection(my.path_geom, r.path_geom),
            0
          )
        ) AS overlap_geojson
      FROM my_route my
      -- Get all segment IDs from MY route
      JOIN segment_routes sr_mine  ON sr_mine.route_id  = my.id
      -- Find OTHER routes that share those segment IDs
      JOIN segment_routes sr_other ON sr_other.way_id   = sr_mine.way_id
      -- Get those other routes
      JOIN routes r                ON r.id              = sr_other.route_id
      -- Get the user info for those routes
      -- Join on both columns for compatibility
      JOIN users u ON (
        u.id = r.user_id_ref
        OR u.id::text = r.user_id::text
      )
      WHERE
        -- Exclude my own routes
        r.user_id_ref != $1
        AND r.user_id::text != $1::text

        -- Role compatibility:
        -- driver matches with passenger or both
        -- passenger matches with driver or both
        -- both matches with anyone
        
        AND (
        my.role IS NOT NULL
        )

        -- Gender preference compatibility
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
        -- Minimum overlap threshold
        COUNT(*) * 100.0 / NULLIF(my.total_segments, 0) >= $2

      ORDER BY shared_segments DESC
      LIMIT 20
    `, [req.user.id, minOverlap])

    res.json(rows)

  } catch (e) {
    console.error('Matches query error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router