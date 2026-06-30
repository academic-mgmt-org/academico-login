-- Bootstrap schema for academico-login.
-- Use this script when the target PostgreSQL database does not already have
-- the minimum tables required by the login service.
--
-- Usage:
--   psql "host=$DB_HOST port=$DB_PORT dbname=$DB_DATABASE user=$DB_USER password=$DB_PASSWORD sslmode=require" \
--     -f database/scripts/bootstrap_login_schema.sql

BEGIN;

CREATE SCHEMA IF NOT EXISTS academico;

CREATE TABLE IF NOT EXISTS academico.roles (
  id BIGSERIAL PRIMARY KEY,
  nombre VARCHAR(80) NOT NULL UNIQUE,
  descripcion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

CREATE TABLE IF NOT EXISTS academico.auth_sessions (
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

CREATE TABLE IF NOT EXISTS academico.password_reset_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  email VARCHAR(150) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  request_ip VARCHAR(64),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_roles_nombre_lower
  ON academico.roles (LOWER(nombre));

CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_email_lower
  ON academico.usuarios (LOWER(email));

CREATE INDEX IF NOT EXISTS idx_usuarios_rol_id
  ON academico.usuarios (rol_id);

CREATE INDEX IF NOT EXISTS idx_usuarios_estado_lower
  ON academico.usuarios (LOWER(estado));

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
  ON academico.auth_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_email
  ON academico.auth_sessions (email);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
  ON academico.auth_sessions (session_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email
  ON academico.password_reset_tokens (LOWER(email));

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_active
  ON academico.password_reset_tokens (token_hash, expires_at)
  WHERE used_at IS NULL;

INSERT INTO academico.roles (nombre, descripcion)
SELECT seed.nombre, seed.descripcion
FROM (
  VALUES
    ('estudiante', 'Rol de estudiante'),
    ('docente', 'Rol de docente'),
    ('administrador', 'Rol de administrador'),
    ('admin', 'Alias de administrador')
) AS seed(nombre, descripcion)
WHERE NOT EXISTS (
  SELECT 1
  FROM academico.roles roles
  WHERE LOWER(roles.nombre) = LOWER(seed.nombre)
);

-- Test users for a first login validation.
-- Passwords:
--   estudiante@demo.com     / password123
--   docente@demo.com        / password123
--   administrador@demo.com  / admin123
--
-- Replace or remove these users before using the database in production.
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
  roles.id,
  seed.nombres,
  seed.apellidos,
  seed.email,
  seed.password_hash,
  seed.identificacion,
  'activo'
FROM (
  VALUES
    (
      'estudiante',
      'Estudiante',
      'Demo',
      'estudiante@demo.com',
      '$2b$10$UdNmOU/um2n9IVtcRU80rOHAU.osv.FI8WhwxXXvsel1P6ZJaHpcm',
      '1000000001'
    ),
    (
      'docente',
      'Docente',
      'Demo',
      'docente@demo.com',
      '$2b$10$UdNmOU/um2n9IVtcRU80rOHAU.osv.FI8WhwxXXvsel1P6ZJaHpcm',
      '1000000002'
    ),
    (
      'administrador',
      'Administrador',
      'Demo',
      'administrador@demo.com',
      '$2b$10$7bzwc5LZaJd5wQHL1BTyPugGsA6nivnNxaHw9pDOv1IDVvfItsmra',
      '1000000003'
    )
) AS seed(
  rol_nombre,
  nombres,
  apellidos,
  email,
  password_hash,
  identificacion
)
INNER JOIN academico.roles roles
  ON LOWER(roles.nombre) = seed.rol_nombre
ON CONFLICT (email) DO UPDATE SET
  rol_id = EXCLUDED.rol_id,
  nombres = EXCLUDED.nombres,
  apellidos = EXCLUDED.apellidos,
  password_hash = EXCLUDED.password_hash,
  identificacion = EXCLUDED.identificacion,
  estado = EXCLUDED.estado;

COMMENT ON TABLE academico.roles IS
  'Roles academicos usados por academico-login para construir el perfil del JWT.';

COMMENT ON TABLE academico.usuarios IS
  'Usuarios autenticables por academico-login. El servicio solo lee esta tabla para validar credenciales.';

COMMENT ON COLUMN academico.usuarios.password_hash IS
  'Hash de password. academico-login soporta bcrypt, sha256:<hash>, SHA-256 hexadecimal y texto plano legacy.';

COMMENT ON TABLE academico.auth_sessions IS
  'Sesiones emitidas por academico-login para revocacion y auditoria basica de refresh tokens.';

COMMENT ON COLUMN academico.auth_sessions.refresh_token_hash IS
  'Hash SHA-256 del refresh token. El token completo nunca se almacena en base de datos.';

COMMENT ON TABLE academico.password_reset_tokens IS
  'Tokens de recuperacion de contraseña emitidos por academico-login. Solo se almacena hash SHA-256 del token.';

COMMIT;
