import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyMiddleware } from './api-key.middleware';

describe('ApiKeyMiddleware', () => {
  const originalApiKey = process.env.LOGIN_API_KEY;

  afterEach(() => {
    process.env.LOGIN_API_KEY = originalApiKey;
  });

  it('permite llamadas con x-api-key valida', () => {
    process.env.LOGIN_API_KEY = 'secret';
    const middleware = new ApiKeyMiddleware();
    const next = jest.fn();

    middleware.use({ headers: { 'x-api-key': 'secret' } }, {}, next);

    expect(next).toHaveBeenCalled();
  });

  it('rechaza llamadas con x-api-key invalida', () => {
    process.env.LOGIN_API_KEY = 'secret';
    const middleware = new ApiKeyMiddleware();

    expect(() => middleware.use({ headers: { 'x-api-key': 'wrong' } }, {}, jest.fn()))
      .toThrow(UnauthorizedException);
  });

  it('rechaza llamadas si LOGIN_API_KEY no esta configurada', () => {
    delete process.env.LOGIN_API_KEY;
    const middleware = new ApiKeyMiddleware();

    expect(() => middleware.use({ headers: {} }, {}, jest.fn()))
      .toThrow(UnauthorizedException);
  });
});
