import { providerFailureCategory, type ProviderFailureCategory } from '../domain/types/provider-failure.js';
import type { ProviderFailureState } from '../domain/types/provider.js';

export function redact(text: string): string {
  const key = process.env.RAILKIT_API_KEY;
  if (!key) return text;
  const variants = [key, key.trim(), encodeURIComponent(key), JSON.stringify(key).slice(1, -1)];
  for (const value of variants) {
    if (value) text = text.split(value).join('[REDACTED]');
  }
  return text;
}


export class ProviderError extends Error {
  constructor(public readonly providerState: ProviderFailureState, message: string, public readonly failureCategory?: ProviderFailureCategory) {
    super(redact(message));
    this.name = 'ProviderError';
  }
}

export function providerError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError('PROVIDER_ERROR', error instanceof Error ? error.message :
    typeof error === 'string' ? error : 'Unexpected provider failure', providerFailureCategory(error));
}
