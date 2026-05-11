/**
 * paperclip-plugin-hindsight — worker entrypoint.
 *
 * Gives Paperclip agents persistent long-term memory via Hindsight.
 *
 * Lifecycle:
 *   agent.run.started   → recall relevant memories, store in plugin state for the run
 *   agent.run.finished  → retain agent output to Hindsight (if autoRetain is enabled)
 *   synthesis.trigger   → synthesize memories and index insights per company (Phase 2)
 *
 * Agent tools (callable mid-run):
 *   hindsight_recall(query)            → search memory, returns relevant context
 *   hindsight_retain(content)          → store content in memory immediately
 *   hindsight_insights(type?, entity?) → query indexed synthesis insights (Phase 2.2)
 *
 * Configuration hierarchy:
 *   Instance config  — set in Settings → Plugins → Hindsight Memory (Paperclip admin)
 *   Company config   — stored in plugin state per company, set via admin UI or API
 *                      (scopeKind: "company", stateKey: "hindsight-config")
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { HindsightClient, formatMemories } from "./client.js";
import { deriveBankId } from "./bank.js";
import { mergeConfigs, type InstanceConfig, type CompanyConfig } from "./company-config.js";
import {
  extractInsights,
  mergeInsightIndex,
  formatInsights,
  type InsightType,
  type InsightIndex,
} from "./insights.js";
import {
  insightToParaEntry,
  filterParaExportCandidates,
  buildParaMemoryStore,
  type ParaMemoryStore,
} from "./para-memory.js";

interface RunStartedPayload {
  agentId: string;
  runId: string;
  userId?: string;
  issueTitle?: string;
  issueDescription?: string;
}

interface RunFinishedPayload {
  agentId: string;
  runId: string;
  userId?: string;
  output?: string;
  result?: string;
}

async function getInstanceConfig(ctx: PluginContext): Promise<InstanceConfig> {
  return (await ctx.config.get()) as unknown as InstanceConfig;
}

async function getCompanyConfig(
  ctx: PluginContext,
  companyId: string
): Promise<CompanyConfig | null> {
  try {
    const raw = await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      stateKey: "hindsight-config",
    });
    return raw ? (raw as unknown as CompanyConfig) : null;
  } catch {
    return null;
  }
}

async function resolveApiKey(ctx: PluginContext, config: InstanceConfig): Promise<string | undefined> {
  if (!config.hindsightApiKeyRef) return undefined;
  const resolved = await ctx.secrets.resolve(config.hindsightApiKeyRef);
  return resolved ?? undefined;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Hindsight memory plugin starting (v0.5.0)");

    // ---------------------------------------------------------------------------
    // agent.run.started — initialize bank on first use, then recall memories
    // ---------------------------------------------------------------------------
    ctx.events.on("agent.run.started", async (event) => {
      const payload = event.payload as RunStartedPayload;
      const companyId = event.companyId;
      const { agentId, runId, userId, issueTitle, issueDescription } = payload;

      const instanceConfig = await getInstanceConfig(ctx);
      const companyConfig = await getCompanyConfig(ctx, companyId);
      const config = mergeConfigs(instanceConfig, companyConfig);

      // Initialize bank on first use if company config specifies bank init settings
      if (companyConfig?.bankInit) {
        const bankId = deriveBankId(
          { companyId, agentId, userId },
          { bankGranularity: config.effectiveBankGranularity }
        );

        const initKey = `bank-initialized::${bankId}`;
        const alreadyInitialized = await ctx.state.get({
          scopeKind: "company",
          scopeId: companyId,
          stateKey: initKey,
        });

        if (!alreadyInitialized) {
          try {
            const apiKey = await resolveApiKey(ctx, instanceConfig);
            const client = new HindsightClient(instanceConfig.hindsightApiUrl, apiKey);
            await client.initializeBank(bankId, companyConfig.bankInit);
            await ctx.state.set(
              { scopeKind: "company", scopeId: companyId, stateKey: initKey },
              true
            );
            ctx.logger.info("Initialized memory bank with best practices", {
              bankId,
              hasRetainMission: !!companyConfig.bankInit.retain_mission,
              hasObservationsMission: !!companyConfig.bankInit.observations_mission,
              hasReflectMission: !!companyConfig.bankInit.reflect_mission,
              entityTypeCount: companyConfig.bankInit.entity_types?.length ?? 0,
              traitCount: companyConfig.bankInit.disposition_traits?.length ?? 0,
            });
          } catch (err) {
            ctx.logger.warn("Failed to initialize bank with missions and entity types", {
              bankId,
              error: String(err),
            });
            // Non-fatal: continue with standard recall
          }
        }
      }

      const query = [issueTitle, issueDescription].filter(Boolean).join("\n");
      if (!query.trim()) return;

      try {
        const apiKey = await resolveApiKey(ctx, instanceConfig);
        const client = new HindsightClient(instanceConfig.hindsightApiUrl, apiKey);
        const bankId = deriveBankId(
          { companyId, agentId, userId },
          { bankGranularity: config.effectiveBankGranularity }
        );

        const response = await client.recall(bankId, query, config.effectiveRecallBudget);

        const memories = formatMemories(response.results);
        if (memories) {
          await ctx.state.set(
            { scopeKind: "run", scopeId: runId, stateKey: "recalled-memories" },
            memories
          );
          ctx.logger.info("Recalled memories for run", {
            runId,
            bankId,
            count: response.results.length,
            companyOverride: companyConfig !== null,
          });
        }
      } catch (err) {
        // Non-fatal: agent runs without memory context.
        ctx.logger.warn("Failed to recall memories on run start", {
          runId,
          error: String(err),
        });
      }
    });

    // ---------------------------------------------------------------------------
    // agent.run.finished — retain run output to Hindsight
    // ---------------------------------------------------------------------------
    ctx.events.on("agent.run.finished", async (event) => {
      const payload = event.payload as RunFinishedPayload;
      const companyId = event.companyId;

      const instanceConfig = await getInstanceConfig(ctx);
      const companyConfig = await getCompanyConfig(ctx, companyId);
      const config = mergeConfigs(instanceConfig, companyConfig);

      if (!config.effectiveAutoRetain) return;

      const { agentId, runId, userId, output, result } = payload;
      const content = output ?? result;

      if (!content?.trim()) return;

      try {
        const apiKey = await resolveApiKey(ctx, instanceConfig);
        const client = new HindsightClient(instanceConfig.hindsightApiUrl, apiKey);
        const bankId = deriveBankId(
          { companyId, agentId, userId },
          { bankGranularity: config.effectiveBankGranularity }
        );

        // runId as stable document_id prevents duplicate retention on retry
        await client.retain(
          bankId,
          content,
          runId,
          { agentId, companyId, runId },
          config.effectiveContext
        );
        ctx.logger.info("Retained run output to memory", {
          runId,
          bankId,
          context: config.effectiveContext,
        });
      } catch (err) {
        ctx.logger.warn("Failed to retain run output", {
          runId,
          error: String(err),
        });
      }
    });

    // ---------------------------------------------------------------------------
    // Tool: hindsight_recall
    // ---------------------------------------------------------------------------
    ctx.tools.register(
      "hindsight_recall",
      {
        displayName: "Recall from Memory",
        description: "Search Hindsight long-term memory for context relevant to a query.",
        parametersSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "What to search for" },
          },
        },
      },
      async (params: unknown, runCtx: ToolRunContext) => {
        const { query } = params as { query: string };
        const companyId = runCtx.companyId;
        const instanceConfig = await getInstanceConfig(ctx);
        const companyConfig = await getCompanyConfig(ctx, companyId);
        const config = mergeConfigs(instanceConfig, companyConfig);
        const bankId = deriveBankId(
          { companyId, agentId: runCtx.agentId },
          { bankGranularity: config.effectiveBankGranularity }
        );

        // Return cached memories from run start if available
        const cached = await ctx.state.get({
          scopeKind: "run",
          scopeId: runCtx.runId,
          stateKey: "recalled-memories",
        });
        if (cached && typeof cached === "string") {
          return { content: cached };
        }

        // Live recall fallback
        try {
          const apiKey = await resolveApiKey(ctx, instanceConfig);
          const client = new HindsightClient(instanceConfig.hindsightApiUrl, apiKey);
          const response = await client.recall(bankId, query, config.effectiveRecallBudget);
          const memories = formatMemories(response.results);
          return { content: memories || "No relevant memories found." };
        } catch (err) {
          return { content: `Memory recall failed: ${String(err)}` };
        }
      }
    );

    // ---------------------------------------------------------------------------
    // Tool: hindsight_retain
    // ---------------------------------------------------------------------------
    ctx.tools.register(
      "hindsight_retain",
      {
        displayName: "Save to Memory",
        description:
          "Store important facts, decisions, or outcomes in Hindsight long-term memory for future runs.",
        parametersSchema: {
          type: "object",
          required: ["content"],
          properties: {
            content: {
              type: "string",
              description: "The content to store in memory",
            },
          },
        },
      },
      async (params: unknown, runCtx: ToolRunContext) => {
        const { content } = params as { content: string };
        const companyId = runCtx.companyId;
        const instanceConfig = await getInstanceConfig(ctx);
        const companyConfig = await getCompanyConfig(ctx, companyId);
        const config = mergeConfigs(instanceConfig, companyConfig);
        const bankId = deriveBankId(
          { companyId, agentId: runCtx.agentId },
          { bankGranularity: config.effectiveBankGranularity }
        );

        try {
          const apiKey = await resolveApiKey(ctx, instanceConfig);
          const client = new HindsightClient(instanceConfig.hindsightApiUrl, apiKey);
          await client.retain(
            bankId,
            content,
            undefined,
            { agentId: runCtx.agentId, companyId, runId: runCtx.runId },
            config.effectiveContext
          );
          return { content: "Memory saved." };
        } catch (err) {
          return { content: `Failed to save memory: ${String(err)}` };
        }
      }
    );

    // ---------------------------------------------------------------------------
    // Tool: hindsight_insights — Phase 2.2 indexed insight retrieval
    // ---------------------------------------------------------------------------
    ctx.tools.register(
      "hindsight_insights",
      {
        displayName: "Query Synthesis Insights",
        description:
          "Retrieve indexed long-term insights synthesized from past agent runs. Filter by type (pattern, risk, opportunity, entity_trend, relationship) or entity name.",
        parametersSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description:
                "Filter by insight type: entity_trend, pattern, risk, opportunity, relationship",
              enum: ["entity_trend", "pattern", "risk", "opportunity", "relationship"],
            },
            entity: {
              type: "string",
              description: "Filter insights mentioning a specific entity (partial match)",
            },
            min_confidence: {
              type: "number",
              description: "Minimum confidence threshold (0-1). Default: 0.7",
            },
            limit: {
              type: "integer",
              description: "Maximum number of insights to return. Default: 10",
            },
          },
        },
      },
      async (params: unknown, runCtx: ToolRunContext) => {
        const { type, entity, min_confidence, limit } = params as {
          type?: InsightType;
          entity?: string;
          min_confidence?: number;
          limit?: number;
        };
        const companyId = runCtx.companyId;
        // Synthesis insights are indexed at company level (not per-agent)
        const bankId = deriveBankId(
          { companyId, agentId: "company-synthesis" },
          { bankGranularity: ["company"] }
        );

        const indexKey = `insight-index::${bankId}`;
        const raw = await ctx.state.get({
          scopeKind: "company",
          scopeId: companyId,
          stateKey: indexKey,
        });

        if (!raw) {
          return {
            content:
              "No synthesis insights available yet. Synthesis runs automatically based on company configuration.",
          };
        }

        const index = raw as unknown as InsightIndex;
        const formatted = formatInsights(index, {
          type,
          entity,
          minConfidence: min_confidence ?? 0.7,
          limit: limit ?? 10,
        });

        if (!formatted) {
          return { content: "No insights match the specified filters." };
        }

        return {
          content: `## Synthesis Insights\n_${index.total_count} total | last synthesized: ${index.last_synthesized_at}_\n\n${formatted}`,
        };
      }
    );

    // ---------------------------------------------------------------------------
    // Phase 2.2: Synthesis job — triggered by scheduled event
    // ---------------------------------------------------------------------------
    ctx.events.on("plugin.hindsight.synthesis.trigger", async (event) => {
      const companyId = event.companyId;

      const instanceConfig = await getInstanceConfig(ctx);
      const companyConfig = await getCompanyConfig(ctx, companyId);
      const config = mergeConfigs(instanceConfig, companyConfig);

      const synthConfig = companyConfig?.synthesisOverride ?? instanceConfig.synthesis;

      // Skip synthesis if disabled
      if (synthConfig?.frequency === "never") return;

      // Use company bank (company-level scope for synthesis)
      const bankId = deriveBankId(
        { companyId, agentId: "company-synthesis" },
        { bankGranularity: ["company"] }
      );

      try {
        const apiKey = await resolveApiKey(ctx, instanceConfig);
        const client = new HindsightClient(instanceConfig.hindsightApiUrl, apiKey);
        const synthesisResp = await client.synthesize(bankId, {
          confidence_threshold: synthConfig?.confidenceThreshold ?? 0.7,
          max_insights: synthConfig?.maxInsights ?? 50,
        });

        if (synthesisResp.result) {
          const newInsights = extractInsights(synthesisResp.result, {
            synthesisId: synthesisResp.synthesis_id,
            bankId,
            companyId,
            context: config.effectiveContext,
            confidenceThreshold: synthConfig?.confidenceThreshold ?? 0.7,
          });

          if (newInsights.length > 0) {
            const indexKey = `insight-index::${bankId}`;
            const existing = await ctx.state.get({
              scopeKind: "company",
              scopeId: companyId,
              stateKey: indexKey,
            });

            const updated = mergeInsightIndex(
              existing as InsightIndex | null,
              newInsights
            );

            await ctx.state.set(
              { scopeKind: "company", scopeId: companyId, stateKey: indexKey },
              updated
            );

            ctx.logger.info("Synthesis complete — insight index updated", {
              companyId,
              bankId,
              newInsights: newInsights.length,
              totalIndexed: updated.total_count,
              synthesisId: synthesisResp.synthesis_id,
            });

            // Phase 2.3: Para-memory export for high-confidence insights
            if (synthConfig?.enableParaMemoryExport !== false) {
              const exportCandidates = filterParaExportCandidates(newInsights, 0.8);
              if (exportCandidates.length > 0) {
                const paraEntries = exportCandidates.map(insightToParaEntry);
                const paraStoreKey = `para-memory-entries::${bankId}`;
                const existingPara = await ctx.state.get({
                  scopeKind: "company",
                  scopeId: companyId,
                  stateKey: paraStoreKey,
                });
                const paraStore = buildParaMemoryStore(
                  existingPara as ParaMemoryStore | null,
                  paraEntries
                );
                await ctx.state.set(
                  { scopeKind: "company", scopeId: companyId, stateKey: paraStoreKey },
                  paraStore
                );
                ctx.logger.info("Para-memory export complete", {
                  companyId,
                  exported: paraEntries.length,
                  totalStored: paraStore.total_exported,
                });
              }
            }
          }
        }
      } catch (err) {
        ctx.logger.warn("Synthesis job failed (non-fatal)", {
          companyId,
          error: String(err),
        });
      }
    });

    ctx.logger.info("Hindsight memory plugin ready");
  },

  async onHealth() {
    return { status: "ok" };
  },

  async onValidateConfig(config) {
    const c = config as Partial<InstanceConfig>;
    if (!c.hindsightApiUrl?.trim()) {
      return { ok: false, errors: ["hindsightApiUrl is required"] };
    }

    try {
      const client = new HindsightClient(c.hindsightApiUrl);
      const healthy = await client.health();
      if (!healthy) {
        return {
          ok: false,
          errors: [`Cannot reach Hindsight at ${c.hindsightApiUrl}`],
        };
      }
    } catch (err) {
      return { ok: false, errors: [`Connection failed: ${String(err)}`] };
    }

    return { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
