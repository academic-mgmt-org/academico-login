import { config } from 'dotenv';
import getPool, { warmDatabasePool } from './db';

config();

function expectDatabaseConfig() {
  const missing = [
    'DB_HOST',
    'DB_PORT',
    'DB_DATABASE',
    'DB_USER',
    'DB_PASSWORD',
  ].filter((name) => !process.env[name] || process.env[name].startsWith('$('));

  expect(missing).toEqual([]);
}

describe('warmDatabasePool real database', () => {
  afterAll(async () => {
    await getPool().end();
  });

  it('calienta conexiones reales contra PostgreSQL antes de atender requests', async () => {
    expectDatabaseConfig();

    const warmup = await warmDatabasePool({ connections: 2 });

    expect(warmup.connections).toBe(2);
    expect(warmup.totalCount).toBeGreaterThanOrEqual(2);
    expect(warmup.idleCount).toBeGreaterThanOrEqual(1);
    expect(warmup.waitingCount).toBe(0);

    const start = process.hrtime.bigint();
    const result = await getPool().query('SELECT 1 AS ready');
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(result.rows).toEqual([{ ready: 1 }]);
    expect(durationMs).toBeLessThan(
      Number(process.env.DB_WARMUP_TEST_MAX_QUERY_MS || 250),
    );
  });
});
