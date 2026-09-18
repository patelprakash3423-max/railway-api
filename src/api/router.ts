import type {SearchContext} from './services/protected-journey-service.js';
import { randomUUID } from 'node:crypto';
import type { JourneySearchService } from '../application/journey-search-service.js';
import { jsonLogger, type SearchLogger } from '../utils/logger.js';
import { PublicError, safeError } from '../application/errors.js';
import { redact } from '../utils/errors.js';
export const MAX_BODY_BYTES = 16384;
export interface ApiRequest extends SearchContext { method: string; path: string; contentType?: string; origin?: string; body?: string; requestId?: string }
export interface ApiReply { status: number; headers: Record<string, string>; body: string }
export interface RouterOptions { corsOrigin?: string; logger?: SearchLogger; journeyV2?: {search(input:unknown,requestId?:string,context?:SearchContext):Promise<unknown>} }
export function createRouter(service: Pick<JourneySearchService, 'search'>, options: RouterOptions = {}) {
  const allowedOrigins = new Set(options.corsOrigin?.split(',').map(origin => origin.trim()) ?? []);
  return async (request: ApiRequest): Promise<ApiReply> => {
    // Always generate: client-supplied identifiers are not trusted or echoed.
    const requestId = request.requestId ?? randomUUID();
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': requestId };
    if (request.origin && allowedOrigins.has(request.origin)) {
      headers['Access-Control-Allow-Origin'] = request.origin;
      headers['Vary'] = 'Origin';
      headers['Access-Control-Expose-Headers'] = 'X-Request-Id';
    }
    const reply = (status: number, value: unknown): ApiReply => ({ status, headers, body: redact(JSON.stringify(value)) });
    const searchPath=request.path==='/api/v1/journeys/search'||request.path==='/api/journeys/v2/search';
    let delegated = false;
    try {
      if (request.path === '/health' && request.method === 'GET') return reply(200, { requestId, status: 'ok' });
      if (!searchPath && request.path !== '/health') throw new PublicError('NOT_FOUND', 'Route not found.', 404);
      if (request.method === 'OPTIONS' && searchPath) {
        // Preflight is transport handling, not a journey search. Unmatched origins
        // receive no CORS permission, while still bypassing search validation/logging.
        headers['Vary'] = 'Origin';
        if (headers['Access-Control-Allow-Origin']) {
          headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
          headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Request-Id';
        }
        delete headers['Content-Type'];
        return { status: 204, headers, body: '' };
      }
      if (request.method !== 'POST' || !searchPath) throw new PublicError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      if (request.contentType?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new PublicError('INVALID_REQUEST', 'Content-Type must be application/json.');
      if (Buffer.byteLength(request.body ?? '') > MAX_BODY_BYTES) throw new PublicError('INVALID_REQUEST', 'Request body exceeds 16 KiB.', 413);
      let body: unknown;
      try { body = JSON.parse(request.body ?? ''); } catch { throw new PublicError('INVALID_REQUEST', 'Invalid JSON request body.'); }
      delegated = true;
      if(request.path==='/api/journeys/v2/search'){if(!options.journeyV2)throw new PublicError('NOT_FOUND','Journey V2 is not configured.',404);return reply(200,await options.journeyV2.search(body,requestId,{signal:request.signal,clientId:request.clientId}));}
      return reply(200, await service.search(body, requestId));
    } catch (error: unknown) {
      const failure = safeError(error);
      if (!delegated && searchPath) {
        try { (options.logger ?? jsonLogger)({ level: 'error', event: 'journey_search_completed', requestId,
          resultCount: 0, externalCallCount: 0, elapsedMs: 0, success: false, errorCode: failure.code }); } catch { /* best effort */ }
      }
      return reply(failure.status, { requestId, error: { code: failure.code, message: failure.message } });
    }
  };
}
