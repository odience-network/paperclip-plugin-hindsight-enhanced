# Phase 2.1: Synthesis Job Infrastructure

**Version:** 0.5.0  
**Status:** Implementation in Progress  
**Date:** 2026-05-11

---

## Overview

Phase 2.1 implements background synthesis jobs that periodically synthesize memories across a company's bank to generate long-term insights, detect patterns, and identify trends that inform future agent decisions.

## Key Features

### 1. Synthesis Method
- **HindsightClient.synthesize()** — Calls Hindsight API to synthesize memories
- Configurable frequency: daily, weekly, monthly, or disabled
- Supports entity type filtering and confidence thresholds
- Returns structured insights with confidence scores

### 2. Insight Types
- **entity_trend** — Patterns in how specific entities evolve over time
- **pattern** — Recurring sequences or behaviors across multiple runs
- **risk** — Detected anomalies or potential problems
- **opportunity** — Suggested optimizations based on observed data
- **relationship** — Dependencies and interactions between entities

### 3. Scheduling
- Configured via Paperclip routines (cron-based)
- Company-level frequency override via `synthesisOverride.frequency`
- Non-blocking: synthesis runs asynchronously without impacting agent recall
- Supports batching to optimize API efficiency

### 4. Storage
- Synthesis results stored as special memory records
- Marked with metadata: `synthesis_id`, `synthesis_timestamp`, `confidence`
- Queryable via company bank ID for trend analysis
- Supports downstream export to para-memory

## Configuration

### Instance Level (Global Default)
```typescript
// In manifest.ts instanceConfigSchema
synthesis: {
  frequency: "weekly",           // daily | weekly | monthly | never
  confidenceThreshold: 0.7,       // (0-1)
  maxInsights: 50,               // per synthesis run
  enableParaMemoryExport: true   // auto-export to para-memory
}
```

### Company Level (Override)
```typescript
// Via plugin state: scopeKind: "company", stateKey: "hindsight-config"
synthesisOverride: {
  frequency: "daily",
  confidenceThreshold: 0.8,
  maxInsights: 100,
  enableParaMemoryExport: true
}
```

## API Integration

### New HindsightClient Method
```typescript
async synthesize(
  bankId: string,
  options?: {
    entity_types?: string[];
    confidence_threshold?: number;
    max_insights?: number;
    async?: boolean;
  }
): Promise<SynthesisResponse>
```

### Response Format
```typescript
interface SynthesisResponse {
  synthesis_id: string;
  status: "completed" | "in_progress";
  result?: {
    insights: Array<{
      type: InsightType;
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
  };
}
```

## Implementation Details

### Synthesis Job Lifecycle

1. **Trigger:** Scheduled routine fires based on company frequency setting
2. **Load Config:** Fetch company synthesis config (frequency, filters, thresholds)
3. **Call Hindsight:** Send synthesize request with entity types + confidence threshold
4. **Process Results:** Parse insights, store with metadata, extract high-confidence ones
5. **Export:** If enabled, queue insights for para-memory export (Phase 2.3)
6. **Log:** Record synthesis job metrics (count, duration, insights generated)

### Error Handling

- **Hindsight unreachable:** Log warning, skip synthesis (non-fatal)
- **Invalid config:** Use defaults, log warning
- **Storage failure:** Retry with exponential backoff
- **Quota exceeded:** Batch smaller insights, reduce max_insights threshold

## Configuration Example

**CMS Platform Company**
```json
{
  "contextOverride": "cms-team",
  "synthesisOverride": {
    "frequency": "daily",
    "confidenceThreshold": 0.75,
    "maxInsights": 75,
    "enableParaMemoryExport": true
  }
}
```

## Testing

Phase 2.1 includes comprehensive test coverage:

1. **Synthesis call execution** — Verify API call format and parameters
2. **Response parsing** — Validate insight extraction and confidence filtering
3. **Config merging** — Test instance + company override precedence
4. **Frequency scheduling** — Verify cron scheduling and routine creation
5. **Error handling** — Test graceful failures and retries
6. **Integration** — End-to-end synthesis + storage flow

## Next Steps

1. ✅ **Code:** HindsightClient.synthesize() method added
2. ✅ **Config:** Synthesis schema added to CompanyConfig and manifest
3. ⏳ **Scheduler:** Add synthesis routine scheduling to worker.ts
4. ⏳ **Tests:** Create test suites for synthesis job execution
5. ⏳ **Documentation:** Update configuration guides

## Timeline

**Phase 2.1 Total:** 1.5 weeks
- Week 1: Synthesis job infrastructure, API integration, scheduling
- Week 1.5: Testing, documentation, integration validation

## Roadmap

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Instance config, company overrides | ✅ Done (v0.3.0) |
| 1.5 | Bank initialization, missions, entity types | ✅ Done (v0.4.0) |
| **2.1** | **Synthesis job infrastructure** | 🔄 In Progress (v0.5.0) |
| 2.2 | Insight extraction + indexing | 📋 Planned |
| 2.3 | Para-memory integration | 📋 Planned |
| 2.4 | Agent behavior + pre-briefing | 📋 Planned |
| 2.5 | Company synthesis configuration UI | 📋 Planned |

---

## References

- Hindsight API: `/v1/default/banks/{bankId}/memories/synthesize`
- Paperclip Plugin SDK: v2026.403.0
- Paperclip Routines: Job scheduling system
- Phase 2 Roadmap: 7-week sequential development plan
