import { BadRequestException } from '@nestjs/common';
import {
  LoginRequestDto,
  LogoutRequestDto,
  RefreshTokenRequestDto,
  RequestContextDto,
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
