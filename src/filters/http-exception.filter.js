import { Catch, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
/**
 * Filtro Global de Excepciones HTTP
 * 
 * Intercepta TODAS las excepciones lanzadas en el Gateway
 * y devuelve respuestas consistentes y profesionales.
 * 
 * Casos manejados:
 * - Errores HTTP estándar (401, 403, 404, etc.)
 * - Errores de conexión con microservicios (503)
 * - Errores inesperados (500)
 * - Timeouts de Axios/HTTP
 * 
 * @author UTN-MOVIL
 * @date 22 de noviembre de 2025
 */
@Catch()
export class HttpExceptionFilter {
  constructor(@Inject(Logger) logger) {
    this.logger = logger;
  }
  catch(exception, host) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    // Determinar el status code
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorMessage = 'Error interno del servidor';
    let errorCode = 'INTERNAL_SERVER_ERROR';

    // Caso 1: Excepciones HTTP de NestJS (UnauthorizedException, etc.)
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        errorMessage = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        errorMessage = exceptionResponse.message || errorMessage;
        errorCode = exceptionResponse.error || errorCode;
      }
    }
    // Caso 2: Errores de conexión (ECONNREFUSED, ETIMEDOUT, etc.)
    else if (exception instanceof Error) {
      const error = exception;

      // Timeout de Axios al llamar a microservicios
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        status = HttpStatus.GATEWAY_TIMEOUT;
        errorCode = 'GATEWAY_TIMEOUT';
        errorMessage = 'El servicio solicitado tardó demasiado en responder';
      }
      // Microservicio no disponible
      else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        status = HttpStatus.SERVICE_UNAVAILABLE;
        errorCode = 'SERVICE_UNAVAILABLE';
        errorMessage = 'El servicio solicitado no está disponible temporalmente';
      }
      // Error de validación de token (Seguridad caído)
      else if (error.message?.includes('validando acceso')) {
        status = HttpStatus.SERVICE_UNAVAILABLE;
        errorCode = 'AUTH_SERVICE_UNAVAILABLE';
        errorMessage = 'Sistema de autenticación temporalmente no disponible. Intente nuevamente en unos momentos.';
      }
      // Otros errores inesperados
      else {
        errorMessage = error.message || 'Error inesperado';
      }
    }

    // Construir respuesta estructurada
    const errorResponse = {
      statusCode: status,
      error: errorCode,
      message: errorMessage,
      timestamp: new Date().toISOString(),
      path: request.url,
      // Información adicional para 503 (Service Unavailable)
      ...(status === HttpStatus.SERVICE_UNAVAILABLE && {
        retryAfter: 60,
        // Segundos
        documentation: 'https://docs.utn-movil.edu.ar/api/errors/503'
      }),
      // Información adicional para 429 (Rate Limit)
      ...(status === HttpStatus.TOO_MANY_REQUESTS && {
        retryAfter: exception.retryAfter || 60
      })
    };

    // Logging diferenciado por severidad
    const logContext = {
      context: 'HttpExceptionFilter',
      event: 'exception_caught',
      statusCode: status,
      errorCode,
      path: request.url,
      method: request.method,
      userAgent: request.headers['user-agent'],
      ip: request.ip
    };

    // Errores 5xx: Críticos (ERROR)
    if (status >= 500) {
      this.logger.error({
        ...logContext,
        error: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined
      }, `❌ Error ${status}: ${errorMessage}`);
    }
    // Errores 4xx: Advertencias (WARN)
    else if (status >= 400) {
      this.logger.warn(logContext, `⚠️ Error ${status}: ${errorMessage}`);
    }

    // Enviar respuesta al cliente
    response.status(status).send(errorResponse);
  }
}