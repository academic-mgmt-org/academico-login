import {
  Inject,
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import getPool from '../db';
import {
  LoginRequestDto,
  LoginResponseDto,
  LogoutRequestDto,
  LogoutResponseDto,
  RefreshTokenRequestDto,
  ValidateTokenResponseDto,
} from './dto/auth.dto';

const AUTH_ERROR_MESSAGE =
  'Usuario o contraseña incorrectos. Verifique sus credenciales.';
const DEFAULT_ACCESS_TOKEN_TTL = '2h';
const DEFAULT_REFRESH_TOKEN_TTL = '7d';
const OPTIONAL_SESSION_ERROR_CODES = new Set(['42P01', '42703', '3F000']);

@Injectable()
export class AuthService {
  constructor(@Inject(JwtService) jwtService) {
    this.jwtService = jwtService;
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

    if (payload.sessionId) {
      await this.revokeSession(getPool(), payload.sessionId);
    }

    return LogoutResponseDto.from({
      success: true,
      revoked: Boolean(payload.sessionId),
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

  getJwtSecret() {
    return process.env.JWT_SECRET || process.env.JWT_DOC_SECRET || 'utn-secret-key-123';
  }

  getAccessTokenTtl() {
    return process.env.JWT_ACCESS_TTL || DEFAULT_ACCESS_TOKEN_TTL;
  }

  getRefreshTokenTtl() {
    return process.env.JWT_REFRESH_TTL || DEFAULT_REFRESH_TOKEN_TTL;
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
