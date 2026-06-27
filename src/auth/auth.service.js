import { Inject, Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import getPool from '../db';

@Injectable()
export class AuthService {
  constructor(@Inject(JwtService) jwtService) {
    this.jwtService = jwtService;
  }

  async login(loginRequest) {
    if (!loginRequest || !loginRequest.username || !loginRequest.password) {
      throw new BadRequestException('Usuario y contraseña son requeridos');
    }

    // Validar y decodificar contraseña en Base64
    const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
    if (!base64Regex.test(loginRequest.password)) {
      throw new UnauthorizedException('Usuario o contraseña incorrectos. Verifique sus credenciales.');
    }

    let password;
    try {
      password = Buffer.from(loginRequest.password, 'base64').toString('utf8');
    } catch (error) {
      throw new UnauthorizedException('Usuario o contraseña incorrectos. Verifique sus credenciales.');
    }

    const email = loginRequest.username.toLowerCase();
    const pool = getPool();

    // Query para obtener el usuario y su rol según el esquema simplificado (V2)
    const query = `
      SELECT 
        u.id AS usuario_id,
        u.nombres,
        u.apellidos,
        u.email,
        u.password_hash,
        u.identificacion,
        u.estado,
        r.nombre AS rol_nombre
      FROM academico.usuarios u
      INNER JOIN academico.roles r ON r.id = u.rol_id
      WHERE u.email = $1 AND u.estado = 'activo'
    `;

    let userRow;
    try {
      const { rows } = await pool.query(query, [email]);
      if (rows.length === 0) {
        throw new UnauthorizedException('Usuario o contraseña incorrectos. Verifique sus credenciales.');
      }
      userRow = rows[0];
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new BadRequestException('Error al consultar el usuario en la base de datos: ' + error.message);
    }

    // Validación de la contraseña (comparación directa con password_hash)
    if (userRow.password_hash !== password) {
      throw new UnauthorizedException('Usuario o contraseña incorrectos. Verifique sus credenciales.');
    }

    // Generar sessionId único
    const sessionId = 'SESSION-' + Math.random().toString(36).substring(2, 15).toUpperCase();

    // Determinar identificadores y roles según el rol de la base de datos
    const identifier = userRow.identificacion || String(userRow.usuario_id);
    let userStudent = null;
    let userProfessor = null;
    const apps = [];

    const rol = userRow.rol_nombre.toLowerCase();

    if (rol === 'estudiante') {
      userStudent = 'E' + identifier;
      apps.push({
        appName: 'PORTAFOLIO_ESTUDIANTE',
        roles: [
          {
            roleName: 'ESTUDIANTE',
            permissions: ['LEER_NOTAS', 'CONSULTAR_HORARIOS', 'DESCARGAR_DOCUMENTOS']
          }
        ]
      });
    } else if (rol === 'docente') {
      userProfessor = 'D' + identifier;
      apps.push({
        appName: 'PORTAFOLIO_DOCENTE',
        roles: [
          {
            roleName: 'DOCENTE',
            permissions: ['REGISTRAR_NOTAS', 'VER_ESTUDIANTES']
          }
        ]
      });
    }

    const payload = {
      identifier: identifier,
      userStudent: userStudent,
      userProfessor: userProfessor,
      userAdministrative: null,
      email: userRow.email,
      userName: userRow.nombres,
      sessionId: sessionId,
      applications: apps
    };

    const secret = process.env.JWT_SECRET || process.env.JWT_DOC_SECRET || 'utn-secret-key-123';
    const accessToken = this.jwtService.sign(payload, { secret, expiresIn: '2h' });
    const refreshToken = this.jwtService.sign({
      identifier: payload.identifier,
      email: payload.email,
      sessionId: payload.sessionId,
    }, { secret, expiresIn: '7d' });

    return {
      accessToken,
      refreshToken,
      mfaRequired: false,
      requiresAppUpdate: false
    };
  }

  async validateToken(token) {
    if (!token) {
      return false;
    }
    try {
      const secret = process.env.JWT_SECRET || process.env.JWT_DOC_SECRET || 'utn-secret-key-123';
      await this.jwtService.verifyAsync(token, { secret });
      return true;
    } catch (error) {
      return false;
    }
  }

  async validateToken2(authorization) {
    if (!authorization) {
      return { isValid: false };
    }

    const [type, token] = authorization.split(' ') ?? [];
    const tokenToVerify = type === 'Bearer' ? token : (token || type);

    if (!tokenToVerify) {
      return { isValid: false };
    }

    try {
      const secret = process.env.JWT_SECRET || process.env.JWT_DOC_SECRET || 'utn-secret-key-123';
      const payload = await this.jwtService.verifyAsync(tokenToVerify, { secret });
      
      return {
        isValid: true,
        identifier: payload.identifier,
        email: payload.email,
        sessionId: payload.sessionId
      };
    } catch (error) {
      return { isValid: false };
    }
  }
}
