import { Injectable } from '@nestjs/common';
import { expressConnectMiddleware } from '@connectrpc/connect-express';
import connectRoutes from '../connect-routes';

@Injectable()
export class ConnectMiddleware {
  constructor() {
    this.connectHandler = expressConnectMiddleware({
      routes: connectRoutes,
    });
  }

  use(req, res, next) {
    const fullUrl = req.originalUrl || req.url;
    if (fullUrl && fullUrl.startsWith('/eliza.v1.ElizaService/')) {
      // ⚠️ IMPORTANT: Restore req.url to the original untrimmed path
      // so the ConnectRPC Express middleware can correctly route the call.
      req.url = fullUrl;
      this.connectHandler(req, res, next);
    } else {
      next();
    }
  }
}
