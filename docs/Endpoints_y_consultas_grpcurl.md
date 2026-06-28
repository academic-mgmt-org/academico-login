# Endpoints y consultas grpcurl - academico-login

Validado el 2026-06-28 UTC contra `localhost:3001`.

Este documento resume todos los endpoints publicados por `academico-login` y
deja ejemplos de consulta con `grpcurl` siguiendo el formato de
`/home/azureuser/CONSULTAS.md`.

## Requisitos

```bash
grpcurl
jq
```

Variable usada en los ejemplos:

```bash
LOGIN_API_KEY=<valor_de_LOGIN_API_KEY>
```

El servicio usa Fastify con HTTP/2 h2c y publica endpoints gRPC/Connect.
Para consultar con `grpcurl`, usar `grpcurl -plaintext`.

## Seguridad

- Los RPCs de `AuthService` y `WhitelistService` requieren
  `x-api-key: $LOGIN_API_KEY`.
- Los RPCs de `HealthService` no requieren API key.
- La reflexion gRPC permite `grpcurl list` y `grpcurl describe` sin API key.
- Los tokens de usuario se envian en el mensaje gRPC correspondiente o en el
  header `authorization`, segun el RPC.

## Endpoints gRPC/Connect

Servicios publicados:

```text
auth.v1.AuthService
auth.v1.WhitelistService
auth.v1.HealthService
```

| RPC grpcurl | Path HTTP/2 Connect | Request | Response |
| --- | --- | --- | --- |
| `auth.v1.AuthService/Login` | `/auth.v1.AuthService/Login` | `LoginRequest` | `LoginResponse` |
| `auth.v1.AuthService/RefreshToken` | `/auth.v1.AuthService/RefreshToken` | `RefreshTokenRequest` | `LoginResponse` |
| `auth.v1.AuthService/ValidateToken` | `/auth.v1.AuthService/ValidateToken` | `ValidateTokenRequest` | `ValidateTokenResponse` |
| `auth.v1.AuthService/ValidateTokenSimple` | `/auth.v1.AuthService/ValidateTokenSimple` | `ValidateTokenRequest` | `TokenValidityResponse` |
| `auth.v1.AuthService/ValidateTokenWithHeader` | `/auth.v1.AuthService/ValidateTokenWithHeader` | `Empty` | `ValidateTokenResponse` |
| `auth.v1.AuthService/Logout` | `/auth.v1.AuthService/Logout` | `LogoutRequest` | `GenericResponse` |
| `auth.v1.WhitelistService/GetAll` | `/auth.v1.WhitelistService/GetAll` | `Empty` | `WhitelistResponse` |
| `auth.v1.HealthService/Health` | `/auth.v1.HealthService/Health` | `Empty` | `HealthResponse` |
| `auth.v1.HealthService/Ready` | `/auth.v1.HealthService/Ready` | `Empty` | `ReadyResponse` |
| `auth.v1.HealthService/Live` | `/auth.v1.HealthService/Live` | `Empty` | `LiveResponse` |

### Mensajes gRPC

`LoginRequest`:

```protobuf
message LoginRequest {
  string username = 1;
  string password = 2;
  string app_version = 3;
  string password_encoding = 4;
}
```

`LoginResponse`:

```protobuf
message LoginResponse {
  string access_token = 1;
  string refresh_token = 2;
  bool mfa_required = 3;
  bool requires_app_update = 4;
  string token_type = 5;
  int32 expires_in = 6;
  string session_id = 7;
}
```

`RefreshTokenRequest`:

```protobuf
message RefreshTokenRequest {
  string refresh_token = 1;
}
```

`ValidateTokenRequest`:

```protobuf
message ValidateTokenRequest {
  string token = 1;
}
```

`ValidateTokenResponse`:

```protobuf
message ValidateTokenResponse {
  bool is_valid = 1;
  string identifier = 2;
  string email = 3;
  string session_id = 4;
  string user_id = 5;
  string role = 6;
  repeated ApplicationAccess applications = 7;
}
```

`LogoutRequest`:

```protobuf
message LogoutRequest {
  string token = 1;
  string refresh_token = 2;
}
```

`GenericResponse`:

```protobuf
message GenericResponse {
  bool success = 1;
  string message = 2;
  bool revoked = 3;
}
```

`TokenValidityResponse`:

```protobuf
message TokenValidityResponse {
  bool is_valid = 1;
}
```

`Empty`:

```protobuf
message Empty {}
```

`WhitelistResponse`:

```protobuf
message WhitelistResponse {
  repeated string routes = 1;
}
```

`HealthResponse`:

```protobuf
message HealthResponse {
  string status = 1;
  string service = 2;
  string timestamp = 3;
  double uptime = 4;
}
```

`ReadyResponse`:

```protobuf
message ReadyResponse {
  bool ready = 1;
  string timestamp = 2;
}
```

`LiveResponse`:

```protobuf
message LiveResponse {
  bool alive = 1;
  string timestamp = 2;
  double uptime = 3;
}
```

`ApplicationAccess`:

```protobuf
message ApplicationAccess {
  string app_name = 1;
  repeated RoleAccess roles = 2;
}
```

`RoleAccess`:

```protobuf
message RoleAccess {
  string role_name = 1;
  repeated string permissions = 2;
}
```

## Consultas grpcurl

Listar servicios expuestos por reflexion:

```bash
grpcurl -plaintext \
  localhost:3001 \
  list
```

Describir servicios:

```bash
grpcurl -plaintext \
  localhost:3001 \
  describe auth.v1.AuthService

grpcurl -plaintext \
  localhost:3001 \
  describe auth.v1.WhitelistService

grpcurl -plaintext \
  localhost:3001 \
  describe auth.v1.HealthService
```

### Login

Este comando retorna `accessToken`, `refreshToken`, `tokenType`, `expiresIn` y
`sessionId`.

```bash
grpcurl -plaintext \
  -H "x-api-key: ${LOGIN_API_KEY}" \
  -d '{"username":"estudiante@utn.edu.ec","password":"cGFzc3dvcmQxMjM=","password_encoding":"base64"}' \
  localhost:3001 \
  auth.v1.AuthService/Login
```

### ValidateToken

Primero obtiene un `accessToken` con `Login`; luego valida ese token.

```bash
set -o pipefail

if TOKEN="$(
  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d '{"username":"estudiante@utn.edu.ec","password":"cGFzc3dvcmQxMjM=","password_encoding":"base64"}' \
    localhost:3001 \
    auth.v1.AuthService/Login \
  | jq -er '.accessToken'
)"; then
  echo "Token obtenido correctamente (${#TOKEN} caracteres)"

  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d "{\"token\":\"${TOKEN}\"}" \
    localhost:3001 \
    auth.v1.AuthService/ValidateToken
else
  echo "ERROR: no se pudo obtener TOKEN desde localhost:3001. No se ejecuta ValidateToken." >&2
fi
```

### ValidateTokenSimple

Primero obtiene un `accessToken` con `Login`; luego valida solo si el token es
valido y retorna `isValid`.

```bash
set -o pipefail

if TOKEN="$(
  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d '{"username":"estudiante@utn.edu.ec","password":"cGFzc3dvcmQxMjM=","password_encoding":"base64"}' \
    localhost:3001 \
    auth.v1.AuthService/Login \
  | jq -er '.accessToken'
)"; then
  echo "Token obtenido correctamente (${#TOKEN} caracteres)"

  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d "{\"token\":\"${TOKEN}\"}" \
    localhost:3001 \
    auth.v1.AuthService/ValidateTokenSimple
else
  echo "ERROR: no se pudo obtener TOKEN desde localhost:3001. No se ejecuta ValidateTokenSimple." >&2
fi
```

### ValidateTokenWithHeader

Primero obtiene un `accessToken` con `Login`; luego valida el token recibido en
el header `authorization`.

```bash
set -o pipefail

if TOKEN="$(
  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d '{"username":"estudiante@utn.edu.ec","password":"cGFzc3dvcmQxMjM=","password_encoding":"base64"}' \
    localhost:3001 \
    auth.v1.AuthService/Login \
  | jq -er '.accessToken'
)"; then
  echo "Token obtenido correctamente (${#TOKEN} caracteres)"

  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -H "authorization: Bearer ${TOKEN}" \
    -d '{}' \
    localhost:3001 \
    auth.v1.AuthService/ValidateTokenWithHeader
else
  echo "ERROR: no se pudo obtener TOKEN desde localhost:3001. No se ejecuta ValidateTokenWithHeader." >&2
fi
```

### RefreshToken

Primero obtiene un `refreshToken` con `Login`; luego solicita un nuevo
`accessToken`.

```bash
set -o pipefail

if REFRESH_TOKEN="$(
  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d '{"username":"estudiante@utn.edu.ec","password":"cGFzc3dvcmQxMjM=","password_encoding":"base64"}' \
    localhost:3001 \
    auth.v1.AuthService/Login \
  | jq -er '.refreshToken'
)"; then
  echo "Refresh token obtenido correctamente (${#REFRESH_TOKEN} caracteres)"

  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d "{\"refresh_token\":\"${REFRESH_TOKEN}\"}" \
    localhost:3001 \
    auth.v1.AuthService/RefreshToken
else
  echo "ERROR: no se pudo obtener REFRESH_TOKEN desde localhost:3001. No se ejecuta RefreshToken." >&2
fi
```

### Logout

Primero obtiene un `refreshToken` con `Login`; luego revoca la sesion asociada.

```bash
set -o pipefail

if REFRESH_TOKEN="$(
  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d '{"username":"estudiante@utn.edu.ec","password":"cGFzc3dvcmQxMjM=","password_encoding":"base64"}' \
    localhost:3001 \
    auth.v1.AuthService/Login \
  | jq -er '.refreshToken'
)"; then
  echo "Refresh token obtenido correctamente (${#REFRESH_TOKEN} caracteres)"

  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d "{\"refresh_token\":\"${REFRESH_TOKEN}\"}" \
    localhost:3001 \
    auth.v1.AuthService/Logout
else
  echo "ERROR: no se pudo obtener REFRESH_TOKEN desde localhost:3001. No se ejecuta Logout." >&2
fi
```

### WhitelistService/GetAll

Retorna las rutas HTTP configuradas como publicas para integraciones que
necesiten conocer la whitelist.

```bash
grpcurl -plaintext \
  -H "x-api-key: ${LOGIN_API_KEY}" \
  -d '{}' \
  localhost:3001 \
  auth.v1.WhitelistService/GetAll
```

### HealthService/Health

Retorna el estado general del microservicio.

```bash
grpcurl -plaintext \
  -d '{}' \
  localhost:3001 \
  auth.v1.HealthService/Health
```

### HealthService/Ready

Retorna si el microservicio esta listo para recibir trafico.

```bash
grpcurl -plaintext \
  -d '{}' \
  localhost:3001 \
  auth.v1.HealthService/Ready
```

### HealthService/Live

Retorna si el proceso esta vivo.

```bash
grpcurl -plaintext \
  -d '{}' \
  localhost:3001 \
  auth.v1.HealthService/Live
```

## Flujo completo gRPC

Este flujo ejecuta el camino principal de negocio en orden: login, validacion,
refresh y logout.

```bash
set -euo pipefail

LOGIN_RESPONSE="$(
  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d '{"username":"estudiante@utn.edu.ec","password":"cGFzc3dvcmQxMjM=","password_encoding":"base64"}' \
    localhost:3001 \
    auth.v1.AuthService/Login
)"

ACCESS_TOKEN="$(printf '%s' "${LOGIN_RESPONSE}" | jq -er '.accessToken')"
REFRESH_TOKEN="$(printf '%s' "${LOGIN_RESPONSE}" | jq -er '.refreshToken')"
SESSION_ID="$(printf '%s' "${LOGIN_RESPONSE}" | jq -er '.sessionId')"

echo "Login OK: ${SESSION_ID}"

grpcurl -plaintext \
  -H "x-api-key: ${LOGIN_API_KEY}" \
  -d "{\"token\":\"${ACCESS_TOKEN}\"}" \
  localhost:3001 \
  auth.v1.AuthService/ValidateToken

grpcurl -plaintext \
  -H "x-api-key: ${LOGIN_API_KEY}" \
  -d "{\"refresh_token\":\"${REFRESH_TOKEN}\"}" \
  localhost:3001 \
  auth.v1.AuthService/RefreshToken

grpcurl -plaintext \
  -H "x-api-key: ${LOGIN_API_KEY}" \
  -d "{\"refresh_token\":\"${REFRESH_TOKEN}\"}" \
  localhost:3001 \
  auth.v1.AuthService/Logout
```

## Notas de integracion

- Para contrasenas en texto plano, usar `"password_encoding":"plain"` o omitir
  el campo.
- Para contrasenas en Base64, usar `"password_encoding":"base64"`.
- `grpcurl` imprime respuestas con nombres JSON camelCase, por ejemplo
  `accessToken`, `refreshToken`, `sessionId`, aunque el `.proto` declare
  `access_token`, `refresh_token` y `session_id`.
- Si se ejecuta contra un gateway publico que transforma nombres de campos,
  puede requerirse `passwordEncoding`/`refreshToken` en lugar de
  `password_encoding`/`refresh_token`.
