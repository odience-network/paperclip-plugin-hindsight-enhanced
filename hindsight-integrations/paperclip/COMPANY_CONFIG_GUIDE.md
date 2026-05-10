# Company Configuration Guide

**Version:** 0.4.0  
**For:** Paperclip Plugin Administrators and Company Managers

---

## Quick Start

Company-level configuration is stored in Paperclip plugin state and allows each company to customize memory behavior independently.

### Configuration Storage

```
Scope Kind: "company"
Scope ID: "acme-corp" (or any company ID)
State Key: "hindsight-config"
```

### Minimal Configuration

```json
{
  "contextOverride": "acme-team"
}
```

### Full Configuration with Bank Initialization

```json
{
  "recallBudgetOverride": "high",
  "autoRetainOverride": true,
  "contextOverride": "acme-cms",
  "bankGranularityOverride": ["company", "agent"],
  "disableAutoRetain": false,
  "bankInit": {
    "retain_mission": "Extract CMS decisions and content workflows",
    "observations_mission": "Map content types, editorial workflows, and stakeholders",
    "reflect_mission": "Synthesize content strategy patterns and publishing cadence",
    "entity_types": ["Content Type", "Editorial Workflow", "Decision", "Stakeholder"],
    "disposition_traits": ["literalism", "empathy"]
  }
}
```

---

## Configuration Fields

### Basic Overrides

#### `contextOverride` (string, optional)
- **Purpose:** Override the instance default context for all memories retained by this company
- **Example:** `"acme-cms"`, `"finance-team"`, `"support-squad"`
- **Impact:** Improves memory extraction quality by providing domain context
- **Default:** Uses instance `defaultContext` (typically "paperclip")

#### `recallBudgetOverride` (string, optional)
- **Purpose:** Override instance recall budget
- **Values:** `"low"` (fastest), `"mid"` (balanced), `"high"` (most thorough)
- **Impact:** `"low"` returns top 3 memories, `"mid"` returns top 5, `"high"` searches deeper
- **Default:** Uses instance `recallBudget` (typically "mid")

#### `autoRetainOverride` (boolean, optional)
- **Purpose:** Override automatic retention of agent run output
- **When `true`:** Run output is automatically retained to memory after each completion
- **When `false`:** Only manual retention via `hindsight_retain` tool
- **Default:** Uses instance `autoRetain` (typically `true`)

#### `bankGranularityOverride` (array, optional)
- **Purpose:** Override memory isolation granularity
- **Values:**
  - `["company"]` — All agents in company share one memory bank
  - `["agent"]` — Each agent has separate memory (ignores company boundary)
  - `["company", "agent"]` — Each agent has separate memory within company (default)
  - `["company", "agent", "user"]` — Per-user memory isolation (GDPR compliance)
- **Impact:** Affects which agents can access which memories
- **Default:** `["company", "agent"]`

#### `disableAutoRetain` (boolean, optional)
- **Purpose:** Force disable auto-retention for this company
- **When `true`:** Overrides `autoRetainOverride` and instance settings
- **Use case:** Sensitive environments, GDPR, compliance testing
- **Default:** `false`

### Bank Initialization (Phase 1.5)

#### `bankInit` (object, optional)

Configure Hindsight's memory extraction missions and entity types on first use.

##### `retain_mission` (string, optional)
Brief instructions for fact extraction and indexing.

**Good examples:**
- "Extract bugs, features, and deployment decisions from agent runs."
- "Record CMS content types, editorial workflows, and publishing decisions."
- "Capture customer interactions, feature requests, and support decisions."

**Anti-patterns:**
- ❌ Too long (>2 sentences) — reduces extraction quality
- ❌ Too vague ("Extract important things")
- ❌ Implementation details ("Call the API and format JSON")

##### `observations_mission` (string, optional)
Instructions for entity extraction and relationship mapping.

**Good examples:**
- "Identify agents, features, users, bugs, and their interactions."
- "Extract stakeholders, content types, workflows, and editorial decisions."
- "Map customers, products, issues, and resolution paths."

##### `reflect_mission` (string, optional)
Instructions for cross-memory synthesis and insight generation.

**Good examples:**
- "Synthesize patterns to identify most-fixed bugs or most-requested features."
- "Identify gaps in documentation, training needs, or process breakdowns."
- "Detect customer segments with similar needs or pain points."

##### `entity_types` (array of strings, optional)
Domain-specific entity types for structured extraction.

**Examples by domain:**

*Software Development:*
```json
["Agent", "Feature", "Bug", "Decision", "Technical Debt", "User"]
```

*Content Management:*
```json
["Content Type", "Editorial Workflow", "Stakeholder", "Publishing Decision"]
```

*Customer Support:*
```json
["Customer", "Product", "Issue Type", "Resolution", "Satisfaction Score"]
```

**Guidelines:**
- Use **capitalized domain language**: "Feature Request", not "feature request"
- Keep list **5-10 types** for best extraction quality
- Include **key actors**: "Agent", "User", "Team"
- Include **key outputs**: "Decision", "Bug", "Feature"

##### `disposition_traits` (array of strings, optional)
Traits that shape how Hindsight synthesizes memories.

**Available traits:**

| Trait | Best For | Example Output |
|-------|----------|-----------------|
| `"skepticism"` | Technical teams, validation | "7 PRs attempted X, but 3 failed. Root cause: unclear." |
| `"literalism"` | Compliance, tracking | "Agent A ran 42 times. Fixed 8 bugs, shipped 3 features." |
| `"empathy"` | Product teams, UX | "Users struggle with this workflow. Consider: better defaults." |

**Domain recommendations:**

- **Engineering:** `["skepticism", "literalism"]` → rigorous, fact-based
- **Product:** `["literalism", "empathy"]` → user-focused with concrete data
- **Operations:** `["skepticism"]` → critical validation
- **Mixed teams:** `["literalism"]` → neutral, fact-focused

---

## Setting Configuration via API

### Example: Using Paperclip SDK (TypeScript)

```typescript
import type { PluginContext } from "@paperclipai/plugin-sdk";

async function configureCompanyMemory(ctx: PluginContext, companyId: string) {
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: companyId,
      stateKey: "hindsight-config",
    },
    {
      // Context for memory extraction
      contextOverride: "acme-cms-platform",

      // Tune recall for this company
      recallBudgetOverride: "high",

      // Bank initialization (one-time, on first run)
      bankInit: {
        retain_mission:
          "Extract content decisions, editorial workflows, and publishing patterns.",
        observations_mission:
          "Identify content types, stakeholders, publishing workflows, and editorial decisions.",
        reflect_mission:
          "Synthesize content strategy patterns, publishing cadence, and stakeholder preferences.",
        entity_types: [
          "Content Type",
          "Editorial Workflow",
          "Publishing Decision",
          "Stakeholder",
        ],
        disposition_traits: ["literalism", "empathy"],
      },
    }
  );

  console.log(`Configured memory bank for ${companyId}`);
}
```

### Example: Using HTTP API

```bash
curl -X POST \
  http://localhost:8888/paperclip/state \
  -H "Content-Type: application/json" \
  -d '{
    "scopeKind": "company",
    "scopeId": "acme-corp",
    "stateKey": "hindsight-config",
    "value": {
      "contextOverride": "acme-cms",
      "bankInit": {
        "retain_mission": "Extract content and workflow decisions",
        "entity_types": ["Content", "Workflow", "Decision"],
        "disposition_traits": ["literalism"]
      }
    }
  }'
```

---

## Validation and Defaults

### Default Values

If a company config doesn't specify a field, instance defaults apply:

```
Company Config          Instance Default     Final Value
─────────────────────────────────────────────────────────
contextOverride: null  defaultContext: "app"  "app"
recallBudget: null     recallBudget: "mid"    "mid"
autoRetain: null       autoRetain: true       true
bankInit: null         (not applicable)       (no init)
```

### Special Case: `disableAutoRetain`

If `disableAutoRetain: true`, memory retention is **completely disabled** for the company, regardless of other settings:

```json
{
  "autoRetainOverride": true,
  "disableAutoRetain": true
  // Result: autoRetain is FALSE (disableAutoRetain takes precedence)
}
```

---

## Bank Initialization Behavior

### When Does Bank Initialization Happen?

1. **First agent run** in the company
2. **If** company config includes `bankInit` field
3. **Plugin** calls Hindsight to initialize the bank with missions and entity types
4. **State** stores `bank-initialized::{bankId} = true` to prevent re-init

### Can I Update Bank Configuration Later?

Bank initialization is **one-time only**. Once initialized, the configuration is locked in Hindsight.

**To reconfigure:**
1. Delete the company config's `bankInit` field
2. Manually reset the bank in Hindsight (if needed)
3. Set new `bankInit` configuration
4. Next run will attempt re-initialization

### What if Bank Init Fails?

Failure is **non-fatal**. Plugin logs the error and continues with standard recall. No memories are lost.

**Common causes:**
- Hindsight service unreachable
- Invalid mission text
- Network timeout

---

## Monitoring and Troubleshooting

### Check Bank Initialization State

```typescript
// Get bank init status for a company
const initState = await ctx.state.get({
  scopeKind: "company",
  scopeId: "acme-corp",
  stateKey: "bank-initialized::paperclip::acme-corp::ag-1",
});

console.log(initState ? "Bank initialized" : "Bank not yet initialized");
```

### Verify Configuration

```typescript
// Read current company config
const config = await ctx.state.get({
  scopeKind: "company",
  scopeId: "acme-corp",
  stateKey: "hindsight-config",
});

console.log(JSON.stringify(config, null, 2));
```

### View Plugin Logs

Look for messages like:
- `"Initialized memory bank with best practices"` → Bank init succeeded
- `"Failed to initialize bank with missions"` → Bank init failed (non-fatal)
- `"Recalled memories for run"` → Recall working

---

## Examples by Use Case

### Use Case 1: Engineering Team (Fast Iteration)

```json
{
  "contextOverride": "acme-backend",
  "recallBudgetOverride": "low",
  "bankInit": {
    "retain_mission": "Extract bugs, PRs, deploys, and technical decisions.",
    "observations_mission": "Map code areas, engineers, issues, and fixes.",
    "entity_types": ["Bug", "Feature", "PR", "Engineer", "System"],
    "disposition_traits": ["skepticism", "literalism"]
  }
}
```

### Use Case 2: Product/UX Team (User-Focused)

```json
{
  "contextOverride": "acme-product",
  "recallBudgetOverride": "high",
  "bankInit": {
    "retain_mission": "Extract user feedback, feature requests, and product decisions.",
    "observations_mission": "Identify users, features, feedback themes, and market needs.",
    "entity_types": ["User", "Feature", "Feedback", "Market Segment"],
    "disposition_traits": ["literalism", "empathy"]
  }
}
```

### Use Case 3: Operations (Compliance Required)

```json
{
  "contextOverride": "acme-ops",
  "disableAutoRetain": false,
  "bankGranularityOverride": ["company", "agent", "user"],
  "bankInit": {
    "retain_mission": "Record operational decisions, incidents, and resolutions.",
    "entity_types": ["Incident", "Resolution", "Decision", "Metric"],
    "disposition_traits": ["skepticism"]
  }
}
```

---

## FAQ

**Q: What if two companies use the same agent ID?**  
A: Banks are isolated by company. Agent `ag-1` in company A has separate memory from `ag-1` in company B.

**Q: Can I share memories between companies?**  
A: No. By design, memory is isolated per company. Override `bankGranularityOverride: ["agent"]` only if intentional.

**Q: Does changing context affect existing memories?**  
A: No. Context is applied to new memories on retention. Existing memories keep their original context.

**Q: How long does bank initialization take?**  
A: Typically <100ms. If network is slow, up to 15 seconds (timeout).

**Q: Can I disable memory for testing?**  
A: Yes: `"disableAutoRetain": true`. Recall still works, but nothing is retained automatically.

---

## Next Steps

1. **Identify use cases** for your companies
2. **Draft domain-specific missions** and entity types
3. **Set configuration** via Paperclip API or admin panel
4. **Monitor logs** for successful bank initialization
5. **Collect feedback** on extraction quality after first month

See [PHASE_1_5_BANK_INITIALIZATION.md](./PHASE_1_5_BANK_INITIALIZATION.md) for technical details.
