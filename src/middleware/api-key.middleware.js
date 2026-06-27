import { Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class ApiKeyMiddleware {
  use(req, res, next) {
    const expectedApiKey = process.env.LOGIN_API_KEY;

    if (!expectedApiKey) {
      throw new UnauthorizedException('LOGIN_API_KEY no configurada');
    }

    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== expectedApiKey) {
      throw new UnauthorizedException('Acceso no autorizado: API Key inválida o no provista');
    }

    next();
  }
}
