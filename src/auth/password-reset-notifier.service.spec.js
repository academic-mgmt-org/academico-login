import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { PasswordResetNotifierService } from './password-reset-notifier.service';

const mockSendEmail = jest.fn();
const mockEmailService = jest.fn(function emailService(target, credentials) {
  this.target = target;
  this.credentials = credentials;
  this.sendEmail = mockSendEmail;
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

  it('usa BASE_URL como target gRPC del gateway', () => {
    process.env = {
      ...originalEnv,
      BASE_URL: 'academia-dev.eastus2.cloudapp.azure.com:50050',
    };

    const service = new PasswordResetNotifierService();
    service.getClient();

    expect(protoLoader.loadSync).toHaveBeenCalled();
    expect(grpc.credentials.createInsecure).toHaveBeenCalled();
    expect(mockEmailService).toHaveBeenCalledWith(
      'academia-dev.eastus2.cloudapp.azure.com:50050',
      'insecure-credentials',
    );
    expect(createConnectTransport).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
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

  it('usa 60 segundos como deadline gRPC por defecto', () => {
    process.env = { ...originalEnv };
    delete process.env.NOTIFICATIONS_GRPC_TIMEOUT_MS;

    const service = new PasswordResetNotifierService();
    const before = Date.now() + 59000;

    expect(service.getGrpcDeadline().getTime()).toBeGreaterThanOrEqual(before);
  });
});
