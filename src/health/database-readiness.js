function numberFromEnv(env, name, fallback) {
  const parsed = Number(env[name]);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredTimeoutMs(env) {
  return numberFromEnv(env, 'READINESS_CHECK_TIMEOUT_MS', 1500);
}

function configuredCacheTtlMs(env) {
  return numberFromEnv(env, 'READINESS_CHECK_CACHE_TTL_MS', 1000);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createDatabaseReadinessCheck(options = {}) {
  const {
    poolFactory,
    queryText = 'SELECT 1',
    dependencyName = 'database',
    env = process.env,
  } = options;
  const state = {
    expiresAt: 0,
    promise: null,
    value: null,
  };

  if (typeof poolFactory !== 'function') {
    throw new Error(
      'createDatabaseReadinessCheck requires a poolFactory function',
    );
  }

  async function runCheck() {
    const startedAt = process.hrtime.bigint();

    try {
      const pool = poolFactory();
      await withTimeout(
        pool.query(queryText),
        configuredTimeoutMs(env),
        `${dependencyName} readiness check timed out`,
      );

      return {
        ready: true,
        dependency: dependencyName,
        error: '',
        durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
      };
    } catch (error) {
      return {
        ready: false,
        dependency: dependencyName,
        error: error?.message || `${dependencyName} readiness check failed`,
        durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
      };
    }
  }

  return async function checkDatabaseReadiness() {
    const now = Date.now();

    if (state.value && now < state.expiresAt) {
      return state.value;
    }

    if (!state.promise) {
      state.promise = runCheck()
        .then((value) => {
          state.value = value;
          state.expiresAt = Date.now() + configuredCacheTtlMs(env);
          return value;
        })
        .finally(() => {
          state.promise = null;
        });
    }

    return state.promise;
  };
}
