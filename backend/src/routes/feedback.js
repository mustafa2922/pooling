import { Router } from 'express'
import { db } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

router.post('/', async (req, res) => {
  const { rating, message, page } = req.body
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Rating 1–5 required' })
  try {
    await db.query(
      `INSERT INTO feedback (user_id, rating, message, page)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, rating, message?.trim() || null, page || 'matches']
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router