import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { PasswordResetNotifierService } from './password-reset-notifier.service';

const mockSendEmail = jest.fn();
const mockClose = jest.fn();
const mockEmailService = jest.fn(function emailService(target, credentials) {
  this.target = target;
  this.credentials = credentials;
  this.sendEmail = mockSendEmail;
  this.close = mockClose;
});

jest.mock('@connectrpc/connect', () => ({
  createClient: jest.fn(() => ({ sendEmail: jest.fn() })),
}));

jest.mock('@connectrpc/connect-node', () => ({
  createConnectTransport: jest.fn((options) => options),
}));

jest.mock('@grpc/proto-loader', () => ({
  loadSync: jest.fn(() => 'package-definition'),
}));

jest.mock('@grpc/grpc-js', () => ({
  credentials: {
    createInsecure: jest.fn(() => 'insecure-credentials'),
  },
  loadPackageDefinition: jest.fn(() => ({
    notificaciones: {
      v1: {
        EmailService: mockEmailService,
      },
    },
  })),
}));

describe('PasswordResetNotifierService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('usa BASE_URL como target gRPC del gateway', async () => {
    process.env = {
      ...originalEnv,
      BASE_URL: 'academia-dev.eastus2.cloudapp.azure.com:50050',
    };
    mockSendEmail.mockImplementation((_email, _options, callback) =>
      callback(null, { success: true }),
    );

    const service = new PasswordResetNotifierService();
    await service.getClient().sendEmail({});

    expect(protoLoader.loadSync).toHaveBeenCalled();
    expect(grpc.credentials.createInsecure).toHaveBeenCalled();
    expect(mockEmailService).toHaveBeenCalledWith(
      'academia-dev.eastus2.cloudapp.azure.com:50050',
      'insecure-credentials',
      expect.objectContaining({
        'grpc.keepalive_time_ms': 20000,
      }),
    );
    expect(mockClose).toHaveBeenCalled();
    expect(createConnectTransport).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('ignora placeholders no resueltos de Azure y usa BASE_URL', () => {
    process.env = {
      ...originalEnv,
      BASE_URL: 'academia-dev.eastus2.cloudapp.azure.com:50050',
      NOTIFICATIONS_GATEWAY_TARGET: '$(NOTIFICATIONS_GATEWAY_TARGET)',
    };

    const service = new PasswordResetNotifierService();

    expect(service.getGatewayTarget()).toBe(
      'academia-dev.eastus2.cloudapp.azure.com:50050',
    );
  });

  it('permite usar un target IPv4 del gateway sin cambiar BASE_URL', async () => {
    process.env = {
      ...originalEnv,
      BASE_URL: 'academia-dev.eastus2.cloudapp.azure.com:50050',
      NOTIFICATIONS_GATEWAY_TARGET: '20.122.210.230:50050',
    };
    mockSendEmail.mockImplementation((_email, _options, callback) =>
      callback(null, { success: true }),
    );

    const service = new PasswordResetNotifierService();
    await service.getClient().sendEmail({});

    expect(mockEmailService).toHaveBeenCalledWith(
      '20.122.210.230:50050',
      'insecure-credentials',
      expect.any(Object),
    );
  });

  it('usa HTTP/2 si BASE_URL es un endpoint HTTP Connect', () => {
    process.env = {
      ...originalEnv,
      BASE_URL: 'http://gateway-connect.test',
    };

    const service = new PasswordResetNotifierService();
    service.getClient();

    expect(createConnectTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://gateway-connect.test',
        httpVersion: '2',
      }),
    );
    expect(createClient).toHaveBeenCalled();
  });

  it('reutiliza cliente HTTP Connect y envia correo construido', async () => {
    process.env = {
      ...originalEnv,
      BASE_URL: 'https://gateway-connect.test',
    };
    const sendEmail = jest.fn().mockResolvedValue({ success: true });
    createClient.mockReturnValueOnce({ sendEmail });

    const service = new PasswordResetNotifierService();
    const firstClient = service.getClient();
    const secondClient = service.getClient();

    expect(firstClient).toBe(secondClient);
    expect(createClient).toHaveBeenCalledTimes(1);

    await expect(
      service.sendPasswordResetEmail({
        usuarioId: 'user-1',
        email: 'user@utn.edu.ec',
        nombre: 'User Test',
        resetUrl: 'https://reset.test/?token=1',
        expiresInMinutes: 30,
      }),
    ).resolves.toEqual({ success: true });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        usuarioId: 'user-1',
        toEmail: 'user@utn.edu.ec',
        toName: 'User Test',
        source: 'academico-login',
      }),
    );
  });

  it('falla de forma explicita cuando no hay gateway configurado', () => {
    process.env = { ...originalEnv };
    delete process.env.BASE_URL;
    delete process.env.NOTIFICATIONS_GATEWAY_TARGET;

    const service = new PasswordResetNotifierService();

    expect(() => service.getClient()).toThrow(
      'BASE_URL no configurado para solicitudes via gateway',
    );
  });

  it('propaga error si el proveedor de correo responde success=false', async () => {
    process.env = {
      ...originalEnv,
      BASE_URL: 'https://gateway-connect.test',
    };
    createClient.mockReturnValueOnce({
      sendEmail: jest.fn().mockResolvedValue({
        success: false,
        message: 'provider rejected',
      }),
    });

    const service = new PasswordResetNotifierService();

    await expect(
      service.sendPasswordResetEmail({
        usuarioId: 'user-1',
        email: 'user@utn.edu.ec',
        resetUrl: 'https://reset.test',
        expiresInMinutes: 30,
      }),
    ).rejects.toThrow('provider rejected');
  });

  it('rechaza promesa gRPC y cierra el cliente cuando sendEmail falla', async () => {
    process.env = {
      ...originalEnv,
      NOTIFICATIONS_GATEWAY_TARGET: '20.122.210.230:50050',
    };
    mockSendEmail.mockImplementation((_email, _options, callback) =>
      callback(new Error('grpc unavailable')),
    );

    const service = new PasswordResetNotifierService();

    await expect(service.getClient().sendEmail({})).rejects.toThrow(
      'grpc unavailable',
    );
    expect(mockClose).toHaveBeenCalled();
  });

  it('usa 60 segundos como deadline gRPC por defecto', () => {
    process.env = { ...originalEnv };
    delete process.env.NOTIFICATIONS_GRPC_TIMEOUT_MS;

    const service = new PasswordResetNotifierService();
    const before = Date.now() + 59000;

    expect(service.getGrpcDeadline().getTime()).toBeGreaterThanOrEqual(before);
  });

  it('respeta timeout gRPC configurado y escapa HTML del correo', () => {
    process.env = {
      ...originalEnv,
      NOTIFICATIONS_GRPC_TIMEOUT_MS: '5000',
    };
    const service = new PasswordResetNotifierService();
    const before = Date.now() + 4900;

    expect(service.getGrpcDeadline().getTime()).toBeGreaterThanOrEqual(before);
    expect(service.isHttpUrl('HTTPS://gateway.test')).toBe(true);
    expect(service.isHttpUrl('20.122.210.230:50050')).toBe(false);

    const email = service.buildPasswordResetEmail({
      usuarioId: 'user-1',
      email: 'user@utn.edu.ec',
      nombre: '<User & Test>',
      resetUrl: 'https://reset.test/?token=\"abc\"',
      expiresInMinutes: 15,
    });

    expect(email.toName).toBe('<User & Test>');
    expect(email.html).toContain('&lt;User &amp; Test&gt;');
    expect(email.html).toContain('&quot;abc&quot;');
    expect(email.metadata).toEqual(
      expect.arrayContaining([{ key: 'expiresInMinutes', value: '15' }]),
    );
  });
});
