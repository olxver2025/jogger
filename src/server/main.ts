import { App } from './app.js';
import { createHttpServer } from './http.js';

const app = new App();
const server = createHttpServer(app);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[jogger] Port ${app.config.port} is in use. Is Jogger already running? Set JOGGER_PORT to use another port.`);
  } else console.error('[jogger] server error:', err);
  process.exit(1);
});

server.listen(app.config.port, app.config.host, async () => {
  app.setPort(app.config.port);
  await app.start();
  const url = `http://${app.config.host}:${app.config.port}/?token=${app.config.token}`;
  console.log(`[jogger] ${app.version} listening on http://${app.config.host}:${app.config.port}`);
  console.log(`[jogger] open: ${url}`);
  if (!app.config.webDir) console.log('[jogger] web UI not built; run `npm run dev` and open the Vite URL, or `npm run build`.');
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('[jogger] shutting down');
  server.close();
  await app.shutdown().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
