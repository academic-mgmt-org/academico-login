import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { WhitelistController } from './whitelist.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || process.env.JWT_DOC_SECRET || 'utn-secret-key-123',
    }),
  ],
  controllers: [AuthController, WhitelistController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
