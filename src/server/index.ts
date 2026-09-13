import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { buildApp } from './app.js';
import { CodexRuntime, runtimeHealth } from './runtime/codex.js';

const dataDir = resolve(process.env.MINDSPACE_DATA_DIR || '.mindspace');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new Store(resolve(dataDir, 'mindspace.sqlite'));
store.recover();
const scheduler = new Scheduler(store, (agent, hooks) => new CodexRuntime(agent, hooks, dataDir));
const webRoot = resolve('dist');
const app = await buildApp({ store, scheduler, health: runtimeHealth, webRoot: existsSync(resolve(webRoot, 'index.html')) ? webRoot : undefined });
const port = Number(process.env.PORT || 3001);
await app.listen({ port, host: '127.0.0.1' });
console.log(`Mindspace backend: http://127.0.0.1:${port}`);
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  await scheduler.shutdown(); await app.close(); store.close();
}
process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
