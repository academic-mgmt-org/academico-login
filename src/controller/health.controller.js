import { Controller, Get } from '@nestjs/common';

@Controller('api')
export class HealthController {
  @Get('health')
  health() {
    return {
      status: 'healthy',
      service: 'academico-login',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    };
  }

  @Get('ready')
  ready() {
    return {
      ready: true,
      timestamp: new Date().toISOString()
    };
  }

  @Get('live')
  live() {
    return {
      alive: true,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    };
  }
}
