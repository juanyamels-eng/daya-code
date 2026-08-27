import type { Tool, ToolContext } from '../../types.js';
import { GenerateImageTool, generateImage } from './image.js';
import { WebSearchTool, webSearch } from './web_search.js';
import { DocumentsQueryTool, documentsQuery } from './documents.js';
import { MemoryStoreTool, memoryStore } from './memory_store.js';
import { MemoryRecallTool, memoryRecall } from './memory_recall.js';
import { DayaClient } from '../../daya/client.js';
import { LocalMemory } from '../../dayamemory/local.js';

export {
  GenerateImageTool,
  generateImage,
  WebSearchTool,
  webSearch,
  DocumentsQueryTool,
  documentsQuery,
  MemoryStoreTool,
  memoryStore,
  MemoryRecallTool,
  memoryRecall,
};

export const ALL_DAYA_TOOLS: Tool[] = [
  GenerateImageTool,
  WebSearchTool,
  DocumentsQueryTool,
  MemoryStoreTool,
  MemoryRecallTool,
];

export function dayaToolsRequiringApiKey(): string[] {
  return ['daya_generate_image', 'daya_web_search', 'daya_documents_query'];
}

export function localOnlyDayaTools(): string[] {
  return ['daya_memory_store', 'daya_memory_recall'];
}

export interface DayaContextExtras {
  memory?: import('../../dayamemory/local.js').LocalMemory;
  dayaClient?: import('../../daya/client.js').DayaClient;
}

export function attachDayaExtras(ctx: ToolContext, extras: DayaContextExtras): ToolContext {
  return { ...ctx, ...extras };
}
