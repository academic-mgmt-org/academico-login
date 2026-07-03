import { Pool } from 'pg';

let pool = null;

function numberFromEnv(name, defaultValue) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function configuredPoolMax() {
  return numberFromEnv('DB_POOL_MAX', 10);
}

function configuredPoolMin() {
  return numberFromEnv('DB_POOL_MIN', 2);
}

function configuredWarmupConnections() {
  return Math.min(
    numberFromEnv('DB_POOL_WARMUP_CONNECTIONS', configuredPoolMin()),
    configuredPoolMax(),
  );
}

export default function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_DATABASE,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: configuredPoolMax(),
      min: configuredPoolMin(),
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

export async function warmDatabasePool(options = {}) {
  const targetPool = options.pool || getPool();
  const connections =
    options.connections === undefined
      ? configuredWarmupConnections()
      : Math.max(0, Math.floor(Number(options.connections) || 0));
  const queryText = options.queryText || 'SELECT 1';
  const startedAt = process.hrtime.bigint();

  await Promise.all(
    Array.from({ length: connections }, () => targetPool.query(queryText)),
  );

  return {
    connections,
    durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
    totalCount: targetPool.totalCount,
    idleCount: targetPool.idleCount,
    waitingCount: targetPool.waitingCount,
  };
}
