#!/usr/bin/env node
import meow from 'meow';
import React from 'react';
import { render } from 'ink';
import { App } from './tui/App.js';
import { loadConfig, envOverrides, type ProviderName } from '@daya-code/core';

const cli = meow(
  `
    Usage
      $ daya [prompt]

    Options
      --cwd <path>        Working directory (default: current)
      --provider <name>   mock | anthropic | openai | openrouter | daya
      --model <name>      Model id
      --auto              Run prompt non-interactively and exit
      --architect         Two-pass mode: plan then execute
      --help              Show this help

    Environment
      DAYA_API_KEY       API key for the DAYA provider
      ANTHROPIC_API_KEY  API key when using --provider anthropic
      OPENAI_API_KEY     API key when using --provider openai
      DAYA_PROVIDER      Override --provider
      DAYA_MODEL         Override --model
  `,
  {
    importMeta: import.meta,
    flags: {
      cwd: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      auto: { type: 'boolean', default: false },
      architect: { type: 'boolean', default: false },
    },
  },
);

const VALID_PROVIDERS: ProviderName[] = ['mock', 'anthropic', 'openai', 'openrouter', 'daya'];

async function main(): Promise<void> {
  const cfg = envOverrides(await loadConfig());

  const providerName = (cli.flags.provider ?? cfg.provider.name) as ProviderName;
  if (!VALID_PROVIDERS.includes(providerName)) {
    console.error(`Unknown provider: ${providerName}. Valid: ${VALID_PROVIDERS.join(', ')}`);
    process.exit(2);
  }
  const model = cli.flags.model ?? cfg.provider.model;
  const cwd = cli.flags.cwd ?? process.cwd();
  const apiKey = cfg.provider.apiKey;
  const baseUrl = cfg.provider.baseUrl;

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
