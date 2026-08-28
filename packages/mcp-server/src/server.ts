import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  defaultTools,
  AllowAllChecker,
  DenyAllChecker,
  LocalMemory,
  DayaClient,
  ALL_DAYA_TOOLS,
} from '@daya-code/core';
import { readFileSync } from 'node:fs';
import { registerTools } from './tools.js';

export interface BuildServerOptions {
  cwd?: string;
  dayaApiKey?: string;
  memoryPath?: string;
}

// Single source of truth for the MCP server version.
const MCP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export function buildServer(
  opts: BuildServerOptions = {},
  dependencies: { controller?: AbortController } = {},
): McpServer {
  const cwd = opts.cwd ?? process.cwd();
  const server = new McpServer({
    name: 'daya-code',
    version: MCP_VERSION,
  });

  const allTools = [...defaultTools(), ...ALL_DAYA_TOOLS];

  // Set DAYA_MCP_DENY_BASH=1 as a kill switch for the bash tool behavior.
  const denyBash = process.env.DAYA_MCP_DENY_BASH === '1' || process.env.DAYA_MCP_DENY_BASH === 'true';
  const permissions = denyBash ? new DenyAllChecker() : new AllowAllChecker();
  if (!denyBash) {
    // Fail loud: the MCP stdio server runs tools with zero user prompting, so
    // every tool that can touch the filesystem runs immediately.
    process.stderr.write(
      '[daya-code-mcp] WARNING: running with an allow-all permission checker. bash/write/edit tools will run without confirmation.\n',
    );
  }

  const dayaClient = opts.dayaApiKey
    ? new DayaClient({ baseUrl: 'https://api.daya.ai', apiKey: opts.dayaApiKey })
    : undefined;

  const memory = opts.memoryPath
    ? new LocalMemory({ path: opts.memoryPath })
    : undefined;

  // Abort in-flight tool calls when the server is shut down.
  const controller = dependencies.controller ?? new AbortController();

  const ctx = {
    cwd,
    signal: controller.signal,
    permissions,
    ...(dayaClient ? { dayaClient } : {}),
    ...(memory ? { memory } : {}),
  } as Parameters<typeof registerTools>[2];

  registerTools(server, allTools, ctx);

  return server;
}
