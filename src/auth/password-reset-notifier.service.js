import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'path';
import { EmailService } from '../gen/proto/notificaciones/v1/notificaciones_pb.js';

@Injectable()
export class PasswordResetNotifierService {
  constructor() {
    this.client = null;
    this.clientBaseUrl = null;
    this.grpcEmailService = null;
  }

  async sendPasswordResetEmail(payload) {
    const client = this.getClient();
    const email = this.buildPasswordResetEmail(payload);
    const response = await client.sendEmail(email);

    if (!response.success) {
      throw new InternalServerErrorException(
        response.message || 'No se pudo enviar el correo de recuperacion',
      );
    }

    return response;
  }

  buildPasswordResetEmail(payload) {
    const name = payload.nombre || payload.email;
    const subject = 'Recuperacion de contraseña - Sistema Academico';
    const plainText = [
      `Hola ${name},`,
      '',
      'Recibimos una solicitud para recuperar tu contraseña.',
      `Usa este enlace para continuar: ${payload.resetUrl}`,
      `El enlace vence en ${payload.expiresInMinutes} minutos.`,
      '',
      'Si no solicitaste este cambio, ignora este correo.',
    ].join('\n');

    return {
      usuarioId: payload.usuarioId,
      toEmail: payload.email,
      toName: name,
      subject,
      plainText,
      html: this.passwordResetHtml({
        ...payload,
        nombre: name,
      }),
      tipo: 'seguridad',
      prioridad: 'alta',
      source: 'academico-login',
      metadata: [
        { key: 'type', value: 'password_reset' },
        { key: 'resetUrl', value: payload.resetUrl },
        { key: 'expiresInMinutes', value: String(payload.expiresInMinutes) },
      ],
    };
  }

  getClient() {
    const baseUrl = this.getGatewayTarget();

    if (!baseUrl) {
      throw new InternalServerErrorException(
        'BASE_URL no configurado para solicitudes via gateway',
      );
    }

    if (this.isHttpUrl(baseUrl)) {
      if (!this.client || this.clientBaseUrl !== baseUrl) {
        const transport = createConnectTransport({
          baseUrl,
          httpVersion: '2',
        });
        this.client = createClient(EmailService, transport);
        this.clientBaseUrl = baseUrl;
      }

      return this.client;
    }

    return this.getGrpcClient(baseUrl);
  }

  getGrpcClient(target) {
    const EmailServiceClient = this.getGrpcEmailService();

    return {
      sendEmail: (email) =>
        new Promise((resolve, reject) => {
          const client = new EmailServiceClient(
            target,
            grpc.credentials.createInsecure(),
            this.getGrpcChannelOptions(),
          );

          client.sendEmail(
            email,
            { deadline: this.getGrpcDeadline() },
            (error, response) => {
              client.close();

              if (error) {
                reject(error);
                return;
              }
              resolve(response);
            },
          );
        }),
    };
  }

  getGrpcEmailService() {
    if (!this.grpcEmailService) {
      const packageDefinition = protoLoader.loadSync(
        join(__dirname, '../proto/notificaciones/v1/notificaciones.proto'),
        {
          keepCase: false,
          longs: String,
          enums: String,
          defaults: true,
          oneofs: true,
        },
      );
      const notificacionesProto =
        grpc.loadPackageDefinition(packageDefinition).notificaciones.v1;

      this.grpcEmailService = notificacionesProto.EmailService;
    }

    return this.grpcEmailService;
  }

  getGatewayTarget() {
    return process.env.NOTIFICATIONS_GATEWAY_TARGET || process.env.BASE_URL;
  }

  getGrpcChannelOptions() {
    return {
      'grpc.keepalive_time_ms': 20000,
      'grpc.keepalive_timeout_ms': 5000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.initial_reconnect_backoff_ms': 1000,
      'grpc.max_reconnect_backoff_ms': 5000,
    };
  }

  isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
  }

  getGrpcDeadline() {
    const parsed = parseInt(
      process.env.NOTIFICATIONS_GRPC_TIMEOUT_MS || '60000',
      10,
    );
    const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
    return new Date(Date.now() + timeoutMs);
  }

  passwordResetHtml(payload) {
    const name = this.escapeHtml(payload.nombre);
    const resetUrl = this.escapeHtml(payload.resetUrl);
    const minutes = this.escapeHtml(String(payload.expiresInMinutes));

    return `
      <!doctype html>
      <html lang="es">
        <body style="font-family: Arial, sans-serif; color: #172033; line-height: 1.5;">
          <h1 style="font-size: 20px;">Recuperacion de contraseña</h1>
          <p>Hola ${name},</p>
          <p>Recibimos una solicitud para recuperar tu contraseña del Sistema Academico.</p>
          <p>
            <a href="${resetUrl}" style="display: inline-block; background: #0f5bd7; color: #ffffff; padding: 10px 16px; border-radius: 6px; text-decoration: none;">
              Restablecer contraseña
            </a>
          </p>
          <p>Este enlace vence en ${minutes} minutos.</p>
          <p>Si no solicitaste este cambio, puedes ignorar este correo.</p>
        </body>
      </html>
    `;
  }

  escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }
}
