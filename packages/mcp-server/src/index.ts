#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

const cwd = process.env['DAYA_CWD'] ?? process.cwd();
const dayaApiKey = process.env['DAYA_API_KEY'];
const memoryPath = process.env['DAYA_MEMORY_PATH'];

// Abort any in-flight tool calls before closing so `bash`/`write_file` never
// linger after the client disconnects.
const controller = new AbortController();

const server = buildServer({ cwd, dayaApiKey, memoryPath }, { controller });
const transport = new StdioServerTransport();

await server.connect(transport);

process.on('SIGINT', async () => {
  controller.abort();
  await server.close();
  process.exit(0);
});
