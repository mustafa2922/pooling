import { Router } from 'express'
import { db } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const MAX_ROUTES = 1

// GET /api/routes/mine — fetch my routes with full geometry
router.get('/mine', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        id, start_label, end_label,
        depart_time, role, gender_pref, days,
        ST_AsGeoJSON(path_geom)  AS path_geojson,
        ST_AsGeoJSON(start_geom) AS start_geojson,
        ST_AsGeoJSON(end_geom)   AS end_geojson,
        created_at
      FROM routes
      WHERE user_id = $1 OR user_id_ref = $1
      ORDER BY created_at DESC
    `, [req.user.id])
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/routes — save route, enforce max 1
router.post('/', async (req, res) => {
  const {
    startLat, startLng, startLabel,
    endLat, endLng, endLabel,
    wayIds, geojson,
    departTime, role, genderPref, days
  } = req.body

  if (!wayIds?.length)
    return res.status(400).json({ error: 'Route geometry is required' })

  const client = await db.connect()
  try {
    await client.query('BEGIN')

    // Check limit
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS count FROM routes WHERE user_id = $1 OR user_id_ref = $1`,
      [req.user.id]
    )
    if (parseInt(countRows[0].count) >= MAX_ROUTES) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        error: 'You already have a saved route. Delete it first to add a new one.',
        limitReached: true
      })
    }

    const { rows } = await client.query(`
      INSERT INTO routes (
        user_id, user_id_ref,
        start_geom, end_geom, path_geom, way_ids,
        start_label, end_label,
        depart_time, role, gender_pref, days
      ) VALUES (
        $1, $1,
        ST_SetSRID(ST_MakePoint($2, $3), 4326),
        ST_SetSRID(ST_MakePoint($4, $5), 4326),
        ST_SetSRID(ST_GeomFromGeoJSON($6), 4326),
        $7, $8, $9, $10, $11, $12, $13
      ) RETURNING id
    `, [
      req.user.id,
      startLng, startLat, endLng, endLat,
      JSON.stringify(geojson), wayIds,
      startLabel || '', endLabel || '',
      departTime || '08:00', role || 'both',
      genderPref || 'any',
      days || ['mon', 'tue', 'wed', 'thu', 'fri']
    ])

    const routeId = rows[0].id

    if (wayIds.length) {
      const vals = wayIds.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',')
      const params = wayIds.flatMap(id => [id, routeId])
      await client.query(
        `INSERT INTO segment_routes (way_id, route_id) VALUES ${vals} ON CONFLICT DO NOTHING`,
        params
      )
    }

    await client.query('COMMIT')
    res.json({ routeId })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

// DELETE /api/routes/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM routes WHERE id = $1 AND (user_id = $2 OR user_id_ref = $2)`,
      [req.params.id, req.user.id]
    )
    if (rowCount === 0)
      return res.status(404).json({ error: 'Route not found or not yours' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router