import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Inject } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) authService) {
    this.authService = authService;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginRequest) {
    return this.authService.login(loginRequest);
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
}
