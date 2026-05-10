/**
 * paperclip-plugin-hindsight — worker entrypoint.
 *
 * Gives Paperclip agents persistent long-term memory via Hindsight.
 *
 * Lifecycle:
 *   agent.run.started  → recall relevant memories, store in plugin state for the run
 *   agent.run.finished → retain agent output to Hindsight (if autoRetain is enabled)
 *
 * Agent tools (callable mid-run):
 *   hindsight_recall(query)   → search memory, returns relevant context
 *   hindsight_retain(content) → store content in memory immediately
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
    ctx.logger.info("Hindsight memory plugin starting (v0.3.0)");

    // ---------------------------------------------------------------------------
    // agent.run.started — recall memories and cache them for this run
    // ---------------------------------------------------------------------------
    ctx.events.on("agent.run.started", async (event) => {
      const payload = event.payload as RunStartedPayload;
      const companyId = event.companyId;
      const { agentId, runId, userId, issueTitle, issueDescription } = payload;

      const instanceConfig = await getInstanceConfig(ctx);
      const companyConfig = await getCompanyConfig(ctx, companyId);
      const config = mergeConfigs(instanceConfig, companyConfig);

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
