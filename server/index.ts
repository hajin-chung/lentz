import { readConfig } from './config.js';
import { createApp } from './app.js';
import { acquireLock } from './lock.js';

const config = await readConfig();
const release = await acquireLock(config.dataDirectory);
const app = await createApp(config).catch(async (error) => {
  await release();
  throw error;
});
await app.listen({ host: config.host, port: config.port }).catch(async (error) => {
  await app.close();
  await release();
  throw error;
});
console.log(
  `\n  Lentz → http://${config.host}:${config.port}\n  Files → ${config.root}\n  State → ${config.dataDirectory}\n`,
);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  // SSE connections otherwise keep Fastify waiting indefinitely.
  app.server.closeAllConnections();
  await app.close();
  await release();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
