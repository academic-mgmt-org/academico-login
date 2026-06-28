import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || process.env.JWT_DOC_SECRET || 'utn-secret-key-123',
    }),
  ],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
