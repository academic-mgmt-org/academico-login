import { BadRequestException } from '@nestjs/common';
import {
  ForgotPasswordRequestDto,
  GenericResponseDto,
  LoginRequestDto,
  LogoutRequestDto,
  RefreshTokenRequestDto,
  RequestContextDto,
  ResetPasswordRequestDto,
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
  });

  it('rechaza ForgotPasswordRequestDto invalido', () => {
    expect(() => ForgotPasswordRequestDto.from({ email: 'correo-invalido' }))
      .toThrow(BadRequestException);
  });

  it('mapea LogoutRequestDto sin exigir token para permitir fallback por header', () => {
    expect(LogoutRequestDto.from({ refresh_token: 'refresh-1' })).toMatchObject({
      refreshToken: 'refresh-1',
    });
    expect(LogoutRequestDto.from({})).toBeInstanceOf(LogoutRequestDto);
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
  });
});
