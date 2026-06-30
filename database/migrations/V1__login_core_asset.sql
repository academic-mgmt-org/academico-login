CREATE SCHEMA IF NOT EXISTS academico;

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

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
  ON academico.auth_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_email
  ON academico.auth_sessions (email);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
  ON academico.auth_sessions (session_id, expires_at)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE academico.auth_sessions IS
  'Sesiones emitidas por el Core Asset academico-login para revocacion y auditoria basica de refresh tokens.';

COMMENT ON COLUMN academico.auth_sessions.refresh_token_hash IS
  'Hash SHA-256 del refresh token. El token completo nunca se almacena en base de datos.';

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

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email
  ON academico.password_reset_tokens (LOWER(email));

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_active
  ON academico.password_reset_tokens (token_hash, expires_at)
  WHERE used_at IS NULL;

COMMENT ON TABLE academico.password_reset_tokens IS
  'Tokens de recuperacion de contraseña emitidos por academico-login. Solo se almacena hash SHA-256 del token.';
