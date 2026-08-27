import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  defaultTools,
  AllowAllChecker,
  LocalMemory,
  DayaClient,
  ALL_DAYA_TOOLS,
} from '@daya-code/core';
import { registerTools } from './tools.js';

export interface BuildServerOptions {
  cwd?: string;
  dayaApiKey?: string;
  memoryPath?: string;
}

export function buildServer(opts: BuildServerOptions = {}): McpServer {
  const cwd = opts.cwd ?? process.cwd();
  const server = new McpServer({
    name: 'daya-code',
    version: '0.1.0',
  });

  const allTools = [...defaultTools(), ...ALL_DAYA_TOOLS];
  const permissions = new AllowAllChecker();

  const dayaClient = opts.dayaApiKey
    ? new DayaClient({ baseUrl: 'https://api.daya.ai', apiKey: opts.dayaApiKey })
    : undefined;

  const memory = opts.memoryPath
    ? new LocalMemory({ path: opts.memoryPath })
    : undefined;

  const ctx = {
    cwd,
    signal: new AbortController().signal,
    permissions,
    ...(dayaClient ? { dayaClient } : {}),
    ...(memory ? { memory } : {}),
  } as Parameters<typeof registerTools>[2];

  registerTools(server, allTools, ctx);

  return server;
}
