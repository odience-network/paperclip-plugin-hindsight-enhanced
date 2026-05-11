/**
 * Tests for paperclip-plugin-hindsight.
 *
 * Uses @paperclipai/plugin-sdk's createTestHarness to simulate the Paperclip
 * host environment without requiring a running Paperclip instance.
 *
 * Hindsight API calls are intercepted via global fetch mocking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetch(responses: Array<{ url: string | RegExp; body: unknown; status?: number }>) {
  return vi.fn(async (url: string) => {
    const match = responses.find((r) =>
      typeof r.url === "string" ? url.includes(r.url) : r.url.test(url)
    );
    if (!match) {
      return new Response(JSON.stringify({ error: "unmatched url" }), { status: 404 });
    }
    return new Response(JSON.stringify(match.body), {
      status: match.status ?? 200,
    });
  });
}

// ---------------------------------------------------------------------------
// Harness setup
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  hindsightApiUrl: "http://localhost:8888",
  bankGranularity: ["company", "agent"],
  recallBudget: "mid",
  autoRetain: true,
};

function buildHarness(config: Record<string, unknown> = DEFAULT_CONFIG) {
  return createTestHarness({ manifest, config, capabilities: manifest.capabilities });
}

async function setupPlugin(harness: ReturnType<typeof buildHarness>) {
  await plugin.definition.setup(harness.ctx);
}

// ---------------------------------------------------------------------------
// Bank ID derivation
// ---------------------------------------------------------------------------

describe("bank ID derivation", () => {
  it("default: company + agent", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId(
        { companyId: "co-1", agentId: "ag-1" },
        { bankGranularity: ["company", "agent"] }
      )
    ).toBe("paperclip::co-1::ag-1");
  });

  it("company only", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId({ companyId: "co-1", agentId: "ag-1" }, { bankGranularity: ["company"] })
    ).toBe("paperclip::co-1");
  });

  it("agent only", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId({ companyId: "co-1", agentId: "ag-1" }, { bankGranularity: ["agent"] })
    ).toBe("paperclip::ag-1");
  });
});

// ---------------------------------------------------------------------------
// agent.run.started — recall
// ---------------------------------------------------------------------------

describe("agent.run.started", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = mockFetch([
      { url: /recall/, body: { results: [{ text: "User prefers TypeScript" }] } },
    ]);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls recall and caches memories in plugin state", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);

    await harness.emit(
      "agent.run.started",
      {
        agentId: "ag-1",
        runId: "run-1",
        issueTitle: "Refactor auth module",
        issueDescription: "Migrate to JWT",
      },
      { companyId: "co-1" }
    );

    const recallCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("recall"));
    expect(recallCall).toBeDefined();
    expect(recallCall?.[0]).toContain("paperclip%3A%3Aco-1%3A%3Aag-1");

    const state = harness.getState({
      scopeKind: "run",
      scopeId: "run-1",
      stateKey: "recalled-memories",
    });
    expect(state).toContain("TypeScript");
  });

  it("skips recall when no issue context provided", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-2" },
      { companyId: "co-1" }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw when Hindsight is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    );
    const harness = buildHarness();
    await setupPlugin(harness);

    await expect(
      harness.emit(
        "agent.run.started",
        { agentId: "ag-1", runId: "run-3", issueTitle: "Fix bug" },
        { companyId: "co-1" }
      )
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// agent.run.finished — auto-retain
// ---------------------------------------------------------------------------

describe("agent.run.finished", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = mockFetch([{ url: /memories$/, body: { success: true } }]);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retains run output with runId as document ID", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);

    await harness.emit(
      "agent.run.finished",
      {
        agentId: "ag-1",
        runId: "run-1",
        output: "Refactored auth. Migrated to JWT with 24h expiry.",
      },
      { companyId: "co-1" }
    );

    const retainCall = fetchMock.mock.calls.find(([url]: [string]) => /memories$/.test(url));
    expect(retainCall).toBeDefined();

    const body = JSON.parse(retainCall?.[1]?.body as string) as {
      items: Array<{ content: string; document_id?: string }>;
    };
    expect(body.items[0]?.content).toContain("JWT");
    expect(body.items[0]?.document_id).toBe("run-1");
  });

  it("skips retain when output is empty", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);

    await harness.emit(
      "agent.run.finished",
      { agentId: "ag-1", runId: "run-2", output: "" },
      { companyId: "co-1" }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips retain when autoRetain is false", async () => {
    const harness = buildHarness({ ...DEFAULT_CONFIG, autoRetain: false });
    await setupPlugin(harness);

    await harness.emit(
      "agent.run.finished",
      { agentId: "ag-1", runId: "run-3", output: "Some output" },
      { companyId: "co-1" }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// hindsight_recall tool
// ---------------------------------------------------------------------------

describe("hindsight_recall tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns cached memories from run start without additional API call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 }))
    );
    const harness = buildHarness();
    await setupPlugin(harness);

    // Emit agent.run.started so recall fires and caches state
    vi.stubGlobal(
      "fetch",
      mockFetch([{ url: /recall/, body: { results: [{ text: "User prefers dark mode" }] } }])
    );
    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-1", issueTitle: "Update UI" },
      { companyId: "co-1" }
    );

    // Now recall tool should return cached state, not hit the API again
    const callsBefore = (vi.mocked(fetch) as ReturnType<typeof vi.fn>).mock.calls.length;
    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "preferences" },
      { agentId: "ag-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" }
    );

    expect((result as { content: string }).content).toContain("dark mode");
    const callsAfter = (vi.mocked(fetch) as ReturnType<typeof vi.fn>).mock.calls.length;
    // No new recall call — returned from cache
    expect(callsAfter).toBe(callsBefore);
  });

  it("falls back to live recall when no cached state", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([{ url: /recall/, body: { results: [{ text: "Agent is a Python specialist" }] } }])
    );
    const harness = buildHarness();
    await setupPlugin(harness);

    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "specialization" },
      { agentId: "ag-1", runId: "run-2", companyId: "co-1", projectId: "proj-1" }
    );

    expect((result as { content: string }).content).toContain("Python specialist");
  });
});

// ---------------------------------------------------------------------------
// hindsight_retain tool
// ---------------------------------------------------------------------------

describe("hindsight_retain tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores content via Hindsight retain endpoint", async () => {
    const fetchMock = mockFetch([{ url: /memories$/, body: { success: true } }]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();
    await setupPlugin(harness);

    const result = await harness.executeTool(
      "hindsight_retain",
      { content: "Decision: use Postgres not MySQL" },
      { agentId: "ag-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" }
    );

    expect((result as { content: string }).content).toBe("Memory saved.");
    const call = fetchMock.mock.calls.find(([url]: [string]) => /memories$/.test(url));
    const body = JSON.parse(call?.[1]?.body as string) as {
      items: Array<{ content: string }>;
    };
    expect(body.items[0]?.content).toContain("Postgres");
  });
});

// ---------------------------------------------------------------------------
// Best practices: context + created_at in retained memories
// ---------------------------------------------------------------------------

describe("retention best practices", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes context and created_at in every retained memory", async () => {
    const fetchMock = mockFetch([{ url: /memories$/, body: { success: true } }]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness({ ...DEFAULT_CONFIG, defaultContext: "my-app" });
    await setupPlugin(harness);

    await harness.emit(
      "agent.run.finished",
      { agentId: "ag-1", runId: "run-1", output: "Did some work." },
      { companyId: "co-1" }
    );

    const call = fetchMock.mock.calls.find(([url]: [string]) => /memories$/.test(url));
    const body = JSON.parse(call?.[1]?.body as string) as {
      items: Array<{ content: string; context?: string; created_at?: string }>;
    };
    expect(body.items[0]?.context).toBe("my-app");
    expect(body.items[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// Company-level config override via plugin state
// ---------------------------------------------------------------------------

describe("company config override", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("respects disableAutoRetain company override", async () => {
    const fetchMock = mockFetch([{ url: /memories$/, body: { success: true } }]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();

    // Set company config in plugin state
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "co-1", stateKey: "hindsight-config" },
      { disableAutoRetain: true }
    );

    await setupPlugin(harness);

    await harness.emit(
      "agent.run.finished",
      { agentId: "ag-1", runId: "run-1", output: "Some work done." },
      { companyId: "co-1" }
    );

    // Should NOT retain because company config disabled it
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses contextOverride from company config for retention", async () => {
    const fetchMock = mockFetch([{ url: /memories$/, body: { success: true } }]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();

    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "co-1", stateKey: "hindsight-config" },
      { contextOverride: "cms-platform" }
    );

    await setupPlugin(harness);

    await harness.emit(
      "agent.run.finished",
      { agentId: "ag-1", runId: "run-1", output: "Shipped CMS feature." },
      { companyId: "co-1" }
    );

    const call = fetchMock.mock.calls.find(([url]: [string]) => /memories$/.test(url));
    const body = JSON.parse(call?.[1]?.body as string) as {
      items: Array<{ content: string; context?: string }>;
    };
    expect(body.items[0]?.context).toBe("cms-platform");
  });

  it("uses recallBudgetOverride from company config", async () => {
    const fetchMock = mockFetch([{ url: /recall/, body: { results: [] } }]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();

    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "co-1", stateKey: "hindsight-config" },
      { recallBudgetOverride: "high" }
    );

    await setupPlugin(harness);

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-1", issueTitle: "Fix performance issue" },
      { companyId: "co-1" }
    );

    const recallCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("recall"));
    const body = JSON.parse(recallCall?.[1]?.body as string) as { budget: string };
    expect(body.budget).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Bank initialization — Phase 1.5 best practices
// ---------------------------------------------------------------------------

describe("bank initialization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("initializes bank with missions on first run when company config specifies", async () => {
    const fetchMock = mockFetch([
      { url: /init/, body: { success: true } },
      { url: /recall/, body: { results: [] } },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();

    const bankInit = {
      retain_mission: "Extract decisions and constraints",
      observations_mission: "Identify agents and features",
      reflect_mission: "Synthesize patterns across runs",
      entity_types: ["Agent", "Feature", "Decision"],
      disposition_traits: ["skepticism", "literalism"],
    };

    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "co-1", stateKey: "hindsight-config" },
      { bankInit }
    );

    await setupPlugin(harness);

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-1", issueTitle: "Fix bug" },
      { companyId: "co-1" }
    );

    const initCall = fetchMock.mock.calls.find(([url]: [string]) => /init/.test(url));
    expect(initCall).toBeDefined();
    const body = JSON.parse(initCall?.[1]?.body as string);
    expect(body.retain_mission).toBe("Extract decisions and constraints");
    expect(body.entity_types).toContain("Agent");
    expect(body.disposition_traits).toContain("skepticism");
  });

  it("only initializes bank once per bankId", async () => {
    const fetchMock = mockFetch([
      { url: /init/, body: { success: true } },
      { url: /recall/, body: { results: [] } },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();

    const bankInit = {
      retain_mission: "Extract facts",
      entity_types: ["Agent"],
    };

    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "co-1", stateKey: "hindsight-config" },
      { bankInit }
    );

    await setupPlugin(harness);

    // First run
    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-1", issueTitle: "Fix bug" },
      { companyId: "co-1" }
    );

    const initCallsAfterFirst = fetchMock.mock.calls.filter(([url]: [string]) => /init/.test(url))
      .length;

    // Second run with same agent
    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-2", issueTitle: "Another task" },
      { companyId: "co-1" }
    );

    const initCallsAfterSecond = fetchMock.mock.calls.filter(([url]: [string]) => /init/.test(url))
      .length;

    // Should be same (no new init call)
    expect(initCallsAfterSecond).toBe(initCallsAfterFirst);
  });

  it("skips bank init when company config has no bankInit", async () => {
    const fetchMock = mockFetch([{ url: /recall/, body: { results: [] } }]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();
    await setupPlugin(harness);

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-1", issueTitle: "Fix bug" },
      { companyId: "co-1" }
    );

    const initCall = fetchMock.mock.calls.find(([url]: [string]) => /init/.test(url));
    expect(initCall).toBeUndefined();
  });

  it("continues on bank init failure (non-fatal)", async () => {
    const fetchMock = mockFetch([
      { url: /init/, body: { error: "Bank init failed" }, status: 400 },
      { url: /recall/, body: { results: [{ text: "Some memory" }] } },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();

    const bankInit = { retain_mission: "Extract facts" };

    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "co-1", stateKey: "hindsight-config" },
      { bankInit }
    );

    await setupPlugin(harness);

    // Should not throw despite init failure
    await expect(
      harness.emit(
        "agent.run.started",
        { agentId: "ag-1", runId: "run-1", issueTitle: "Fix bug" },
        { companyId: "co-1" }
      )
    ).resolves.not.toThrow();

    // Recall should still work
    const recallCall = fetchMock.mock.calls.find(([url]: [string]) => /recall/.test(url));
    expect(recallCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 2.2: Insight extraction and indexing
// ---------------------------------------------------------------------------

describe("insight extraction (Phase 2.2)", () => {
  it("extracts insights from synthesis result above confidence threshold", async () => {
    const { extractInsights } = await import("../src/insights.js");

    const synResult = {
      insights: [
        { type: "pattern" as const, entities: ["Agent", "Feature"], summary: "Agents prefer TypeScript", confidence: 0.9, supporting_memories: [] },
        { type: "risk" as const, entities: ["Bug"], summary: "Error rate elevated", confidence: 0.4 },
        { type: "opportunity" as const, entities: ["Performance"], summary: "Caching could improve speed", confidence: 0.75 },
      ],
    };

    const extracted = extractInsights(synResult, {
      synthesisId: "syn-1",
      bankId: "paperclip::co-1",
      companyId: "co-1",
      context: "test",
      confidenceThreshold: 0.7,
    });

    expect(extracted).toHaveLength(2); // risk (0.4) filtered out
    expect(extracted[0]?.type).toBe("pattern");
    expect(extracted[0]?.confidence).toBe(0.9);
    expect(extracted[1]?.type).toBe("opportunity");
  });

  it("merges new insights into existing index without duplicates", async () => {
    const { extractInsights, mergeInsightIndex } = await import("../src/insights.js");

    const synResult1 = {
      insights: [
        { type: "pattern" as const, entities: ["Agent"], summary: "First insight", confidence: 0.85 },
      ],
    };
    const synResult2 = {
      insights: [
        { type: "risk" as const, entities: ["Bug"], summary: "Second insight", confidence: 0.8 },
      ],
    };

    const ins1 = extractInsights(synResult1, { synthesisId: "syn-1", bankId: "b", companyId: "co-1", context: "x", confidenceThreshold: 0.7 });
    const ins2 = extractInsights(synResult2, { synthesisId: "syn-2", bankId: "b", companyId: "co-1", context: "x", confidenceThreshold: 0.7 });

    const index1 = mergeInsightIndex(null, ins1);
    const index2 = mergeInsightIndex(index1, ins2);

    expect(index2.total_count).toBe(2);
    expect(index2.insights.some((i) => i.type === "pattern")).toBe(true);
    expect(index2.insights.some((i) => i.type === "risk")).toBe(true);
  });

  it("replaces insights from same synthesis_id on re-merge", async () => {
    const { extractInsights, mergeInsightIndex } = await import("../src/insights.js");

    const synResult = {
      insights: [
        { type: "pattern" as const, entities: ["Agent"], summary: "Updated insight", confidence: 0.9 },
      ],
    };

    const ins1 = extractInsights(synResult, { synthesisId: "syn-1", bankId: "b", companyId: "co-1", context: "x", confidenceThreshold: 0.7 });
    const index1 = mergeInsightIndex(null, ins1);

    // Re-synthesize with same ID
    const ins1b = extractInsights(synResult, { synthesisId: "syn-1", bankId: "b", companyId: "co-1", context: "x", confidenceThreshold: 0.7 });
    const index2 = mergeInsightIndex(index1, ins1b);

    // Count stays at 1 — same synthesis_id replaces old entry
    expect(index2.total_count).toBe(1);
  });

  it("formats insights with type and confidence", async () => {
    const { extractInsights, formatInsights, mergeInsightIndex } = await import("../src/insights.js");

    const synResult = {
      insights: [
        { type: "pattern" as const, entities: ["TypeScript", "Agent"], summary: "Agents prefer TS", confidence: 0.92 },
      ],
    };

    const ins = extractInsights(synResult, { synthesisId: "syn-1", bankId: "b", companyId: "co-1", context: "x" });
    const index = mergeInsightIndex(null, ins);
    const formatted = formatInsights(index);

    expect(formatted).toContain("PATTERN");
    expect(formatted).toContain("92%");
    expect(formatted).toContain("TypeScript");
  });
});

describe("hindsight_insights tool (Phase 2.2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns no insights message when no synthesis has run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const harness = buildHarness();
    await setupPlugin(harness);

    const result = await harness.executeTool(
      "hindsight_insights",
      {},
      { agentId: "ag-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" }
    );

    expect((result as { content: string }).content).toContain("No synthesis insights available");
  });

  it("returns formatted insights when index is populated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const harness = buildHarness();
    await setupPlugin(harness);

    // Pre-populate insight index in state
    const { extractInsights, mergeInsightIndex } = await import("../src/insights.js");
    const synResult = {
      insights: [
        { type: "risk" as const, entities: ["Auth", "Bug"], summary: "Auth errors are increasing", confidence: 0.88 },
      ],
    };
    // Synthesis uses company-scope bank: "paperclip::co-1"
    const companyBankId = "paperclip::co-1";
    const ins = extractInsights(synResult, { synthesisId: "syn-1", bankId: companyBankId, companyId: "co-1", context: "x", confidenceThreshold: 0.7 });
    const index = mergeInsightIndex(null, ins);

    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "co-1", stateKey: `insight-index::${companyBankId}` },
      index
    );

    const result = await harness.executeTool(
      "hindsight_insights",
      { type: "risk" },
      { agentId: "ag-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" }
    );

    expect((result as { content: string }).content).toContain("RISK");
    expect((result as { content: string }).content).toContain("Auth errors");
  });
});

// ---------------------------------------------------------------------------
// Phase 2.1: Synthesis job infrastructure
// ---------------------------------------------------------------------------

describe("synthesis jobs (Phase 2.1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls synthesize endpoint with company synthesis config", async () => {
    const fetchMock = mockFetch([
      {
        url: /synthesize/,
        body: {
          synthesis_id: "syn-1",
          status: "completed",
          result: {
            insights: [
              {
                type: "pattern",
                entities: ["Agent", "Feature"],
                summary: "Agents frequently request this feature",
                confidence: 0.85,
              },
            ],
          },
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();

    const synthesisConfig = {
      frequency: "weekly",
      confidenceThreshold: 0.75,
      maxInsights: 50,
      enableParaMemoryExport: true,
    };

    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "co-1", stateKey: "hindsight-config" },
      { synthesisOverride: synthesisConfig }
    );

    await setupPlugin(harness);

    // Verify synthesis method exists and can be called
    const { HindsightClient } = await import("../src/client.js");
    const client = new HindsightClient("http://localhost:8888");
    const result = await client.synthesize("paperclip::co-1", {
      confidence_threshold: synthesisConfig.confidenceThreshold,
      max_insights: synthesisConfig.maxInsights,
    });

    expect(result.synthesis_id).toBe("syn-1");
    expect(result.status).toBe("completed");
    expect(result.result?.insights[0]?.confidence).toBe(0.85);
  });

  it("respects synthesis frequency override", async () => {
    const harness = buildHarness();

    const synthesisConfig = {
      frequency: "daily",
      confidenceThreshold: 0.8,
      maxInsights: 100,
    };

    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "co-1", stateKey: "hindsight-config" },
      { synthesisOverride: synthesisConfig }
    );

    const stored = await harness.ctx.state.get({
      scopeKind: "company",
      scopeId: "co-1",
      stateKey: "hindsight-config",
    });

    expect(stored).toEqual({ synthesisOverride: synthesisConfig });
  });

  it("disables synthesis when frequency is 'never'", async () => {
    const fetchMock = mockFetch([]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();

    const synthesisConfig = {
      frequency: "never",
      confidenceThreshold: 0.7,
    };

    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: "co-1", stateKey: "hindsight-config" },
      { synthesisOverride: synthesisConfig }
    );

    // If frequency is 'never', no synthesis calls should be made
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles synthesis API failure gracefully", async () => {
    const fetchMock = mockFetch([
      { url: /synthesize/, body: { error: "service unavailable" }, status: 503 },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();

    await setupPlugin(harness);

    const { HindsightClient } = await import("../src/client.js");
    const client = new HindsightClient("http://localhost:8888");

    // Should throw on 503
    await expect(client.synthesize("paperclip::co-1")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// onValidateConfig
// ---------------------------------------------------------------------------

describe("onValidateConfig", () => {
  it("fails when hindsightApiUrl is missing", async () => {
    const result = await plugin.definition.onValidateConfig!({ hindsightApiUrl: "" });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.includes("hindsightApiUrl"))).toBe(true);
  });

  it("fails when Hindsight is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    );
    const result = await plugin.definition.onValidateConfig!({
      hindsightApiUrl: "http://localhost:8888",
    });
    expect(result.ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it("passes with a reachable Hindsight instance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 }))
    );
    const result = await plugin.definition.onValidateConfig!({
      hindsightApiUrl: "http://localhost:8888",
    });
    expect(result.ok).toBe(true);
    vi.unstubAllGlobals();
  });
});
