import { config } from 'dotenv';
import { configure } from 'railkit';

config({ path: new URL('../../.env', import.meta.url), quiet: true });

export function configureRailKit(): void {
  if (!process.env.RAILKIT_API_KEY?.trim() ||
      process.env.RAILKIT_API_KEY.trim() === 'your_api_key_here') {
    throw new Error('RAILKIT_API_KEY is missing. Add your real API key to .env before running this script.');
  }
  configure(process.env.RAILKIT_API_KEY);
}
