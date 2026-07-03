/**
 * Configuración de Pino Logger para API Gateway UTN-MOVIL
 *
 * Características:
 * - Logging asíncrono (no bloqueante del event loop)
 * - Redacción automática de información sensible (tokens, API keys, passwords)
 * - Formato JSON en producción para integración con herramientas de análisis
 * - Formato pretty (coloreado) en desarrollo para mejor legibilidad
 * - Serialización optimizada para requests/responses
 *
 * @see https://getpino.io/
 * @see https://github.com/iamolegga/nestjs-pino
 */
export const pinoLoggerConfig = {
  pinoHttp: {
    // ============================================
    // CONFIGURACIÓN DE TRANSPORTE (DEV vs PROD)
    // ============================================
    /**
     * Transport se activa SOLO en desarrollo para pretty printing.
     * En producción (NODE_ENV=production), transport es undefined = JSON puro.
     *
     * Esto optimiza performance en producción eliminando overhead de formateo.
     */
    transport:
      process.env.NODE_ENV !== 'production'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              // Colores en terminal
              levelFirst: true,
              // Nivel de log primero
              translateTime: 'yyyy-mm-dd HH:MM:ss.l',
              // Formato fecha legible
              ignore: 'pid,hostname',
              // Ocultar PID y hostname
              singleLine: false,
              // Multi-línea para mejor lectura
              messageFormat: '{context} {msg}', // Formato: [Context] Mensaje
            },
          }
        : undefined,
    // ============================================
    // NIVEL DE LOGGING
    // ============================================
    /**
     * Niveles disponibles (menor a mayor severidad):
     * - trace (10): Debugging extremo
     * - debug (20): Información de debugging
     * - info (30): Información general (RECOMENDADO PRODUCCIÓN)
     * - warn (40): Advertencias
     * - error (50): Errores
     * - fatal (60): Errores fatales
     *
     * Default: 'info' (balance entre información y performance)
     */
    level: process.env.LOG_LEVEL || 'info',
    // ============================================
    // SERIALIZERS PERSONALIZADOS
    // ============================================
    /**
     * Serializers controlan qué información de request/response se loguea.
     *
     * SEGURIDAD: NO incluir headers (pueden contener tokens, API keys, cookies)
     * PERFORMANCE: Solo loguear información esencial
     */
    serializers: {
      req: (req) => ({
        id: req.id,
        // ID único del request (generado por Pino)
        method: req.method,
        // GET, POST, PUT, DELETE
        url: req.url,
        // Ruta completa
        // ❌ NO incluir: headers, query params, body (pueden tener datos sensibles)
        remoteAddress: req.remoteAddress,
        // IP del cliente
        remotePort: req.remotePort, // Puerto del cliente
      }),
      res: (res) => ({
        statusCode: res.statusCode, // 200, 404, 500, etc.
        // ❌ NO incluir: headers, body
      }),
    },
    // ============================================
    // REDACCIÓN DE DATOS SENSIBLES
    // ============================================
    /**
     * Redact elimina automáticamente campos sensibles de los logs.
     *
     * IMPORTANTE: Estos campos se ELIMINAN completamente (remove: true).
     * Si prefieres reemplazar con "[Redacted]", cambia a: remove: false
     *
     * Estrategia:
     * - Headers de autenticación (Authorization, Cookie, X-API-Key)
     * - Campos de autenticación (password, token, accessToken, refreshToken)
     * - Datos personales (cedula, numeroDocumento)
     * - Códigos MFA (mfaCode, codigo, code)
     * - API Keys del gateway
     */
    redact: {
      paths: [
        // Headers sensibles
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers["x-gateway-key"]',
        'req.headers["api-key"]',
        // Campos de autenticación (cualquier nivel de anidación con wildcard *)
        '*.password',
        '*.Password',
        '*.PASSWORD',
        '*.token',
        '*.Token',
        '*.accessToken',
        '*.refreshToken',
        '*.access_token',
        '*.refresh_token',
        '*.apiKey',
        '*.api_key',
        '*.API_KEY',
        // Datos personales sensibles
        '*.cedula',
        '*.numeroDocumento',
        '*.numero_documento',
        '*.dni',
        '*.ssn',
        '*.email',
        // Opcional: si no quieres loguear emails

        // MFA codes
        '*.mfaCode',
        '*.codigo',
        '*.code',
        '*.verificationCode',
        '*.otp',
        // Otros campos sensibles del API Gateway
        '*.cardNumber',
        '*.cvv',
        '*.pin',
        '*.baseUrl', // URLs de microservicios (por seguridad)
      ],
      remove: true, // true = eliminar completamente, false = reemplazar con [Redacted]
    },
    // ============================================
    // FORMATTERS PERSONALIZADOS
    // ============================================
    /**
     * Formatters controlan cómo se serializa la información.
     *
     * level: Formato del nivel de log
     * bindings: Información del proceso (PID, hostname)
     */
    formatters: {
      level: (label) => ({
        level: label,
      }),
      bindings: (bindings) => ({
        // Solo incluir PID y hostname en desarrollo (no en producción por seguridad)
        ...(process.env.NODE_ENV !== 'production' && {
          pid: bindings.pid,
          hostname: bindings.hostname,
        }),
      }),
    },
    // ============================================
    // TIMESTAMP
    // ============================================
    /**
     * Timestamp en formato ISO 8601 (estándar internacional).
     *
     * Ejemplo: "2025-11-01T19:30:45.123Z"
     *
     * Compatible con:
     * - Elasticsearch
     * - Datadog
     * - CloudWatch
     * - Splunk
     */
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    // ============================================
    // AUTO-LOGGING DE REQUESTS HTTP
    // ============================================
    /**
     * autoLogging configura qué requests se loguean automáticamente.
     *
     * OPTIMIZACIÓN: Ignorar health checks y rutas administrativas para reducir ruido en logs.
     */
    autoLogging: {
      ignore: (req) => {
        const ignoredPaths = [
          '/api/health',
          '/health',
          '/healthz',
          '/readiness',
          '/liveness',
          '/metrics',
          // Si usas Prometheus
          '/api-docs',
          // Swagger UI
          '/favicon.ico',
          // Favicon
          '/socket.io', // WebSocket connections
        ];
        return ignoredPaths.some((path) => req.url?.startsWith(path));
      },
    },
    // ============================================
    // PROPIEDADES PERSONALIZADAS POR REQUEST
    // ============================================
    /**
     * customProps agrega campos personalizados a cada log de request.
     *
     * Útil para agregar contexto consistente (ej: microservicio, versión, etc.)
     */
    customProps: () => ({
      context: 'HTTP',
      microservice: 'utn-movil-api-gateway',
      // version: process.env.npm_package_version, // Si necesitas versión
    }),
    // ============================================
    // NIVEL DE LOG SEGÚN STATUS CODE
    // ============================================
    /**
     * customLogLevel asigna niveles de log según el status code HTTP.
     *
     * Estrategia:
     * - 2xx (success): info
     * - 3xx (redirect): silent (no loguear)
     * - 4xx (client error): warn
     * - 5xx (server error): error
     */
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 400 && res.statusCode < 500) {
        return 'warn'; // 400, 401, 403, 404 = Cliente error
      } else if (res.statusCode >= 500 || err) {
        return 'error'; // 500, 502, 503 = Server error
      } else if (res.statusCode >= 300 && res.statusCode < 400) {
        return 'silent'; // 301, 302 = Redirects (no loguear para reducir ruido)
      }
      return 'info'; // 200, 201, 204 = Success
    },
    // ============================================
    // MENSAJES PERSONALIZADOS
    // ============================================
    /**
     * customSuccessMessage y customErrorMessage personalizan el mensaje de log.
     *
     * Formato: METHOD URL completed/failed
     * Ejemplo: "POST /api/v1/seguridad/auth/login completed"
     */
    customSuccessMessage: (req) => {
      return `${req.method} ${req.url} completed`;
    },
    customErrorMessage: (req) => {
      return `${req.method} ${req.url} failed`;
    },
  },
};
