import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { Logger } from 'nestjs-pino';
import { config } from 'dotenv';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import { ConnectError, Code } from '@connectrpc/connect';
import connectRoutes from './connect-routes';
config();

async function bootstrap() {
  const app = await NestFactory.create(
    AppModule,
    new FastifyAdapter({
      http2: true,
    }),
    {
      bufferLogs: true,
    },
  );

  app.useLogger(app.get(Logger));
  const logger = app.get(Logger);

  // Cargar reflection dynamic import para ConnectRPC
  let registerServerReflectionFromUint8Array = null;
  try {
    const reflectModule = await Function(
      'return import("@lambdalisue/connectrpc-grpcreflect/server")',
    )();
    registerServerReflectionFromUint8Array =
      reflectModule.registerServerReflectionFromUint8Array;
    logger.log('✅ ConnectRPC Reflection Service module loaded successfully');
  } catch (error) {
    logger.warn(
      `⚠️ ConnectRPC Reflection Service module could not be loaded: ${error.message}`,
    );
  }

  const fastifyInstance = app.getHttpAdapter().getInstance();
  await fastifyInstance.register(fastifyConnectPlugin, {
    routes: (router) =>
      connectRoutes(router, app, registerServerReflectionFromUint8Array),
    interceptors: [
      (next) => async (req) => {
        // Excluir servicios de reflection y health check del requerimiento de API Key
        const serviceName = req.service?.typeName;
        if (
          serviceName === 'grpc.reflection.v1.ServerReflection' ||
          serviceName === 'grpc.reflection.v1alpha.ServerReflection' ||
          serviceName === 'grpc.health.v1.Health' ||
          serviceName === 'auth.v1.HealthService'
        ) {
          return await next(req);
        }

        const apiKey = req.header.get('x-api-key');
        const expectedApiKey = process.env.LOGIN_API_KEY;
        if (!apiKey || apiKey !== expectedApiKey) {
          throw new ConnectError(
            'Acceso no autorizado: API Key inválida o no provista',
            Code.Unauthenticated,
          );
        }
        return await next(req);
      },
    ],
  });

  app.enableCors({
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Authorization,x-api-key',
  });

  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');
  logger.log(
    `🚀 Microservicio academico-login corriendo en puerto ${port} (HTTP/2 Fastify habilitado)`,
  );
}
bootstrap();
