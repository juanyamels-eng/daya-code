import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildServer, type BuildServerOptions } from '../src/server.js';

function createTestServer(opts: BuildServerOptions = {}): McpServer {
  return buildServer({
    cwd: process.cwd(),
    ...opts,
  });
}

describe('buildServer', () => {
  it('returns a McpServer instance', () => {
    const server = createTestServer();
    expect(server).toBeInstanceOf(McpServer);
  });

  it('registers 11 tools (6 built-in + 5 DAYA)', async () => {
    const server = createTestServer();
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(11);

    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('bash');
    expect(names).toContain('glob');
    expect(names).toContain('grep');
    expect(names).toContain('daya_generate_image');
    expect(names).toContain('daya_web_search');
    expect(names).toContain('daya_documents_query');
    expect(names).toContain('daya_memory_store');
    expect(names).toContain('daya_memory_recall');

    await client.close();
    await server.close();
  });

  it('each tool has name, description, and inputSchema', async () => {
    const server = createTestServer();
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }

    await client.close();
    await server.close();
  });

  it('can call a tool via MCP protocol', async () => {
    const server = createTestServer();
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'glob',
      arguments: { pattern: '*.json' },
    });

    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);

    const first = result.content[0] as { type: string; text: string };
    expect(first.type).toBe('text');
    expect(typeof first.text).toBe('string');

    await client.close();
    await server.close();
  });
});
