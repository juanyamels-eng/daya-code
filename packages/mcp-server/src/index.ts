#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

const cwd = process.env['DAYA_CWD'] ?? process.cwd();
const dayaApiKey = process.env['DAYA_API_KEY'];
const memoryPath = process.env['DAYA_MEMORY_PATH'];

const server = buildServer({ cwd, dayaApiKey, memoryPath });
const transport = new StdioServerTransport();

await server.connect(transport);

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});
