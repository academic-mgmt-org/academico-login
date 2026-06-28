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
import {
  LoginRequestDto,
  LoginResponseDto,
  LogoutRequestDto,
  LogoutResponseDto,
  RefreshTokenRequestDto,
  RequestContextDto,
  ValidateTokenRequestDto,
  ValidateTokenResponseDto,
} from './dto/auth.dto';

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) authService) {
    this.authService = authService;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginRequest, @Headers() headers) {
    const result = await this.authService.login(
      LoginRequestDto.from(loginRequest),
      this.requestContext(headers),
    );
    return LoginResponseDto.from(result);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body) {
    const result = await this.authService.refresh(
      RefreshTokenRequestDto.from(body),
    );
    return LoginResponseDto.from(result);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() body, @Headers() headers) {
    const result = await this.authService.logout(
      LogoutRequestDto.from(body),
      headers['authorization'],
    );
    return LogoutResponseDto.from(result);
  }

  @Post('validate-token')
  @HttpCode(HttpStatus.OK)
  async validateToken(@Body() body) {
    const tokenRequest = ValidateTokenRequestDto.from(body);
    const isValid = await this.authService.validateToken(tokenRequest.token);
    return ValidateTokenResponseDto.from({ isValid });
  }

  @Post('validate-token-2')
  @HttpCode(HttpStatus.OK)
  async validateTokenWithHeader(@Headers() headers) {
    const authorization = headers['authorization'];
    const result = await this.authService.validateToken2(authorization);
    return ValidateTokenResponseDto.from(result);
  }

  requestContext(headers) {
    return RequestContextDto.fromHeaders(headers);
  }
}
