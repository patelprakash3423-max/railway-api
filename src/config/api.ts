import { configuredProviderQuota } from '../domain/usage/provider-quota.js';
import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url), quiet: true });
export function apiConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT ?? '4000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API port.');
  const diagnostics = env.ENABLE_API_DIAGNOSTICS ?? 'false';
  if (diagnostics !== 'true' && diagnostics !== 'false') throw new Error('ENABLE_API_DIAGNOSTICS must be true or false.');
  const expose = env.EXPOSE_SEARCH_DIAGNOSTICS ?? 'false';
  if (expose !== 'true' && expose !== 'false') throw new Error('EXPOSE_SEARCH_DIAGNOSTICS must be true or false.');
  const corsOrigin = env.CORS_ORIGIN || undefined;
  if (corsOrigin) {
    const url = new URL(corsOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== corsOrigin) throw new Error('CORS_ORIGIN must be one explicit HTTP(S) origin.');
  }
  return { exposeSearchDiagnostics: expose === 'true', providerQuota: configuredProviderQuota(env), port, host: env.HOST || '0.0.0.0', enableDiagnostics: diagnostics === 'true', corsOrigin };
}
