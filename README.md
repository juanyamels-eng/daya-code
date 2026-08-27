# DAYA Code

[![npm version](https://img.shields.io/npm/v/daya-code.svg)](https://www.npmjs.com/package/daya-code)
[![license](https://img.shields.io/npm/l/daya-code.svg)](https://github.com/juanyamels-eng/daya-code/blob/main/LICENSE)
[![build](https://img.shields.io/badge/build-passing-brightgreen.svg)](https://github.com/juanyamels-eng/daya-code)

> Terminal code agent connected to the **DAYA suite** — AI images, web search, documents, and persistent memory.

DAYA Code is an open-source CLI agent (similar to Claude Code / OpenCode) that lives in your terminal, reads and edits your codebase, and is wired to DAYA's AI capabilities as native tools.

## Demo

```bash
# Install globally
npm install -g daya-code

# Interactive mode (TUI)
daya

# Non-interactive mode
daya --auto "list all TypeScript files in this project"

# With a real provider
export ANTHROPIC_API_KEY=sk-ant-...
daya --provider anthropic --model claude-sonnet-4-5 --auto "refactor src/index.ts"

# Generate an image
export DAYA_API_KEY=daya-...
daya --provider daya --auto "generate an image of a futuristic city at night"

# Search the web
daya --provider daya --auto "what is the latest version of Node.js?"

# Query your documents
daya --provider daya --auto "summarize the contents of docs/api.md"
```

## Features

- **6 built-in tools**: `read_file`, `write_file`, `edit_file`, `bash`, `glob`, `grep`
- **5 DAYA tools**: `daya_generate_image`, `daya_web_search`, `daya_documents_query`, `daya_memory_store`, `daya_memory_recall`
- **4 providers**: Anthropic, OpenAI, OpenRouter, DAYA (via Vercel AI SDK)
- **Ink TUI**: beautiful terminal interface with real-time streaming
- **Persistent memory**: facts and preferences remembered across sessions
- **MCP server**: expose all tools to any MCP-compatible client (Claude Desktop, Cursor, etc.)

## Providers

| Provider     | Flag               | Env var            | Notes |
|--------------|--------------------|--------------------|-------|
| `mock`       | `--provider mock`  | —                  | Default. No API key needed. |
| `anthropic`  | `--provider anthropic` | `ANTHROPIC_API_KEY` | Claude models (Sonnet 4.5, Haiku 4.5, Opus 4). |
| `openai`     | `--provider openai`    | `OPENAI_API_KEY`    | GPT-4o, GPT-4.1, o1, o3. |
| `openrouter` | `--provider openrouter` | `OPENAI_API_KEY` (any) | Multi-provider gateway. |
| `daya`       | `--provider daya`      | `DAYA_API_KEY`      | DAYA native endpoint (`https://api.daya.ai/v1`). |

If the chosen provider has no API key set, the agent silently falls back to `mock`.

## Slash commands (TUI)

- `/quit` — exit
- `/clear` — reset session
- `/model <id>` — switch model on the fly without restarting

## MCP Server

DAYA Code includes an MCP (Model Context Protocol) server that exposes all tools to any MCP-compatible client.

### Run the MCP server

```bash
# Install
npm install -g daya-code

# Start the MCP server (stdio transport)
DAYA_API_KEY=daya-... daya-mcp

# Or configure in Claude Desktop (claude_desktop_config.json):
{
  "mcpServers": {
    "daya-code": {
      "command": "daya-mcp",
      "env": {
        "DAYA_API_KEY": "daya-...",
        "DAYA_CWD": "/path/to/your/project"
      }
    }
  }
}
```

## Roadmap

- [x] **Fase 1 (MVP)** — Core agent loop, 6 file/bash tools, mock provider, Ink TUI
- [x] **Fase 2** — Real providers (Anthropic, OpenAI, OpenRouter, DAYA), streaming, `/model` command
- [x] **Fase 3** — DAYA suite tools (images, web search, documents, memory), local SQLite memory with FTS5, MCP server
- [ ] **Fase 4** — Multi-file editing, plan mode, tool confirmation dialogs
- [ ] **Fase 5** — Plugin system, custom tools, team collaboration

## Project structure

```
daya-code/
├── packages/
│   ├── core/        # @daya-code/core   — agent loop, providers, tools, sessions
│   ├── cli/         # daya-code         — Ink TUI + CLI entry (published to npm)
│   └── mcp-server/  # @daya-code/mcp-server — MCP server for external clients
├── LICENSE
└── package.json
```

## Development

```bash
# Clone
git clone https://github.com/juanyamels-eng/daya-code.git
cd daya-code

# Install
npm install

# Build all packages
npm run build

# Run tests
npm test

# Run the TUI in dev mode
npm run dev
```

## License

MIT
