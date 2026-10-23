import { loadAiConfig, publicAiConfig } from './config.js';
import { createObjectStorage } from './storage.js';
import { startPipelineServer } from './server.js';

async function main() {
  const config = await loadAiConfig();
  const storage = await createObjectStorage(config);
  const started = await startPipelineServer(config, storage);
  const safe = publicAiConfig(config);
  console.log(JSON.stringify({
    service: 'reasonframe-ai',
    event: 'started',
    address: started.address,
    port: started.port,
    storage: safe.storage,
    capabilities: safe.capabilities,
    maxTasks: safe.maxTasks,
    modelConfigured: safe.modelConfigured,
    ttsConfigured: safe.ttsConfigured,
  }));
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ service: 'reasonframe-ai', event: 'stopping', signal }));
    await started.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => { void stop('SIGTERM'); });
  process.on('SIGINT', () => { void stop('SIGINT'); });
  process.on('uncaughtException', error => {
    console.error(JSON.stringify({ service: 'reasonframe-ai', event: 'uncaught_exception', message: (error as Error).message }));
    void stop('uncaughtException');
  });
  process.on('unhandledRejection', error => {
    console.error(JSON.stringify({ service: 'reasonframe-ai', event: 'unhandled_rejection', message: String(error) }));
  });
}

main().catch(error => {
  console.error(JSON.stringify({ service: 'reasonframe-ai', event: 'startup_failed', message: (error as Error).message }));
  process.exit(1);
});
