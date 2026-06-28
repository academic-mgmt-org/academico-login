import { ElizaService } from './gen/proto/eliza_pb.js';
import { AuthService as AuthRpcService } from './gen/proto/auth_pb.js';
import { AuthService as AuthDomainService } from './auth/auth.service.js';
import { ConnectError, Code } from '@connectrpc/connect';
import { readFileSync } from 'fs';
import { join } from 'path';

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

/**
 * ConnectRPC routes definitions.
 * @param {import('@connectrpc/connect').ConnectRouter} router
 * @param {import('@nestjs/common').INestApplication} app
 * @param {Function} registerServerReflectionFromUint8Array
 */
export default (router, app, registerServerReflectionFromUint8Array) => {
  const authService = app.get(AuthDomainService);

  router.service(ElizaService, {
    async say(req) {
      return {
        sentence: `You said: "${req.sentence}"`,
      };
    },

    async login(req) {
      try {
        const result = await authService.login({
          username: req.username,
          password: req.password,
          appVersion: req.appVersion,
        });
        return {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          mfaRequired: result.mfaRequired,
          requiresAppUpdate: result.requiresAppUpdate,
        };
      } catch (err) {
        throw toConnectError(err);
      }
    },
  });

  router.service(AuthRpcService, {
    async login(req) {
      try {
        const result = await authService.login({
          username: req.username,
          password: req.password,
          appVersion: req.appVersion,
          passwordEncoding: req.passwordEncoding,
        });
        return toLoginResponse(result);
      } catch (err) {
        throw toConnectError(err);
      }
    },

    async refreshToken(req) {
      try {
        const result = await authService.refresh(req.refreshToken);
        return toLoginResponse(result);
      } catch (err) {
        throw toConnectError(err);
      }
    },

    async validateToken(req) {
      try {
        const validation = await authService.validateToken2(req.token);
        return {
          isValid: validation.isValid,
          identifier: validation.identifier || '',
          email: validation.email || '',
          sessionId: validation.sessionId || '',
          userId: validation.userId || '',
          role: validation.role || '',
        };
      } catch (err) {
        throw toConnectError(err);
      }
    },

    async logout(req) {
      try {
        const result = await authService.logout({
          token: req.token,
          refreshToken: req.refreshToken,
        });
        return {
          success: result.success,
          message: result.message,
        };
      } catch (err) {
        throw toConnectError(err);
      }
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
