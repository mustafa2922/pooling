// src/index.js
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import routesRouter  from './routes/routes.js'
import matchesRouter from './routes/matches.js'
import authRouter    from './routes/auth.js'

dotenv.config()

const app = express()

app.use(cors({
  origin: '*', // tighten this after deployment
  methods: ['GET','POST','PUT','DELETE'],
  allowedHeaders: ['Content-Type','Authorization']
}))
app.use(express.json())

app.use('/api/auth',    authRouter)
app.use('/api/routes',  routesRouter)
app.use('/api/matches', matchesRouter)
app.get('/health', (_, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3001
app.listen(PORT,'0.0.0.0',() => console.log(`HamSafar API running on :${PORT}`))