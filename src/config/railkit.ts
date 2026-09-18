import { config } from 'dotenv';
import { configure } from 'railkit';
import { ProviderConfigurationError } from '../application/errors.js';

config({ path: new URL('../../.env', import.meta.url), quiet: true });

export function configureRailKit(): void {
  const key = process.env.RAILKIT_API_KEY?.trim();
  // Validate local configuration only. Authenticity/revocation requires the provider.
  if (!key || key === 'your_api_key_here' || !/^[\x21-\x7e]+$/.test(key)) throw new ProviderConfigurationError();
  try { configure(key); } catch { throw new ProviderConfigurationError(); }
}
