import { loadConfig, publicConfig } from '../core/config.js';
import { JobManager } from '../core/jobs.js';
import { createApp } from './app.js';

const config = await loadConfig(), manager = new JobManager(config);
await manager.open();
const app = createApp(manager), server = app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ service: 'reasonframe', url: `http://${config.host}:${(server.address() as { port: number }).port}`, ...publicConfig(config) }));
});
let stopping = false;
const shutdown = async () => {
  if (stopping) return; stopping = true;
  server.close(); server.closeIdleConnections();
  await manager.close(); server.closeAllConnections();
};
process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
