// This runs BEFORE any protected route handler
// It reads the JWT from the Authorization header, verifies it,
// and attaches the user payload to req.user
// If invalid or missing → immediately returns 401, route handler never runs

import jwt from 'jsonwebtoken'

export function requireAuth(req, res, next) {
  // Authorization header looks like: "Bearer eyJhbGci..."
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const token = header.split(' ')[1]

  try {
    // jwt.verify throws if token is expired or tampered with
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    // payload = { id, name, phone, email, iat, exp }
    req.user = payload
    next() // passes control to the actual route handler
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}