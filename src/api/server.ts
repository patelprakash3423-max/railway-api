import {clientIdentity} from './search-protection.js';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { JourneySearchService } from '../application/journey-search-service.js';
import { createRouter, MAX_BODY_BYTES, type RouterOptions } from './router.js';
import { PublicError, safeError } from '../application/errors.js';
import { jsonLogger } from '../utils/logger.js';
import { redact } from '../utils/errors.js';
export async function readBody(request: AsyncIterable<Uint8Array | string>): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new PublicError('INVALID_REQUEST', 'Request body exceeds 16 KiB.', 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function createHttpHandler(service: Pick<JourneySearchService, 'search'>, options: RouterOptions = {}) {
  const route = createRouter(service, options);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const controller=new AbortController();
    const disconnected=()=>{if(!response.writableFinished)controller.abort(new PublicError('REQUEST_ABORTED','Request cancelled.',499));};
    response.once('close',disconnected);
    request.once('aborted',disconnected);
    const requestId = randomUUID();
    const path = (request.url ?? '/').split('?')[0];
    try {
      const body = request.method === 'POST' && (path === '/api/v1/journeys/search'||path === '/api/journeys/v2/search') ? await readBody(request.iterator({ destroyOnReturn: false })) : undefined;
      const result = await route({ method: request.method ?? '', path, body, requestId,
        contentType: request.headers['content-type'], origin: request.headers.origin,signal:controller.signal,clientId:clientIdentity(request.socket.remoteAddress,request.headers['x-forwarded-for']) });
      response.writeHead(result.status, result.headers); response.end(result.body);
    } catch (error: unknown) {
      const failure = safeError(error);
      response.writeHead(failure.status, { 'Content-Type': 'application/json', 'X-Request-Id': requestId, 'Connection': 'close' });
      response.end(redact(JSON.stringify({ requestId, error: { code: failure.code, message: failure.message } })));
      try { (options.logger ?? jsonLogger)({ level: 'error', event: 'journey_search_completed', requestId,
        resultCount: 0, externalCallCount: 0, elapsedMs: 0, success: false, errorCode: failure.code }); } catch { /* best effort */ }
    } finally {response.removeListener('close',disconnected);request.removeListener('aborted',disconnected);}
  };
}
export function createApiServer(service: Pick<JourneySearchService, 'search'>, options: RouterOptions = {}): Server {
  const handler = createHttpHandler(service, options);
  const server = createServer((request, response) => { void handler(request, response); });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
export function closeApiServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}
