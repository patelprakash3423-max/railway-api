export class PublicError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export function safeError(error: unknown): PublicError {
  return error instanceof PublicError ? error : new PublicError('INTERNAL_ERROR', 'An unexpected error occurred.', 500);
}
