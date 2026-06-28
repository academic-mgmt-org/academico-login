# Documento Técnico Core Asset: Authentication Service (Login)

## 1. Información General

|Campo|Valor|
|---|---|
|Nombre|Authentication Service|
|Tipo|Core Asset|
|Dominio|Identidad y Autenticación|
|Tecnología|NestJS + ConnectRPC/gRPC + REST|
|Base de Datos|PostgreSQL|
|Versión|1.0.0|
|Reutilizable|Sí|

---

# 2. Objetivo

Centralizar la autenticación de usuarios para las líneas de productos académicos.

Este servicio será responsable de:

- Validar credenciales.
- Emitir `accessToken` y `refreshToken`.
- Validar tokens para el Gateway.
- Renovar sesiones autenticadas.
- Revocar sesiones.
- Publicar la whitelist consumida por el Gateway.
- Mantener un contrato reutilizable para nuevos clientes web, móviles o gateways.

---

# 3. Responsabilidades

## Incluye

- Login de usuarios activos.
- Generación de JWT.
- Refresh token.
- Logout y revocación de sesión.
- Validación criptográfica de JWT.
- Whitelist de rutas públicas.
- Protección interna por `LOGIN_API_KEY`.
- Registro opcional de sesiones en `academico.auth_sessions`.

---

## No Incluye

- Creación de usuarios.
- Actualización de usuarios.
- Asignación administrativa de roles.
- Gestión de organizaciones.
- Recuperación de contraseña.
- MFA avanzado.
- Administración de permisos.

---

# 4. Ubicación en la Arquitectura

El `Authentication Service` no administra el Gateway ni administra usuarios. Su responsabilidad es autenticar y mantener sesiones.

```text
Authentication Service
│
├── Login
├── Emisión y validación de JWT
├── Refresh token
├── Logout
└── Sesiones en academico.auth_sessions
```

Sus conexiones con el resto de la plataforma son integraciones:

```text
Cliente consumidor
(web, móvil, backend, gateway)
      │
      ▼
academico-web / academico-gateway
      │
      │ solicita login, refresh, validate-token o whitelist
      ▼
Authentication Service
      │
      ├── Lee usuarios activos, roles y password_hash
      │       desde academico.usuarios y academico.roles
      │
      ├── Crea, consulta o revoca sesiones
      │       en academico.auth_sessions
      │
      └── Devuelve tokens e identidad validada
              al Gateway o cliente integrador
```

Lectura correcta de las conexiones:

- `Gateway`: consume el servicio de autenticación. No es gestionado por `academico-login`.
- `Tablas de Usuario`: son fuente de datos para validar credenciales, estado y rol. `academico-login` no crea ni modifica usuarios.
- `academico.auth_sessions`: sí es gestionada por `academico-login`, porque forma parte del ciclo de sesión.
- `Audit`: representa una integración futura o complementaria para eventos de auditoría; no forma parte obligatoria del flujo actual.

El servicio es la autoridad de autenticación. El ciclo de vida maestro del usuario no está implementado en este asset; permanece en el Core Asset de Gestión de Usuarios o en el modelo de datos existente. Para autenticar, este servicio consulta las tablas `academico.usuarios` y `academico.roles`.

---

# 5. Modelo de Dominio

## Entidades principales

```text
User
  │
  ├── Role
  │
  └── AuthSession
        │
        ├── AccessToken
        └── RefreshTokenHash
```

---

# 6. Casos de Uso

## CU-001 Iniciar Sesión

Actor:

```text
Usuario académico
```

Proceso:

```text
1. Recibir usuario y contraseña
2. Normalizar correo
3. Validar usuario activo
4. Verificar password_hash
5. Crear sessionId
6. Emitir accessToken y refreshToken
7. Registrar sesión si la tabla existe
```

---

## CU-002 Validar Token

Permite al Gateway validar:

- Firma JWT.
- Expiración.
- Tipo de token.
- Sesión revocada cuando existe `auth_sessions`.
- Identidad mínima para ruteo seguro.

---

## CU-003 Renovar Token

Entrada:

```text
refreshToken
```

Resultado:

```text
Nuevo accessToken con el mismo sessionId
```

---

## CU-004 Cerrar Sesión

Proceso:

```text
1. Recibir accessToken o refreshToken
2. Validar firma
3. Marcar auth_sessions.revoked_at
4. Responder estado de revocación
```

---

## CU-005 Publicar Whitelist

Rutas públicas expuestas al Gateway:

- `/login/api/v1/auth/login`
- `/login/api/v1/auth/refresh`

---

# 7. Modelo de Datos

## auth_sessions

```sql
CREATE TABLE academico.auth_sessions (
  session_id VARCHAR(80) PRIMARY KEY,
  user_id TEXT NOT NULL,
  username VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL,
  role_name VARCHAR(80) NOT NULL,
  refresh_token_hash CHAR(64) NOT NULL,
  user_agent TEXT,
  ip_address VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
```

Script:

```text
database/migrations/V1__login_core_asset.sql
```

---

# 8. Estados de Sesión

```text
ACTIVE
EXPIRED
REVOKED
INVALID
```

---

# 9. Reglas de Negocio

## RN-001

Solo usuarios con `academico.usuarios.estado = 'activo'` pueden autenticarse.

---

## RN-002

El correo se normaliza a minúsculas antes de consultar la base de datos.

---

## RN-003

El `refreshToken` completo no se almacena en base de datos.

```text
Solo se persiste SHA-256(refreshToken)
```

---

## RN-004

El asset soporta `password_hash` en `bcrypt`, `sha256:<hash>`, hash SHA-256 hexadecimal y texto plano legacy para compatibilidad con semillas actuales.

---

## RN-005

Las llamadas internas deben incluir `x-api-key` con el valor configurado en `LOGIN_API_KEY`.

---

# 10. Contrato gRPC

## auth.proto

```protobuf
syntax = "proto3";
package auth.v1;

service AuthService {
  rpc Login(LoginRequest)
      returns(LoginResponse);

  rpc RefreshToken(RefreshTokenRequest)
      returns(LoginResponse);

  rpc ValidateToken(ValidateTokenRequest)
      returns(ValidateTokenResponse);

  rpc Logout(LogoutRequest)
      returns(GenericResponse);
}
```

---

## LoginRequest

```protobuf
message LoginRequest {
  string username = 1;
  string password = 2;
  string app_version = 3;
  string password_encoding = 4;
}
```

---

## LoginResponse

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

---

## ValidateTokenResponse

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

---

# 11. Eventos de Dominio

El servicio debe emitir eventos técnicos para Auditoría y Observabilidad.

## AUTH_LOGIN_SUCCEEDED

```json
{
  "event":"AUTH_LOGIN_SUCCEEDED",
  "email":"estudiante@utn.edu.ec",
  "sessionId":"SESSION-..."
}
```

---

## AUTH_LOGIN_FAILED

```json
{
  "event":"AUTH_LOGIN_FAILED",
  "email":"estudiante@utn.edu.ec",
  "reason":"INVALID_CREDENTIALS"
}
```

---

## AUTH_TOKEN_REFRESHED

```json
{
  "event":"AUTH_TOKEN_REFRESHED",
  "sessionId":"SESSION-..."
}
```

---

## AUTH_SESSION_REVOKED

```json
{
  "event":"AUTH_SESSION_REVOKED",
  "sessionId":"SESSION-..."
}
```

---

# 12. Integraciones

## academico-web

Consume:

```text
POST /api/auth/login
```

El backend Laravel traduce esta llamada a gRPC usando `auth.v1.AuthService/Login`.

---

## academico-gateway

Consume:

```text
/login/api/v1/auth/login
/login/api/v1/auth/refresh
/login/api/v1/auth/validate-token-2
/login/api/v1/whitelist/all
```

---

## Fuente de Usuarios Existente

Este asset no implementa creación, actualización ni administración de usuarios. Para el login consume la información existente en base de datos:

```text
academico.usuarios
academico.roles
```

---

## Audit Service

Registra:

```text
AUTH_LOGIN_SUCCEEDED
AUTH_LOGIN_FAILED
AUTH_TOKEN_REFRESHED
AUTH_SESSION_REVOKED
```

---

# 13. Observabilidad

## Logs

```json
{
  "service":"academico-login",
  "operation":"LOGIN",
  "email":"estudiante@utn.edu.ec",
  "sessionId":"SESSION-..."
}
```

---

## Métricas

- Logins exitosos.
- Logins fallidos.
- Tokens validados.
- Tokens renovados.
- Sesiones revocadas.
- Latencia promedio de login.
- Errores de conexión a base de datos.

---

# 14. Seguridad

## Datos sensibles

No exponer:

```text
Contraseñas
JWT completos en logs
Refresh tokens completos
API keys
Secretos JWT
```

---

## Protección

Aplicar:

- TLS en tránsito.
- `LOGIN_API_KEY` para tráfico interno.
- JWT firmado con `JWT_SECRET`.
- TTL configurable con `JWT_ACCESS_TTL` y `JWT_REFRESH_TTL`.
- Hash de refresh token en base de datos.
- Revocación por `sessionId`.

---

# 15. Integración DevOps

## Azure Boards

Epic:

```text
Gestión de Identidades
```

Feature:

```text
Autenticación y Sesiones
```

Historia:

```text
US-501 Implementar Core Asset Login
```

---

## Pipeline

```text
Build Docker
↓
Publicar imagen en ACR
↓
Aprobación manual
↓
Despliegue con Docker Compose
↓
Validación de contenedor y healthcheck
```

---

## Commit

```bash
git commit -m "feat(login): completar core asset de autenticacion AB#501"
```

---

## Pull Request

```text
Implementación Core Asset Login

Fixes AB#501
```

---

# 16. Quality Gates

|Métrica|Objetivo|
|---|---|
|Cobertura|>= 85%|
|Vulnerabilidades críticas|0|
|Bugs críticos|0|
|Latencia login|< 200 ms|
|Latencia validación token|< 100 ms|
|Disponibilidad|99.9%|

---

# 17. Roadmap Evolutivo

### Versión 1.0

- Login.
- JWT.
- Refresh token.
- Logout.
- Validación para Gateway.
- Whitelist pública.

### Versión 1.1

- MFA.
- Políticas de bloqueo por intentos fallidos.
- Rotación de refresh tokens.
- Métricas Prometheus.

### Versión 2.0

- JWKS para validación distribuida.
- Federación OIDC/SAML.
- Multi-tenant.
- Integración con directorios corporativos.

---

# 18. Ubicación dentro de la Plataforma Core Assets

```text
Core Assets

├── Authentication Service
├── Authorization Service
├── Gestión de Usuarios
├── Audit Service
├── Notification Service
├── File Service
└── Reporting Service
```

`Gestión de Usuarios` se muestra como Core Asset complementario de la plataforma, no como funcionalidad implementada dentro de `academico-login`.

## Flujo Integrado

```text
Login Usuario
      │
      ▼

Authentication Service
      │
      ├── Valida credenciales contra academico.usuarios y academico.roles
      ├── Emite JWT
      ├── Registra sesión
      └── Publica identidad al Gateway

             ↓

        Usuario autenticado
```

### Beneficio Estratégico

El **Authentication Service** concentra la política de login y emisión de tokens en un Core Asset reutilizable. Esto permite que nuevas líneas de producto consuman el mismo contrato de autenticación sin duplicar validaciones, secretos, sesiones ni reglas de integración con el Gateway.
