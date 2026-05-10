# Phase 1.5: Memory Bank Initialization with Best Practices

**Version:** 0.4.0  
**Status:** Implementation Complete  
**Date:** 2026-05-11

---

## Overview

Phase 1.5 extends Phase 1 with **memory bank initialization** best practices, enabling companies to configure domain-specific extraction missions, entity types, and disposition traits for better memory efficacy and performance.

This addresses the feedback from Hindsight best practices documentation and CEO requirements for company-level customization of memory extraction behavior.

---

## Key Features Added

### 1. Memory Bank Initialization Missions

Each company can now define three extraction missions for their memory banks:

#### **Retain Mission**
- **Purpose:** Instructions for basic fact extraction and indexing
- **Example:** "Extract decisions, dependencies, and technical constraints from agent runs."
- **Used by:** Hindsight synthesis phase to prioritize fact retention

#### **Observations Mission**
- **Purpose:** Instructions for entity extraction and relationship mapping
- **Example:** "Identify agents, features, users, and their interactions."
- **Used by:** Hindsight synthesis phase to extract domain entities

#### **Reflect Mission**
- **Purpose:** Instructions for cross-memory synthesis and insight generation
- **Example:** "Synthesize patterns across multiple runs to identify domain expertise."
- **Used by:** Hindsight synthesis phase to generate high-level insights

### 2. Entity Types

Companies can define domain-specific entity types for extraction. Examples:
- `["Agent", "Feature", "User", "Decision", "Bug", "Performance Issue"]`

Hindsight uses these types to structure entity extraction and relationship mapping.

### 3. Disposition Traits

Companies can specify traits that shape memory synthesis style:
- **skepticism:** Question assumptions and validate claims
- **literalism:** Focus on precise, concrete facts
- **empathy:** Consider human factors and context

Example: `["skepticism", "literalism"]` → synthesize with careful fact-checking

---

## Configuration Hierarchy

```
Instance Level (Paperclip Admin Settings)
├── hindsightApiUrl (default: http://localhost:8888) ✓ Self-hosted first
├── hindsightApiKeyRef (for Cloud deployments)
├── bankGranularity (default: ["company", "agent"])
├── recallBudget (default: "mid")
├── autoRetain (default: true)
└── defaultContext (default: "paperclip")

Company Level (Override per Company)
├── recallBudgetOverride
├── autoRetainOverride
├── contextOverride
├── bankGranularityOverride
└── bankInit (NEW)
    ├── retain_mission
    ├── observations_mission
    ├── reflect_mission
    ├── entity_types[]
    └── disposition_traits[]
```

---

## Implementation Details

### Bank Initialization Lifecycle

1. **First Run Detection:** When an agent in a company has its first run, plugin checks if bank is already initialized
2. **Lazy Initialization:** If company config specifies `bankInit` and bank is not yet initialized:
   - Plugin calls `client.initializeBank(bankId, bankInit)`
   - Hindsight API receives mission and entity type definitions
   - Bank initialization is tracked in plugin state to prevent re-initialization
3. **Standard Recall:** After initialization completes, recall proceeds normally

### State Tracking

Initialization state is tracked per bank in plugin state:
```typescript
scopeKind: "company"
scopeId: companyId
stateKey: `bank-initialized::${bankId}`
value: true
```

This prevents duplicate initialization calls even if the handler retries.

### Error Handling

- **Bank init failure:** Non-fatal. Plugin logs warning and continues with standard recall
- **Network timeout:** 15-second timeout on all Hindsight API calls
- **Missing config:** If no `bankInit` is specified, initialization is skipped entirely

---

## API Integration

### New HindsightClient Method

```typescript
async initializeBank(
  bankId: string,
  config: {
    retain_mission?: string;
    observations_mission?: string;
    reflect_mission?: string;
    entity_types?: string[];
    disposition_traits?: string[];
  }
): Promise<void>
```

Posts to: `POST /v1/default/banks/{bankId}/init`

### Self-Hosted Hindsight Configuration

Default configuration prioritizes self-hosted Hindsight:

```json
{
  "hindsightApiUrl": "http://localhost:8888",
  "hindsightApiKeyRef": ""
}
```

- **Self-hosted (default):** No API key required, uses local instance
- **Hindsight Cloud:** Set `hindsightApiKeyRef` to reference a Paperclip secret containing the API key

---

## Company Configuration Interface

### Setting Bank Initialization via Plugin State

Companies can configure bank initialization through Paperclip's plugin state API:

```typescript
// Example: Configure bank init for company "acme-corp"
await ctx.state.set(
  {
    scopeKind: "company",
    scopeId: "acme-corp",
    stateKey: "hindsight-config",
  },
  {
    contextOverride: "acme-cms-team",
    recallBudgetOverride: "high",
    bankInit: {
      retain_mission:
        "Extract CMS features, content decisions, and editorial workflows from agent runs.",
      observations_mission:
        "Identify content types, editorial workflows, publishing decisions, and stakeholder interactions.",
      reflect_mission:
        "Synthesize patterns in content strategy, publishing cadence, and stakeholder preferences.",
      entity_types: [
        "Content Type",
        "Editorial Workflow",
        "Publishing Decision",
        "Content Stakeholder",
      ],
      disposition_traits: ["literalism", "empathy"],
    },
  }
);
```

### Future UI: Company Configuration Page

Future implementation should provide a company-level admin UI for:
1. Setting recall budget, auto-retain, and context overrides
2. Defining custom missions and entity types
3. Selecting disposition traits
4. Testing/validating bank initialization before deployment

---

## Testing

Phase 1.5 includes 4 new test suites verifying:

1. **Bank initialization with missions:** Verify missions are sent to Hindsight on first run
2. **Idempotency:** Verify bank is only initialized once per bankId
3. **Skip when not configured:** Verify initialization is skipped if `bankInit` is not set
4. **Non-fatal failures:** Verify recall continues if bank init fails

All 23/23 tests passing.

---

## Best Practices Summary

### For Instance Administrators

1. **Verify self-hosted Hindsight** is running at the configured URL before deployment
2. **Set `defaultContext`** to a meaningful value (e.g., "acme-agents") to improve extraction quality
3. **Document bank configuration** for each company so teams know what missions/entities apply

### For Company Configuration

1. **Keep missions concise** (~1-2 sentences). Brevity improves Hindsight extraction quality.
2. **Use domain language** in entity types. Examples: "Feature Request", "User Feedback", "Technical Debt"
3. **Choose disposition traits** based on domain requirements:
   - **Development teams:** `["skepticism", "literalism"]` (validate assumptions, track precise facts)
   - **Product teams:** `["empathy", "literalism"]` (consider user context, track decisions)
   - **Operations teams:** `["skepticism"]` (critical validation)

### Hindsight Best Practices Integration

Phase 1.5 implements recommendations from Hindsight best practices:

- ✅ **Context always set:** Every retained memory includes company-level context
- ✅ **Timestamps included:** `created_at` ISO 8601 timestamp on every memory
- ✅ **Stable document IDs:** Run ID used as document_id for deduplication
- ✅ **Bank initialization:** Domain-specific missions enable targeted extraction
- ✅ **Entity types:** Company-level entity definitions improve relationship mapping
- ✅ **Disposition traits:** Configurable synthesis style per company

---

## Roadmap Integration

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Instance config, company overrides, best practices | ✅ Complete (v0.3.0) |
| 1.5 | Memory bank initialization, missions, entity types | ✅ Complete (v0.4.0) |
| 2 | Para-memory synthesis job, long-term insights | 📋 Planned |
| 3 | Company-level configuration UI | 📋 Planned |

---

## Next Steps

1. **Deploy v0.4.0** to test environment
2. **Configure test company** with bank initialization for pilot
3. **Monitor synthesis quality** in Hindsight to validate mission effectiveness
4. **Collect feedback** from early adopters for Phase 2 synthesis features
5. **Plan Phase 3:** Company admin UI for bank configuration

---

## Self-Hosted Hindsight Prioritization

Version 0.4.0 prioritizes self-hosted Hindsight:

- **Default API URL:** `http://localhost:8888` (local instance)
- **API Key:** Optional (required only for Cloud deployments)
- **Configuration:** Administrators can override with Cloud endpoint if needed

This aligns with the requirement to prioritize self-hosted deployments while supporting Cloud as an optional advanced configuration.

---

## References

- Hindsight Best Practices: Memory bank initialization, entity types, disposition traits
- Paperclip Plugin SDK: v2026.403.0
- Hindsight API: `/v1/default/banks/{bankId}/init`
