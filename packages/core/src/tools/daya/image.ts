import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute, dirname, join, extname } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../types.js';
import { ok, err } from '../index.js';
import { DayaClient, type GeneratedImage, type GenerateImageResponse } from '../../daya/client.js';

export const GenerateImageInputSchema = z.object({
  prompt: z.string().min(1).describe('Text description of the image to generate.'),
  model: z.string().optional().describe('DAYA image model id (e.g. "daya-image-1").'),
  size: z
    .enum(['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024'])
    .optional()
    .describe('Output size. Default: 1024x1024.'),
  n: z.number().int().positive().max(4).optional().describe('How many images to generate. Default 1.'),
  savePath: z
    .string()
    .optional()
    .describe('Where to save the image(s): a file path or a directory. Relative to cwd or absolute. When omitted, nothing is written to disk — URLs are returned only.'),
});

export const GenerateImageTool: Tool = {
  definition: {
    name: 'daya_generate_image',
    description:
      'Generate one or more images from a text prompt using the DAYA API. Returns URLs and/or saves the image(s) to disk. Requires DAYA_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        model: { type: 'string' },
        size: { type: 'string', enum: ['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024'] },
        n: { type: 'number' },
        savePath: { type: 'string' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  execute: async (input, ctx) => generateImage(input, ctx),
};

export async function generateImage(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = GenerateImageInputSchema.safeParse(input);
  if (!parsed.success) return err(`Invalid input: ${parsed.error.message}`);

  const client = ctxDayaClient(ctx);
  if (!client) return err('DAYA_API_KEY is not set; cannot call daya_generate_image.');

  const { prompt, model, size, n = 1, savePath } = parsed.data;

  let res: GenerateImageResponse;
  try {
    res = await client.generateImage({ prompt, model, size, n }, { signal: ctx.signal });
  } catch (e) {
    return err(`DAYA image generation failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const saved: string[] = [];
  if (savePath) {
    const baseAbs = isAbsolute(savePath) ? savePath : resolve(ctx.cwd, savePath);
    for (let i = 0; i < res.data.length; i += 1) {
      const item = res.data[i]!;
      const ext = pickExt(item);
      const target = extname(baseAbs) ? baseAbs : join(baseAbs, `${Date.now()}-${i}.${ext}`);

      // Same approval path as write_file: saving to disk is a mutating action
      // and must not happen silently without a permission check.
      const decision = await ctx.permissions.check({ kind: 'write_file', path: target });
      if (!decision.allowed) {
        return err(`Permission denied for saving image to ${target}: ${decision.reason ?? 'no reason given'}`);
      }

      try {
        await mkdir(dirname(target), { recursive: true });
        if (item.b64_json) {
          await writeFile(target, Buffer.from(item.b64_json, 'base64'));
        } else if (item.url) {
          const fetched = await client.fetchRaw(item.url, { signal: ctx.signal });
          if (!fetched.ok) {
            return err(`Failed to download image from ${item.url}: HTTP ${fetched.status}`);
          }
          const buf = Buffer.from(await fetched.arrayBuffer());
          await writeFile(target, buf);
        } else {
          return err('DAYA image response had neither url nor b64_json');
        }
        saved.push(target);
        item.savedPath = target;
      } catch (e) {
        return err(`Failed to save image: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const lines = res.data.map((d, i) => {
    const parts: string[] = [`#${i + 1}`];
    if (d.savedPath) parts.push(`saved=${d.savedPath}`);
    else if (d.url) parts.push(`url=${d.url}`);
    if (d.revised_prompt) parts.push(`revised="${d.revised_prompt}"`);
    return parts.join(' ');
  });
  return ok(lines.join('\n'), { count: res.data.length, saved, data: res.data });
}

function pickExt(img: GeneratedImage): string {
  if (img.url) {
    const m = /\.([a-zA-Z0-9]{2,5})(?:\?|$)/.exec(img.url);
    if (m) return m[1]!.toLowerCase();
  }
  return 'png';
}

function ctxDayaClient(ctx: ToolContext): DayaClient | null {
  return ctx.dayaClient ?? null;
}
