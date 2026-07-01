import {
  AuthService as AuthRpcService,
  HealthService as HealthRpcService,
  WhitelistService as WhitelistRpcService,
} from './gen/proto/auth_pb.js';
import { AuthService as AuthDomainService } from './auth/auth.service.js';
import { ConnectError, Code } from '@connectrpc/connect';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LoginRequestDto,
  LogoutRequestDto,
  ForgotPasswordRequestDto,
  RequestContextDto,
  RefreshTokenRequestDto,
  ResetPasswordRequestDto,
  ValidateTokenRequestDto,
} from './auth/dto/auth.dto.js';

const WHITELIST_ROUTES = [
  '/login/api/v1/auth/login',
  '/login/api/v1/auth/refresh',
  '/login/api/v1/auth/forgot-password',
  '/login/api/v1/auth/reset-password',
];

function toConnectError(err) {
  let code = Code.Internal;
  let message = err.message || 'Error interno del servidor';

  if (typeof err.getStatus === 'function') {
    const status = err.getStatus();
    if (status === 400) {
      code = Code.InvalidArgument;
    } else if (status === 401) {
      code = Code.Unauthenticated;
    } else if (status === 403) {
      code = Code.PermissionDenied;
    } else if (status === 404) {
      code = Code.NotFound;
    }
  }

  if (err.response && err.response.message) {
    message = Array.isArray(err.response.message)
      ? err.response.message.join(', ')
      : err.response.message;
  }

  return new ConnectError(message, code);
}

function toLoginResponse(result) {
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    mfaRequired: result.mfaRequired,
    requiresAppUpdate: result.requiresAppUpdate,
    tokenType: result.tokenType,
    expiresIn: result.expiresIn || 0,
    sessionId: result.sessionId,
  };
}

function getRequestHeader(context, name) {
  return context?.requestHeader?.get(name) || undefined;
}

function toRequestContext(context) {
  return RequestContextDto.fromHeaders({
    'x-forwarded-for': getRequestHeader(context, 'x-forwarded-for'),
    'x-real-ip': getRequestHeader(context, 'x-real-ip'),
    'user-agent': getRequestHeader(context, 'user-agent'),
  });
}

function toValidateTokenResponse(validation) {
  return {
    isValid: validation.isValid,
    identifier: validation.identifier || '',
    email: validation.email || '',
    sessionId: validation.sessionId || '',
    userId: validation.userId || '',
    role: validation.role || '',
    applications: (validation.applications || []).map((application) => ({
      appName: application.appName || '',
      roles: (application.roles || []).map((role) => ({
        roleName: role.roleName || '',
        permissions: role.permissions || [],
      })),
    })),
  };
}

/**
 * ConnectRPC routes definitions.
 * @param {import('@connectrpc/connect').ConnectRouter} router
 * @param {import('@nestjs/common').INestApplication} app
 * @param {Function} registerServerReflectionFromUint8Array
 */
export default (router, app, registerServerReflectionFromUint8Array) => {
  const authService = app.get(AuthDomainService);

  router.service(AuthRpcService, {
    async login(req, context) {
      try {
        const result = await authService.login(
          LoginRequestDto.from({
            username: req.username,
            password: req.password,
            appVersion: req.appVersion,
            passwordEncoding: req.passwordEncoding,
          }),
          toRequestContext(context),
        );
        return toLoginResponse(result);
      } catch (err) {
        throw toConnectError(err);
      }
    },

    async refreshToken(req) {
      try {
        const result = await authService.refresh(
          RefreshTokenRequestDto.from(req),
        );
        return toLoginResponse(result);
      } catch (err) {
        throw toConnectError(err);
      }
    },

    async forgotPassword(req, context) {
      try {
        const result = await authService.forgotPassword(
          ForgotPasswordRequestDto.from(req),
          toRequestContext(context),
        );
        return {
          success: result.success,
          message: result.message || '',
          revoked: false,
        };
      } catch (err) {
        throw toConnectError(err);
      }
    },

    async resetPassword(req) {
      try {
        const result = await authService.resetPassword(
          ResetPasswordRequestDto.from({
            token: req.token,
            email: req.email,
            newPassword: req.newPassword,
            passwordEncoding: req.passwordEncoding,
          }),
        );
        return {
          success: result.success,
          message: result.message || '',
          revoked: false,
        };
      } catch (err) {
        throw toConnectError(err);
      }
    },

    async validateToken(req) {
      try {
        const tokenRequest = ValidateTokenRequestDto.from(req);
        const validation = await authService.validateToken2(tokenRequest.token);
        return toValidateTokenResponse(validation);
      } catch (err) {
        throw toConnectError(err);
      }
    },

    async validateTokenSimple(req) {
      try {
        const tokenRequest = ValidateTokenRequestDto.from(req);
        const isValid = await authService.validateToken(tokenRequest.token);
        return { isValid };
      } catch (err) {
        throw toConnectError(err);
      }
    },

    async validateTokenWithHeader(_req, context) {
      try {
        const authorization = getRequestHeader(context, 'authorization');
        const validation = await authService.validateToken2(authorization);
        return toValidateTokenResponse(validation);
      } catch (err) {
        throw toConnectError(err);
      }
    },

    async logout(req, context) {
      try {
        const result = await authService.logout(
          LogoutRequestDto.from({
            token: req.token,
            refreshToken: req.refreshToken,
          }),
          getRequestHeader(context, 'authorization'),
        );
        return {
          success: result.success,
          message: result.message,
          revoked: Boolean(result.revoked),
        };
      } catch (err) {
        throw toConnectError(err);
      }
    },
  });

  router.service(WhitelistRpcService, {
    getAll() {
      return { routes: WHITELIST_ROUTES };
    },
  });

  router.service(HealthRpcService, {
    health() {
      return {
        status: 'healthy',
        service: 'academico-login',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };
    },

    ready() {
      return {
        ready: true,
        timestamp: new Date().toISOString(),
      };
    },

    live() {
      return {
        alive: true,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };
    },
  });

  // Registrar Reflection API utilizando el descriptor binario compilado
  try {
    let descriptorBytes;
    try {
      descriptorBytes = readFileSync(join(__dirname, 'gen/descriptor.bin'));
    } catch (e) {
      descriptorBytes = readFileSync(join(__dirname, '../gen/descriptor.bin'));
    }
    registerServerReflectionFromUint8Array(router, descriptorBytes);
  } catch (error) {
    console.error('❌ Error al registrar gRPC Server Reflection:', error);
  }
};
