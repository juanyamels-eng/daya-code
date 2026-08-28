#!/usr/bin/env node

import { loadConfig } from './config.js';
import { createGateway } from './server.js';
import { UsageStore } from './usage.js';

const cfg = loadConfig();

const usage = new UsageStore(cfg.usageFile);
const server = createGateway(cfg, usage);

const missingKeys = Object.entries(cfg.upstreams)
  .filter(([, up]) => !up.apiKey && up.baseUrl.startsWith('https://'))
  .map(([name]) => name);

if (missingKeys.length > 0) {
  console.warn(
    `[gateway] missing API keys for: ${missingKeys.join(', ')} (set via gateway config or ${missingKeys
      .map((k) => (k === 'huggingface' ? 'HF_API_KEY' : `${k.toUpperCase()}_API_KEY`))
      .join(' / ')})`,
  );
  console.warn('[gateway] seamless preserved, but those upstreams will be skipped until you add a key.');
}

server.listen(cfg.port, () => {
  const lines = ['', '\u251c\u2500 DAYA Gateway', `\u251c\u2500 Listening on http://localhost:${cfg.port}`, '\u251c\u2500 OpenAI-compatible: /v1/chat/completions, /v1/models'];
  if (cfg.adminKey) lines.push('\u251c\u2500 Admin key set (skips user quota)');
  lines.push(`\u2514\u2500 Users: ${cfg.users.length} (${cfg.users.map((u) => u.name).join(', ') || '(none)'})`);
  console.log(lines.join('\n'));
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('\n[gateway] shutting down');
    server.close(() => {
      void usage.flush().finally(() => process.exit(0));
    });
    // Drop idle keep-alive connections so close() can finish promptly instead
    // of hanging on browsers/client libraries holding sockets open.
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 500).unref();
  });
}