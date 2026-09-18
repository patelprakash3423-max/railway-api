export class PublicError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export class ProviderConfigurationError extends PublicError {
  constructor() { super('PROVIDER_CONFIGURATION_ERROR', 'Availability provider configuration is invalid or missing.', 503); }
}
export function safeError(error: unknown): PublicError {
  return error instanceof PublicError ? error : new PublicError('INTERNAL_ERROR', 'An unexpected error occurred.', 500);
}
