export interface DayaClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export class DayaHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'DayaHttpError';
  }
}

export interface DayaRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class DayaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DayaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts: DayaRequestOptions = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    const timeout = opts.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`DAYA request timeout after ${timeout}ms`)), timeout);
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => controller.abort(opts.signal?.reason), { once: true });
    }

    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) {
        throw new DayaHttpError(res.status, text, `DAYA ${method} ${path} failed: ${res.status} ${res.statusText}`);
      }
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  fetchRaw(url: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Response> {
    const timeout = opts.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`DAYA download timeout after ${timeout}ms`)), timeout);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort(opts.signal.reason);
      else opts.signal.addEventListener('abort', () => controller.abort(opts.signal?.reason), { once: true });
    }
    return this.fetchImpl(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  generateImage(body: GenerateImageRequest, opts?: DayaRequestOptions): Promise<GenerateImageResponse> {
    return this.request('POST', '/v1/images/generations', body, opts);
  }

  webSearch(body: WebSearchRequest, opts?: DayaRequestOptions): Promise<WebSearchResponse> {
    return this.request('POST', '/v1/search', body, opts);
  }

  memoryUpsert(body: MemoryUpsertRequest, opts?: DayaRequestOptions): Promise<MemoryUpsertResponse> {
    return this.request('POST', '/v1/memory/upsert', body, opts);
  }

  memoryQuery(body: MemoryQueryRequest, opts?: DayaRequestOptions): Promise<MemoryQueryResponse> {
    return this.request('POST', '/v1/memory/query', body, opts);
  }

  documentsQuery(body: DocumentsQueryRequest, opts?: DayaRequestOptions): Promise<DocumentsQueryResponse> {
    return this.request('POST', '/v1/documents/query', body, opts);
  }
}

export interface GenerateImageRequest {
  prompt: string;
  model?: string;
  size?: '256x256' | '512x512' | '1024x1024' | '1024x1792' | '1792x1024';
  n?: number;
  savePath?: string;
}
export interface GeneratedImage {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
  savedPath?: string;
}
export interface GenerateImageResponse {
  created: number;
  data: GeneratedImage[];
}

export interface WebSearchRequest {
  query: string;
  top_k?: number;
  recency?: 'day' | 'week' | 'month' | 'year';
  site?: string;
}
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}
export interface WebSearchResponse {
  query: string;
  results: WebSearchHit[];
}

export interface MemoryUpsertRequest {
  namespace: string;
  key: string;
  value: string;
  metadata?: Record<string, unknown>;
  ttl_seconds?: number;
}
export interface MemoryUpsertResponse {
  ok: true;
  id: string;
}

export interface MemoryQueryRequest {
  namespace: string;
  query: string;
  top_k?: number;
}
export interface MemoryHit {
  key: string;
  value: string;
  score: number;
  metadata?: Record<string, unknown>;
}
export interface MemoryQueryResponse {
  results: MemoryHit[];
}

export interface DocumentsQueryRequest {
  query: string;
  top_k?: number;
  collection?: string;
  filter?: Record<string, unknown>;
}
export interface DocumentHit {
  id: string;
  title?: string;
  content: string;
  score: number;
  source?: string;
}
export interface DocumentsQueryResponse {
  results: DocumentHit[];
}
