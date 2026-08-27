#!/usr/bin/env node
import meow from 'meow';
import React from 'react';
import { render } from 'ink';
import { App } from './tui/App.js';
import { loadConfig, envOverrides, PRESET_NAMES, type ProviderName } from '@daya-code/core';

const cli = meow(
  `
    Usage
      $ daya [prompt]

    Options
      --cwd <path>        Working directory (default: current)
      --provider <name>   mock | anthropic | openai | openrouter | daya | openai-compatible
                          free presets: ${PRESET_NAMES.join(' | ')}
      --model <name>      Model id
      --base-url <url>    OpenAI-compatible API base URL (for openai-compatible providers)
      --api-key <key>     API key (overrides config/env)
      --auto              Run prompt non-interactively and exit
      --architect         Two-pass mode: plan then execute
      --help              Show this help

    Environment
      DAYA_API_KEY       API key for the DAYA provider
      ANTHROPIC_API_KEY  API key when using --provider anthropic
      OPENAI_API_KEY     API key when using --provider openai
      DAYA_PROVIDER      Override --provider
      DAYA_MODEL         Override --model
      DAYA_BASE_URL      Override --base-url

    Free presets (permanent free tier, no credit card)
      --provider groq            Llama 3.3 70B @ api.groq.com       (key: console.groq.com)
      --provider cerebras        Llama 3.3 70B @ api.cerebras.ai    (key: cloud.cerebras.ai)
      --provider gemini          Gemini 2.5 Flash, 1M ctx           (key: aistudio.google.com)
      --provider github-models   GPT-4.1 / o4-mini via GitHub Models
      --provider nvidia          DeepSeek, Qwen3, Llama via NVIDIA NIM
      --provider mistral         mistral-small (1B tokens/month free)
      --provider huggingface     Llama/Qwen via HuggingFace router
      --provider ollama          Local models (no key) @ http://localhost:11434
      --provider openrouter --model openrouter/free   auto-routes to any free model
      --provider openai-compatible --base-url <url> --model <id>  any OpenAI-compatible endpoint
  `,
  {
    importMeta: import.meta,
    flags: {
      cwd: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      auto: { type: 'boolean', default: false },
      architect: { type: 'boolean', default: false },
      baseUrl: { type: 'string' },
      apiKey: { type: 'string' },
    },
  },
);

const VALID_PROVIDERS: ProviderName[] = ['mock', 'anthropic', 'openai', 'openrouter', 'daya', 'openai-compatible', ...PRESET_NAMES];

async function main(): Promise<void> {
  const cfg = envOverrides(await loadConfig());

  const providerName = (cli.flags.provider ?? cfg.provider.name) as ProviderName;
  if (!VALID_PROVIDERS.includes(providerName)) {
    console.error(`Unknown provider: ${providerName}. Valid: ${VALID_PROVIDERS.join(', ')}`);
    process.exit(2);
  }
  const model = cli.flags.model ?? cfg.provider.model;
  const cwd = cli.flags.cwd ?? process.cwd();
  const apiKey = cli.flags.apiKey ?? cfg.provider.apiKey;
  const baseUrl = cli.flags.baseUrl ?? cfg.provider.baseUrl;

  if (cli.flags.auto) {
    const prompt = cli.input.join(' ').trim();
    if (!prompt) {
      console.error('daya --auto requires a prompt');
      process.exit(2);
    }
    const { runOnce } = await import('./run-once.js');
    await runOnce({ prompt, provider: providerName, model, apiKey, baseUrl, cwd });
    return;
  }

  render(
    React.createElement(App, {
      initialPrompt: cli.input.join(' '),
      provider: providerName,
      model,
      apiKey,
      baseUrl,
      cwd,
      sessionsDir: cfg.sessions.dir,
      lintCmd: cfg.lintCmd,
      testCmd: cfg.testCmd,
      autoCommit: cfg.autoCommit,
      architectModel: cfg.architectModel,
      theme: cfg.theme,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
