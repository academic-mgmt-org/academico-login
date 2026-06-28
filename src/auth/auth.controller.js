import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Inject,
} from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) authService) {
    this.authService = authService;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginRequest, @Headers() headers) {
    return this.authService.login(loginRequest, this.requestContext(headers));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body) {
    const refreshToken = body?.refreshToken || body?.refresh_token;
    return this.authService.refresh(refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() body, @Headers() headers) {
    return this.authService.logout(body, headers['authorization']);
  }

  @Post('validate-token')
  @HttpCode(HttpStatus.OK)
  async validateToken(@Body('token') token) {
    const isValid = await this.authService.validateToken(token);
    return { isValid };
  }

  @Post('validate-token-2')
  @HttpCode(HttpStatus.OK)
  async validateTokenWithHeader(@Headers() headers) {
    const authorization = headers['authorization'];
    return this.authService.validateToken2(authorization);
  }

  requestContext(headers) {
    const forwardedFor = headers['x-forwarded-for'];
    const ipAddress = forwardedFor
      ? String(forwardedFor).split(',')[0].trim()
      : headers['x-real-ip'];

    return {
      ipAddress,
      userAgent: headers['user-agent'],
    };
  }
}
