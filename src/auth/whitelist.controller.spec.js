import { WhitelistController } from './whitelist.controller';

describe('WhitelistController', () => {
  it('publica la ruta publica de login del gateway', () => {
    const controller = new WhitelistController();

    expect(controller.getAll()).toEqual([
      '/login/api/v1/auth/login',
      '/login/api/v1/auth/refresh',
    ]);
  });
});
