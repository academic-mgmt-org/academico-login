import { BadRequestException } from '@nestjs/common';
import {
  ForgotPasswordRequestDto,
  GenericResponseDto,
  LoginResponseDto,
  LoginRequestDto,
  LogoutResponseDto,
  LogoutRequestDto,
  RefreshTokenRequestDto,
  RequestContextDto,
  ResetPasswordRequestDto,
  ValidateTokenResponseDto,
  ValidateTokenRequestDto,
} from './auth.dto';

describe('Auth DTOs', () => {
  it('normaliza LoginRequestDto y soporta aliases snake_case', () => {
    const dto = LoginRequestDto.from({
      username: ' Estudiante@UTN.EDU.EC ',
      password: 'password123',
      app_version: '1.0.0',
      password_encoding: 'plain',
    });

    expect(dto).toBeInstanceOf(LoginRequestDto);
    expect(dto).toMatchObject({
      username: 'estudiante@utn.edu.ec',
      password: 'password123',
      appVersion: '1.0.0',
      passwordEncoding: 'plain',
    });
  });

  it('rechaza LoginRequestDto sin credenciales obligatorias', () => {
    expect(() => LoginRequestDto.from({ username: 'estudiante@utn.edu.ec' }))
      .toThrow(BadRequestException);
    expect(() => LoginRequestDto.from(null)).toThrow(BadRequestException);
    expect(() =>
      LoginRequestDto.from({ username: '   ', password: 'password123' }),
    ).toThrow(BadRequestException);
  });

  it('normaliza RefreshTokenRequestDto desde camelCase y snake_case', () => {
    expect(
      RefreshTokenRequestDto.from({ refreshToken: 'refresh-1' }),
    ).toMatchObject({
      refreshToken: 'refresh-1',
    });
    expect(
      RefreshTokenRequestDto.from({ refresh_token: 'refresh-2' }),
    ).toMatchObject({
      refreshToken: 'refresh-2',
    });
    expect(RefreshTokenRequestDto.from('refresh-3')).toMatchObject({
      refreshToken: 'refresh-3',
    });
    expect(() => RefreshTokenRequestDto.from({})).toThrow(BadRequestException);
  });

  it('normaliza ForgotPasswordRequestDto y GenericResponseDto', () => {
    expect(
      ForgotPasswordRequestDto.from({ email: ' ESTUDIANTE@UTN.EDU.EC ' }),
    ).toEqual({
      email: 'estudiante@utn.edu.ec',
    });

    expect(GenericResponseDto.from({ success: true, message: 'ok' })).toEqual({
      success: true,
      message: 'ok',
    });
    const response = new GenericResponseDto({ success: true });
    expect(GenericResponseDto.from(response)).toBe(response);
  });

  it('normaliza ResetPasswordRequestDto con aliases camelCase y snake_case', () => {
    expect(
      ResetPasswordRequestDto.from({
        reset_token: ' reset-token ',
        email: ' ESTUDIANTE@UTN.EDU.EC ',
        new_password: 'password123',
        password_encoding: 'plain',
      }),
    ).toMatchObject({
      token: 'reset-token',
      email: 'estudiante@utn.edu.ec',
      newPassword: 'password123',
      passwordEncoding: 'plain',
    });
    const dto = new ResetPasswordRequestDto({
      token: 'token',
      newPassword: 'password123',
    });
    expect(ResetPasswordRequestDto.from(dto)).toBe(dto);
  });

  it('rechaza ResetPasswordRequestDto incompleto o con correo invalido', () => {
    expect(() => ResetPasswordRequestDto.from({ token: 'reset-token' }))
      .toThrow(BadRequestException);
    expect(() =>
      ResetPasswordRequestDto.from({
        token: 'reset-token',
        email: 'correo-invalido',
        newPassword: 'password123',
      }),
    ).toThrow(BadRequestException);
    expect(() => ResetPasswordRequestDto.from(null)).toThrow(
      BadRequestException,
    );
    expect(() =>
      ResetPasswordRequestDto.from({ token: '   ', newPassword: 'password123' }),
    ).toThrow(BadRequestException);
  });

  it('rechaza ForgotPasswordRequestDto invalido', () => {
    expect(() => ForgotPasswordRequestDto.from({ email: 'correo-invalido' }))
      .toThrow(BadRequestException);
    expect(ForgotPasswordRequestDto.from('DOCENTE@UTN.EDU.EC')).toEqual({
      email: 'docente@utn.edu.ec',
    });
    const dto = new ForgotPasswordRequestDto({ email: 'a@b.com' });
    expect(ForgotPasswordRequestDto.from(dto)).toBe(dto);
  });

  it('mapea LogoutRequestDto sin exigir token para permitir fallback por header', () => {
    expect(LogoutRequestDto.from({ refresh_token: 'refresh-1' })).toMatchObject({
      refreshToken: 'refresh-1',
    });
    expect(LogoutRequestDto.from({})).toBeInstanceOf(LogoutRequestDto);
    expect(LogoutRequestDto.from('access-token')).toMatchObject({
      token: 'access-token',
    });
    const dto = new LogoutRequestDto({ token: 'token' });
    expect(LogoutRequestDto.from(dto)).toBe(dto);
  });

  it('mapea ValidateTokenRequestDto y RequestContextDto', () => {
    expect(ValidateTokenRequestDto.from({ token: 'jwt-token' })).toMatchObject({
      token: 'jwt-token',
    });
    expect(
      RequestContextDto.fromHeaders({
        'x-forwarded-for': '10.0.0.1, 10.0.0.2',
        'user-agent': 'jest',
      }),
    ).toMatchObject({
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
    });
    expect(ValidateTokenRequestDto.from('jwt-token')).toMatchObject({
      token: 'jwt-token',
    });
    const dto = new ValidateTokenRequestDto({ token: 'jwt-token' });
    expect(ValidateTokenRequestDto.from(dto)).toBe(dto);
    expect(
      RequestContextDto.fromHeaders({
        'x-real-ip': '10.0.0.3',
      }),
    ).toMatchObject({
      ipAddress: '10.0.0.3',
    });
  });

  it('mapea DTOs de respuesta manteniendo instancias existentes', () => {
    const login = new LoginResponseDto({
      accessToken: 'access',
      refreshToken: 'refresh',
      mfaRequired: false,
      requiresAppUpdate: true,
    });
    expect(LoginResponseDto.from(login)).toBe(login);
    expect(LoginResponseDto.from({ tokenType: 'Bearer' })).toMatchObject({
      tokenType: 'Bearer',
      mfaRequired: false,
      requiresAppUpdate: false,
    });

    const validation = new ValidateTokenResponseDto({
      isValid: true,
      email: 'user@utn.edu.ec',
    });
    expect(ValidateTokenResponseDto.from(validation)).toBe(validation);
    expect(ValidateTokenResponseDto.from({ applications: [] })).toMatchObject({
      isValid: false,
      applications: [],
    });

    const logout = new LogoutResponseDto({
      success: true,
      revoked: true,
      message: 'ok',
    });
    expect(LogoutResponseDto.from(logout)).toBe(logout);
    expect(LogoutResponseDto.from({ success: 1 })).toMatchObject({
      success: true,
    });
  });
});
