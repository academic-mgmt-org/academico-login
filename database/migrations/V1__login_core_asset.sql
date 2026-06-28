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
