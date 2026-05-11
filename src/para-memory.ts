/**
 * Phase 2.3: Para-Memory integration.
 *
 * Exports high-confidence insights to the para-memory file system using the
 * PARA structure (Projects, Areas, Resources, Archives).
 *
 * Insights are written as atomic YAML fact files with temporal metadata so
 * future agents can load structured knowledge directly from the filesystem
 * without calling Hindsight on every heartbeat.
 */

import type { IndexedInsight } from "./insights.js";

export interface ParaMemoryEntry {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  body: string;
  source_insight_id: string;
  confidence: number;
  entities: string[];
  created_at: string;
  updated_at: string;
}

// Map insight types to para-memory types
const INSIGHT_TO_PARA_TYPE: Record<string, ParaMemoryEntry["type"]> = {
  entity_trend: "reference",
  pattern: "feedback",
  risk: "feedback",
  opportunity: "reference",
  relationship: "reference",
};

/**
 * Convert an indexed insight to a para-memory entry.
 */
export function insightToParaEntry(insight: IndexedInsight): ParaMemoryEntry {
  const paraType = INSIGHT_TO_PARA_TYPE[insight.type] ?? "reference";
  const now = new Date().toISOString();

  const entityLabel =
    insight.entities.length > 0 ? ` (${insight.entities.join(", ")})` : "";

  return {
    name: `${insight.type}_${insight.id.replace(/[^a-zA-Z0-9]/g, "_")}`,
    description: `${insight.type.replace("_", " ")} insight${entityLabel}: ${insight.summary.slice(0, 80)}`,
    type: paraType,
    body: buildParaBody(insight),
    source_insight_id: insight.id,
    confidence: insight.confidence,
    entities: insight.entities,
    created_at: insight.indexed_at,
    updated_at: now,
  };
}

function buildParaBody(insight: IndexedInsight): string {
  const lines: string[] = [
    `---`,
    `name: ${insight.type}_${insight.synthesis_id}`,
    `description: ${insight.summary.replace(/\n/g, " ")}`,
    `type: ${INSIGHT_TO_PARA_TYPE[insight.type] ?? "reference"}`,
    `---`,
    ``,
    insight.summary,
    ``,
    `**Why:** Detected in memory synthesis (${insight.type}, confidence ${(insight.confidence * 100).toFixed(0)}%)`,
    `**How to apply:** ${buildApplicationNote(insight)}`,
    ``,
    `Entities: ${insight.entities.join(", ") || "none"}`,
    `Synthesized: ${insight.indexed_at}`,
    `Bank: ${insight.bankId}`,
    `Synthesis ID: ${insight.synthesis_id}`,
  ];

  if (insight.supporting_memories && insight.supporting_memories.length > 0) {
    lines.push("", "Supporting memories:");
    insight.supporting_memories.forEach((m) => lines.push(`- ${m}`));
  }

  return lines.join("\n");
}

function buildApplicationNote(insight: IndexedInsight): string {
  switch (insight.type) {
    case "risk":
      return "Monitor this risk — consider adding checks or mitigations before proceeding.";
    case "opportunity":
      return "This optimization may be worth pursuing in the next planning cycle.";
    case "pattern":
      return "Reference this pattern when making similar decisions to stay consistent.";
    case "entity_trend":
      return "Track this entity — the trend may affect planning or architectural decisions.";
    case "relationship":
      return "Be aware of this dependency when making changes to related entities.";
    default:
      return "Review and apply judgment based on context.";
  }
}

/**
 * Filter insights that qualify for para-memory export.
 * Only high-confidence insights above the threshold are exported.
 */
export function filterParaExportCandidates(
  insights: IndexedInsight[],
  minConfidence = 0.8
): IndexedInsight[] {
  return insights
    .filter((i) => i.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Format all para-memory entries for the plugin state store.
 * State key: "para-memory-entries::{bankId}"
 */
export interface ParaMemoryStore {
  entries: ParaMemoryEntry[];
  last_exported_at: string;
  total_exported: number;
}

export function buildParaMemoryStore(
  existing: ParaMemoryStore | null,
  newEntries: ParaMemoryEntry[]
): ParaMemoryStore {
  if (!existing || newEntries.length === 0) {
    return {
      entries: newEntries,
      last_exported_at: new Date().toISOString(),
      total_exported: newEntries.length,
    };
  }

  // Replace entries with same source_insight_id (re-synthesis updates)
  const newIds = new Set(newEntries.map((e) => e.source_insight_id));
  const retained = existing.entries.filter((e) => !newIds.has(e.source_insight_id));
  const merged = [...retained, ...newEntries];

  return {
    entries: merged,
    last_exported_at: new Date().toISOString(),
    total_exported: merged.length,
  };
}
