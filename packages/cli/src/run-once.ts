import { join } from 'node:path';
import {
  Agent,
  defaultTools,
  AllowAllChecker,
  createProvider,
  projectMemory,
  loadConventions,
  type ProviderName,
} from '@daya-code/core';

export interface RunOnceOpts {
  prompt: string;
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  cwd: string;
  lintCmd?: string;
  testCmd?: string;
  autoCommit?: boolean;
}

export async function runOnce(opts: RunOnceOpts): Promise<void> {
  const pm = projectMemory(opts.cwd);
  const conventions = await loadConventions(opts.cwd);

  // Wire Ctrl+C straight into the agent so a long --auto run stops promptly.
  const controller = new AbortController();
  let hardExit = false;
  const onSigint = () => {
    if (hardExit) process.exit(130);
    hardExit = true;
    process.stderr.write('\n[interrupt — aborting run, press Ctrl+C again to force exit]\n');
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  const agent = new Agent({
    provider: createProvider({
      name: opts.provider,
      model: opts.model,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
    }),
    tools: defaultTools(),
    permissions: new AllowAllChecker(),
    cwd: opts.cwd,
    conventions,
    lintCmd: opts.lintCmd,
    testCmd: opts.testCmd,
    autoCommit: opts.autoCommit,
    watchFiles: true,
    memoryFile: join(opts.cwd, 'DAYA.md'),
    daya: {
      memory: pm.memory,
      namespace: pm.namespace,
      autoRecall: true,
    },
  });

  try {
    const messages = await agent.run(opts.prompt, {
      signal: controller.signal,
      mode: 'build',
      onEvent: (e) => {
        if (e.type === 'assistant_text_delta') {
          const d = (e.data as { delta: string }).delta;
          process.stdout.write(d);
        } else if (e.type === 'tool_finished') {
          const { name, result } = e.data as { name: string; result: { output: string; isError?: boolean } };
          process.stderr.write(`\n[tool:${name}] ${result.isError ? 'ERROR: ' : ''}${result.output}\n`);
        } else if (e.type === 'done') {
          process.stderr.write(`\n[done]\n`);
        }
      },
    });
    await agent.persistMemories(messages);
  } finally {
    process.off('SIGINT', onSigint);
    agent.stopWatcher();
  }
}