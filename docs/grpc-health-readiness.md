# gRPC health y readiness reutilizable

Este servicio implementa el contrato estandar `grpc.health.v1.Health/Check` para que Kubernetes pueda validar contenedores con gRPC real en vez de solo TCP.

## Contrato

Todos los microservicios academicos deben exponer:

- `grpc.health.v1.Health/Check`
- `service: <microservicio>-readiness`
- `service: <microservicio>-liveness`

La respuesta debe usar `HealthCheckResponse.ServingStatus`:

- `SERVING`: el servicio puede recibir trafico.
- `NOT_SERVING`: el proceso responde, pero una dependencia requerida no esta lista.
- `SERVICE_UNKNOWN`: el nombre de servicio solicitado no existe.

## Readiness de base de datos

La readiness de base de datos no recibe SQL desde fuera. Cada servicio ejecuta internamente una consulta fija, barata y segura:

```sql
SELECT 1
```

Esto evita exponer un endpoint administrativo peligroso y mantiene el probe replicable.

## Archivos reutilizables

Copiar estos archivos en cada microservicio Node/ConnectRPC:

- `proto/grpc/health/v1/health.proto`
- `src/health/database-readiness.js`
- `src/health/grpc-health.js`

Despues regenerar proto:

```bash
npm run proto:build
```

## Integracion en rutas ConnectRPC

Cada servicio debe registrar el health estandar con su propio `getPool()`:

```js
import getPool from './db.js';
import { createDatabaseReadinessCheck } from './health/database-readiness.js';
import {
  createLegacyHealthHandlers,
  registerGrpcHealthService,
} from './health/grpc-health.js';
import { HealthService as HealthRpcService } from './gen/proto/<service>_pb.js';

const SERVICE_NAME = 'academico-usuarios';
const checkReadiness = createDatabaseReadinessCheck({
  poolFactory: getPool,
  dependencyName: 'PostgreSQL',
});

registerGrpcHealthService(router, {
  serviceName: SERVICE_NAME,
  readinessCheck: checkReadiness,
});

router.service(HealthRpcService, {
  ...createLegacyHealthHandlers({
    serviceName: SERVICE_NAME,
    readinessCheck: checkReadiness,
  }),
});
```

Si el servicio no conserva un `HealthService` propio historico, solo necesita `registerGrpcHealthService`.

## Kubernetes

Usar probes gRPC nativos:

```yaml
startupProbe:
  grpc:
    port: 3001
    service: academico-usuarios-readiness
  periodSeconds: 5
  failureThreshold: 12
  timeoutSeconds: 2
readinessProbe:
  grpc:
    port: 3001
    service: academico-usuarios-readiness
  periodSeconds: 5
  failureThreshold: 3
  timeoutSeconds: 2
livenessProbe:
  grpc:
    port: 3001
    service: academico-usuarios-liveness
  periodSeconds: 10
  failureThreshold: 3
  timeoutSeconds: 2
```

Para rollouts de una sola replica, mantener tambien:

```yaml
minReadySeconds: 15
terminationGracePeriodSeconds: 30
lifecycle:
  preStop:
    exec:
      command:
        - /bin/sh
        - -c
        - sleep 10
```

## Variables

- `READINESS_CHECK_TIMEOUT_MS`: timeout de la consulta de readiness. Default: `1500`.
- `READINESS_CHECK_CACHE_TTL_MS`: cache para no consultar la BD en cada probe concurrente. Default: `1000`.
