import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL + '?pgbouncer=true',
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

// Test connection on startup
db.query('SELECT 1').then(() => {
  console.log('Database connected');
}).catch(err => {
  console.error('Database connection failed:', err.message);
});