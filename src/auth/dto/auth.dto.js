import { BadRequestException } from '@nestjs/common';

function pickFirst(source, fields) {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      return source[field];
    }
  }

  return undefined;
}

function assignIfDefined(target, key, value) {
  if (value !== undefined) {
    target[key] = value;
  }
}

export class LoginRequestDto {
  constructor({ username, password, appVersion, passwordEncoding }) {
    this.username = username;
    this.password = password;
    assignIfDefined(this, 'appVersion', appVersion);
    assignIfDefined(this, 'passwordEncoding', passwordEncoding);
  }

  static from(value) {
    if (value instanceof LoginRequestDto) {
      return value;
    }

    if (!value || typeof value !== 'object') {
      throw new BadRequestException('Usuario y contraseña son requeridos');
    }

    const usernameValue = pickFirst(value, ['username']);
    const passwordValue = pickFirst(value, ['password']);

    if (!usernameValue || !passwordValue) {
      throw new BadRequestException('Usuario y contraseña son requeridos');
    }

    const username = String(usernameValue).trim().toLowerCase();
    const password = String(passwordValue);

    if (!username || !password) {
      throw new BadRequestException('Usuario y contraseña son requeridos');
    }

    return new LoginRequestDto({
      username,
      password,
      appVersion: pickFirst(value, ['appVersion', 'app_version']),
      passwordEncoding: pickFirst(value, [
        'passwordEncoding',
        'password_encoding',
      ]),
    });
  }
}

export class RefreshTokenRequestDto {
  constructor({ refreshToken }) {
    this.refreshToken = refreshToken;
  }

  static from(value) {
    if (value instanceof RefreshTokenRequestDto) {
      return value;
    }

    const refreshTokenValue =
      typeof value === 'string'
        ? value
        : pickFirst(value, ['refreshToken', 'refresh_token']);

    if (!refreshTokenValue) {
      throw new BadRequestException('Refresh token es requerido');
    }

    return new RefreshTokenRequestDto({
      refreshToken: String(refreshTokenValue),
    });
  }
}

export class ForgotPasswordRequestDto {
  constructor({ email }) {
    this.email = email;
  }

  static from(value = {}) {
    if (value instanceof ForgotPasswordRequestDto) {
      return value;
    }

    const emailValue =
      typeof value === 'string' ? value : pickFirst(value, ['email', 'username']);

    if (!emailValue) {
      throw new BadRequestException('Correo electronico es requerido');
    }

    const email = String(emailValue).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Correo electronico invalido');
    }

    return new ForgotPasswordRequestDto({ email });
  }
}

export class ResetPasswordRequestDto {
  constructor({ token, email, newPassword, passwordEncoding }) {
    this.token = token;
    assignIfDefined(this, 'email', email);
    this.newPassword = newPassword;
    assignIfDefined(this, 'passwordEncoding', passwordEncoding);
  }

  static from(value = {}) {
    if (value instanceof ResetPasswordRequestDto) {
      return value;
    }

    if (!value || typeof value !== 'object') {
      throw new BadRequestException('Token y nueva contraseña son requeridos');
    }

    const tokenValue = pickFirst(value, ['token', 'resetToken', 'reset_token']);
    const newPasswordValue = pickFirst(value, [
      'newPassword',
      'new_password',
      'password',
    ]);

    if (!tokenValue || !newPasswordValue) {
      throw new BadRequestException('Token y nueva contraseña son requeridos');
    }

    const token = String(tokenValue).trim();
    const newPassword = String(newPasswordValue);

    if (!token || !newPassword) {
      throw new BadRequestException('Token y nueva contraseña son requeridos');
    }

    const emailValue = pickFirst(value, ['email', 'username']);
    let email;
    if (emailValue !== undefined && emailValue !== null && emailValue !== '') {
      email = String(emailValue).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new BadRequestException('Correo electronico invalido');
      }
    }

    return new ResetPasswordRequestDto({
      token,
      email,
      newPassword,
      passwordEncoding: pickFirst(value, [
        'passwordEncoding',
        'password_encoding',
      ]),
    });
  }
}

export class LogoutRequestDto {
  constructor({ token, refreshToken }) {
    assignIfDefined(this, 'token', token);
    assignIfDefined(this, 'refreshToken', refreshToken);
  }

  static from(value = {}) {
    if (value instanceof LogoutRequestDto) {
      return value;
    }

    if (typeof value === 'string') {
      return new LogoutRequestDto({ token: value });
    }

    return new LogoutRequestDto({
      token: pickFirst(value, ['token']),
      refreshToken: pickFirst(value, ['refreshToken', 'refresh_token']),
    });
  }
}

export class ValidateTokenRequestDto {
  constructor({ token }) {
    assignIfDefined(this, 'token', token);
  }

  static from(value = {}) {
    if (value instanceof ValidateTokenRequestDto) {
      return value;
    }

    const tokenValue =
      typeof value === 'string' ? value : pickFirst(value, ['token']);

    return new ValidateTokenRequestDto({
      token: tokenValue === undefined ? undefined : String(tokenValue),
    });
  }
}

export class RequestContextDto {
  constructor({ ipAddress, userAgent }) {
    assignIfDefined(this, 'ipAddress', ipAddress);
    assignIfDefined(this, 'userAgent', userAgent);
  }

  static fromHeaders(headers = {}) {
    const forwardedFor = headers['x-forwarded-for'];
    const ipAddress = forwardedFor
      ? String(forwardedFor).split(',')[0].trim()
      : headers['x-real-ip'];

    return new RequestContextDto({
      ipAddress,
      userAgent: headers['user-agent'],
    });
  }
}

export class LoginResponseDto {
  constructor({
    accessToken,
    refreshToken,
    tokenType,
    expiresIn,
    sessionId,
    mfaRequired,
    requiresAppUpdate,
  }) {
    assignIfDefined(this, 'accessToken', accessToken);
    assignIfDefined(this, 'refreshToken', refreshToken);
    assignIfDefined(this, 'tokenType', tokenType);
    assignIfDefined(this, 'expiresIn', expiresIn);
    assignIfDefined(this, 'sessionId', sessionId);
    this.mfaRequired = Boolean(mfaRequired);
    this.requiresAppUpdate = Boolean(requiresAppUpdate);
  }

  static from(value = {}) {
    if (value instanceof LoginResponseDto) {
      return value;
    }

    return new LoginResponseDto(value);
  }
}

export class ValidateTokenResponseDto {
  constructor({
    isValid,
    identifier,
    email,
    sessionId,
    userId,
    role,
    applications,
  }) {
    this.isValid = Boolean(isValid);
    assignIfDefined(this, 'identifier', identifier);
    assignIfDefined(this, 'email', email);
    assignIfDefined(this, 'sessionId', sessionId);
    assignIfDefined(this, 'userId', userId);
    assignIfDefined(this, 'role', role);
    assignIfDefined(this, 'applications', applications);
  }

  static from(value = {}) {
    if (value instanceof ValidateTokenResponseDto) {
      return value;
    }

    return new ValidateTokenResponseDto(value);
  }
}

export class LogoutResponseDto {
  constructor({ success, revoked, message }) {
    this.success = Boolean(success);
    assignIfDefined(this, 'revoked', revoked);
    assignIfDefined(this, 'message', message);
  }

  static from(value = {}) {
    if (value instanceof LogoutResponseDto) {
      return value;
    }

    return new LogoutResponseDto(value);
  }
}

export class GenericResponseDto {
  constructor({ success, message }) {
    this.success = Boolean(success);
    assignIfDefined(this, 'message', message);
  }

  static from(value = {}) {
    if (value instanceof GenericResponseDto) {
      return value;
    }

    return new GenericResponseDto(value);
  }
}
