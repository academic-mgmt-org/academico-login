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
    this.grpcClient = null;
    this.grpcTarget = null;
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
    const baseUrl = process.env.BASE_URL;

    if (!baseUrl) {
      throw new InternalServerErrorException(
        'BASE_URL no configurado para solicitudes via gateway',
      );
    }

    if (this.isHttpUrl(baseUrl)) {
      if (!this.client || this.clientBaseUrl !== baseUrl) {
        const transport = createConnectTransport({
          baseUrl,
          httpVersion: '1.1',
        });
        this.client = createClient(EmailService, transport);
        this.clientBaseUrl = baseUrl;
      }

      return this.client;
    }

    return this.getGrpcClient(baseUrl);
  }

  getGrpcClient(target) {
    if (!this.grpcClient || this.grpcTarget !== target) {
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
      const notificacionesProto = grpc.loadPackageDefinition(
        packageDefinition,
      ).notificaciones.v1;

      this.grpcClient = new notificacionesProto.EmailService(
        target,
        grpc.credentials.createInsecure(),
      );
      this.grpcTarget = target;
    }

    return {
      sendEmail: (email) =>
        new Promise((resolve, reject) => {
          this.grpcClient.sendEmail(email, (error, response) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(response);
          });
        }),
    };
  }

  isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
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
