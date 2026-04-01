# Chapter 16: API Client and Caching Architecture

## Overview

Every API request Claude Code sends is shaped by a sophisticated caching strategy designed to minimize token costs. The system prompt is segmented into blocks with different cache scopes, beta headers are latched to prevent mid-session cache busting, and a dedicated detection system monitors for unexpected cache misses. This chapter traces the complete path from system prompt assembly to the final API request, focusing on how caching decisions are made and enforced.

## API Client Architecture

### queryModel() as the Core Async Generator

All API requests flow through a single function: `queryModel()` in `src/services/api/claude.ts`. It is an async generator that yields `StreamEvent`, `AssistantMessage`, and `SystemAPIErrorMessage` objects. Two thin wrappers expose it:

```typescript
// Non-streaming: collects all yields, returns the final AssistantMessage
export async function queryModelWithoutStreaming({ messages, systemPrompt, ... })

// Streaming: re-yields everything for the caller to consume in real time
export async function* queryModelWithStreaming({ messages, systemPrompt, ... })
```

Both wrappers delegate to `queryModel()` through a VCR layer (used for recording and replaying API interactions in development).

### System Prompt Finalization

Inside `queryModel()`, the system prompt array is finalized by prepending and appending fixed elements:

```typescript
systemPrompt = asSystemPrompt(
  [
    getAttributionHeader(fingerprint),      // billing/attestation header
    getCLISyspromptPrefix({                  // identity one-liner
      isNonInteractive: options.isNonInteractiveSession,
      hasAppendSystemPrompt: options.hasAppendSystemPrompt,
    }),
    ...systemPrompt,                         // all memoized sections
    ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
    ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),
  ].filter(Boolean),
)
```

The order matters for caching: the attribution header and prefix are always first, static instruction sections come next, and dynamic advisor/chrome instructions are appended last.

### The Three CLI Prefix Strings

Defined in `src/constants/system.ts`, the prefix is a single sentence that tells the model who it is. The choice depends on session type:

```typescript
const DEFAULT_PREFIX =
  `You are Claude Code, Anthropic's official CLI for Claude.`

const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX =
  `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`

const AGENT_SDK_PREFIX =
  `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
```

Selection logic in `getCLISyspromptPrefix()`:

| Condition | Prefix |
|-----------|--------|
| Vertex provider | `DEFAULT_PREFIX` |
| Non-interactive + has append system prompt | `AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX` |
| Non-interactive (SDK mode) | `AGENT_SDK_PREFIX` |
| Interactive (default) | `DEFAULT_PREFIX` |

All three strings are stored in a `Set` called `CLI_SYSPROMPT_PREFIXES`, which `splitSysPromptPrefix()` uses to identify the prefix block by content rather than by position.

### Attribution Header Format

The attribution header is a structured string sent as the first system prompt block:

```
x-anthropic-billing-header: cc_version=1.2.3.a1b2c3; cc_entrypoint=cli; cch=00000; cc_workload=cron;
```

- `cc_version`: package version concatenated with a fingerprint derived from the first user message
- `cc_entrypoint`: how Claude Code was launched (`cli`, `sdk`, etc.)
- `cch=00000`: a placeholder overwritten by Bun's native HTTP stack with a client attestation token (when `NATIVE_CLIENT_ATTESTATION` is enabled)
- `cc_workload`: optional routing hint (e.g., `cron` for scheduled tasks)

The header can be disabled via the `CLAUDE_CODE_ATTRIBUTION_HEADER` environment variable or a GrowthBook killswitch.

## Three-Tier Cache Segmentation

The function `splitSysPromptPrefix()` in `src/utils/api.ts` is the heart of the caching strategy. It takes the flat system prompt array and segments it into blocks, each tagged with a `cacheScope` of `'global'`, `'org'`, or `null`.

### How Blocks Are Identified

Rather than relying on array position, the function identifies blocks by content pattern matching:

```typescript
if (block.startsWith('x-anthropic-billing-header')) {
  attributionHeader = block
} else if (CLI_SYSPROMPT_PREFIXES.has(block)) {
  systemPromptPrefix = block
} else {
  // Everything else
}
```

This is resilient to ordering changes as long as the attribution header and prefix retain their distinctive content.

### The Three Modes

```
┌──────────────────────────────────────────────────────────────────┐
│                    splitSysPromptPrefix()                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Mode 1: MCP tools present (skipGlobalCacheForSystemPrompt=true) │
│  ┌──────────────┬──────────────┬─────────────────┐              │
│  │ attribution  │   prefix     │    rest          │              │
│  │ scope: null  │ scope: org   │  scope: org      │              │
│  └──────────────┴──────────────┴─────────────────┘              │
│                                                                  │
│  Mode 2: Global cache with boundary (1P only)                    │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐  │
│  │ attribution  │   prefix     │   static     │  dynamic     │  │
│  │ scope: null  │ scope: null  │ scope: global│  scope: null │  │
│  └──────────────┴──────────────┴──────────────┴──────────────┘  │
│                                                                  │
│  Mode 3: Default (3P or no boundary)                             │
│  ┌──────────────┬──────────────┬─────────────────┐              │
│  │ attribution  │   prefix     │    rest          │              │
│  │ scope: null  │ scope: org   │  scope: org      │              │
│  └──────────────┴──────────────┴─────────────────┘              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Mode 1 -- MCP tools present.** When MCP tools are detected in the active tool set (and not deferred via tool search), the system prompt cannot use global cache scope because MCP tools are per-user and would fragment the global cache. The system prompt gets `org`-scoped caching on the prefix and rest blocks, while the attribution header gets no caching at all.

**Mode 2 -- Global cache with boundary marker.** For first-party Anthropic users without MCP tools, the system prompt is split at `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (the literal string `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`). Everything before the boundary is static across all users and gets `scope: 'global'` -- shared across the entire Anthropic fleet. Everything after the boundary is user-specific (runtime-variant sections) and gets `scope: null` (no caching). The prefix also gets `null` scope since it varies by session type.

**Mode 3 -- Default.** Third-party providers (Bedrock, Vertex) or first-party users where the boundary marker is missing fall back to `org`-scoped caching, identical to Mode 1.

### The Dynamic Boundary

The boundary marker is inserted inside `getSystemPrompt()` in `src/constants/prompts.ts`:

```typescript
[
  ...staticSections,        // identity, capabilities, tool instructions, etc.
  getOutputEfficiencySection(),
  // === BOUNDARY MARKER ===
  ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
  // --- Dynamic content ---
  ...resolvedDynamicSections,
]
```

Dynamic sections placed after the boundary include session-variant guidance that would fragment the global cache prefix if placed before it. Each conditional bit would otherwise multiply the Blake2b prefix hash variants (2^N possible combinations).

> **Key Insight:** The boundary marker itself is stripped during `splitSysPromptPrefix()` processing -- it never appears in the actual API request. It exists solely as a signal to the segmentation logic.

## Cache Control Configuration

### getCacheControl()

The `getCacheControl()` function in `src/services/api/claude.ts` builds the `cache_control` object attached to each text block:

```typescript
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

The base type is always `'ephemeral'` (default 5-minute TTL). Two optional upgrades:

- **TTL upgrade to 1 hour**: Granted when the user is eligible (Anthropic employee or non-overage subscriber) AND the query source matches a GrowthBook allowlist pattern. Bedrock users can opt in via `ENABLE_PROMPT_CACHING_1H_BEDROCK`.
- **Scope upgrade to global**: Only applied for blocks before the dynamic boundary in Mode 2.

Both eligibility and the allowlist are latched into bootstrap state on first evaluation to prevent mid-session changes from causing cache key instability.

### buildSystemPromptBlocks()

This function converts the segmented blocks into the final `TextBlockParam[]` for the API:

```typescript
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: { skipGlobalCacheForSystemPrompt?: boolean; querySource?: QuerySource },
): TextBlockParam[] {
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => ({
    type: 'text' as const,
    text: block.text,
    ...(enablePromptCaching &&
      block.cacheScope !== null && {
        cache_control: getCacheControl({
          scope: block.cacheScope,
          querySource: options?.querySource,
        }),
      }),
  }))
}
```

Blocks with `cacheScope: null` receive no `cache_control` at all. Prompt caching can be entirely disabled via `DISABLE_PROMPT_CACHING` or per-model environment variables (`DISABLE_PROMPT_CACHING_HAIKU`, `DISABLE_PROMPT_CACHING_SONNET`, `DISABLE_PROMPT_CACHING_OPUS`).

## Beta Header Latching

### The Problem

Beta headers are part of the server-side cache key. If a user toggles AFK mode mid-session, that adds `AFK_MODE_BETA_HEADER` to the request, changing the cache key and busting approximately 50-70K tokens of cached prompt.

### The Solution: Sticky-On Latches

Once a beta header is first sent, it stays active for the rest of the session:

```typescript
// Once AFK mode is activated, the header stays on
let afkHeaderLatched = getAfkModeHeaderLatched() === true
if (!afkHeaderLatched && isAgenticQuery && isAutoModeActive()) {
  afkHeaderLatched = true
  setAfkModeHeaderLatched(true)  // Persisted in bootstrap state
}

// Same pattern for fast mode
let fastModeHeaderLatched = getFastModeHeaderLatched() === true
if (!fastModeHeaderLatched && isFastMode) {
  fastModeHeaderLatched = true
  setFastModeHeaderLatched(true)
}
```

Four headers use this latch pattern:

| Header | Trigger |
|--------|---------|
| `AFK_MODE_BETA_HEADER` | Auto mode activated during agentic query |
| `FAST_MODE_BETA_HEADER` | Fast mode used for first time |
| `CACHE_EDITING_BETA_HEADER` | Cached microcompact enabled on main thread |
| `thinkingClearLatched` | Time since last API completion exceeds 1 hour |

The distinction between the latched header and the live behavior is important. For example, the fast mode beta header stays latched, but the `speed='fast'` parameter remains dynamic -- cooldown can suppress the actual fast-mode request without changing the cache key.

### Latch Lifecycle

Latches are cleared on `/clear` and `/compact` via `clearBetaHeaderLatches()`:

```typescript
export function clearBetaHeaderLatches(): void {
  STATE.afkModeHeaderLatched = null
  STATE.fastModeHeaderLatched = null
  STATE.cacheEditingHeaderLatched = null
  STATE.thinkingClearLatched = null
}
```

This is called from `clearSystemPromptSections()`, which also resets the memoized system prompt. A fresh conversation gets fresh header evaluation.

### getMergedBetas()

The `getMergedBetas()` function in `src/utils/betas.ts` assembles the base beta set:

```typescript
export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]

  if (options?.isAgenticQuery) {
    // Agentic queries always need claude-code and cli-internal headers
    if (!baseBetas.includes(CLAUDE_CODE_20250219_BETA_HEADER)) {
      baseBetas.push(CLAUDE_CODE_20250219_BETA_HEADER)
    }
    // ...cli-internal header for ant users
  }

  const sdkBetas = getSdkBetas()
  return [...baseBetas, ...sdkBetas.filter(b => !baseBetas.includes(b))]
}
```

The latched headers are appended later inside `queryModel()` via the `paramsFromContext` closure, which is called on every retry attempt. Additional headers like `PROMPT_CACHING_SCOPE_BETA_HEADER`, `ADVISOR_BETA_HEADER`, and tool search headers are added conditionally before latching begins.

## Prompt Cache Break Detection

The file `src/services/api/promptCacheBreakDetection.ts` implements a two-phase detection system for unexpected cache misses.

### Phase 1: Pre-Call State Recording

Before each API call, `recordPromptState()` captures a snapshot of everything that could affect the server-side cache key:

```typescript
recordPromptState({
  system,                   // TextBlockParam[] with cache_control
  toolSchemas,              // BetaToolUnion[] (excluding defer_loading tools)
  querySource,
  model,
  agentId,
  fastMode: fastModeHeaderLatched,
  globalCacheStrategy,
  betas,
  autoModeActive: afkHeaderLatched,
  isUsingOverage,
  cachedMCEnabled: cacheEditingHeaderLatched,
  effortValue: effort,
  extraBodyParams,
})
```

The function hashes the system prompt and tool schemas (with `cache_control` stripped for one hash, included for another), then computes a diff against the previous state. Changes are stored as `pendingChanges` but no events are fired yet.

### Phase 2: Post-Call Response Check

After the API responds, `checkResponseForCacheBreak()` examines the usage tokens:

```typescript
// Detect a cache break: cache read dropped >5% AND
// the absolute drop exceeds 2,000 tokens
const tokenDrop = prevCacheRead - cacheReadTokens
if (cacheReadTokens >= prevCacheRead * 0.95 || tokenDrop < MIN_CACHE_MISS_TOKENS) {
  state.pendingChanges = null
  return  // No break detected
}
```

When a break is detected, the pending changes from Phase 1 are used to build an explanation:

- System prompt changed (+/- N chars)
- Tools changed (+N/-N tools, or specific tool schemas changed)
- Model changed
- Beta headers changed (+added, -removed)
- Cache control changed (scope or TTL flip)
- Possible 5min or 1h TTL expiry (when no client-side changes are found)
- Likely server-side routing/eviction (prompt unchanged, under 5min gap)

A diff file is written to the temp directory for debugging, and a `tengu_prompt_cache_break` analytics event is logged with all the diagnostic fields.

### Tracking Scope

Not all query sources are tracked. Short-lived forked agents (speculation, session memory, prompt suggestions) are excluded because they run 1-3 turns with a fresh agent ID each time. The tracked sources include:

- `repl_main_thread` (and `compact`, which shares the same cache)
- `sdk`
- `agent:custom`, `agent:default`, `agent:builtin`

A maximum of 10 sources are tracked simultaneously to prevent unbounded memory growth from subagent spawning.

## Retry Logic and Error Handling

### withRetry()

The `withRetry()` function in `src/services/api/withRetry.ts` is itself an async generator, yielding `SystemAPIErrorMessage` objects during retry delays so the UI can display progress.

```
┌─────────────────────────────┐
│        withRetry()           │
│                              │
│  for attempt 1..maxRetries   │
│    ├─ try operation()        │
│    │   └─ success → return   │
│    └─ catch error            │
│        ├─ FallbackTriggered? │
│        │   └─ throw (to      │
│        │      query.ts)      │
│        ├─ 529 + not          │
│        │  foreground?         │
│        │   └─ CannotRetry    │
│        ├─ 529 × 3 + has     │
│        │  fallback?           │
│        │   └─ throw Fallback │
│        ├─ PROMPT_TOO_LONG?   │
│        │   └─ adjust         │
│        │      maxTokens      │
│        ├─ shouldRetry()?     │
│        │   ├─ delay with     │
│        │   │  backoff+jitter │
│        │   └─ yield error msg│
│        └─ else               │
│            └─ CannotRetry    │
└─────────────────────────────┘
```

### Exponential Backoff with Jitter

```typescript
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) return seconds * 1000
  }
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), maxDelayMs)
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}
```

Base delay starts at 500ms and doubles each attempt up to a 32-second cap. The `Retry-After` header, when present, overrides the calculated delay entirely.

### Error Classification

The `shouldRetry()` function classifies errors:

- **Always retryable**: Connection errors, 408 (timeout), 409 (lock), 5xx server errors, `overloaded_error` in message body
- **Conditionally retryable**: 429 (rate limit) -- only for non-subscriber or enterprise users; 401 -- clears API key cache and retries
- **Never retryable**: Mock rate limit errors (from `/mock-limits`), errors where `x-should-retry: false` header is set (with exceptions for ant users on 5xx)

### PROMPT_TOO_LONG Handling

When the API returns a 400 with "input length and `max_tokens` exceed context limit", the error message is parsed:

```typescript
// Example: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
const regex = /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
```

The retry context's `maxTokensOverride` is set to `contextLimit - inputTokens - 1000` (safety buffer), with a floor of 3,000 tokens. The next attempt uses this reduced `max_tokens`.

### Persistent Retry Mode

When `CLAUDE_CODE_UNATTENDED_RETRY` is enabled (ant-only, for unattended sessions), 429 and 529 errors are retried indefinitely with a 5-minute max backoff cap. Long waits are chunked into 30-second intervals with heartbeat yields to prevent the host from marking the session idle.

## Fallback Model Switching

When `withRetry()` throws `FallbackTriggeredError` (after 3 consecutive 529 errors with a fallback model configured), `query.ts` handles the switch:

```typescript
} catch (innerError) {
  if (innerError instanceof FallbackTriggeredError && fallbackModel) {
    currentModel = fallbackModel
    attemptWithFallback = true

    // Clear all state from the failed attempt
    yield* yieldMissingToolResultBlocks(
      assistantMessages,
      'Model fallback triggered',
    )
    assistantMessages.length = 0
    toolResults.length = 0
    toolUseBlocks.length = 0
    needsFollowUp = false

    // Discard pending tool executions and create fresh executor
    streamingToolExecutor.discard()
    streamingToolExecutor = new StreamingToolExecutor(...)
  }
}
```

The fallback yields tombstone `tool_result` blocks for any orphaned `tool_use` messages from the failed attempt, preventing API validation errors on the retry. The streaming tool executor is discarded and recreated to prevent stale results from leaking across attempts.

> **Key Insight:** `FallbackTriggeredError` is deliberately not caught inside `queryModel()` -- it propagates up through the retry wrapper and the VCR layer to `query.ts`, which is the only place with enough context to perform the full state reset.

## Token Estimation

The `src/services/tokenEstimation.ts` file provides both API-based and heuristic token counting.

### Rough Estimation

The simplest estimator divides byte length by a bytes-per-token ratio:

```typescript
export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  return Math.round(content.length / bytesPerToken)
}
```

File-type-aware variants use tighter ratios for dense formats (JSON gets 2 bytes/token instead of the default 4).

### API-Based Counting

`countMessagesTokensWithAPI()` calls the Anthropic count-tokens endpoint using the main loop model. For Bedrock, it uses the AWS `CountTokensCommand` directly. A fallback path (`countTokensViaHaikuFallback()`) uses Haiku for cheaper token counting, with special handling for Vertex global regions and thinking blocks.

These counts feed into:
- Auto-compact threshold calculation (deciding when to compact the conversation)
- Context window management (ensuring requests fit within model limits)
- Analytics logging (tracking context sizes across sessions)

## API Request Assembly

The complete assembly sequence, from high-level context gathering to the final API parameters:

```
1. fetchSystemPromptParts()
   ├─ getSystemPrompt()         → memoized section array with boundary marker
   ├─ getUserContext()           → { claudeMd: "..." }
   └─ getSystemContext()         → { gitStatus: "..." }

2. QueryEngine.ask()
   ├─ appendSystemContext(systemPrompt, systemContext)
   │   └─ appends "gitStatus: ..." to system prompt array
   └─ prependUserContext(messages, userContext)
       └─ prepends <system-reminder> user message with CLAUDE.md

3. queryModel()
   ├─ Prepend attribution header + CLI prefix
   ├─ Append advisor/chrome instructions
   ├─ buildSystemPromptBlocks()
   │   └─ splitSysPromptPrefix()
   │       └─ Returns SystemPromptBlock[] with cacheScope tags
   │           └─ Map to TextBlockParam[] with cache_control
   ├─ Build tool schemas (with defer_loading, cache_control)
   ├─ Normalize messages for API
   ├─ Compute fingerprint from first user message
   ├─ Latch beta headers
   └─ paramsFromContext() assembles final params:
       {
         model,
         messages,      // with cache breakpoints
         system,        // TextBlockParam[] with cache_control
         tools,         // BetaToolUnion[] (toolSchemas + extraToolSchemas)
         tool_choice,
         betas,         // merged base + SDK + latched headers
         metadata,      // user_id with device_id, session_id
         max_tokens,
         thinking,      // { type: 'adaptive' } or { type: 'enabled', budget_tokens }
         temperature,   // only when thinking disabled
         speed,         // 'fast' when fast mode active
         output_config, // effort, task_budget, format
         context_management,  // API-side microcompact strategies
         ...extraBodyParams,  // CLAUDE_CODE_EXTRA_BODY + bedrock betas
       }
```

> **Key Insight:** The fingerprint is computed from user messages *before* synthetic messages (deferred tool lists, tool reference blocks) are injected. This ensures the attribution header's version fingerprint reflects the actual user input, not internal bookkeeping.

## Key Takeaways

1. **Three cache modes exist** depending on whether MCP tools are present, whether the global cache feature is enabled, and whether the dynamic boundary marker is found. The mode selection is automatic and invisible to the user.

2. **The dynamic boundary splits static from dynamic content.** Static sections (shared across all users) get global scope; dynamic sections (runtime-variant) get no caching. This single marker controls a significant cost optimization.

3. **Beta headers are latched sticky-on.** Once sent, a beta header stays for the session to prevent cache key instability. The actual behavior (fast mode, AFK mode) remains dynamic -- only the header is frozen.

4. **Cache break detection is a two-phase system.** State is recorded before each API call, and cache tokens are checked after. This lets the system attribute breaks to specific causes (system prompt change, tool schema change, beta header flip, TTL expiry, or server-side eviction).

5. **Retry logic is layered.** `withRetry()` handles exponential backoff, `Retry-After` headers, authentication refresh, `max_tokens` adjustment for context overflow, and fallback model switching -- all as an async generator that yields status messages to the UI.

6. **Token estimation has two tiers.** API-based counting is accurate but costs a request; rough estimation (bytes / 4) is free and used for analytics and threshold calculations where precision is less critical.

7. **The final request assembly is a pipeline** that passes through context gathering, system prompt memoization, message normalization, cache segmentation, beta header merging, and parameter construction -- with each stage carefully ordered to preserve cache stability.
