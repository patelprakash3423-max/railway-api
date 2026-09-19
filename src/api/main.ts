import {ProtectedJourneyService} from './services/protected-journey-service.js';
import {hardeningConfig} from '../config/hardening.js';
import {installAvailabilityAbortTransport} from '../providers/railkit/availability-abort.js';
import { apiConfig } from '../config/api.js';
import { RailKitProvider } from '../providers/railkit/railkit-provider.js';
import { jsonLogger } from '../utils/logger.js';
import { createApiServer, closeApiServer } from './server.js';
import {openProductionRailwayDatabase} from './services/journey-v2-service.js';
import {PublicError} from '../application/errors.js';
try {
  const config = apiConfig();
  const database=openProductionRailwayDatabase();
  installAvailabilityAbortTransport();
  const railkit=new RailKitProvider();
  const protectionConfig=hardeningConfig();
  const journeyV2=new ProtectedJourneyService(database,railkit,protectionConfig,{diagnostics:config.exposeSearchDiagnostics||config.enableDiagnostics,logger:jsonLogger});
  const service={search:async():Promise<never>=>{throw new PublicError('ENDPOINT_RETIRED','Use /api/journeys/v2/search.',410);}};
  const server = createApiServer(service, { corsOrigin: config.corsOrigin,journeyV2,clientIdentityMode:protectionConfig.clientIdentityMode });
  server.on('error', () => { jsonLogger({ level: 'error', event: 'api_server_error' }); process.exitCode = 1; });
  server.listen(config.port, config.host, () => jsonLogger({ level: 'info', event: 'api_started', port: config.port }));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    jsonLogger({ level: 'info', event: 'api_stopping' });
    void closeApiServer(server).then(()=>database.close()).catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
} catch(error) { jsonLogger({ level: 'error', event: 'api_start_failed', message: error instanceof PublicError?error.message:'Check API environment configuration.' }); process.exitCode = 1; }
