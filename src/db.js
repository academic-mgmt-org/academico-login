import { Pool } from 'pg';

let pool = null;

export default function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_DATABASE,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: {
        rejectUnauthorized: false,
      },
    });
  }
  return pool;
}
