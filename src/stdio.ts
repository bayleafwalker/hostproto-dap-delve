import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DelveHost } from './host.js';
import { createServer } from './server.js';

const host = new DelveHost();
const handle = serveStdio(() => createServer(host), { legacy: 'reject', onerror: e => console.error('[hostproto]', e.message) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void host.close().finally(() => process.exit(0)); });
void handle;
