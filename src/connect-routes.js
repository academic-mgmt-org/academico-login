import { ElizaService } from './gen/proto/eliza_pb.js';
import { AuthService } from './auth/auth.service.js';
import { ConnectError, Code } from '@connectrpc/connect';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * ConnectRPC routes definitions.
 * @param {import('@connectrpc/connect').ConnectRouter} router
 * @param {import('@nestjs/common').INestApplication} app
 * @param {Function} registerServerReflectionFromUint8Array
 */
export default (router, app, registerServerReflectionFromUint8Array) => {
  const authService = app.get(AuthService);

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

        throw new ConnectError(message, code);
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
