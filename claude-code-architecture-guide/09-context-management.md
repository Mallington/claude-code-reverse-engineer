# Chapter 9: Context Management

## Overview

Context management is the art of fitting everything -- system prompt, tools, conversation history, system reminders, skill content, tool results -- into the model's context window. Claude Code uses several strategies to manage this.

## The Context Budget

### Available Context by Model
| Model | Context Window | Effective (after system + tools) |
|-------|---------------|----------------------------------|
| Claude Sonnet 4 | 200K tokens | ~170K tokens |
| Claude Opus 4.6 (1M) | 1M tokens | ~970K tokens |
| Claude Haiku 4.5 | 200K tokens | ~170K tokens |

### Fixed Costs Per Turn
| Component | Approximate Tokens |
|-----------|-------------------|
| System prompt (2 blocks) | ~3,500 |
| Tool definitions (57 tools) | ~15,000-20,000 |
| System reminders (first turn) | ~2,000-5,000 |
| **Total fixed overhead** | **~20,000-28,000** |

This means every API call starts with ~20K-28K tokens of overhead before any conversation content.

## Caching Strategy

### Prompt Caching
The system prompt uses `cache_control: { type: "ephemeral" }` on both blocks:

```json
{
  "system": [
    { "text": "...", "cache_control": { "type": "ephemeral" } },
    { "text": "...", "cache_control": { "type": "ephemeral" } }
  ]
}
```

This tells the API to cache the system prompt between turns. On subsequent turns:
- **Cache hit**: System prompt tokens are read from cache (faster, cheaper)
- **Cache miss**: Full re-processing (happens when system prompt changes)

### Why System Reminders Exist
Dynamic content goes into messages (not system) specifically to **preserve the cache**. If the system prompt changed every turn (e.g., to include the current date or task status), caching would never work.

---

## The Four-Layer Compression Architecture (Source Code Revealed)

Claude Code does not use a single compression strategy. It uses a **four-layer pipeline** ranging from zero-cost server-side edits to full LLM-powered summarization. Each layer fires at different thresholds and has different tradeoffs. Two additional mechanisms (Reactive Compact and Context Collapse) operate outside the normal pipeline.

### Architecture Overview

| Layer | Source File | Trigger | What It Does | API Cost |
|-------|------------|---------|-------------|----------|
| 1. API Microcompact | `apiMicrocompact.ts` | Every request | Server-side `context_management` edits (clear thinking, clear tool results) | Zero |
| 2. Client Microcompact | `microCompact.ts` | Every request | Client-side clearing of old tool results (time-based or cache-editing) | Zero |
| 3. Session-Memory Compact | `sessionMemoryCompact.ts` | Token threshold | Substitutes existing session memory file as the summary | Zero |
| 4. Full LLM Compact | `compact.ts` | Token threshold (fallback) | LLM-generated conversation summarization via forked agent | Full API call |
| (R) Reactive Compact | `reactiveCompact.ts` | 413 error from API | Emergency compaction when API rejects prompt as too long | Full API call |
| (C) Context Collapse | `contextCollapse/` | Feature-gated | Granular commit/archive of conversation segments | Varies |

The layers execute in a strict pipeline every turn. Session-Memory Compact is tried **before** Full LLM Compact (because it is free). If it produces a result that still fits under the threshold, the LLM compact is skipped entirely.

### The Pre-Processing Pipeline (query.ts)

Every turn, before the main API call, the following pipeline runs in this exact order:

```
applyToolResultBudget()          -- enforce per-tool result size caps
        |
        v
snipCompactIfNeeded()            -- history snip (feature-gated)
        |
        v
microcompactMessages()           -- Layer 2: time-based or cached MC
        |
        v
applyCollapsesIfNeeded()         -- Context Collapse (feature-gated)
        |
        v
autoCompactIfNeeded()            -- Layers 3+4: session-memory then LLM compact
        |
        v
[API call with Layer 1 context_management config]
```

Source: `query.ts` lines ~370-468. The `applyToolResultBudget` step replaces oversized tool results with stubs. Snip removes old messages. Microcompact clears stale tool outputs. Context Collapse projects a reduced view. Autocompact fires the heavy summarization if tokens still exceed the threshold.

---

### Token Thresholds and Constants

From `autoCompact.ts` and `context.ts`:

```
MODEL_CONTEXT_WINDOW_DEFAULT     = 200,000 tokens
COMPACT_MAX_OUTPUT_TOKENS        = 20,000 tokens (reserved for summary output)
AUTOCOMPACT_BUFFER_TOKENS        = 13,000
WARNING_THRESHOLD_BUFFER_TOKENS  = 20,000
ERROR_THRESHOLD_BUFFER_TOKENS    = 20,000
MANUAL_COMPACT_BUFFER_TOKENS     = 3,000
```

**Effective context window** is calculated as:

```
effectiveContextWindow = contextWindow - min(maxOutputTokensForModel, 20_000)
```

For a 200K model: `200,000 - 20,000 = 180,000` effective tokens.

**Auto-compact fires at**: `effectiveContextWindow - 13,000` = **167,000 tokens** for a 200K model.

**Warning threshold**: `autoCompactThreshold - 20,000` = ~147,000 tokens.

**Blocking limit** (user cannot send messages): `effectiveContextWindow - 3,000` = **177,000 tokens**.

**Circuit breaker**: After 3 consecutive auto-compact failures, the system stops trying for the remainder of the session. This prevents runaway API costs in sessions where context is irrecoverably over the limit. A BQ query from March 2026 found 1,279 sessions with 50+ consecutive failures (up to 3,272 per session), wasting approximately 250K API calls/day globally before the circuit breaker was added.

**Overrides**:
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: caps the context window used for threshold calculation
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: fire autocompact at N% of effective window (for testing)
- `DISABLE_COMPACT`: disable all compaction
- `DISABLE_AUTO_COMPACT`: disable only auto-compact (manual `/compact` still works)
- `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`: override the blocking limit

---

### Layer 1: API Microcompact (Server-Side)

**Source**: `src/services/compact/apiMicrocompact.ts`

This layer generates a `ContextManagementConfig` object that is sent with every API request. The server applies these edits to the conversation before processing, so the client never pays for the tokens that are cleared.

**Two strategies**:

1. **`clear_thinking_20251015`**: Controls thinking block preservation.
   - Default: preserves all thinking blocks (`keep: 'all'`)
   - When `clearAllThinking` is true (idle >1h, cache miss): keeps only the last 1 thinking turn (`keep: { type: 'thinking_turns', value: 1 }`)
   - The API schema requires `value >= 1`, so you cannot clear ALL thinking this way
   - Skipped when redact-thinking is active (redacted blocks have no model-visible content)

2. **`clear_tool_uses_20250919`**: Clears old tool results server-side (ant-only, env-gated).
   - Trigger: `input_tokens > 180,000` (default `DEFAULT_MAX_INPUT_TOKENS`)
   - Target: clear until only ~40,000 tokens of tool results remain (`DEFAULT_TARGET_INPUT_TOKENS`)
   - Clearable result tools: Shell, Glob, Grep, Read, WebFetch, WebSearch
   - Clearable use tools (inputs only): Edit, Write, NotebookEdit
   - Controlled by `USE_API_CLEAR_TOOL_RESULTS` and `USE_API_CLEAR_TOOL_USES` env vars

```typescript
// The config sent with the API request
type ContextManagementConfig = {
  edits: ContextEditStrategy[]
}
```

---

### Layer 2: Client Microcompact

**Source**: `src/services/compact/microCompact.ts`

This layer runs client-side every turn before the API call. It has two paths:

#### Time-Based Path
**Config**: `timeBasedMCConfig.ts` -- defaults: `gapThresholdMinutes: 60`, `keepRecent: 5`

Fires when the gap since the last assistant message exceeds the threshold (60 minutes by default, matching the server's 1-hour prompt cache TTL). Since the cache is guaranteed cold, clearing old tool results shrinks what gets rewritten without any cache penalty.

Behavior:
- Collects all compactable tool IDs in encounter order
- Keeps the last `keepRecent` (5 by default, minimum 1)
- Replaces older tool result content with `[Old tool result content cleared]`
- Resets cached-MC state (since the server cache is invalidated)
- Only runs on main thread (not subagents)

**Compactable tools**:
- `Read`, `Shell` (all variants), `Grep`, `Glob`, `WebSearch`, `WebFetch`, `Edit`, `Write`

#### Cached Microcompact Path (ant-only, feature-gated)

Uses the `cache_edits` API to delete tool results server-side without invalidating the cached prefix. This is the preferred path when the cache is warm.

Behavior:
- Tracks tool results registered across turns in a persistent `CachedMCState`
- When a count-based threshold is exceeded, queues `cache_edits` blocks for the API layer
- Does NOT modify local message content -- cache_reference and cache_edits are applied at the API layer
- After the API response, a deferred boundary message records actual `cache_deleted_input_tokens`
- Takes precedence over time-based MC (they are mutually exclusive per turn)

---

### Layer 3: Session-Memory Compact

**Source**: `src/services/compact/sessionMemoryCompact.ts`

This is the first layer tried inside `autoCompactIfNeeded()`, and it is **free** -- no API call required. It uses the session memory file that Claude Code's session memory system has already been extracting throughout the conversation.

**Prerequisites**:
- Session memory feature flag is enabled (`tengu_session_memory`)
- SM-compact flag is enabled (`tengu_sm_compact`)
- Session memory file exists and is not empty (not just the template)
- Can be forced with `ENABLE_CLAUDE_CODE_SM_COMPACT` env var

**How `calculateMessagesToKeepIndex()` works**:

```
Default config:
  minTokens:            10,000
  minTextBlockMessages: 5
  maxTokens:            40,000
```

Starting from the `lastSummarizedMessageId` (the point up to which session memory has been extracted), expand backwards to meet both minimums:
- At least 10K tokens of messages
- At least 5 messages with text blocks
- Stop at 40K tokens (hard cap)

**Invariant preservation**: `adjustIndexToPreserveAPIInvariants()` ensures:
- Tool_use/tool_result pairs are never split (would cause API errors)
- Thinking blocks that share a `message.id` with kept assistant messages are included (streaming yields separate messages per content block with the same ID)
- Never expands past the last compact boundary message

**Compaction result**: The existing session memory content becomes the summary, wrapped in the standard compact summary message format. Recent messages (determined by the index calculation) are preserved verbatim after the summary.

**Fallback**: Returns `null` if the post-compact token count still exceeds `autoCompactThreshold`, causing `autoCompactIfNeeded()` to fall through to Full LLM Compact.

---

### Layer 4: Full LLM Compact

**Source**: `src/services/compact/compact.ts`, `src/services/compact/prompt.ts`

This is the heavyweight: it makes an API call to generate a conversation summary. It fires only when Session-Memory Compact either is unavailable or fails to bring tokens under the threshold.

#### Pre-Compact Hooks

Before compaction begins, `executePreCompactHooks()` runs any registered pre-compact hooks. These can:
- Inject custom instructions into the compact prompt
- Display a message to the user

#### Summary Generation: `streamCompactSummary()`

Two paths, tried in order:

1. **Forked agent path** (default, preferred): Uses `runForkedAgent()` with `querySource: 'compact'`. This reuses the main conversation's prompt cache by sending identical cache-key params (system, tools, model, messages prefix, thinking config). The fork gets `maxTurns: 1` and `skipCacheWrite: true`.

2. **Direct streaming fallback**: If the forked agent returns no text (e.g., model attempted a tool call despite instructions), falls back to `queryModelWithStreaming()` with `maxOutputTokens` set to `COMPACT_MAX_OUTPUT_TOKENS` (20,000).

#### The Compact Prompt (9 Required Sections)

From `prompt.ts`, the LLM is instructed to produce:

```
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. All User Messages           <-- critical for preserving intent
7. Pending Tasks
8. Current Work
9. Optional Next Step
```

Section 6, "All user messages", is particularly important. The prompt explicitly says: *"List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent."* This prevents the summarizer from dropping user corrections and feedback.

#### The Analysis Scratchpad

The prompt instructs the LLM to produce an `<analysis>` block before the `<summary>` block. This is a **drafting scratchpad** that improves summary quality. `formatCompactSummary()` strips the analysis block from the final output -- it never enters the context window. Only the `<summary>` content survives.

#### Prompt-Too-Long During Compaction: `truncateHeadForPTLRetry()`

If the compact request itself hits a prompt-too-long error (the conversation is so large that even the summarization call exceeds limits), a retry loop activates:

1. `groupMessagesByApiRound()` splits the conversation into API round-trip groups
2. Drop enough oldest groups to cover the token gap (or 20% of groups if gap is unparseable)
3. Prepend a synthetic `[earlier conversation truncated for compaction retry]` marker if the result starts with an assistant message
4. Up to `MAX_PTL_RETRIES = 3` attempts

#### Post-Compact Restoration

After the summary is generated, critical context is re-injected:

| Restored Content | Budget | Details |
|-----------------|--------|---------|
| Recently-read files | 50K tokens total, 5K per file | Top 5 files from `readFileState` cache |
| Active plan | Unbounded | From `getPlan()` if a plan file exists |
| Invoked skills | 25K tokens total, 5K per skill | Skill content that was loaded during the session |
| Deferred tools delta | N/A | Re-announces loaded tool schemas |
| Agent listing delta | N/A | Re-announces sub-agent definitions |
| MCP instructions delta | N/A | Re-announces MCP server instructions |
| SessionStart hooks | N/A | Re-fires hooks (CLAUDE.md, etc.) with `compact` event |
| Post-compact hooks | N/A | Runs any registered PostCompact hooks |

```typescript
// Constants from compact.ts
POST_COMPACT_MAX_FILES_TO_RESTORE   = 5
POST_COMPACT_TOKEN_BUDGET           = 50_000
POST_COMPACT_MAX_TOKENS_PER_FILE    = 5_000
POST_COMPACT_MAX_TOKENS_PER_SKILL   = 5_000
POST_COMPACT_SKILLS_TOKEN_BUDGET    = 25_000
```

Note on skills: The system intentionally does NOT call `resetSentSkillNames()` after compaction. Re-injecting the full skill listing (~4K tokens) would be pure `cache_creation` cost with marginal benefit. The model still has `SkillTool` in its schema, and the `invoked_skills` attachment preserves the content of skills already used in the session.

#### Additional Pre-Processing

Before the messages are sent to the summarizer:
- `stripImagesFromMessages()`: replaces image/document blocks with `[image]`/`[document]` markers (saves tokens, prevents the summarization call itself from hitting PTL)
- `stripReinjectedAttachments()`: removes `skill_discovery` and `skill_listing` attachments (they are re-surfaced post-compact anyway)

---

### Message Grouping

**Source**: `src/services/compact/grouping.ts`

`groupMessagesByApiRound()` splits a message array at API round-trip boundaries. A new group starts whenever a new assistant message ID appears (different from the previous assistant's `message.id`).

This is finer-grained than grouping by human turns. Streaming chunks from the same API response share an ID, so `[tool_use_A(id=X), tool_result_A, tool_use_B(id=X)]` stays in one group. This enables reactive compact and PTL retry truncation to operate on single-prompt agentic sessions (SDK/CCR/eval callers) where the entire workload is one human turn.

---

### Post-Compact Cleanup

**Source**: `src/services/compact/postCompactCleanup.ts`

`runPostCompactCleanup()` runs after both auto-compact and manual `/compact`. It resets caches and tracking state that are invalidated by compaction.

**What it resets**:
- Microcompact state (cached-MC tool tracking, pending cache edits)
- Context Collapse state (if main-thread compact)
- `getUserContext` memoized cache (if main-thread compact)
- `getMemoryFiles` cache (if main-thread compact)
- System prompt sections
- Classifier approvals
- Speculative bash permission checks
- Beta tracing state
- Session messages cache
- File content cache (for commit attribution)

**What it does NOT reset**:
- `sentSkillNames` -- avoids re-injecting ~4K tokens of skill listing
- Invoked skill content -- must survive across compactions so `createSkillAttachmentIfNeeded()` can include full skill text in subsequent compaction attachments

**Main-thread safety**: Subagents run in the same process and share module-level state with the main thread. The cleanup function checks `querySource` and only resets main-thread module-level state (context-collapse, memory file cache) for main-thread compacts. Without this guard, a subagent compacting would corrupt the main thread's state.

---

### Reactive Compact (413 Error Recovery)

**Source**: `src/services/compact/reactiveCompact.ts` (feature-gated: `REACTIVE_COMPACT`)

When the API returns a 413 Prompt Too Long error, reactive compact fires as an emergency fallback:

1. The API error is intercepted in `query.ts`
2. Reactive compact uses `groupMessagesByApiRound()` to split the conversation
3. It peels message groups from the tail to reduce context
4. Falls through to standard compaction if needed

This is the safety net for cases where the proactive layers (auto-compact, session-memory compact) fail or are disabled. It is ant-only and feature-gated.

Context Collapse's `recoverFromOverflow` also participates: it drains staged collapses on a real API 413, then falls through to reactive compact if needed.

---

### Context Collapse (Feature-Gated)

**Source**: `src/services/contextCollapse/` (feature-gated: `CONTEXT_COLLAPSE`)

Context Collapse is an experimental alternative to the auto-compact system. When enabled, it **suppresses proactive auto-compact entirely** and manages context through granular commit/archive of conversation segments.

Key thresholds:
- 90% of effective context: commit (archive old segments)
- 95% of effective context: blocking spawn (prevent new subagents)

Context Collapse sits in the pipeline between microcompact and autocompact (`applyCollapsesIfNeeded()`). When it is active, it projects a collapsed view of the conversation that replaces the full history. The view is a read-time projection over the REPL's full history -- collapsed messages live in the collapse store, not the REPL array. `projectView()` replays the commit log on every entry to the pipeline.

Auto-compact is suppressed because it fires at ~93% of effective context, which sits between collapse's commit-start (90%) and blocking (95%). If both ran, auto-compact would usually win the race and destroy the granular context that collapse was about to save.

---

### Data Flow Diagram

```
User sends message
        |
        v
+----------------------------------+
|  applyToolResultBudget()         |  Enforce per-tool result size caps
+----------------------------------+
        |
        v
+----------------------------------+
|  snipCompactIfNeeded()           |  History snip (feature-gated)
|  [HISTORY_SNIP]                  |
+----------------------------------+
        |
        v
+----------------------------------+
|  LAYER 2: microcompactMessages() |
|  +----------------------------+  |
|  | Time-based path            |  |  Gap > 60min? Clear old tool results
|  | (cold cache, mutates msgs) |  |  Keep last 5 compactable results
|  +----------------------------+  |
|  | OR                         |  |
|  +----------------------------+  |
|  | Cached-MC path             |  |  Warm cache? Queue cache_edits for
|  | (ant-only, no mutation)    |  |  server-side deletion
|  +----------------------------+  |
+----------------------------------+
        |
        v
+----------------------------------+
|  applyCollapsesIfNeeded()        |  Context Collapse (feature-gated)
|  [CONTEXT_COLLAPSE]              |  Projects collapsed view of history
+----------------------------------+
        |
        v
+----------------------------------+
|  autoCompactIfNeeded()           |  Tokens > threshold (167K for 200K)?
|  +----------------------------+  |
|  | LAYER 3: trySessionMemory  |  |  Try free SM compact first
|  | Compaction()               |  |  Uses existing session memory file
|  +----> success? done         |  |  Keeps 10-40K tokens of recent msgs
|  |                            |  |
|  | LAYER 4: compactConversation  |  Falls back to LLM summarization
|  | ()                         |  |  Forked agent (cache-sharing) or
|  +----> summary generated     |  |  direct streaming
|  +----------------------------+  |
+----------------------------------+
        |
        v
+----------------------------------+
|  LAYER 1: API context_management |  Server-side edits sent WITH request
|  - clear_thinking (all or 1)     |
|  - clear_tool_uses (ant-only)    |
+----------------------------------+
        |
        v
+----------------------------------+
|  API Call                        |
|  (if 413) --> Reactive Compact   |  Emergency recovery
+----------------------------------+
        |
        v
   Model response
```

---

## Token-Saving Techniques

### 1. Deferred Tool Loading
Instead of sending all 50+ MCP tool schemas every turn, list names and load on demand:
- **Savings**: ~10,000-15,000 tokens per turn for large MCP configurations
- **Cost**: Extra API round-trip when a deferred tool is needed

### 2. Sub-Agent Context Isolation
Sub-agents get fresh context, preventing the parent's context from growing with task details:
- **Savings**: Parent context stays lean even across many tasks
- **Cost**: Sub-agent lacks parent's conversation history

### 3. Explore Agent for Research
Using the `Explore` agent type for research prevents search results from bloating the parent's context:
- **Savings**: Research results stay in sub-agent, only summary returns
- **Cost**: Extra API calls for the sub-agent

### 4. Skill On-Demand Loading
Skills are listed in catalog form (~100 tokens each) but full content (~500-3000 tokens) loads only when invoked:
- **Savings**: 14 skills x 1500 avg = ~21,000 tokens saved if all were pre-loaded
- **Cost**: Extra tool call + round trip per skill invocation

### 5. Concise Response Guidelines
The system prompt aggressively encourages brevity:
- "Keep your responses short"
- "Minimize output tokens as much as possible"
- `max_tokens: 32000` caps response length (with `CAPPED_DEFAULT_MAX_TOKENS = 8,000` for slot-reservation optimization, escalating to 64K on retry)

---

## The Conversation Lifecycle

```
Turn 1: [System] + [Tools] + [SystemReminder(full)] + [UserMsg]
  --> Response + ToolUse
Turn 2: [System] + [Tools] + [ToolResult] + [SystemReminder(light)] + [UserMsg]
  --> Response + ToolUse
...
Turn N: Context approaching 167K tokens
  --> Pipeline: budget -> snip -> microcompact -> collapse -> autocompact
  --> LAYER 3 tried first (session memory -- free)
  --> If still over: LAYER 4 (LLM compact)
  --> SessionStart hooks re-fire (compact event)
  --> Post-compact cleanup resets caches
  --> Continue with compressed history + restored context
...
Turn N+K: 3 consecutive compact failures
  --> Circuit breaker trips, autocompact disabled for session
  --> Blocking limit (177K) enforced at UI level
```

---

## Token Tracking

Claude Code tracks token usage internally:
- Input tokens per request
- Output tokens per request
- Cache read/write tokens
- Running total for the session

The `stats-cache.json` file stores aggregate statistics.

---

## Building Your Own Context Manager

Key design decisions:

### 1. Separate Frozen vs Dynamic Content
```python
# Frozen (cached between turns)
system_prompt = [
    {"text": "identity", "cache_control": {"type": "ephemeral"}},
    {"text": "instructions", "cache_control": {"type": "ephemeral"}}
]

# Dynamic (injected per-turn in messages)
system_reminders = gather_dynamic_context()
```

### 2. Implement Layered Compression
Claude Code's four-layer approach is worth emulating. Start with zero-cost operations (clearing old tool results, reusing existing summaries) before falling back to expensive LLM calls:

```python
# Layer 1: Server-side context management (free)
api_config = {"context_management": {"edits": [
    {"type": "clear_thinking", "keep": "all"},
]}}

# Layer 2: Client-side tool result clearing (free)
if time_since_last_response > CACHE_TTL:
    clear_old_tool_results(keep_recent=5)

# Layer 3: Reuse existing summaries (free)
if session_memory_exists and not session_memory_empty:
    summary = session_memory_content
    if fits_in_budget(summary + recent_messages):
        return compact_with_session_memory(summary, recent_messages)

# Layer 4: LLM summarization (expensive -- last resort)
summary = llm_summarize(conversation, prompt=NINE_SECTION_TEMPLATE)
```

### 3. Implement Deferred Loading
```python
# Don't send all tool schemas
tools = builtin_tools  # Always included
deferred_names = [t.name for t in mcp_tools]  # Names only

# Include ToolSearch tool for on-demand loading
tools.append(tool_search_definition)
system_reminders.append(f"<available-deferred-tools>{deferred_names}</available-deferred-tools>")
```

### 4. Use Sub-Agents for Isolation
```python
# Heavy research goes to sub-agent
if task_is_research:
    result = spawn_subagent(prompt, tools=readonly_tools)
    # Only result.summary enters parent context
```

### 5. Preserve API Invariants During Compression
When pruning messages, ensure:
- Every `tool_result` has a matching `tool_use` in a preceding assistant message
- Thinking blocks that share a `message.id` with kept messages are included
- Never split streaming chunks (multiple messages with same ID)

### 6. Add Circuit Breakers
Compaction can fail repeatedly (e.g., context is irrecoverably large). Track consecutive failures and stop retrying after a threshold to avoid wasting API calls:

```python
MAX_CONSECUTIVE_FAILURES = 3
if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
    skip_autocompact()  # Let blocking limit handle it
```

---

## Context Awareness

Claude Sonnet 4.6, Sonnet 4.5, and Haiku 4.5 have **context awareness** -- they can track remaining context and adjust behavior:
- Summarize more aggressively when context is running low
- Avoid loading unnecessary skills when context is tight
- Prefer delegating to sub-agents when parent context is getting full

---

## Summary

Claude Code's context management is a sophisticated multi-layered system built around one principle: **do the cheapest thing first**. Server-side edits cost nothing. Clearing cold-cache tool results costs nothing. Reusing an already-extracted session memory costs nothing. Only when all free options are exhausted does the system spend tokens on LLM-powered summarization -- and even then, it reuses the main conversation's prompt cache via a forked agent to minimize cost. The circuit breaker prevents runaway costs when compaction repeatedly fails. The result is a system that keeps long-running sessions productive while minimizing both latency and API spend.
