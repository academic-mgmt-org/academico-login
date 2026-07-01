import {
  Inject,
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import getPool from '../db';
import { PasswordResetNotifierService } from './password-reset-notifier.service';
import {
  ForgotPasswordRequestDto,
  GenericResponseDto,
  LoginRequestDto,
  LoginResponseDto,
  LogoutRequestDto,
  LogoutResponseDto,
  RefreshTokenRequestDto,
  ResetPasswordRequestDto,
  ValidateTokenResponseDto,
} from './dto/auth.dto';

const AUTH_ERROR_MESSAGE =
  'Usuario o contraseña incorrectos. Verifique sus credenciales.';
const PASSWORD_RESET_GENERIC_MESSAGE =
  'Si hay una cuenta asociada a ese correo, enviaremos instrucciones en los próximos minutos. Revisa también spam o correo no deseado. Si no recibes nada, verifica que escribiste el correo correcto o contacta soporte académico.';
const PASSWORD_RESET_INVALID_MESSAGE =
  'Token de recuperacion invalido o expirado';
const PASSWORD_RESET_SUCCESS_MESSAGE = 'Contraseña actualizada correctamente';
const DEFAULT_ACCESS_TOKEN_TTL = '2h';
const DEFAULT_REFRESH_TOKEN_TTL = '7d';
const DEFAULT_PASSWORD_RESET_TTL_MINUTES = 30;
const DEFAULT_PASSWORD_RESET_THROTTLE_SECONDS = 60;
const DEFAULT_PASSWORD_BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
const OPTIONAL_SESSION_ERROR_CODES = new Set(['42P01', '42703', '3F000']);

@Injectable()
export class AuthService {
  constructor(
    @Inject(JwtService) jwtService,
    @Inject(PasswordResetNotifierService) passwordResetNotifier,
  ) {
    this.jwtService = jwtService;
    this.passwordResetNotifier = passwordResetNotifier;
    this.logger = new Logger(AuthService.name);
  }

  async login(loginRequest, requestContext = {}) {
    const credentials = this.normalizeLoginRequest(
      LoginRequestDto.from(loginRequest),
    );
    const pool = getPool();
    const userRow = await this.findActiveUser(pool, credentials.username);

    const passwordMatches = await this.verifyAnyPassword(
      credentials.passwordCandidates,
      userRow.password_hash,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException(AUTH_ERROR_MESSAGE);
    }

    const sessionId = this.createSessionId();
    const payload = this.buildTokenPayload(userRow, sessionId);
    const secret = this.getJwtSecret();
    const accessTokenTtl = this.getAccessTokenTtl();
    const refreshTokenTtl = this.getRefreshTokenTtl();

    const accessToken = this.jwtService.sign(payload, {
      secret,
      expiresIn: accessTokenTtl,
    });
    const refreshToken = this.jwtService.sign(
      {
        sub: payload.sub,
        identifier: payload.identifier,
        email: payload.email,
        sessionId: payload.sessionId,
        tokenUse: 'refresh',
      },
      { secret, expiresIn: refreshTokenTtl },
    );

    await this.registerSession(pool, {
      sessionId,
      userId: payload.sub,
      username: credentials.username,
      email: payload.email,
      roleName: payload.role,
      refreshToken,
      expiresAt: this.expiresAtFromTtl(refreshTokenTtl),
      userAgent: requestContext.userAgent,
      ipAddress: requestContext.ipAddress,
    });

    return LoginResponseDto.from({
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.durationToSeconds(accessTokenTtl),
      sessionId,
      mfaRequired: false,
      requiresAppUpdate: false,
    });
  }

  async refresh(refreshTokenRequest) {
    const { refreshToken } = RefreshTokenRequestDto.from(refreshTokenRequest);

    let refreshPayload;
    try {
      refreshPayload = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.getJwtSecret(),
      });
    } catch (error) {
      throw new UnauthorizedException('Refresh token invalido o expirado');
    }

    if (refreshPayload.tokenUse !== 'refresh' || !refreshPayload.sessionId) {
      throw new UnauthorizedException('Refresh token invalido o expirado');
    }

    const pool = getPool();
    const sessionRevoked = await this.isSessionRevoked(
      pool,
      refreshPayload.sessionId,
      refreshToken,
    );
    if (sessionRevoked) {
      throw new UnauthorizedException('Sesion revocada');
    }

    const userRow = await this.findActiveUser(pool, refreshPayload.email);
    const payload = this.buildTokenPayload(userRow, refreshPayload.sessionId);
    const accessTokenTtl = this.getAccessTokenTtl();
    const accessToken = this.jwtService.sign(payload, {
      secret: this.getJwtSecret(),
      expiresIn: accessTokenTtl,
    });

    await this.touchSession(pool, refreshPayload.sessionId);

    return LoginResponseDto.from({
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.durationToSeconds(accessTokenTtl),
      sessionId: refreshPayload.sessionId,
      mfaRequired: false,
      requiresAppUpdate: false,
    });
  }

  async forgotPassword(forgotPasswordRequest, requestContext = {}) {
    const request = ForgotPasswordRequestDto.from(forgotPasswordRequest);
    const response = GenericResponseDto.from({
      success: true,
      message: PASSWORD_RESET_GENERIC_MESSAGE,
    });

    const pool = getPool();
    const userRow = await this.findActiveUserForPasswordReset(
      pool,
      request.email,
    );

    if (!userRow) {
      return response;
    }

    await this.ensurePasswordResetSchema(pool);

    if (await this.isPasswordResetThrottled(pool, request.email)) {
      return response;
    }

    const rawToken = this.createPasswordResetToken();
    const tokenHash = this.sha256(rawToken);
    const expiresInMinutes = this.getPasswordResetTtlMinutes();
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    const resetUrl = this.buildPasswordResetUrl(rawToken, userRow.email);

    await this.storePasswordResetToken(pool, {
      userId: String(userRow.usuario_id),
      email: userRow.email,
      tokenHash,
      expiresAt,
      ipAddress: requestContext.ipAddress,
      userAgent: requestContext.userAgent,
    });

    this.dispatchPasswordResetEmail({
      usuarioId: String(userRow.usuario_id),
      email: userRow.email,
      nombre: this.getDisplayName(userRow),
      resetUrl,
      expiresInMinutes,
    });

    return response;
  }

  dispatchPasswordResetEmail(payload) {
    const sendPromise =
      this.passwordResetNotifier.sendPasswordResetEmail(payload);

    if (sendPromise && typeof sendPromise.catch === 'function') {
      sendPromise.catch((error) => {
        this.logger.error(
          `Error enviando correo de recuperacion: ${error.message || error}`,
        );
      });
    }
  }

  async resetPassword(resetPasswordRequest) {
    const request = ResetPasswordRequestDto.from(resetPasswordRequest);
    const newPassword = this.normalizeNewPassword(
      request.newPassword,
      request.passwordEncoding,
    );
    const passwordHash = await this.hashPassword(newPassword);
    const pool = getPool();

    await this.ensurePasswordResetSchema(pool);

    const client = await pool.connect();
    let resetTokenRow;

    try {
      await client.query('BEGIN');

      resetTokenRow = await this.consumePasswordResetToken(client, {
        tokenHash: this.sha256(request.token),
        email: request.email,
      });

      if (!resetTokenRow) {
        throw new BadRequestException(PASSWORD_RESET_INVALID_MESSAGE);
      }

      const passwordUpdated = await this.updateUserPassword(client, {
        userId: String(resetTokenRow.user_id),
        email: resetTokenRow.email,
        passwordHash,
      });

      if (!passwordUpdated) {
        throw new BadRequestException(PASSWORD_RESET_INVALID_MESSAGE);
      }

      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // Best effort rollback; preserve the original error for callers.
      }
      throw error;
    } finally {
      client.release();
    }

    await this.revokeSessionsForPayload(pool, {
      userId: String(resetTokenRow.user_id),
      email: resetTokenRow.email,
    });

    return GenericResponseDto.from({
      success: true,
      message: PASSWORD_RESET_SUCCESS_MESSAGE,
    });
  }

  async logout(logoutRequest = {}, authorization) {
    const logoutDto = LogoutRequestDto.from(logoutRequest);
    const token =
      logoutDto.refreshToken ||
      logoutDto.token ||
      this.extractBearerToken(authorization);

    if (!token) {
      throw new BadRequestException('Token es requerido para cerrar sesion');
    }

    let payload = null;
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: this.getJwtSecret(),
      });
    } catch (error) {
      return LogoutResponseDto.from({
        success: false,
        revoked: false,
        message: 'Token invalido o expirado',
      });
    }

    const revoked = await this.revokeSessionsForPayload(getPool(), payload);

    return LogoutResponseDto.from({
      success: true,
      revoked,
      message: 'Sesion cerrada correctamente',
    });
  }

  async validateToken(token) {
    if (!token) {
      return false;
    }

    const validation = await this.validateToken2(token);
    return validation.isValid;
  }

  async validateToken2(authorization) {
    const tokenToVerify = this.extractBearerToken(authorization);

    if (!tokenToVerify) {
      return ValidateTokenResponseDto.from({ isValid: false });
    }

    try {
      const payload = await this.jwtService.verifyAsync(tokenToVerify, {
        secret: this.getJwtSecret(),
      });

      if (payload.tokenUse === 'refresh') {
        return ValidateTokenResponseDto.from({ isValid: false });
      }

      if (
        payload.sessionId &&
        (await this.isSessionRevoked(getPool(), payload.sessionId))
      ) {
        return ValidateTokenResponseDto.from({ isValid: false });
      }

      return ValidateTokenResponseDto.from({
        isValid: true,
        identifier: payload.identifier,
        email: payload.email,
        sessionId: payload.sessionId,
        userId: payload.userId || payload.sub,
        role: payload.role,
        applications: payload.applications || [],
      });
    } catch (error) {
      return ValidateTokenResponseDto.from({ isValid: false });
    }
  }

  async findActiveUser(pool, email) {
    const query = `
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
      WHERE LOWER(u.email) = $1 AND LOWER(u.estado) = 'activo'
      LIMIT 1
    `;

    try {
      const { rows } = await pool.query(query, [email.toLowerCase()]);
      if (rows.length === 0) {
        throw new UnauthorizedException(AUTH_ERROR_MESSAGE);
      }
      return rows[0];
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new BadRequestException(
        'Error al consultar el usuario en la base de datos: ' + error.message,
      );
    }
  }

  async findActiveUserForPasswordReset(pool, email) {
    const query = `
      SELECT
        u.id AS usuario_id,
        u.nombres,
        u.apellidos,
        u.email,
        u.identificacion,
        u.estado
      FROM academico.usuarios u
      WHERE LOWER(u.email) = $1 AND LOWER(u.estado) = 'activo'
      LIMIT 1
    `;

    try {
      const { rows } = await pool.query(query, [email.toLowerCase()]);
      return rows[0] || null;
    } catch (error) {
      throw new BadRequestException(
        'Error al consultar el usuario en la base de datos: ' + error.message,
      );
    }
  }

  async ensurePasswordResetSchema(pool) {
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS academico;

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
    `);
  }

  async isPasswordResetThrottled(pool, email) {
    const throttleSeconds = this.getPasswordResetThrottleSeconds();
    if (throttleSeconds <= 0) {
      return false;
    }

    const { rows } = await pool.query(
      `
        SELECT 1
        FROM academico.password_reset_tokens
        WHERE LOWER(email) = $1
          AND created_at > NOW() - ($2::int * INTERVAL '1 second')
        LIMIT 1
      `,
      [email.toLowerCase(), throttleSeconds],
    );

    return rows.length > 0;
  }

  async storePasswordResetToken(pool, reset) {
    await pool.query(
      `
        UPDATE academico.password_reset_tokens
        SET used_at = COALESCE(used_at, NOW())
        WHERE LOWER(email) = $1
          AND used_at IS NULL
      `,
      [reset.email.toLowerCase()],
    );

    await pool.query(
      `
        INSERT INTO academico.password_reset_tokens (
          user_id,
          email,
          token_hash,
          request_ip,
          user_agent,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        reset.userId,
        reset.email.toLowerCase(),
        reset.tokenHash,
        reset.ipAddress || null,
        reset.userAgent || null,
        reset.expiresAt,
      ],
    );
  }

  async consumePasswordResetToken(client, reset) {
    const { rows } = await client.query(
      `
        UPDATE academico.password_reset_tokens
        SET used_at = NOW()
        WHERE token_hash = $1
          AND used_at IS NULL
          AND expires_at > NOW()
          AND ($2::text IS NULL OR LOWER(email) = LOWER($2))
        RETURNING id, user_id, email
      `,
      [reset.tokenHash, reset.email || null],
    );

    return rows[0] || null;
  }

  async updateUserPassword(client, change) {
    const { rowCount } = await client.query(
      `
        UPDATE academico.usuarios
        SET password_hash = $1
        WHERE id::text = $2
          AND LOWER(email) = LOWER($3)
          AND LOWER(estado) = 'activo'
      `,
      [change.passwordHash, change.userId, change.email],
    );

    return rowCount > 0;
  }

  normalizeLoginRequest(loginRequest) {
    if (!loginRequest || !loginRequest.username || !loginRequest.password) {
      throw new BadRequestException('Usuario y contraseña son requeridos');
    }

    const username = String(loginRequest.username).trim().toLowerCase();
    const rawPassword = String(loginRequest.password);

    if (!username || !rawPassword) {
      throw new BadRequestException('Usuario y contraseña son requeridos');
    }

    let passwordCandidates = [rawPassword];
    const requestedEncoding = loginRequest.passwordEncoding;

    if (requestedEncoding === 'base64' || this.isStrictBase64(rawPassword)) {
      try {
        const decodedPassword = Buffer.from(rawPassword, 'base64').toString(
          'utf8',
        );
        passwordCandidates =
          requestedEncoding === 'base64'
            ? [decodedPassword]
            : [decodedPassword, rawPassword];
      } catch (error) {
        throw new UnauthorizedException(AUTH_ERROR_MESSAGE);
      }
    } else if (requestedEncoding && requestedEncoding !== 'plain') {
      throw new BadRequestException('Codificacion de contraseña no soportada');
    }

    return { username, passwordCandidates };
  }

  normalizeNewPassword(rawPassword, passwordEncoding) {
    let password = String(rawPassword);
    const requestedEncoding =
      passwordEncoding === undefined || passwordEncoding === null
        ? undefined
        : String(passwordEncoding).trim().toLowerCase();

    if (requestedEncoding === 'base64') {
      try {
        password = Buffer.from(password, 'base64').toString('utf8');
      } catch (error) {
        throw new BadRequestException('Codificacion de contraseña no soportada');
      }
    } else if (requestedEncoding && requestedEncoding !== 'plain') {
      throw new BadRequestException('Codificacion de contraseña no soportada');
    }

    if (!password || !password.trim()) {
      throw new BadRequestException('Nueva contraseña es requerida');
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
      );
    }

    return password;
  }

  isStrictBase64(value) {
    const normalized = String(value).trim();
    if (!normalized || normalized.length % 4 !== 0) {
      return false;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
      return false;
    }
    try {
      return Buffer.from(normalized, 'base64').toString('base64') === normalized;
    } catch (error) {
      return false;
    }
  }

  async verifyPassword(password, storedHash) {
    if (!storedHash) {
      return false;
    }

    const stored = String(storedHash);

    if (/^\$2[aby]\$/.test(stored)) {
      try {
        return await bcrypt.compare(password, stored);
      } catch (error) {
        return false;
      }
    }

    if (stored.startsWith('sha256:')) {
      return this.safeEqual(this.sha256(password), stored.slice(7).toLowerCase());
    }

    if (/^[a-f0-9]{64}$/i.test(stored)) {
      return this.safeEqual(this.sha256(password), stored.toLowerCase());
    }

    return this.safeEqual(password, stored);
  }

  async verifyAnyPassword(passwordCandidates, storedHash) {
    for (const password of passwordCandidates) {
      if (await this.verifyPassword(password, storedHash)) {
        return true;
      }
    }

    return false;
  }

  async hashPassword(password) {
    return bcrypt.hash(password, this.getPasswordBcryptRounds());
  }

  buildTokenPayload(userRow, sessionId) {
    const identifier = userRow.identificacion || String(userRow.usuario_id);
    const roleProfile = this.getRoleProfile(userRow.rol_nombre, identifier);
    const fullName = [userRow.nombres, userRow.apellidos]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      sub: String(userRow.usuario_id),
      identifier,
      userId: String(userRow.usuario_id),
      userStudent: roleProfile.userStudent,
      userProfessor: roleProfile.userProfessor,
      userAdministrative: roleProfile.userAdministrative,
      email: userRow.email,
      userName: fullName || userRow.email,
      sessionId,
      role: roleProfile.roleName,
      permissions: roleProfile.permissions,
      applications: [
        {
          appName: roleProfile.appName,
          roles: [
            {
              roleName: roleProfile.roleName,
              permissions: roleProfile.permissions,
            },
          ],
        },
      ],
    };
  }

  getRoleProfile(roleName, identifier) {
    const role = String(roleName || 'usuario').toLowerCase();

    if (role === 'estudiante') {
      return {
        appName: 'PORTAFOLIO_ESTUDIANTE',
        roleName: 'ESTUDIANTE',
        userStudent: 'E' + identifier,
        userProfessor: null,
        userAdministrative: null,
        permissions: [
          'LEER_NOTAS',
          'CONSULTAR_HORARIOS',
          'DESCARGAR_DOCUMENTOS',
        ],
      };
    }

    if (role === 'docente') {
      return {
        appName: 'PORTAFOLIO_DOCENTE',
        roleName: 'DOCENTE',
        userStudent: null,
        userProfessor: 'D' + identifier,
        userAdministrative: null,
        permissions: ['REGISTRAR_NOTAS', 'VER_ESTUDIANTES'],
      };
    }

    if (role === 'administrador' || role === 'admin') {
      return {
        appName: 'GESTION_ACADEMICA',
        roleName: 'ADMINISTRADOR',
        userStudent: null,
        userProfessor: null,
        userAdministrative: 'A' + identifier,
        permissions: [
          'GESTIONAR_USUARIOS',
          'GESTIONAR_PARAMETROS',
          'CONSULTAR_REPORTES',
        ],
      };
    }

    return {
      appName: 'GESTION_ACADEMICA',
      roleName: role.toUpperCase(),
      userStudent: null,
      userProfessor: null,
      userAdministrative: 'A' + identifier,
      permissions: ['CONSULTAR_INFORMACION'],
    };
  }

  async registerSession(pool, session) {
    const query = `
      INSERT INTO academico.auth_sessions (
        session_id,
        user_id,
        username,
        email,
        role_name,
        refresh_token_hash,
        user_agent,
        ip_address,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (session_id) DO UPDATE SET
        refresh_token_hash = EXCLUDED.refresh_token_hash,
        last_used_at = NOW(),
        expires_at = EXCLUDED.expires_at,
        revoked_at = NULL
    `;

    try {
      await pool.query(query, [
        session.sessionId,
        session.userId,
        session.username,
        session.email,
        session.roleName,
        this.sha256(session.refreshToken),
        session.userAgent || null,
        session.ipAddress || null,
        session.expiresAt,
      ]);
    } catch (error) {
      if (this.isOptionalSessionPersistenceError(error)) {
        return;
      }
      throw error;
    }
  }

  async isSessionRevoked(pool, sessionId, refreshToken = null) {
    const query = `
      SELECT revoked_at, expires_at, refresh_token_hash
      FROM academico.auth_sessions
      WHERE session_id = $1
      LIMIT 1
    `;

    try {
      const { rows } = await pool.query(query, [sessionId]);
      if (rows.length === 0) {
        return false;
      }

      const session = rows[0];
      if (session.revoked_at) {
        return true;
      }

      if (session.expires_at && new Date(session.expires_at) <= new Date()) {
        return true;
      }

      if (
        refreshToken &&
        session.refresh_token_hash &&
        !this.safeEqual(session.refresh_token_hash, this.sha256(refreshToken))
      ) {
        return true;
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  async touchSession(pool, sessionId) {
    try {
      await pool.query(
        `
          UPDATE academico.auth_sessions
          SET last_used_at = NOW()
          WHERE session_id = $1
        `,
        [sessionId],
      );
    } catch (error) {
      if (!this.isOptionalSessionPersistenceError(error)) {
        return;
      }
    }
  }

  async revokeSession(pool, sessionId) {
    try {
      await pool.query(
        `
          UPDATE academico.auth_sessions
          SET revoked_at = NOW(), last_used_at = NOW()
          WHERE session_id = $1
        `,
        [sessionId],
      );
    } catch (error) {
      if (!this.isOptionalSessionPersistenceError(error)) {
        return;
      }
    }
  }

  async revokeSessionsForPayload(pool, payload = {}) {
    const conditions = [];
    const values = [];

    const userId = payload.userId || payload.sub;
    if (userId) {
      values.push(String(userId));
      conditions.push(`user_id = $${values.length}`);
    }

    if (payload.email) {
      values.push(String(payload.email).toLowerCase());
      conditions.push(`LOWER(email) = $${values.length}`);
    }

    if (conditions.length === 0) {
      if (payload.sessionId) {
        await this.revokeSession(pool, payload.sessionId);
        return true;
      }

      return false;
    }

    try {
      await pool.query(
        `
          UPDATE academico.auth_sessions
          SET revoked_at = NOW(), last_used_at = NOW()
          WHERE (${conditions.join(' OR ')})
            AND revoked_at IS NULL
        `,
        values,
      );
    } catch (error) {
      if (!this.isOptionalSessionPersistenceError(error)) {
        return false;
      }
    }

    return true;
  }

  extractBearerToken(authorization) {
    if (!authorization) {
      return null;
    }

    const value = String(authorization).trim();
    if (!value) {
      return null;
    }

    const [type, token] = value.split(' ');
    return type === 'Bearer' ? token : token || type;
  }

  isOptionalSessionPersistenceError(error) {
    return OPTIONAL_SESSION_ERROR_CODES.has(error?.code);
  }

  createSessionId() {
    return 'SESSION-' + randomUUID().toUpperCase();
  }

  createPasswordResetToken() {
    return randomBytes(32).toString('base64url');
  }

  buildPasswordResetUrl(token, email) {
    const baseUrl = this.getPasswordResetBaseUrl();

    if (!baseUrl) {
      throw new InternalServerErrorException(
        'BASE_URL no configurado para recuperacion de contraseña',
      );
    }

    try {
      const url = new URL('/reset-password', baseUrl);
      url.searchParams.set('token', token);
      url.searchParams.set('email', email);
      return url.toString();
    } catch (error) {
      const resetUrl = `${baseUrl.replace(/\/+$/, '')}/reset-password`;
      const separator = resetUrl.includes('?') ? '&' : '?';
      return `${resetUrl}${separator}token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    }
  }

  getPasswordResetBaseUrl() {
    const explicitBaseUrl =
      process.env.PASSWORD_RESET_BASE_URL ||
      process.env.PUBLIC_BASE_URL ||
      process.env.FRONTEND_BASE_URL;

    if (explicitBaseUrl) {
      return explicitBaseUrl;
    }

    const baseUrl = process.env.BASE_URL;
    if (!baseUrl || /^https?:\/\//i.test(baseUrl)) {
      return baseUrl;
    }

    const host = String(baseUrl).split(':')[0];
    return host ? `https://${host}` : baseUrl;
  }

  getDisplayName(userRow) {
    return (
      [userRow.nombres, userRow.apellidos].filter(Boolean).join(' ').trim() ||
      userRow.email
    );
  }

  getJwtSecret() {
    return process.env.JWT_SECRET || process.env.JWT_DOC_SECRET || 'utn-secret-key-123';
  }

  getAccessTokenTtl() {
    return process.env.JWT_ACCESS_TTL || DEFAULT_ACCESS_TOKEN_TTL;
  }

  getRefreshTokenTtl() {
    return process.env.JWT_REFRESH_TTL || DEFAULT_REFRESH_TOKEN_TTL;
  }

  getPasswordResetTtlMinutes() {
    const parsed = parseInt(
      process.env.PASSWORD_RESET_TTL_MINUTES ||
        String(DEFAULT_PASSWORD_RESET_TTL_MINUTES),
      10,
    );
    return Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, 1440)
      : DEFAULT_PASSWORD_RESET_TTL_MINUTES;
  }

  getPasswordResetThrottleSeconds() {
    const parsed = parseInt(
      process.env.PASSWORD_RESET_THROTTLE_SECONDS ||
        String(DEFAULT_PASSWORD_RESET_THROTTLE_SECONDS),
      10,
    );
    return Number.isFinite(parsed) && parsed >= 0
      ? Math.min(parsed, 3600)
      : DEFAULT_PASSWORD_RESET_THROTTLE_SECONDS;
  }

  getPasswordBcryptRounds() {
    const parsed = parseInt(
      process.env.PASSWORD_BCRYPT_ROUNDS ||
        String(DEFAULT_PASSWORD_BCRYPT_ROUNDS),
      10,
    );
    return Number.isFinite(parsed) && parsed >= 4 && parsed <= 14
      ? parsed
      : DEFAULT_PASSWORD_BCRYPT_ROUNDS;
  }

  expiresAtFromTtl(ttl) {
    const seconds =
      this.durationToSeconds(ttl) || this.durationToSeconds(DEFAULT_REFRESH_TOKEN_TTL);
    return new Date(Date.now() + seconds * 1000);
  }

  durationToSeconds(value) {
    if (typeof value === 'number') {
      return value;
    }

    const match = String(value).trim().match(/^(\d+)([smhd])?$/i);
    if (!match) {
      return null;
    }

    const amount = Number(match[1]);
    const unit = (match[2] || 's').toLowerCase();
    const multipliers = {
      s: 1,
      m: 60,
      h: 60 * 60,
      d: 24 * 60 * 60,
    };

    return amount * multipliers[unit];
  }

  sha256(value) {
    return createHash('sha256').update(String(value)).digest('hex');
  }

  safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));

    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
  }
}
