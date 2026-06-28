# academico-login

Microservicio de login y autenticacion del Sistema de Gestion Academica.

## Rol en la arquitectura

Este servicio es el Core Asset de autenticacion para el flujo usado por
`academico-web` y `academico-gateway`:

- Valida credenciales de usuario.
- Emite `accessToken` y `refreshToken` JWT.
- Renueva sesiones mediante `POST /api/v1/auth/refresh`.
- Revoca sesiones mediante `POST /api/v1/auth/logout`.
- Valida JWT mediante `POST /api/v1/auth/validate-token-2`.
- Publica la whitelist de rutas publicas mediante `GET /api/v1/whitelist/all`.
- Protege llamadas internas con `LOGIN_API_KEY`.
- Consulta la tabla `academico.usuarios` para validar credenciales, pero no
  administra el ciclo de vida de usuarios.
- Registra sesiones en `academico.auth_sessions` cuando la migracion del asset
  fue aplicada.

El contrato reutilizable del asset es `auth.v1.AuthService`.

## Documentacion transversal

La documentacion canonica del flujo web -> gateway -> login -> JWT -> gateway -> servicio esta en:

- `academico-gateway/docs/architecture/gateway-auth-routing.md`
- `academico-gateway/docs/adr/0001-gateway-auth-jwt-routing.md`
- `DOCUMENTACION_CORE_ASSET_LOGIN.md`

En Azure DevOps, publicar `academico-gateway/docs` como Wiki del proyecto para que esta documentacion quede visible para todos los repositorios participantes.

## Configuracion

Ver [.env.example](.env.example).

Variables principales:

- `PORT`
- `LOGIN_API_KEY`
- `JWT_SECRET`
- `JWT_DOC_SECRET`
- `JWT_ACCESS_TTL`
- `JWT_REFRESH_TTL`
- `DB_HOST`
- `DB_PORT`
- `DB_DATABASE`
- `DB_USER`
- `DB_PASSWORD`

## Base de datos

La migracion del asset esta en:

```text
database/migrations/V1__login_core_asset.sql
```

Debe aplicarse sobre el esquema `academico` para habilitar auditoria basica,
revocacion de sesiones y hash de refresh tokens. Si la tabla aun no existe, el
servicio conserva compatibilidad y no bloquea el login.

## Contratos

REST:

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/validate-token`
- `POST /api/v1/auth/validate-token-2`
- `GET /api/v1/whitelist/all`

ConnectRPC/gRPC:

- `auth.v1.AuthService/Login`
- `auth.v1.AuthService/RefreshToken`
- `auth.v1.AuthService/ValidateToken`
- `auth.v1.AuthService/Logout`

## Ejecucion local

```bash
npm install
npm run proto:build
npm run start:dev
```

## Pruebas

```bash
npm test
npm run build
```
