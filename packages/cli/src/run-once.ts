import {
  Agent,
  defaultTools,
  AllowAllChecker,
  createProvider,
  projectMemory,
  type ProviderName,
} from '@daya-code/core';

export interface RunOnceOpts {
  prompt: string;
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  cwd: string;
}

export async function runOnce(opts: RunOnceOpts): Promise<void> {
  const pm = projectMemory(opts.cwd);
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
    daya: {
      memory: pm.memory,
      namespace: pm.namespace,
      autoRecall: true,
    },
  });

  const messages = await agent.run(opts.prompt, {
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
}
