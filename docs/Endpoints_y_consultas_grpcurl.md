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

Variables usadas en los ejemplos:

```bash
LOGIN_HOST=localhost:3001
LOGIN_API_KEY=<valor_de_LOGIN_API_KEY>
```

El servicio usa Fastify con HTTP/2 h2c. Para REST, usar
`curl --http2-prior-knowledge`. Para gRPC/Connect, usar `grpcurl -plaintext`.

## Seguridad

- Los endpoints REST requieren `x-api-key: $LOGIN_API_KEY`, excepto
  `/api/health`, `/api/ready` y `/api/live`.
- Los RPCs de negocio requieren `x-api-key: $LOGIN_API_KEY`.
- La reflexion gRPC permite `grpcurl list` y `grpcurl describe` sin API key.
- Los tokens de usuario se envian como `Bearer <accessToken>` solo en REST
  cuando el endpoint lo requiere; en gRPC los tokens van en el mensaje.

## Endpoints REST

| Metodo | Endpoint | Requiere API key | Entrada | Salida principal |
| --- | --- | --- | --- | --- |
| `GET` | `/api/health` | No | Sin body | `status`, `service`, `timestamp`, `uptime` |
| `GET` | `/api/ready` | No | Sin body | `ready`, `timestamp` |
| `GET` | `/api/live` | No | Sin body | `alive`, `timestamp`, `uptime` |
| `POST` | `/api/v1/auth/login` | Si | `username`, `password`, opcional `appVersion`/`app_version`, `passwordEncoding`/`password_encoding` | `accessToken`, `refreshToken`, `tokenType`, `expiresIn`, `sessionId`, `mfaRequired`, `requiresAppUpdate` |
| `POST` | `/api/v1/auth/refresh` | Si | `refreshToken` o `refresh_token` | Nueva respuesta de login con el mismo `refreshToken` y `sessionId` |
| `POST` | `/api/v1/auth/logout` | Si | `token`, `refreshToken`/`refresh_token` o header `Authorization: Bearer <token>` | `success`, `revoked`, `message` |
| `POST` | `/api/v1/auth/validate-token` | Si | `token` | `isValid` |
| `POST` | `/api/v1/auth/validate-token-2` | Si | Header `Authorization: Bearer <accessToken>` | `isValid`, `identifier`, `email`, `sessionId`, `userId`, `role`, `applications` |
| `GET` | `/api/v1/whitelist/all` | Si | Sin body | Lista de rutas publicas para gateway |

Ejemplo REST de login:

```bash
curl --http2-prior-knowledge -sS \
  -X POST "http://${LOGIN_HOST}/api/v1/auth/login" \
  -H "content-type: application/json" \
  -H "x-api-key: ${LOGIN_API_KEY}" \
  -d '{"username":"estudiante@utn.edu.ec","password":"cGFzc3dvcmQxMjM=","passwordEncoding":"base64"}'
```

## Endpoints gRPC/Connect

Servicio publicado:

```text
auth.v1.AuthService
```

| RPC grpcurl | Path HTTP/2 Connect | Request | Response |
| --- | --- | --- | --- |
| `auth.v1.AuthService/Login` | `/auth.v1.AuthService/Login` | `LoginRequest` | `LoginResponse` |
| `auth.v1.AuthService/RefreshToken` | `/auth.v1.AuthService/RefreshToken` | `RefreshTokenRequest` | `LoginResponse` |
| `auth.v1.AuthService/ValidateToken` | `/auth.v1.AuthService/ValidateToken` | `ValidateTokenRequest` | `ValidateTokenResponse` |
| `auth.v1.AuthService/Logout` | `/auth.v1.AuthService/Logout` | `LogoutRequest` | `GenericResponse` |

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
}
```

## Consultas grpcurl

Listar servicios expuestos por reflexion:

```bash
grpcurl -plaintext \
  "${LOGIN_HOST}" \
  list
```

Describir el servicio:

```bash
grpcurl -plaintext \
  "${LOGIN_HOST}" \
  describe auth.v1.AuthService
```

### Login

Este comando retorna `accessToken`, `refreshToken`, `tokenType`, `expiresIn` y
`sessionId`.

```bash
grpcurl -plaintext \
  -H "x-api-key: ${LOGIN_API_KEY}" \
  -d '{"username":"estudiante@utn.edu.ec","password":"cGFzc3dvcmQxMjM=","password_encoding":"base64"}' \
  "${LOGIN_HOST}" \
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
    "${LOGIN_HOST}" \
    auth.v1.AuthService/Login \
  | jq -er '.accessToken'
)"; then
  echo "Token obtenido correctamente (${#TOKEN} caracteres)"

  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d "{\"token\":\"${TOKEN}\"}" \
    "${LOGIN_HOST}" \
    auth.v1.AuthService/ValidateToken
else
  echo "ERROR: no se pudo obtener TOKEN desde ${LOGIN_HOST}. No se ejecuta ValidateToken." >&2
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
    "${LOGIN_HOST}" \
    auth.v1.AuthService/Login \
  | jq -er '.refreshToken'
)"; then
  echo "Refresh token obtenido correctamente (${#REFRESH_TOKEN} caracteres)"

  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d "{\"refresh_token\":\"${REFRESH_TOKEN}\"}" \
    "${LOGIN_HOST}" \
    auth.v1.AuthService/RefreshToken
else
  echo "ERROR: no se pudo obtener REFRESH_TOKEN desde ${LOGIN_HOST}. No se ejecuta RefreshToken." >&2
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
    "${LOGIN_HOST}" \
    auth.v1.AuthService/Login \
  | jq -er '.refreshToken'
)"; then
  echo "Refresh token obtenido correctamente (${#REFRESH_TOKEN} caracteres)"

  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d "{\"refresh_token\":\"${REFRESH_TOKEN}\"}" \
    "${LOGIN_HOST}" \
    auth.v1.AuthService/Logout
else
  echo "ERROR: no se pudo obtener REFRESH_TOKEN desde ${LOGIN_HOST}. No se ejecuta Logout." >&2
fi
```

## Flujo completo gRPC

Este flujo ejecuta los cuatro RPCs de negocio en orden: login, validacion,
refresh y logout.

```bash
set -euo pipefail

LOGIN_RESPONSE="$(
  grpcurl -plaintext \
    -H "x-api-key: ${LOGIN_API_KEY}" \
    -d '{"username":"estudiante@utn.edu.ec","password":"cGFzc3dvcmQxMjM=","password_encoding":"base64"}' \
    "${LOGIN_HOST}" \
    auth.v1.AuthService/Login
)"

ACCESS_TOKEN="$(printf '%s' "${LOGIN_RESPONSE}" | jq -er '.accessToken')"
REFRESH_TOKEN="$(printf '%s' "${LOGIN_RESPONSE}" | jq -er '.refreshToken')"
SESSION_ID="$(printf '%s' "${LOGIN_RESPONSE}" | jq -er '.sessionId')"

echo "Login OK: ${SESSION_ID}"

grpcurl -plaintext \
  -H "x-api-key: ${LOGIN_API_KEY}" \
  -d "{\"token\":\"${ACCESS_TOKEN}\"}" \
  "${LOGIN_HOST}" \
  auth.v1.AuthService/ValidateToken

grpcurl -plaintext \
  -H "x-api-key: ${LOGIN_API_KEY}" \
  -d "{\"refresh_token\":\"${REFRESH_TOKEN}\"}" \
  "${LOGIN_HOST}" \
  auth.v1.AuthService/RefreshToken

grpcurl -plaintext \
  -H "x-api-key: ${LOGIN_API_KEY}" \
  -d "{\"refresh_token\":\"${REFRESH_TOKEN}\"}" \
  "${LOGIN_HOST}" \
  auth.v1.AuthService/Logout
```

## Notas de integracion

- Para contrasenas en texto plano, usar `"password_encoding":"plain"` o omitir
  el campo.
- Para contrasenas en Base64, usar `"password_encoding":"base64"`.
- `grpcurl` imprime respuestas con nombres JSON camelCase, por ejemplo
  `accessToken`, `refreshToken`, `sessionId`, aunque el `.proto` declare
  `access_token`, `refresh_token` y `session_id`.
- En REST, los DTOs aceptan aliases `camelCase` y `snake_case` para
  `passwordEncoding`, `appVersion` y `refreshToken`.
- Si se ejecuta contra un gateway publico que transforma nombres de campos,
  puede requerirse `passwordEncoding`/`refreshToken` en lugar de
  `password_encoding`/`refresh_token`.
