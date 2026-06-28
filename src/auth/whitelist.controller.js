import { Controller, Get } from '@nestjs/common';

@Controller('api/v1/whitelist')
export class WhitelistController {
  @Get('all')
  getAll() {
    return ['/login/api/v1/auth/login', '/login/api/v1/auth/refresh'];
  }
}
