<div align="center">

# ⚡ DAYA Code

**The first terminal agent connected to a full AI suite.**

Not just another code assistant. DAYA Code lives in your terminal, edits your code, generates images, searches the web, queries your documents, and remembers everything — all from one command.

[![npm version](https://img.shields.io/npm/v/daya-code?style=flat-square&color=blue)](https://www.npmjs.com/package/daya-code)
[![license](https://img.shields.io/npm/l/daya-code?style=flat-square)](https://github.com/juanyamels-eng/daya-code/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-34%20passing-brightgreen?style=flat-square)](https://github.com/juanyamels-eng/daya-code)

</div>

---

## Demo

<!-- Replace this placeholder with a real GIF -->

```
$ daya "create a todo app with React and Tailwind"

✓ read_file  src/App.tsx
✓ write_file src/App.tsx          — created React component
✓ write_file src/index.css        — added Tailwind imports
✓ bash       npm install tailwindcss

Done. Created 3 files in 12s.
```

> **Coming soon:** terminal recording showing real-time streaming, image generation, and web search.

---

## Why DAYA Code?

Most terminal agents stop at reading and writing files. DAYA Code goes further.

| Feature | Claude Code | OpenCode | **DAYA Code** |
|---------|:-----------:|:--------:|:-------------:|
| Read / write / edit files | ✅ | ✅ | ✅ |
| Bash execution | ✅ | ✅ | ✅ |
| Real-time streaming | ✅ | ✅ | ✅ |
| Multiple providers | ❌ | ✅ | ✅ |
| AI image generation | ❌ | ❌ | ✅ |
| Web search | ❌ | ❌ | ✅ |
| Document querying | ❌ | ❌ | ✅ |
| Persistent memory | ❌ | ❌ | ✅ |
| MCP server | ❌ | ❌ | ✅ |
| Open source | ❌ | ✅ | ✅ |

**In short:** other agents edit code. DAYA Code edits code **and** connects to a full AI suite — images, search, docs, memory — all native, no plugins needed.

---

## Quickstart

### 1. Install

```bash
npm install -g daya-code
```

### 2. Run

```bash
# Interactive mode (beautiful TUI)
daya

# One-shot mode
daya --auto "list all TypeScript files in this project"
```

### 3. Connect a provider (optional)

```bash
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
export OPENAI_API_KEY=sk-...

# DAYA (full suite: images, search, docs, memory)
export DAYA_API_KEY=daya-...

daya --provider anthropic --auto "refactor src/index.ts"
```

> No API key? No problem. DAYA Code runs with a **mock provider** by default — perfect for exploring.

---

## DAYA Suite Tools

When connected to a DAYA provider, you unlock 5 additional tools:

| Tool | What it does |
|------|-------------|
| `daya_generate_image` | Generate images from text prompts |
| `daya_web_search` | Search the web in real-time |
| `daya_documents_query` | Query and summarize documents |
| `daya_memory_store` | Save facts and preferences |
| `daya_memory_recall` | Recall what was stored (with FTS5 search) |

Memory persists across sessions. The agent remembers your preferences, project context, and past conversations.

---

## Providers

| Provider | Flag | Env Var | Models |
|----------|------|---------|--------|
| `mock` | `--provider mock` | — | Default. No API key needed. |
| `anthropic` | `--provider anthropic` | `ANTHROPIC_API_KEY` | Claude Sonnet 4.5, Haiku 4.5, Opus 4 |
| `openai` | `--provider openai` | `OPENAI_API_KEY` | GPT-4o, GPT-4.1, o1, o3 |
| `openrouter` | `--provider openrouter` | `OPENAI_API_KEY` | Multi-provider gateway |
| `daya` | `--provider daya` | `DAYA_API_KEY` | Full DAYA suite access |

---

## MCP Server

DAYA Code includes an MCP server. Use it with Claude Desktop, Cursor, or any MCP client.

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "daya-code": {
      "command": "daya-mcp",
      "env": {
        "DAYA_API_KEY": "daya-..."
      }
    }
  }
}
```

---

## Roadmap

- [x] **Phase 1** — Core agent loop, 6 tools, mock provider, Ink TUI
- [x] **Phase 2** — Real providers, streaming, `/model` command
- [x] **Phase 3** — DAYA suite tools, SQLite memory with FTS5, MCP server
- [ ] **Phase 4** — Multi-file editing, plan mode, tool confirmations
- [ ] **Phase 5** — Plugin system, custom tools, team collaboration

---

## Contributing

Contributions welcome!

```bash
git clone https://github.com/juanyamels-eng/daya-code.git
cd daya-code
npm install
npm run build
npm test
```

Please open an issue first to discuss what you'd like to change.

---

## License

[MIT](LICENSE) © [juanyamels-eng](https://github.com/juanyamels-eng)
