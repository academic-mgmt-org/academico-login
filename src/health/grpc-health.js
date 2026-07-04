import { Health as StandardHealthRpcService } from '../gen/proto/grpc/health/v1/health_pb.js';

export const GRPC_HEALTH_STATUS = {
  SERVING: 1,
  NOT_SERVING: 2,
  SERVICE_UNKNOWN: 3,
};

function defaultReadinessServiceNames(serviceName) {
  return ['', serviceName, `${serviceName}-readiness`];
}

function defaultLivenessServiceNames(serviceName) {
  return [`${serviceName}-liveness`];
}

function serviceNameFromEnv(fallback) {
  return process.env.SERVICE_NAME || fallback;
}

export function registerGrpcHealthService(router, options = {}) {
  const serviceName = serviceNameFromEnv(options.serviceName || 'service');
  const readinessCheck =
    options.readinessCheck || (async () => ({ ready: true }));
  const readinessServiceNames = new Set(
    options.readinessServiceNames || defaultReadinessServiceNames(serviceName),
  );
  const livenessServiceNames = new Set(
    options.livenessServiceNames || defaultLivenessServiceNames(serviceName),
  );

  router.service(StandardHealthRpcService, {
    async check(req) {
      const requestedService = req.service || '';

      if (livenessServiceNames.has(requestedService)) {
        return { status: GRPC_HEALTH_STATUS.SERVING };
      }

      if (!readinessServiceNames.has(requestedService)) {
        return { status: GRPC_HEALTH_STATUS.SERVICE_UNKNOWN };
      }

      const readiness = await readinessCheck();
      return {
        status: readiness.ready
          ? GRPC_HEALTH_STATUS.SERVING
          : GRPC_HEALTH_STATUS.NOT_SERVING,
      };
    },
  });
}

export function createLegacyHealthHandlers(options = {}) {
  const serviceName = serviceNameFromEnv(options.serviceName || 'service');
  const readinessCheck =
    options.readinessCheck || (async () => ({ ready: true }));

  return {
    async health() {
      const readiness = await readinessCheck();

      return {
        status: readiness.ready ? 'healthy' : 'unhealthy',
        service: serviceName,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };
    },

    async ready() {
      const readiness = await readinessCheck();

      return {
        ready: readiness.ready,
        timestamp: new Date().toISOString(),
      };
    },

    live() {
      return {
        alive: true,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };
    },
  };
}
