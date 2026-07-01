import { BadRequestException, UnauthorizedException } from '@nestjs/common';
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
      message: 'Si hay una cuenta asociada a ese correo, enviaremos instrucciones en los próximos minutos. Revisa también spam o correo no deseado. Si no recibes nada, verifica que escribiste el correo correcto o contacta soporte académico.',
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
    expect(mockClient.query.mock.calls[1][1][1]).toBe(
      'estudiante@utn.edu.ec',
    );
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
    expect(mockClient.query.mock.calls.some(([query]) =>
      String(query).includes('UPDATE academico.usuarios'),
    )).toBe(false);
    expect(mockClient.release).toHaveBeenCalled();
  });
});
