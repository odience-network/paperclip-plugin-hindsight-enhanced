/**
 * Phase 2.2: Insight extraction, indexing, and retrieval.
 *
 * Parses raw synthesis results into structured, queryable insights.
 * High-confidence insights are indexed by type, entity, and context
 * for targeted recall by agents and downstream para-memory export.
 */

import type { SynthesisResult } from "./client.js";

export type InsightType =
  | "entity_trend"
  | "pattern"
  | "risk"
  | "opportunity"
  | "relationship";

export interface IndexedInsight {
  id: string;
  type: InsightType;
  entities: string[];
  summary: string;
  confidence: number;
  bankId: string;
  companyId: string;
  context: string;
  synthesis_id: string;
  indexed_at: string;
  supporting_memories?: string[];
}

export interface InsightIndex {
  insights: IndexedInsight[];
  last_synthesized_at: string;
  total_count: number;
}

/**
 * Parse and filter insights from a synthesis result.
 * Only insights meeting the confidence threshold are returned.
 */
export function extractInsights(
  result: SynthesisResult,
  options: {
    synthesisId: string;
    bankId: string;
    companyId: string;
    context: string;
    confidenceThreshold?: number;
  }
): IndexedInsight[] {
  const threshold = options.confidenceThreshold ?? 0.7;

  return (result.insights ?? [])
    .filter((insight) => insight.confidence >= threshold)
    .map((insight, idx) => ({
      id: `${options.synthesisId}::${idx}`,
      type: insight.type,
      entities: insight.entities ?? [],
      summary: insight.summary,
      confidence: insight.confidence,
      bankId: options.bankId,
      companyId: options.companyId,
      context: options.context,
      synthesis_id: options.synthesisId,
      indexed_at: new Date().toISOString(),
      supporting_memories: insight.supporting_memories,
    }));
}

/**
 * Merge new insights into an existing index, deduplicating by synthesis_id + position.
 * Older entries from the same synthesis_id are replaced.
 */
export function mergeInsightIndex(
  existing: InsightIndex | null,
  newInsights: IndexedInsight[]
): InsightIndex {
  if (!existing || newInsights.length === 0) {
    return {
      insights: newInsights,
      last_synthesized_at: new Date().toISOString(),
      total_count: newInsights.length,
    };
  }

  // Drop insights from the same synthesis run (re-synthesis replaces old results)
  const synthesisIds = new Set(newInsights.map((i) => i.synthesis_id));
  const retained = existing.insights.filter((i) => !synthesisIds.has(i.synthesis_id));
  const merged = [...retained, ...newInsights];

  return {
    insights: merged,
    last_synthesized_at: new Date().toISOString(),
    total_count: merged.length,
  };
}

/**
 * Format insight index for agent consumption (recalled at run start or via tool).
 */
export function formatInsights(
  index: InsightIndex,
  filter?: {
    type?: InsightType;
    entity?: string;
    minConfidence?: number;
    limit?: number;
  }
): string {
  let results = index.insights;

  if (filter?.type) {
    results = results.filter((i) => i.type === filter.type);
  }
  if (filter?.entity) {
    const entity = filter.entity.toLowerCase();
    results = results.filter((i) =>
      i.entities.some((e) => e.toLowerCase().includes(entity))
    );
  }
  if (filter?.minConfidence !== undefined) {
    results = results.filter((i) => i.confidence >= filter.minConfidence!);
  }

  // Sort by confidence descending
  results = results.sort((a, b) => b.confidence - a.confidence);

  if (filter?.limit) {
    results = results.slice(0, filter.limit);
  }

  if (results.length === 0) return "";

  return results
    .map(
      (i) =>
        `[${i.type.toUpperCase()} | confidence: ${(i.confidence * 100).toFixed(0)}%] ${i.summary}` +
        (i.entities.length > 0 ? ` (entities: ${i.entities.join(", ")})` : "")
    )
    .join("\n");
}
