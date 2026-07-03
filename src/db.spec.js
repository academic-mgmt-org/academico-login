import { warmDatabasePool } from './db';

describe('warmDatabasePool', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('calienta conexiones en paralelo usando DB_POOL_MIN por defecto', async () => {
    process.env = {
      ...originalEnv,
      DB_POOL_MIN: '2',
      DB_POOL_MAX: '10',
    };
    delete process.env.DB_POOL_WARMUP_CONNECTIONS;

    const resolvers = [];
    const pool = {
      query: jest.fn(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
      ),
      totalCount: 2,
      idleCount: 2,
      waitingCount: 0,
    };

    const warmup = warmDatabasePool({ pool });

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(1, 'SELECT 1');
    expect(pool.query).toHaveBeenNthCalledWith(2, 'SELECT 1');

    resolvers.forEach((resolve) => resolve({ rows: [{ one: 1 }] }));

    await expect(warmup).resolves.toMatchObject({
      connections: 2,
      totalCount: 2,
      idleCount: 2,
      waitingCount: 0,
    });
  });

  it('limita el warmup al maximo del pool', async () => {
    process.env = {
      ...originalEnv,
      DB_POOL_MIN: '5',
      DB_POOL_MAX: '3',
    };
    delete process.env.DB_POOL_WARMUP_CONNECTIONS;

    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ one: 1 }] }),
    };

    await expect(warmDatabasePool({ pool })).resolves.toMatchObject({
      connections: 3,
    });
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('permite deshabilitar el warmup con cero conexiones', async () => {
    process.env = {
      ...originalEnv,
      DB_POOL_MIN: '2',
      DB_POOL_WARMUP_CONNECTIONS: '0',
    };

    const pool = {
      query: jest.fn(),
    };

    await expect(warmDatabasePool({ pool })).resolves.toMatchObject({
      connections: 0,
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('propaga errores para impedir readiness con base de datos fria o no disponible', async () => {
    const pool = {
      query: jest.fn().mockRejectedValue(new Error('db unavailable')),
    };

    await expect(warmDatabasePool({ pool, connections: 1 })).rejects.toThrow(
      'db unavailable',
    );
  });
});
