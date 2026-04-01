# Chapter 14: The Query Engine

## Overview

Every user message in Claude Code flows through two central components: `QueryEngine` (the session owner) and `query()` (the agentic loop). Together they form the beating heart of the system -- QueryEngine manages the lifecycle of a conversation, while query() runs the inner `while(true)` loop that calls the model, executes tools, recovers from errors, and decides when to stop. This chapter traces that machinery in detail.

## Architecture Overview

The call chain from user input to model response follows a fixed sequence:

```
QueryEngine.submitMessage(prompt)
       │
       ▼
fetchSystemPromptParts()          ← Resolve system prompt, user/system context
       │
       ▼
processUserInput()                ← Handle slash commands, build user message
       │
       ▼
query()                           ← Entry point: wraps queryLoop, notifies commands
       │
       ▼
queryLoop()                       ← The while(true) agentic loop
       │
       ▼
  ┌─── yields ──────────────────┐
  │ AssistantMessage             │
  │ UserMessage (tool results)   │
  │ StreamEvent                  │
  │ TombstoneMessage             │
  │ ToolUseSummaryMessage        │
  │ AttachmentMessage            │
  └──────────────────────────────┘
```

`QueryEngine` is one instance per conversation. It creates the `query()` generator, iterates it, maps each yielded internal message to an SDK-compatible format, persists the transcript, tracks usage, and reports the final result. The `query()` function itself is a pure generator -- it knows nothing about SDK types or session persistence.

## The QueryEngine Class

From `src/QueryEngine.ts`:

### Lifecycle

```typescript
export class QueryEngine {
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private readFileState: FileStateCache
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()

  constructor(config: QueryEngineConfig) {
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }
}
```

One `QueryEngine` is created per conversation. State persists across turns:

- **mutableMessages** -- the canonical message array, growing across turns
- **permissionDenials** -- accumulated denials reported at turn end
- **readFileState** -- tracks which files the model has already read (prevents duplicate memory attachments)
- **discoveredSkillNames** -- cleared per turn, feeds skill discovery analytics
- **totalUsage** -- cumulative API token usage

### submitMessage() Entry Point

`submitMessage()` is an `AsyncGenerator<SDKMessage>`. Each call represents one user turn. The method:

1. **Resolves the system prompt** via `fetchSystemPromptParts()` -- gathers the default prompt, user context (CLAUDE.md etc.), and system context (git status etc.)
2. **Processes user input** via `processUserInput()` -- handles slash commands, builds the user message(s), determines whether the model needs to be queried
3. **Wraps canUseTool** to track permission denials for SDK reporting
4. **Persists the user message to transcript** before entering the query loop (so `--resume` works even if the process is killed mid-response)
5. **Iterates query()** -- the inner agentic loop -- mapping each yielded message to SDK types
6. **Records transcript and usage** after each yielded message
7. **Yields the final result** with cost, usage, stop reason, and permission denials

> **Key Insight:** The transcript is written *before* the API call begins. This is a deliberate design choice -- if the process is killed between sending the user message and receiving a response, `--resume` can still pick up the conversation. The cost is ~4ms of disk I/O on the critical path (skipped in `--bare` mode).

### Memory Mechanics Injection

When an SDK caller provides a custom system prompt AND has set `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, QueryEngine injects the memory-mechanics prompt. This tells the model how to use Write/Edit tools to manage MEMORY.md files:

```typescript
const memoryMechanicsPrompt =
  customPrompt !== undefined && hasAutoMemPathOverride()
    ? await loadMemoryPrompt()
    : null

const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

## The Core Agentic Loop

From `src/query.ts`, the `queryLoop()` function is a `while(true)` generator. Each iteration represents one round-trip to the model. The loop carries mutable state in a `State` object:

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined  // Why the previous iteration continued
}
```

Each continue site writes a new `State` object rather than mutating individual fields. The `transition` field records *why* the loop continued (next turn, recovery, escalation), enabling tests to assert which recovery path fired.

### Complete Loop Diagram

```
                        ┌──────────────────────────────────┐
                        │         while (true)              │
                        └──────────────┬───────────────────┘
                                       │
                    ┌──────────────────────────────────────┐
                    │  STAGE 1: Pre-Processing Pipeline     │
                    │                                       │
                    │  applyToolResultBudget()               │
                    │         │                              │
                    │         ▼                              │
                    │  snipCompactIfNeeded()                 │
                    │         │                              │
                    │         ▼                              │
                    │  microcompact()                        │
                    │         │                              │
                    │         ▼                              │
                    │  applyCollapsesIfNeeded()              │
                    │         │                              │
                    │         ▼                              │
                    │  autocompact()                         │
                    └──────────────────┬───────────────────┘
                                       │
                    ┌──────────────────────────────────────┐
                    │  STAGE 2: Context Assembly             │
                    │                                       │
                    │  appendSystemContext(systemPrompt,     │
                    │    systemContext)     ← git status     │
                    │  prependUserContext(messages,          │
                    │    userContext)       ← CLAUDE.md      │
                    │  toolUseContext.messages = current     │
                    └──────────────────┬───────────────────┘
                                       │
                    ┌──────────────────────────────────────┐
                    │  STAGE 3: Blocking Limit Check         │
                    │                                       │
                    │  if (tokenCount > blockingLimit        │
                    │      && !reactiveCompact               │
                    │      && !contextCollapse) {            │
                    │    yield PROMPT_TOO_LONG_ERROR         │
                    │    return                              │
                    │  }                                     │
                    └──────────────────┬───────────────────┘
                                       │
                    ┌──────────────────────────────────────┐
                    │  STAGE 4: Model Streaming              │
                    │                                       │
                    │  callModel() with full params          │
                    │         │                              │
                    │    for await (message of stream) {     │
                    │      ├─ assistant msg → push + yield   │
                    │      ├─ tool_use block → start tool    │
                    │      │   via StreamingToolExecutor     │
                    │      ├─ withheld errors → buffer       │
                    │      │   (413, max_output, media)      │
                    │      └─ completed results → yield      │
                    │    }                                   │
                    │                                       │
                    │  on FallbackTriggeredError:            │
                    │    tombstone orphaned msgs             │
                    │    switch model, retry                 │
                    └──────────────────┬───────────────────┘
                                       │
                              needsFollowUp?
                             /              \
                           no                yes
                           │                  │
          ┌────────────────▼──────┐   ┌──────▼──────────────────┐
          │  STAGE 5: Recovery     │   │  STAGE 6: Tool Execution│
          │                        │   │                         │
          │  Context collapse      │   │  getRemainingResults()  │
          │    drain               │   │    or runTools()        │
          │  Reactive compact      │   │  yield tool results     │
          │  Max output escalation │   │  generate tool use      │
          │    (8K → 64K)          │   │    summaries (Haiku)    │
          │  Max output recovery   │   │                         │
          │    (up to 3 retries)   │   └──────┬──────────────────┘
          │  Stop hooks            │          │
          │  Token budget check    │   ┌──────▼──────────────────┐
          │                        │   │  STAGE 7: Attachments    │
          │  → return or continue  │   │                         │
          └────────────────────────┘   │  getAttachmentMessages() │
                                       │    ← file changes        │
                                       │    ← queued commands     │
                                       │  Memory prefetch consume │
                                       │  Skill discovery consume │
                                       └──────┬──────────────────┘
                                               │
                                       ┌───────▼─────────────────┐
                                       │  STAGE 8: Next Iteration │
                                       │                          │
                                       │  messages = [            │
                                       │    ...messagesForQuery,  │
                                       │    ...assistantMessages, │
                                       │    ...toolResults        │
                                       │  ]                       │
                                       │  turnCount++             │
                                       │  continue                │
                                       └──────────────────────────┘
```

### Stage 1: Pre-Processing Pipeline

Each iteration begins by reducing the message array. Five transformations run in sequence, each potentially shrinking context:

1. **applyToolResultBudget()** -- Enforces per-message size limits on tool result content. Large tool outputs are replaced with hash references stored on disk. Runs before microcompact because microcompact operates by tool_use_id and is unaffected by content replacement.

2. **snipCompactIfNeeded()** -- (feature-gated: `HISTORY_SNIP`) Removes old message groups that exceed a snip threshold. Returns a `tokensFreed` count plumbed to autocompact so its threshold check accounts for what snip already removed.

3. **microcompact()** -- Compresses individual tool results within messages (e.g., truncating large bash output). For cached microcompact, the boundary message is deferred until after the API response so it can use actual `cache_deleted_input_tokens` from the API.

4. **applyCollapsesIfNeeded()** -- (feature-gated: `CONTEXT_COLLAPSE`) Projects the collapsed context view and commits pending collapses. Runs before autocompact so that if collapse brings context under the autocompact threshold, we keep granular context rather than a single summary.

5. **autocompact()** -- If total token count still exceeds the threshold, runs a full compaction (summarizes old messages using a forked model call). Yields compact boundary messages and replaces `messagesForQuery` with the post-compact summary.

> **Key Insight:** The ordering matters. Collapse runs before autocompact so it gets "first dibs" -- if collapsing individual tool groups is sufficient, the more aggressive full autocompact is skipped. This preserves more granular context for the model.

### Stage 2: Context Assembly

After message reduction, context is assembled for the API call:

```typescript
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)

// Inside callModel:
messages: prependUserContext(messagesForQuery, userContext)
```

- `appendSystemContext()` adds dynamic system-level context (git status) to the system prompt
- `prependUserContext()` injects CLAUDE.md and other user context as `<system-reminder>` tags inside the first user message

The split ensures the system prompt stays as stable as possible for prompt caching, while dynamic context rides in the messages array.

### Stage 3: Blocking Limit Check

Before calling the model, the loop checks if context exceeds a hard blocking limit. This check is skipped when:

- Compaction just happened (stale token counts would false-positive)
- The query source is `compact` or `session_memory` (would deadlock -- the compact agent needs to run to reduce tokens)
- Reactive compact or context collapse is enabled (they handle 413s after the API call)

If the check fires and no recovery system is available, the loop yields `PROMPT_TOO_LONG_ERROR_MESSAGE` and returns immediately.

### Stage 4: Model Streaming

The model call uses streaming SSE. The inner loop processes each streamed event:

```typescript
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: { model: currentModel, fallbackModel, ... },
})) {
  // Process assistant messages, tool_use blocks, etc.
}
```

During streaming, three things happen in parallel:

1. **Assistant messages are yielded** to callers as they arrive
2. **Tool use blocks trigger StreamingToolExecutor** -- concurrent-safe tools start executing *while the model is still streaming*
3. **Recoverable errors are withheld** -- prompt-too-long (413), max output tokens, and media size errors are buffered rather than yielded. They are only surfaced if recovery fails.

**Fallback model switching** catches `FallbackTriggeredError`. On trigger:
- Orphaned assistant messages get tombstoned (removes them from UI and transcript)
- The StreamingToolExecutor is discarded and recreated
- Thinking signature blocks are stripped (they are model-bound)
- The model is switched and the attempt retries

### Stage 5: Post-Streaming Recovery

When the model finishes without tool calls (`needsFollowUp === false`), the loop checks a cascade of recovery paths before returning:

**Context Collapse Drain** (for withheld 413 errors):
```
if (isWithheld413 && transition !== 'collapse_drain_retry') {
  drained = contextCollapse.recoverFromOverflow(messagesForQuery)
  if (drained.committed > 0) → continue with collapse_drain_retry
}
```

**Reactive Compact** (for withheld 413 or media errors):
```
if ((isWithheld413 || isWithheldMedia) && !hasAttemptedReactiveCompact) {
  compacted = tryReactiveCompact(...)
  if (compacted) → continue with reactive_compact_retry
}
```

**Max Output Tokens Escalation** (8K cap to 64K):
```
if (isWithheldMaxOutput && maxOutputTokensOverride === undefined) {
  → continue with maxOutputTokensOverride = ESCALATED_MAX_TOKENS
}
```

**Max Output Tokens Recovery** (up to 3 retries):
```
if (isWithheldMaxOutput && recoveryCount < 3) {
  inject "Output token limit hit. Resume directly..." message
  → continue with maxOutputTokensRecoveryCount++
}
```

**Stop Hooks Evaluation**:
```
stopHookResult = handleStopHooks(...)
if (stopHookResult.blockingErrors.length > 0)
  → continue with stopHookActive = true
```

**Token Budget Continuation**:
```
if (checkTokenBudget().action === 'continue')
  inject nudge message, → continue
```

If none of these fire, the loop returns `{ reason: 'completed' }`.

### Stage 6: Tool Execution

When the model produces tool_use blocks (`needsFollowUp === true`):

```typescript
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

for await (const update of toolUpdates) {
  if (update.message) {
    yield update.message
    toolResults.push(...normalizeMessagesForAPI([update.message]))
  }
}
```

With StreamingToolExecutor, most tools have already completed by the time streaming ends. `getRemainingResults()` drains any still in progress. Without the streaming executor, `runTools()` executes them sequentially.

**Tool use summaries** are generated asynchronously via Haiku after the batch completes. The promise is stored in `nextPendingToolUseSummary` and awaited at the top of the *next* iteration -- by which time the 1-second Haiku call has typically resolved:

```typescript
if (pendingToolUseSummary) {
  const summary = await pendingToolUseSummary
  if (summary) yield summary
}
```

### Stage 7: Attachment Collection

After tool execution, the loop collects additional context to inject before the next model call:

1. **getAttachmentMessages()** -- File change diffs, queued user commands, task notifications
2. **Memory prefetch consume** -- If the memory prefetch (started at loop entry) has settled, its results are filtered against `readFileState` and injected
3. **Skill discovery prefetch** -- Prefetched skill search results are consumed

Queued commands are scoped by agent ID -- the main thread only drains commands addressed to it, and subagents only drain their own task notifications.

### Stage 8: Next Iteration Assembly

The final step assembles the message array for the next iteration and continues the loop:

```typescript
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  maxOutputTokensOverride: undefined,
  stopHookActive,
  transition: { reason: 'next_turn' },
}
state = next
```

Note that `maxOutputTokensRecoveryCount` and `hasAttemptedReactiveCompact` reset on normal turns -- they are per-turn guards that prevent infinite recovery loops.

## StreamingToolExecutor

From `src/services/tools/StreamingToolExecutor.ts`:

The StreamingToolExecutor processes tool_use blocks as they arrive from the streaming API, executing tools in parallel with the model's response when safe to do so.

### Concurrency Model

Each tool is classified as concurrent-safe or not:

```typescript
const isConcurrencySafe = parsedInput?.success
  ? Boolean(toolDefinition.isConcurrencySafe(parsedInput.data))
  : false
```

The execution rules:

- **Concurrent-safe tools** (e.g., Read, Grep) can execute in parallel with other concurrent-safe tools
- **Non-concurrent tools** (e.g., Bash, Write) require exclusive access -- they must wait until all executing tools finish
- **Ordering is preserved** for non-concurrent tools -- the queue stops at the first non-concurrent tool that cannot yet execute

```typescript
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
  )
}
```

### Tool Lifecycle

Each tool moves through states: `queued` -> `executing` -> `completed` -> `yielded`.

```
  addTool(block)
       │
       ▼
   ┌────────┐    canExecuteTool()?    ┌───────────┐
   │ queued  │ ──────── yes ────────> │ executing  │
   │        │ <─── no (wait) ─────── │           │
   └────────┘                         └─────┬─────┘
                                            │
                                      tool finishes
                                            │
                                      ┌─────▼─────┐
                                      │ completed  │
                                      └─────┬─────┘
                                            │
                                   getCompletedResults()
                                            │
                                      ┌─────▼─────┐
                                      │  yielded   │
                                      └───────────┘
```

### Sibling Abort Controller

The executor creates a child abort controller (`siblingAbortController`) from the main `toolUseContext.abortController`. When a Bash tool errors, it aborts the sibling controller -- killing sibling subprocesses immediately -- without aborting the parent controller (so the query loop itself continues):

```typescript
if (tool.block.name === BASH_TOOL_NAME) {
  this.hasErrored = true
  this.erroredToolDescription = this.getToolDescription(tool)
  this.siblingAbortController.abort('sibling_error')
}
```

Only Bash errors trigger sibling cancellation. The rationale: Bash commands often have implicit dependency chains (mkdir fails -> subsequent commands are pointless), while Read/Grep/WebFetch are independent.

### Synthetic Error Messages

When a tool is cancelled (by sibling error, user interrupt, or streaming fallback), the executor generates a synthetic `tool_result` with `is_error: true`:

- **sibling_error**: `"Cancelled: parallel tool call Bash(mkdir -p src/...) errored"`
- **user_interrupted**: Uses the standard `REJECT_MESSAGE`
- **streaming_fallback**: `"Streaming fallback - tool execution discarded"`

These ensure every `tool_use` block has a matching `tool_result` -- the API requires this pairing.

## Recovery Paths

### Prompt Too Long (413)

Two-tier recovery:

1. **Context collapse drain** -- Commits all staged collapses. Cheap, preserves granular context. Single-shot: if the retry still 413s, falls through to tier 2.
2. **Reactive compact** -- Runs a full compaction (forked model call to summarize). Guarded by `hasAttemptedReactiveCompact` to prevent spirals.

If both fail, the withheld error is surfaced and the loop returns.

### Max Output Tokens

Two-tier recovery:

1. **Escalation** -- If the default 8K cap was active and no explicit override was set, retry with `ESCALATED_MAX_TOKENS` (64K). Fires once per turn.
2. **Resume recovery** -- Inject a meta message: "Output token limit hit. Resume directly -- no apology, no recap..." and retry. Up to 3 attempts (`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`).

If all retries exhaust, the withheld error is surfaced.

### Fallback Model

On `FallbackTriggeredError`:

1. Tombstone all orphaned assistant messages (partial thinking blocks have invalid signatures that would cause API errors on replay)
2. Discard and recreate the StreamingToolExecutor
3. Strip signature blocks from message history
4. Switch to the fallback model
5. Yield a system warning: "Switched to {fallback} due to high demand for {original}"
6. Retry the streaming loop

### Error Withholding Pattern

Recoverable errors are *withheld* during streaming rather than yielded immediately. They are pushed to `assistantMessages` so the recovery checks find them, but not yielded to callers. This prevents SDK consumers (Desktop, mobile) from seeing transient errors and terminating the session while recovery is still possible.

```typescript
let withheld = false
if (reactiveCompact?.isWithheldPromptTooLong(message)) withheld = true
if (mediaRecoveryEnabled && reactiveCompact?.isWithheldMediaSizeError(message)) withheld = true
if (isWithheldMaxOutputTokens(message)) withheld = true
if (!withheld) yield yieldMessage
```

> **Key Insight:** The withholding and recovery checks must agree on which errors they handle. If a message is withheld but recovery is not enabled for that error type, the message is silently swallowed. The code guards against this by hoisting the `mediaRecoveryEnabled` flag once per turn and using it in both locations.

## History Persistence

From `src/history.ts`:

### Storage Format

Command history is stored in `~/.claude/history.jsonl` -- a single JSONL file shared across all projects. Each line is a JSON object:

```typescript
type LogEntry = {
  display: string                              // The user's input text
  pastedContents: Record<number, StoredPastedContent>
  timestamp: number
  project: string                              // getProjectRoot() at write time
  sessionId?: string
}
```

### Pasted Content Handling

Pasted content uses a two-tier storage strategy:

- **Small pastes** (<=1024 chars): stored inline in the JSONL entry
- **Large pastes**: content is hashed and stored in a separate paste store. The JSONL entry contains only the `contentHash` reference.

```typescript
if (content.content.length <= MAX_PASTED_CONTENT_LENGTH) {
  storedPastedContents[id] = { id, type, content: content.content }
} else {
  const hash = hashPastedText(content.content)
  storedPastedContents[id] = { id, type, contentHash: hash }
  void storePastedText(hash, content.content)  // fire-and-forget
}
```

Images are excluded from history entirely -- they are stored separately in the image cache.

### Read Order and Session Priority

The file is read in reverse (newest first) via `readLinesReverse()`. The `getHistory()` generator prioritizes current-session entries:

1. Scan entries newest-first
2. Current session entries are yielded immediately
3. Other session entries are buffered
4. After the scan window (MAX_HISTORY_ITEMS = 100), yield buffered entries

This ensures Up-arrow history shows the current session's commands first, without interleaving from concurrent sessions.

### Write Buffering

Writes are buffered in memory (`pendingEntries`) and flushed asynchronously with file locking:

```typescript
pendingEntries.push(logEntry)
currentFlushPromise = flushPromptHistory(0)
```

The flush acquires an advisory lock (`lock(historyPath, { stale: 10000 })`), serializes pending entries to JSONL, and appends to the file. Retries up to 5 times with 500ms backoff. A cleanup handler registered via `registerCleanup()` ensures pending entries are flushed on process exit.

### Undo Support

`removeLastFromHistory()` supports the auto-restore-on-interrupt feature. When ESC rewinds a conversation before any response arrives, the history entry should be removed too:

- **Fast path**: entry still in `pendingEntries` -- splice it out
- **Slow path**: entry already flushed to disk -- add its timestamp to `skippedTimestamps`, consulted by the read path

## Key Takeaways

1. **QueryEngine and query() have a clean separation of concerns.** QueryEngine owns session state (messages, usage, permissions, transcript persistence) while query() owns the agentic loop (model calls, tool execution, recovery). The query() generator knows nothing about SDK types or disk I/O.

2. **The pre-processing pipeline runs five stages in a fixed order.** Tool result budgeting, snip compaction, microcompact, context collapse, and autocompact each get a chance to reduce context before the model call. The ordering is deliberate -- collapse runs before autocompact to preserve granular context when possible.

3. **Recoverable errors are withheld, not surfaced.** Prompt-too-long, max output tokens, and media size errors are buffered during streaming and only revealed to callers if all recovery attempts fail. This prevents SDK consumers from seeing transient errors.

4. **StreamingToolExecutor overlaps tool execution with model streaming.** Concurrent-safe tools (Read, Grep) start as soon as their tool_use block arrives, potentially completing before the model finishes streaming. Non-concurrent tools (Bash, Write) wait for exclusive access.

5. **The loop state is immutable between continue sites.** Each recovery path writes a complete new `State` object with a `transition` field explaining why it continued. This makes the eight distinct continue sites (next turn, collapse drain, reactive compact, max output escalation, max output recovery, stop hook blocking, token budget continuation, and fallback retry) auditable and testable.

6. **History is a global JSONL file with session-aware ordering.** Current-session entries surface first in Up-arrow history. Large pasted content is hash-referenced to keep the JSONL file small. Writes are buffered and flushed asynchronously with locking to handle concurrent sessions.
