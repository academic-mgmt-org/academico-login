import { Pool } from 'pg';

let pool = null;

function numberFromEnv(name, defaultValue) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

export default function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_DATABASE,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: numberFromEnv('DB_POOL_MAX', 10),
      min: numberFromEnv('DB_POOL_MIN', 1),
      idleTimeoutMillis: numberFromEnv('DB_POOL_IDLE_TIMEOUT_MS', 60000),
      connectionTimeoutMillis: numberFromEnv(
        'DB_POOL_CONNECTION_TIMEOUT_MS',
        2000,
      ),
      keepAlive: true,
      keepAliveInitialDelayMillis: numberFromEnv(
        'DB_POOL_KEEPALIVE_INITIAL_DELAY_MS',
        10000,
      ),
      ssl: {
        rejectUnauthorized: false,
      },
    });
  }
  return pool;
}
