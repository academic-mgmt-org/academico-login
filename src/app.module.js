import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule, Logger } from 'nestjs-pino';
import { pinoLoggerConfig } from './config/pino-logger.config';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { APP_FILTER } from '@nestjs/core';
import { HealthController } from './controller/health.controller';
import { AuthModule } from './auth/auth.module';
import { ApiKeyMiddleware } from './middleware/api-key.middleware';

@Module({
  imports: [
    LoggerModule.forRoot(pinoLoggerConfig),
    ConfigModule.forRoot({
      envFilePath: '.env',
      isGlobal: true
    }),
    AuthModule
  ],
  controllers: [HealthController],
  providers: [
    Logger,
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter
    }
  ]
})
export class AppModule {
  configure(consumer) {
    consumer
      .apply(ApiKeyMiddleware)
      .exclude('/api/health', '/api/ready', '/api/live')
      .forRoutes('*');
  }
}
