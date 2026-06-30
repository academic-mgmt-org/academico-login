import { UnauthorizedException } from '@nestjs/common';
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
  let jwtService;
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

    mockPool = {
      query: jest.fn(),
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

    service = new AuthService(jwtService);
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
});
