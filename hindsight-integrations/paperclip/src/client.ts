/**
 * Minimal Hindsight HTTP client for use inside the plugin worker.
 *
 * Uses native fetch (Node 20+). No external dependencies.
 */

export interface Memory {
  text: string;
  type?: string;
}

export interface RecallResponse {
  results: Memory[];
}

export interface SynthesisResult {
  id?: string;
  insights: Array<{
    type: "entity_trend" | "pattern" | "risk" | "opportunity" | "relationship";
    entities: string[];
    summary: string;
    confidence: number;
    supporting_memories?: string[];
  }>;
  synthesis_metadata?: {
    batch_size: number;
    memory_count: number;
    synthesis_duration_ms: number;
  };
}

export interface SynthesisResponse {
  synthesis_id: string;
  status: "completed" | "in_progress";
  result?: SynthesisResult;
}

export class HindsightClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(baseUrl: string, token?: string) {
    const url = baseUrl.trim();
    if (!url) throw new Error("hindsightApiUrl is required");
    this.baseUrl = url.replace(/\/$/, "");
    this.token = token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} from ${path}: ${text}`);
      }

      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async recall(bankId: string, query: string, budget = "mid"): Promise<RecallResponse> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`;
    return this.request<RecallResponse>("POST", path, {
      query,
      budget,
      max_tokens: 1024,
    });
  }

  async retain(
    bankId: string,
    content: string,
    documentId?: string,
    metadata?: Record<string, string>,
    context = "paperclip"
  ): Promise<void> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories`;
    const item: Record<string, unknown> = {
      content,
      // Always set context — improves extraction quality (best practice)
      context,
      created_at: new Date().toISOString(),
    };
    if (documentId) item["document_id"] = documentId;
    if (metadata) item["metadata"] = metadata;
    await this.request("POST", path, { items: [item], async: true });
  }

  async initializeBank(
    bankId: string,
    config: {
      retain_mission?: string;
      observations_mission?: string;
      reflect_mission?: string;
      entity_types?: string[];
      disposition_traits?: string[];
    }
  ): Promise<void> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/init`;
    await this.request("POST", path, config);
  }

  async synthesize(
    bankId: string,
    options?: {
      entity_types?: string[];
      confidence_threshold?: number;
      max_insights?: number;
      async?: boolean;
    }
  ): Promise<SynthesisResponse> {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories/synthesize`;
    return this.request<SynthesisResponse>("POST", path, {
      entity_types: options?.entity_types,
      confidence_threshold: options?.confidence_threshold ?? 0.7,
      max_insights: options?.max_insights ?? 50,
      async: options?.async ?? false,
    });
  }

  async health(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}

export function formatMemories(memories: Memory[]): string {
  if (memories.length === 0) return "";
  return memories.map((m) => `- ${m.text}`).join("\n");
}
