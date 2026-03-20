// Two endpoints:
// POST /api/auth/signup  — create account, return JWT
// POST /api/auth/login   — verify credentials, return JWT
// GET  /api/auth/me      — return current user from token

import { Router } from 'express'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { db } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// ── SIGNUP ──────────────────────────────────────────────────────────────────
// Execution flow:
// validate fields → check phone/email not taken →
// hash password (bcrypt, 12 rounds) → insert user → return JWT
router.post('/signup', async (req, res) => {
  const { name, phone, email, password, gender } = req.body

  // Validation
  if (!name?.trim())
    return res.status(400).json({ error: 'Name is required' })
  if (!phone?.match(/^03[0-9]{9}$/))
    return res.status(400).json({ error: 'Enter a valid Pakistani number e.g. 03001234567' })
  if (!email?.includes('@'))
    return res.status(400).json({ error: 'Enter a valid email' })
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' })

  try {
    // bcrypt.hash turns "mypassword" into "$2b$12$..." — one way, irreversible
    // 12 = cost factor — how many times it hashes (slower = harder to brute force)
    const password_hash = await bcrypt.hash(password, 12)

    const { rows } = await db.query(`
      insert into users (name, phone, email, password_hash, gender)
      values ($1, $2, $3, $4, $5)
      returning id, name, phone, email, gender
    `, [name.trim(), phone, email.toLowerCase(), password_hash, gender || null])

    const user = rows[0]
    const token = signToken(user)

    res.status(201).json({ token, user })
  } catch (e) {
    // Postgres unique violation code = 23505
    if (e.code === '23505') {
      const field = e.detail?.includes('phone') ? 'phone' : 'email'
      return res.status(409).json({ error: `This ${field} is already registered` })
    }
    console.error(e)
    res.status(500).json({ error: 'Signup failed' })
  }
})

// ── LOGIN ────────────────────────────────────────────────────────────────────
// Execution flow:
// find user by email → bcrypt.compare (never compare plain text) →
// if match → return JWT
router.post('/login', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' })

  try {
    const { rows } = await db.query(
      'select * from users where email = $1',
      [email.toLowerCase()]
    )

    if (!rows.length)
      return res.status(401).json({ error: 'No account found with this email' })

    const user = rows[0]

    // bcrypt.compare hashes the input and compares — never sees plain password
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid)
      return res.status(401).json({ error: 'Wrong password' })

    const token = signToken(user)
    res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, email: user.email, gender: user.gender } })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Login failed' })
  }
})

// ── ME ───────────────────────────────────────────────────────────────────────
// Returns current user — frontend calls this on load to check session
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'select id, name, phone, email, gender from users where id = $1',
      [req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch user' })
  }
})

router.post('/change-password', requireAuth, async (req, res) => {
  const { password } = req.body
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'Minimum 6 characters' })
  try {
    const hash = await bcrypt.hash(password, 12)
    await db.query('update users set password_hash = $1 where id = $2', [hash, req.user.id])
    res.json({ ok: true })
  } catch { res.status(500).json({ error: 'Failed' }) }
})

// ── HELPER ───────────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, phone: user.phone, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' } // user stays logged in for 30 days
  )
}

export default router