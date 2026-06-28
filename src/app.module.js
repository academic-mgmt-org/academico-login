import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule, Logger } from 'nestjs-pino';
import { pinoLoggerConfig } from './config/pino-logger.config';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    LoggerModule.forRoot(pinoLoggerConfig),
    ConfigModule.forRoot({
      envFilePath: '.env',
      isGlobal: true
    }),
    AuthModule
  ],
  providers: [
    Logger,
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter
    }
  ]
})
export class AppModule {}
