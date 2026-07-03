import {
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import getPool from '../db';
import { AuthService } from './auth.service';

jest.mock('../db', () => ({
  __esModule: true,
  default: jest.fn(),
}));

describe('AuthService', () => {
  const originalEnv = { ...process.env };
  let mockPool;
  let mockClient;
  let jwtService;
  let passwordResetNotifier;
  let service;

  const userRow = {
    usuario_id: 'user-1',
    nombres: 'Estudiante',
    apellidos: 'Prueba',
    email: 'estudiante@utn.edu.ec',
    password_hash: 'password123',
    identificacion: '1000000001',
    estado: 'activo',
    rol_nombre: 'estudiante',
  };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'test-secret',
      JWT_ACCESS_TTL: '2h',
      JWT_REFRESH_TTL: '7d',
    };

    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };

    mockPool = {
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(mockClient),
    };
    getPool.mockReturnValue(mockPool);

    jwtService = {
      sign: jest.fn((payload) =>
        payload.tokenUse === 'refresh'
          ? `refresh-${payload.sessionId}`
          : `access-${payload.sessionId}`,
      ),
      verifyAsync: jest.fn(),
    };

    passwordResetNotifier = {
      sendPasswordResetEmail: jest.fn().mockResolvedValue({
        success: true,
        provider: 'log',
        messageId: 'msg-1',
      }),
    };

    service = new AuthService(jwtService, passwordResetNotifier);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('autentica credenciales Base64 y emite tokens con datos de estudiante', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [userRow] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await service.login(
      {
        username: ' Estudiante@UTN.EDU.EC ',
        password: Buffer.from('password123', 'utf8').toString('base64'),
      },
      { userAgent: 'jest', ipAddress: '127.0.0.1' },
    );

    expect(result.accessToken).toMatch(/^access-SESSION-/);
    expect(result.refreshToken).toMatch(/^refresh-SESSION-/);
    expect(result.expiresIn).toBe(7200);
    expect(mockPool.query.mock.calls[0][1]).toEqual(['estudiante@utn.edu.ec']);
    expect(mockPool.query.mock.calls[1][0]).toContain(
      'INSERT INTO academico.auth_sessions',
    );
    expect(jwtService.sign.mock.calls[0][0]).toMatchObject({
      identifier: '1000000001',
      userStudent: 'E1000000001',
      role: 'ESTUDIANTE',
    });
  });

  it('soporta password_hash con bcrypt', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            ...userRow,
            password_hash: bcrypt.hashSync('password123', 4),
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await service.login({
      username: 'estudiante@utn.edu.ec',
      password: 'password123',
    });

    expect(result.accessToken).toMatch(/^access-SESSION-/);
  });

  it('rechaza credenciales incorrectas', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [userRow] });

    await expect(
      service.login({
        username: 'estudiante@utn.edu.ec',
        password: 'incorrecta',
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it('valida tokens Bearer y devuelve la identidad minima para el gateway', async () => {
    jwtService.verifyAsync.mockResolvedValueOnce({
      sub: 'user-1',
      identifier: '1000000001',
      email: 'estudiante@utn.edu.ec',
      sessionId: 'SESSION-1',
      role: 'ESTUDIANTE',
      applications: [],
    });
    mockPool.query.mockRejectedValueOnce(
      Object.assign(new Error('missing table'), { code: '42P01' }),
    );

    await expect(service.validateToken2('Bearer jwt-token')).resolves.toEqual({
      isValid: true,
      identifier: '1000000001',
      email: 'estudiante@utn.edu.ec',
      sessionId: 'SESSION-1',
      userId: 'user-1',
      role: 'ESTUDIANTE',
      applications: [],
    });
  });

  it('cierra todas las sesiones activas del usuario al hacer logout', async () => {
    jwtService.verifyAsync.mockResolvedValueOnce({
      sub: 'user-1',
      email: 'estudiante@utn.edu.ec',
      sessionId: 'SESSION-LOGOUT',
      tokenUse: 'refresh',
    });
    mockPool.query.mockResolvedValueOnce({ rowCount: 3 });

    await expect(
      service.logout({ refreshToken: 'refresh-SESSION-LOGOUT' }),
    ).resolves.toMatchObject({
      success: true,
      revoked: true,
      message: 'Sesion cerrada correctamente',
    });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE academico.auth_sessions'),
      ['user-1', 'estudiante@utn.edu.ec'],
    );
    expect(mockPool.query.mock.calls[0][0]).toContain('user_id = $1');
    expect(mockPool.query.mock.calls[0][0]).toContain('LOWER(email) = $2');
  });

  it('solicita recuperacion de contraseña sin revelar si el correo no existe', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.forgotPassword({ email: 'desconocido@utn.edu.ec' }),
    ).resolves.toMatchObject({
      success: true,
      message:
        'Si hay una cuenta asociada a ese correo, enviaremos instrucciones en los próximos minutos. Revisa también spam o correo no deseado. Si no recibes nada, verifica que escribiste el correo correcto o contacta soporte académico.',
    });

    expect(passwordResetNotifier.sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('genera token hasheado y delega envio de correo de recuperacion', async () => {
    process.env.BASE_URL = 'https://academico.test';
    process.env.PASSWORD_RESET_TTL_MINUTES = '45';
    process.env.PASSWORD_RESET_THROTTLE_SECONDS = '60';

    mockPool.query
      .mockResolvedValueOnce({ rows: [userRow] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await expect(
      service.forgotPassword(
        { email: ' Estudiante@UTN.EDU.EC ' },
        { ipAddress: '127.0.0.1', userAgent: 'jest' },
      ),
    ).resolves.toMatchObject({
      success: true,
    });

    const insertParams = mockPool.query.mock.calls[4][1];
    expect(insertParams[0]).toBe('user-1');
    expect(insertParams[1]).toBe('estudiante@utn.edu.ec');
    expect(insertParams[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(insertParams[3]).toBe('127.0.0.1');
    expect(insertParams[4]).toBe('jest');

    expect(passwordResetNotifier.sendPasswordResetEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        usuarioId: 'user-1',
        email: 'estudiante@utn.edu.ec',
        nombre: 'Estudiante Prueba',
        expiresInMinutes: 45,
      }),
    );
    expect(
      passwordResetNotifier.sendPasswordResetEmail.mock.calls[0][0].resetUrl,
    ).toContain('https://academico.test/reset-password?token=');
  });

  it('no bloquea la respuesta si falla el envio asincrono de correo', async () => {
    process.env.BASE_URL = 'https://academico.test';
    service.logger.error = jest.fn();
    passwordResetNotifier.sendPasswordResetEmail.mockRejectedValueOnce(
      new Error('provider timeout'),
    );

    mockPool.query
      .mockResolvedValueOnce({ rows: [userRow] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await expect(
      service.forgotPassword({ email: 'estudiante@utn.edu.ec' }),
    ).resolves.toMatchObject({
      success: true,
    });

    expect(passwordResetNotifier.sendPasswordResetEmail).toHaveBeenCalled();

    await Promise.resolve();

    expect(service.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('provider timeout'),
    );
  });

  it('restablece contraseña con token de recuperacion y revoca sesiones', async () => {
    process.env.PASSWORD_BCRYPT_ROUNDS = '4';

    mockPool.query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 2 });
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'reset-1',
            user_id: 'user-1',
            email: 'estudiante@utn.edu.ec',
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await expect(
      service.resetPassword({
        token: 'reset-token',
        email: 'estudiante@utn.edu.ec',
        newPassword: 'nuevaPassword123',
      }),
    ).resolves.toMatchObject({
      success: true,
      message: 'Contraseña actualizada correctamente',
    });

    expect(mockPool.query.mock.calls[0][0]).toContain(
      'CREATE TABLE IF NOT EXISTS academico.password_reset_tokens',
    );
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query.mock.calls[1][0]).toContain(
      'UPDATE academico.password_reset_tokens',
    );
    expect(mockClient.query.mock.calls[1][1][1]).toBe('estudiante@utn.edu.ec');
    expect(mockClient.query.mock.calls[2][0]).toContain(
      'UPDATE academico.usuarios',
    );

    const updatePasswordParams = mockClient.query.mock.calls[2][1];
    expect(updatePasswordParams[1]).toBe('user-1');
    expect(updatePasswordParams[2]).toBe('estudiante@utn.edu.ec');
    await expect(
      bcrypt.compare('nuevaPassword123', updatePasswordParams[0]),
    ).resolves.toBe(true);

    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
    expect(mockPool.query.mock.calls[1][0]).toContain(
      'UPDATE academico.auth_sessions',
    );
    expect(mockPool.query.mock.calls[1][1]).toEqual([
      'user-1',
      'estudiante@utn.edu.ec',
    ]);
  });

  it('rechaza reset de contraseña con token invalido y hace rollback', async () => {
    process.env.PASSWORD_BCRYPT_ROUNDS = '4';

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });

    await expect(
      service.resetPassword({
        token: 'reset-token-invalido',
        newPassword: 'nuevaPassword123',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(
      mockClient.query.mock.calls.some(([query]) =>
        String(query).includes('UPDATE academico.usuarios'),
      ),
    ).toBe(false);
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('renueva access token cuando el refresh token y la sesion son validos', async () => {
    jwtService.verifyAsync.mockResolvedValueOnce({
      sub: 'user-1',
      email: 'estudiante@utn.edu.ec',
      sessionId: 'SESSION-REFRESH',
      tokenUse: 'refresh',
    });
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            revoked_at: null,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            refresh_token_hash: service.sha256('refresh-token'),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [userRow] })
      .mockResolvedValueOnce({ rowCount: 1 });

    await expect(
      service.refresh({ refreshToken: 'refresh-token' }),
    ).resolves.toMatchObject({
      accessToken: 'access-SESSION-REFRESH',
      refreshToken: 'refresh-token',
      sessionId: 'SESSION-REFRESH',
    });

    expect(mockPool.query.mock.calls[2][0]).toContain(
      'UPDATE academico.auth_sessions',
    );
  });

  it('rechaza refresh token expirado, de uso incorrecto o sesion revocada', async () => {
    jwtService.verifyAsync.mockRejectedValueOnce(new Error('expired'));

    await expect(service.refresh({ refreshToken: 'expired' })).rejects.toThrow(
      UnauthorizedException,
    );

    jwtService.verifyAsync.mockResolvedValueOnce({
      tokenUse: 'access',
      sessionId: 'SESSION-1',
    });
    await expect(
      service.refresh({ refreshToken: 'access-token' }),
    ).rejects.toThrow(UnauthorizedException);

    jwtService.verifyAsync.mockResolvedValueOnce({
      tokenUse: 'refresh',
      sessionId: 'SESSION-2',
      email: 'estudiante@utn.edu.ec',
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          revoked_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          refresh_token_hash: service.sha256('refresh-token'),
        },
      ],
    });

    await expect(
      service.refresh({ refreshToken: 'refresh-token' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('valida token simple y rechaza token ausente, refresh token, sesion revocada y errores JWT', async () => {
    await expect(service.validateToken('')).resolves.toBe(false);

    jwtService.verifyAsync.mockResolvedValueOnce({
      tokenUse: 'refresh',
      sessionId: 'SESSION-REFRESH',
    });
    await expect(service.validateToken('refresh-token')).resolves.toBe(false);

    jwtService.verifyAsync.mockResolvedValueOnce({
      sub: 'user-1',
      email: 'estudiante@utn.edu.ec',
      sessionId: 'SESSION-REVOKED',
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          revoked_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          refresh_token_hash: null,
        },
      ],
    });
    await expect(service.validateToken2('Bearer jwt-token')).resolves.toEqual({
      isValid: false,
    });

    jwtService.verifyAsync.mockRejectedValueOnce(new Error('bad token'));
    await expect(service.validateToken2('bad-token')).resolves.toEqual({
      isValid: false,
    });
  });

  it('cubre perfiles de rol y payload JWT para docente, administrador y usuario generico', () => {
    expect(service.getRoleProfile('docente', '1002')).toMatchObject({
      appName: 'PORTAFOLIO_DOCENTE',
      roleName: 'DOCENTE',
      userProfessor: 'D1002',
    });
    expect(service.getRoleProfile('admin', '1003')).toMatchObject({
      appName: 'GESTION_ACADEMICA',
      roleName: 'ADMINISTRADOR',
      userAdministrative: 'A1003',
    });
    expect(service.getRoleProfile('invitado', '1004')).toMatchObject({
      roleName: 'INVITADO',
      userAdministrative: 'A1004',
      permissions: ['CONSULTAR_INFORMACION'],
    });

    expect(
      service.buildTokenPayload(
        {
          ...userRow,
          nombres: '',
          apellidos: '',
          identificacion: '',
          rol_nombre: 'docente',
        },
        'SESSION-PAYLOAD',
      ),
    ).toMatchObject({
      sub: 'user-1',
      identifier: 'user-1',
      userName: 'estudiante@utn.edu.ec',
      userProfessor: 'Duser-1',
      role: 'DOCENTE',
      sessionId: 'SESSION-PAYLOAD',
    });
  });

  it('cubre normalizacion de passwords, encoding y comparacion de hashes', async () => {
    expect(
      service.normalizeLoginRequest({
        username: 'USER@UTN.EDU.EC',
        password: Buffer.from('password123').toString('base64'),
        passwordEncoding: 'base64',
      }),
    ).toEqual({
      username: 'user@utn.edu.ec',
      passwordCandidates: ['password123'],
    });
    expect(() =>
      service.normalizeLoginRequest({
        username: 'user@utn.edu.ec',
        password: 'password123',
        passwordEncoding: 'rot13',
      }),
    ).toThrow(BadRequestException);
    expect(
      service.normalizeNewPassword(
        Buffer.from('abcd1234').toString('base64'),
        'base64',
      ),
    ).toBe('abcd1234');
    expect(() => service.normalizeNewPassword('', 'plain')).toThrow(
      BadRequestException,
    );
    expect(() => service.normalizeNewPassword('short', 'plain')).toThrow(
      BadRequestException,
    );
    expect(() => service.normalizeNewPassword('abcd1234', 'rot13')).toThrow(
      BadRequestException,
    );

    expect(service.isStrictBase64('not-base64')).toBe(false);
    expect(await service.verifyPassword('password123', '')).toBe(false);
    expect(
      await service.verifyPassword(
        'password123',
        'sha256:' + service.sha256('password123'),
      ),
    ).toBe(true);
    expect(
      await service.verifyPassword(
        'password123',
        service.sha256('password123'),
      ),
    ).toBe(true);
    expect(await service.verifyPassword('password123', 'password123')).toBe(
      true,
    );
    expect(service.safeEqual('a', 'ab')).toBe(false);
  });

  it('maneja consultas de usuario, errores de base y throttling de reset', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      service.findActiveUser(mockPool, 'missing@utn.edu.ec'),
    ).rejects.toThrow(UnauthorizedException);

    mockPool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.findActiveUser(mockPool, 'estudiante@utn.edu.ec'),
    ).rejects.toThrow(BadRequestException);

    mockPool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.findActiveUserForPasswordReset(mockPool, 'estudiante@utn.edu.ec'),
    ).rejects.toThrow(BadRequestException);

    process.env.PASSWORD_RESET_THROTTLE_SECONDS = '0';
    await expect(
      service.isPasswordResetThrottled(mockPool, 'estudiante@utn.edu.ec'),
    ).resolves.toBe(false);

    process.env.PASSWORD_RESET_THROTTLE_SECONDS = '60';
    mockPool.query.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    await expect(
      service.isPasswordResetThrottled(mockPool, 'estudiante@utn.edu.ec'),
    ).resolves.toBe(true);
  });

  it('maneja persistencia opcional de sesiones y estados de revocacion', async () => {
    mockPool.query.mockRejectedValueOnce(
      Object.assign(new Error('missing table'), { code: '42P01' }),
    );
    await expect(
      service.registerSession(mockPool, {
        sessionId: 'SESSION-1',
        userId: 'user-1',
        username: 'estudiante@utn.edu.ec',
        email: 'estudiante@utn.edu.ec',
        roleName: 'ESTUDIANTE',
        refreshToken: 'refresh-token',
        expiresAt: new Date(),
      }),
    ).resolves.toBeUndefined();

    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(service.isSessionRevoked(mockPool, 'SESSION-1')).resolves.toBe(
      false,
    );

    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          revoked_at: null,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
          refresh_token_hash: null,
        },
      ],
    });
    await expect(service.isSessionRevoked(mockPool, 'SESSION-1')).resolves.toBe(
      true,
    );

    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          revoked_at: null,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          refresh_token_hash: service.sha256('other-refresh'),
        },
      ],
    });
    await expect(
      service.isSessionRevoked(mockPool, 'SESSION-1', 'refresh-token'),
    ).resolves.toBe(true);

    mockPool.query.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(service.isSessionRevoked(mockPool, 'SESSION-1')).resolves.toBe(
      false,
    );
  });

  it('actualiza, revoca y calcula sesiones con fallos tolerados', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(
      service.touchSession(mockPool, 'SESSION-1'),
    ).resolves.toBeUndefined();

    mockPool.query.mockRejectedValueOnce(
      Object.assign(new Error('missing column'), { code: '42703' }),
    );
    await expect(
      service.revokeSession(mockPool, 'SESSION-1'),
    ).resolves.toBeUndefined();

    service.revokeSession = jest.fn().mockResolvedValue(undefined);
    await expect(
      service.revokeSessionsForPayload(mockPool, { sessionId: 'SESSION-ONLY' }),
    ).resolves.toBe(true);
    expect(service.revokeSession).toHaveBeenCalledWith(
      mockPool,
      'SESSION-ONLY',
    );

    await expect(service.revokeSessionsForPayload(mockPool, {})).resolves.toBe(
      false,
    );

    mockPool.query.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(
      service.revokeSessionsForPayload(mockPool, { email: 'USER@UTN.EDU.EC' }),
    ).resolves.toBe(false);
  });

  it('cubre helpers de URLs, tiempos y secretos', () => {
    process.env.PASSWORD_RESET_BASE_URL = 'https://reset.test/base';
    expect(service.buildPasswordResetUrl('token 1', 'user@utn.edu.ec')).toBe(
      'https://reset.test/reset-password?token=token+1&email=user%40utn.edu.ec',
    );

    delete process.env.PASSWORD_RESET_BASE_URL;
    process.env.BASE_URL = 'academico.test:50050';
    expect(service.getPasswordResetBaseUrl()).toBe('https://academico.test');

    delete process.env.BASE_URL;
    expect(() =>
      service.buildPasswordResetUrl('token', 'user@utn.edu.ec'),
    ).toThrow(InternalServerErrorException);

    process.env.JWT_SECRET = '';
    process.env.JWT_DOC_SECRET = 'doc-secret';
    expect(service.getJwtSecret()).toBe('doc-secret');

    process.env.JWT_ACCESS_TTL = '';
    process.env.JWT_REFRESH_TTL = '';
    expect(service.getAccessTokenTtl()).toBe('2h');
    expect(service.getRefreshTokenTtl()).toBe('7d');

    process.env.PASSWORD_RESET_TTL_MINUTES = '5000';
    process.env.PASSWORD_RESET_THROTTLE_SECONDS = '9999';
    process.env.PASSWORD_BCRYPT_ROUNDS = '99';
    expect(service.getPasswordResetTtlMinutes()).toBe(1440);
    expect(service.getPasswordResetThrottleSeconds()).toBe(3600);
    expect(service.getPasswordBcryptRounds()).toBe(12);
    expect(service.durationToSeconds('15m')).toBe(900);
    expect(service.durationToSeconds('2h')).toBe(7200);
    expect(service.durationToSeconds('1d')).toBe(86400);
    expect(service.durationToSeconds('bad')).toBeNull();
    expect(service.expiresAtFromTtl('bad')).toBeInstanceOf(Date);
  });

  it('hace rollback si falla la actualizacion de contraseña', async () => {
    process.env.PASSWORD_BCRYPT_ROUNDS = '4';

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'reset-1',
            user_id: 'user-1',
            email: 'estudiante@utn.edu.ec',
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await expect(
      service.resetPassword({
        token: 'reset-token',
        email: 'estudiante@utn.edu.ec',
        newPassword: 'nuevaPassword123',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });
});
