# Levantar el servicio de login e integrarlo con una base de datos

Esta guia describe los pasos operativos para ejecutar `academico-login` y conectarlo a una base de datos existente o nueva.

## 1. Alcance real del servicio

`academico-login` es un microservicio NestJS que:

- valida credenciales contra tablas de usuarios y roles;
- emite `accessToken` y `refreshToken` JWT;
- valida tokens para clientes internos o gateway;
- renueva y revoca sesiones;
- protege sus endpoints con `LOGIN_API_KEY`;
- registra sesiones en `academico.auth_sessions` cuando la migracion del asset fue aplicada.

El codigo actual usa el paquete `pg`, por lo que soporta PostgreSQL de forma directa. Para usar otro motor, como MySQL, SQL Server, Oracle o MongoDB, se debe reemplazar la capa de acceso a datos descrita en la seccion "Integrar con otro motor de base de datos".

## 2. Prerrequisitos

Para levantar el servicio con Docker:

- Docker.
- Docker Compose.
- Acceso a una base de datos PostgreSQL o a un motor alternativo con una adaptacion de repositorio.
- Variables de entorno configuradas en `.env`.
- Puerto disponible para el servicio. Por defecto se usa `3001`.

No es necesario instalar Node.js ni `npm` en el host si se usa Docker. El `Dockerfile` usa `node:22.13.0-slim` para instalar dependencias, compilar y ejecutar la aplicacion dentro del contenedor.

## 3. Variables de entorno

Crear el archivo `.env` desde `.env.example` si aun no existe:

```bash
cp -n .env.example .env
```

Configurar al menos:

```env
PORT=3001
NODE_ENV=development
LOGIN_API_KEY=valor-interno-seguro
JWT_SECRET=valor-jwt-seguro
JWT_DOC_SECRET=valor-jwt-doc-opcional
JWT_ACCESS_TTL=2h
JWT_REFRESH_TTL=7d
DB_HOST=host-de-la-base
DB_PORT=5432
DB_DATABASE=nombre_base
DB_USER=usuario_base
DB_PASSWORD=password_base
```

Notas:

- `LOGIN_API_KEY` es obligatoria. Todas las rutas REST, excepto health checks, requieren el header `x-api-key`.
- `JWT_SECRET` debe ser el mismo para todos los consumidores que necesiten validar tokens localmente.
- `JWT_ACCESS_TTL` y `JWT_REFRESH_TTL` aceptan valores como `30m`, `2h` o `7d`.
- La conexion actual en `src/db.js` usa SSL con `rejectUnauthorized: false`. Si la base de datos no soporta SSL, se debe ajustar esa configuracion antes de levantar el servicio.
- Para usar las variables del `.env` en comandos de terminal, cargarlas con:

```bash
set -a
source .env
set +a
```

## 4. Preparar la base de datos PostgreSQL

Si la base esta vacia y no tiene las tablas del dominio de login, ejecutar el script de arranque:

```bash
psql "host=$DB_HOST port=$DB_PORT dbname=$DB_DATABASE user=$DB_USER password=$DB_PASSWORD sslmode=require" \
  -f database/scripts/bootstrap_login_schema.sql
```

Ese script crea:

- `academico.roles`
- `academico.usuarios`
- `academico.auth_sessions`
- indices necesarios para busqueda por email, estado y sesiones
- roles base: `estudiante`, `docente`, `administrador`, `admin`
- usuarios de prueba para validar login en una instalacion nueva

Si la base ya tiene tablas propias de usuarios y roles, no ejecutar este script directamente sobre esas tablas sin revisar compatibilidad. En ese caso usar vistas o adaptar la consulta como se describe en "Integrar con una base de datos PostgreSQL existente".

Credenciales de prueba creadas por el script:

| Usuario | Password | Rol |
| --- | --- | --- |
| `estudiante@demo.com` | `password123` | `estudiante` |
| `docente@demo.com` | `password123` | `docente` |
| `administrador@demo.com` | `admin123` | `administrador` |

Eliminar o reemplazar estos usuarios antes de usar la base en produccion.

El servicio consulta usuarios con este contrato:

```sql
SELECT
  u.id AS usuario_id,
  u.nombres,
  u.apellidos,
  u.email,
  u.password_hash,
  u.identificacion,
  u.estado,
  COALESCE(r.nombre, 'usuario') AS rol_nombre
FROM academico.usuarios u
INNER JOIN academico.roles r ON r.id = u.rol_id
WHERE LOWER(u.email) = $1
  AND LOWER(u.estado) = 'activo'
LIMIT 1;
```

Por tanto, la base debe exponer estas columnas minimas:

| Tabla | Columnas requeridas |
| --- | --- |
| `academico.roles` | `id`, `nombre` |
| `academico.usuarios` | `id`, `rol_id`, `nombres`, `apellidos`, `email`, `password_hash`, `identificacion`, `estado` |

El script de arranque crea un esquema equivalente a este:

```sql
CREATE SCHEMA IF NOT EXISTS academico;

CREATE TABLE IF NOT EXISTS academico.roles (
  id BIGSERIAL PRIMARY KEY,
  nombre VARCHAR(80) NOT NULL UNIQUE,
  descripcion TEXT
);

CREATE TABLE IF NOT EXISTS academico.usuarios (
  id BIGSERIAL PRIMARY KEY,
  rol_id BIGINT NOT NULL REFERENCES academico.roles(id),
  nombres VARCHAR(120) NOT NULL,
  apellidos VARCHAR(120) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  identificacion VARCHAR(30),
  estado VARCHAR(20) NOT NULL DEFAULT 'activo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usuarios_email_lower
  ON academico.usuarios (LOWER(email));

CREATE INDEX IF NOT EXISTS idx_usuarios_estado_lower
  ON academico.usuarios (LOWER(estado));
```

El script tambien crea roles base equivalentes a:

```sql
INSERT INTO academico.roles (nombre, descripcion)
VALUES
  ('estudiante', 'Rol de estudiante'),
  ('docente', 'Rol de docente'),
  ('administrador', 'Rol de administrador'),
  ('admin', 'Alias de administrador')
ON CONFLICT (nombre) DO NOTHING;
```

Los nombres de rol reconocidos por el servicio son:

- `estudiante`
- `docente`
- `administrador`
- `admin`

Otros nombres funcionan, pero reciben un perfil generico con permisos basicos.

## 5. Aplicar la migracion del asset

Si ya se ejecuto `database/scripts/bootstrap_login_schema.sql`, la tabla `academico.auth_sessions` ya fue creada. Esta migracion puede ejecutarse igual porque es idempotente.

Aplicar la migracion:

```bash
psql "host=$DB_HOST port=$DB_PORT dbname=$DB_DATABASE user=$DB_USER password=$DB_PASSWORD sslmode=require" \
  -f database/migrations/V1__login_core_asset.sql
```

Esta migracion crea `academico.auth_sessions`, usada para:

- auditoria basica de sesiones;
- hash SHA-256 del refresh token;
- revocacion por logout;
- deteccion de sesiones expiradas o revocadas.

La tabla `auth_sessions` es recomendable. Si no existe, el login sigue emitiendo tokens, pero el servicio pierde persistencia de sesiones del lado servidor.

## 6. Crear usuarios

`password_hash` acepta:

- bcrypt, recomendado para produccion;
- `sha256:<hash>`;
- SHA-256 hexadecimal de 64 caracteres;
- texto plano legacy, solo para desarrollo o compatibilidad.

Ejemplo recomendado con bcrypt desde Node:

```bash
node -e "const bcrypt=require('bcryptjs'); bcrypt.hash('password123', 10).then(console.log)"
```

Insertar usuario de prueba:

```sql
INSERT INTO academico.usuarios (
  rol_id,
  nombres,
  apellidos,
  email,
  password_hash,
  identificacion,
  estado
)
SELECT
  r.id,
  'Usuario',
  'Prueba',
  'usuario@demo.com',
  '<hash-bcrypt-generado>',
  '1000000001',
  'activo'
FROM academico.roles r
WHERE r.nombre = 'estudiante'
ON CONFLICT (email) DO UPDATE SET
  rol_id = EXCLUDED.rol_id,
  nombres = EXCLUDED.nombres,
  apellidos = EXCLUDED.apellidos,
  password_hash = EXCLUDED.password_hash,
  identificacion = EXCLUDED.identificacion,
  estado = EXCLUDED.estado;
```

El repositorio tambien incluye `seed_user.cjs`, pero ese script crea usuarios con contraseña en texto plano para arranque rapido. No usarlo como patron de produccion.

## 7. Levantar el servicio en desarrollo

Instalar dependencias:

```bash
npm install
```

Generar contratos protobuf:

```bash
npm run proto:build
```

Ejecutar en modo desarrollo:

```bash
npm run start:dev
```

El servicio queda escuchando en:

```text
http://localhost:3001
```

## 8. Levantar el servicio con Docker

Construir y ejecutar:

```bash
docker compose up -d --build
```

Ver logs:

```bash
docker compose logs -f academico-login
```

Detener:

```bash
docker compose down
```

El `docker-compose.yml` publica el puerto `3001:3001` y carga variables desde `.env`.

Si la base de datos no corre dentro del mismo `docker-compose.yml`, `DB_HOST` debe ser alcanzable desde el contenedor. Usar el nombre del servicio cuando la base este en la misma red Docker, o el host/IP real cuando sea externa.

## 9. Verificar build y pruebas

Con Docker, validar que la imagen compile correctamente:

```bash
docker compose build
```

Si se quieren ejecutar pruebas sin instalar Node.js en el host, usar la etapa `builder` del `Dockerfile`:

```bash
docker build --target builder -t academico-login-test .
docker run --rm --env-file .env academico-login-test npm test
```

Si se trabaja en desarrollo local sin Docker:

```bash
npm test
npm run build
```

## 10. Validar funcionamiento

Health check:

```bash
curl http://localhost:3001/api/health
```

Login:

```bash
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "x-api-key: $LOGIN_API_KEY" \
  -d '{
    "username": "usuario@demo.com",
    "password": "password123"
  }'
```

Respuesta esperada:

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<jwt>",
  "tokenType": "Bearer",
  "expiresIn": 7200,
  "sessionId": "SESSION-...",
  "mfaRequired": false,
  "requiresAppUpdate": false
}
```

Validar token:

```bash
curl -X POST http://localhost:3001/api/v1/auth/validate-token-2 \
  -H "x-api-key: $LOGIN_API_KEY" \
  -H "Authorization: Bearer <accessToken>"
```

Renovar token:

```bash
curl -X POST http://localhost:3001/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -H "x-api-key: $LOGIN_API_KEY" \
  -d '{"refreshToken":"<refreshToken>"}'
```

Cerrar sesion:

```bash
curl -X POST http://localhost:3001/api/v1/auth/logout \
  -H "Content-Type: application/json" \
  -H "x-api-key: $LOGIN_API_KEY" \
  -d '{"refreshToken":"<refreshToken>"}'
```

## 11. Integrar con una base de datos PostgreSQL existente

Si la base existente ya tiene usuarios, hay dos caminos.

### Opcion A: adaptar la base con vistas

Crear vistas o tablas compatibles con el contrato esperado:

- `academico.roles`
- `academico.usuarios`

Esta opcion evita cambiar el codigo del servicio. Es la recomendada cuando la base sigue siendo PostgreSQL.

Ejemplo de vista para usuarios:

```sql
CREATE SCHEMA IF NOT EXISTS academico;

CREATE OR REPLACE VIEW academico.usuarios AS
SELECT
  id_usuario AS id,
  id_rol AS rol_id,
  nombres,
  apellidos,
  correo AS email,
  clave_hash AS password_hash,
  documento AS identificacion,
  estado
FROM seguridad.usuarios;
```

Ejemplo de vista para roles:

```sql
CREATE OR REPLACE VIEW academico.roles AS
SELECT
  id_rol AS id,
  nombre_rol AS nombre,
  descripcion
FROM seguridad.roles;
```

La vista debe devolver `estado = 'activo'` para usuarios habilitados o mapear el estado real a ese valor.

### Opcion B: adaptar la consulta del servicio

Modificar `findActiveUser` en `src/auth/auth.service.js` para leer las tablas reales. Mantener los alias de salida:

- `usuario_id`
- `nombres`
- `apellidos`
- `email`
- `password_hash`
- `identificacion`
- `estado`
- `rol_nombre`

Si se conservan esos alias, el resto del flujo de JWT y sesiones no necesita cambios.

## 12. Integrar con otro motor de base de datos

Para un motor diferente a PostgreSQL, crear una capa de acceso equivalente:

1. Reemplazar `src/db.js` por el cliente del motor elegido.
2. Adaptar `findActiveUser` para consultar usuarios activos y devolver los mismos alias.
3. Adaptar `registerSession`, `isSessionRevoked`, `touchSession` y `revokeSession` si se desea persistencia de sesiones.
4. Reescribir `database/migrations/V1__login_core_asset.sql` al dialecto del motor.
5. Mantener el mismo contrato de salida hacia `AuthService`.

Contrato minimo que debe devolver la consulta de usuario:

```js
{
  usuario_id: '1',
  nombres: 'Usuario',
  apellidos: 'Prueba',
  email: 'usuario@demo.com',
  password_hash: '<bcrypt>',
  identificacion: '1000000001',
  estado: 'activo',
  rol_nombre: 'estudiante'
}
```

Mientras ese contrato se cumpla, el servicio puede seguir generando el mismo payload JWT.

## 13. Integrar consumidores

Los consumidores REST deben enviar:

- `x-api-key: <LOGIN_API_KEY>`;
- `Content-Type: application/json` en peticiones con body;
- `Authorization: Bearer <accessToken>` para validacion.

Endpoints REST principales:

| Metodo | Ruta | Uso |
| --- | --- | --- |
| `POST` | `/api/v1/auth/login` | Inicia sesion |
| `POST` | `/api/v1/auth/refresh` | Renueva access token |
| `POST` | `/api/v1/auth/logout` | Revoca sesion |
| `POST` | `/api/v1/auth/validate-token` | Valida token enviado en body |
| `POST` | `/api/v1/auth/validate-token-2` | Valida token desde header `Authorization` |
| `GET` | `/api/v1/whitelist/all` | Publica rutas publicas |

El servicio tambien expone contratos ConnectRPC/gRPC definidos en `proto/auth.proto`.

## 14. Checklist de despliegue

- `.env` creado y cargado.
- `LOGIN_API_KEY` configurada y compartida solo con consumidores internos.
- `JWT_SECRET` configurado con valor seguro.
- Conexion `DB_*` validada.
- Tablas o vistas `academico.usuarios` y `academico.roles` disponibles.
- Usuarios activos con `password_hash` valido.
- Migracion `database/migrations/V1__login_core_asset.sql` aplicada.
- `npm run build` ejecuta correctamente.
- `POST /api/v1/auth/login` responde tokens.
- `POST /api/v1/auth/validate-token-2` valida el `accessToken`.
