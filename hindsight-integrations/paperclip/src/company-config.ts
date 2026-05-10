/**
 * Company-level configuration overlay.
 *
 * Merges instance-level config with per-company overrides so each company
 * can tune memory behaviour without affecting others.
 */

import type { BankConfig } from "./bank.js";

export interface InstanceConfig {
  hindsightApiUrl: string;
  hindsightApiKeyRef?: string;
  bankGranularity?: Array<"company" | "agent" | "user">;
  recallBudget?: "low" | "mid" | "high";
  autoRetain?: boolean;
  defaultContext?: string;
}

export interface CompanyConfig {
  recallBudgetOverride?: "low" | "mid" | "high";
  autoRetainOverride?: boolean;
  contextOverride?: string;
  bankGranularityOverride?: Array<"company" | "agent" | "user">;
  disableAutoRetain?: boolean;
}

export interface EffectiveConfig extends InstanceConfig {
  effectiveRecallBudget: "low" | "mid" | "high";
  effectiveAutoRetain: boolean;
  effectiveContext: string;
  effectiveBankGranularity: Array<"company" | "agent" | "user">;
}

export function mergeConfigs(
  instance: InstanceConfig,
  company: CompanyConfig | null | undefined
): EffectiveConfig {
  const c = company ?? {};

  const effectiveAutoRetain =
    c.disableAutoRetain === true
      ? false
      : (c.autoRetainOverride ?? instance.autoRetain ?? true);

  return {
    ...instance,
    effectiveRecallBudget: c.recallBudgetOverride ?? instance.recallBudget ?? "mid",
    effectiveAutoRetain,
    effectiveContext: c.contextOverride ?? instance.defaultContext ?? "paperclip",
    effectiveBankGranularity:
      c.bankGranularityOverride ?? instance.bankGranularity ?? ["company", "agent"],
  };
}

export type { BankConfig };
