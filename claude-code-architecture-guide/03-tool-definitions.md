# Chapter 3: Tool Definitions

## Overview

Tools are the primary way Claude Code interacts with the local environment. They're defined in the `tools` array of the API request as JSON Schema objects. The model receives these as part of every API call and can request any tool via `tool_use` blocks.

## Tool Categories

From our captured session (57 tools total):

### Built-in Tools (16)

These are core Claude Code tools, always available:

| # | Tool | Purpose |
|---|------|---------|
| 1 | **Task** | Launch sub-agents for complex multi-step tasks |
| 2 | **Bash** | Execute shell commands |
| 3 | **Glob** | Fast file pattern matching |
| 4 | **Grep** | Content search with ripgrep |
| 5 | **ExitPlanMode** | Transition from planning to implementation |
| 6 | **Read** | Read files from filesystem |
| 7 | **Edit** | Edit existing files (sends diff) |
| 8 | **MultiEdit** | Edit multiple locations in a file |
| 9 | **Write** | Create/overwrite files |
| 10 | **NotebookEdit** | Edit Jupyter notebook cells |
| 11 | **WebFetch** | Fetch web content |
| 12 | **TodoWrite** | Task management (create, update, complete) |
| 13 | **WebSearch** | Web search |
| 14 | **BashOutput** | Read output from background bash commands |
| 15 | **KillShell** | Kill background shell processes |
| 16 | **SlashCommand** | Execute slash commands |

### Plugin-Added Tools (only with plugins enabled)

When the Superpowers plugin is active, additional tools appear:

| Tool | Purpose |
|------|---------|
| **Skill** | Load and invoke skill content |
| **Agent** | Enhanced agent dispatch (replaces/extends Task) |
| **AskUserQuestion** | Explicitly ask the user a question |
| **CronCreate** | Create recurring tasks |
| **CronDelete** | Delete recurring tasks |
| **CronList** | List recurring tasks |
| **TaskCreate** | Create structured tasks |
| **TaskGet** | Get task details |
| **TaskList** | List all tasks |
| **TaskOutput** | Read task output |
| **TaskStop** | Stop a running task |
| **TaskUpdate** | Update task status |
| **EnterPlanMode** | Enter planning mode |
| **EnterWorktree** | Enter a git worktree |
| **ExitWorktree** | Exit a git worktree |

### MCP Server Tools (40+)

These come from configured MCP servers. Each MCP tool is prefixed with `mcp__<server-name>__`:

**Playwright (23 tools)**
```
mcp__playwright__browser_close
mcp__playwright__browser_resize
mcp__playwright__browser_console_messages
mcp__playwright__browser_handle_dialog
mcp__playwright__browser_evaluate
mcp__playwright__browser_file_upload
mcp__playwright__browser_fill_form
mcp__playwright__browser_install
mcp__playwright__browser_press_key
mcp__playwright__browser_type
mcp__playwright__browser_navigate
mcp__playwright__browser_navigate_back
mcp__playwright__browser_network_requests
mcp__playwright__browser_run_code
mcp__playwright__browser_take_screenshot
mcp__playwright__browser_snapshot
mcp__playwright__browser_click
mcp__playwright__browser_drag
mcp__playwright__browser_hover
mcp__playwright__browser_select_option
mcp__playwright__browser_tabs
mcp__playwright__browser_wait_for
```

**CircleCI (15 tools)**
```
mcp__circleci-mcp-server__get_build_failure_logs
mcp__circleci-mcp-server__find_flaky_tests
mcp__circleci-mcp-server__get_latest_pipeline_status
mcp__circleci-mcp-server__get_job_test_results
mcp__circleci-mcp-server__config_helper
mcp__circleci-mcp-server__create_prompt_template
mcp__circleci-mcp-server__recommend_prompt_template_tests
mcp__circleci-mcp-server__run_pipeline
mcp__circleci-mcp-server__list_followed_projects
mcp__circleci-mcp-server__run_evaluation_tests
mcp__circleci-mcp-server__rerun_workflow
mcp__circleci-mcp-server__download_usage_api_data
mcp__circleci-mcp-server__find_underused_resource_classes
mcp__circleci-mcp-server__analyze_diff
mcp__circleci-mcp-server__run_rollback_pipeline
mcp__circleci-mcp-server__list_component_versions
```

**MCP Resource Access (2 tools)**
```
ListMcpResourcesTool
ReadMcpResourceTool
```

## Tool Schema Format

Each tool follows this JSON structure:

```json
{
  "name": "Bash",
  "description": "Executes a given bash command and returns its output...",
  "input_schema": {
    "type": "object",
    "properties": {
      "command": {
        "description": "The command to execute",
        "type": "string"
      },
      "timeout": {
        "description": "Optional timeout in milliseconds",
        "type": "number"
      },
      "run_in_background": {
        "description": "Run command in background",
        "type": "boolean"
      },
      "description": {
        "description": "Description of what the command does",
        "type": "string"
      }
    },
    "required": ["command"]
  }
}
```

## The Task/Agent Tool — The Most Complex Tool

The `Task` tool (or `Agent` when plugins add it) is the most complex tool definition at ~4,400 characters of description. It:

1. Lists all available agent types with their descriptions
2. Specifies which tools each agent type has access to
3. Provides usage guidelines (when to use, when not to use)
4. Supports isolation modes (worktrees)
5. Supports background execution
6. Supports model override per agent

Agent types are dynamically registered. The base set includes:
- `general-purpose` — Default, has all tools
- `statusline-setup` — Configure status line (Read, Edit only)
- `Explore` — Fast codebase exploration (read-only tools)
- `Plan` — Software architecture (read-only tools)
- `claude-code-guide` — Answer questions about Claude Code

Plugins can register additional agent types. The Superpowers plugin adds:
- `superpowers:code-reviewer` — Code review against plans

## Deferred Tool Loading

For sessions with many MCP tools, Claude Code uses **deferred tool loading**. Instead of sending full tool schemas for all MCP tools, it sends a list of tool names in a `<available-deferred-tools>` system-reminder. The model sees the names and can use a special `ToolSearch` tool to fetch the full schema on demand.

This is a token optimization — sending 40+ full MCP tool schemas on every turn would consume significant context.

```xml
<available-deferred-tools>
mcp__claude_ai_Amplitude__create_cohort
mcp__claude_ai_Amplitude__create_dashboard
mcp__claude_ai_Slack__slack_send_message
...
</available-deferred-tools>
```

The `ToolSearch` tool accepts a query and returns matching tool schemas:
```json
{
  "name": "ToolSearch",
  "parameters": {
    "query": "select:Read,Edit,Grep",
    "max_results": 5
  }
}
```

## Tool Discovery: MCP Schema Validation

During session initialization, Claude Code validates each MCP tool's JSON schema by making individual API calls:

1. Model: `opus` (for validation)
2. Each call sends one tool with a dummy message `"foo"`
3. If the schema is invalid, the tool is excluded
4. Then `claude-3-5-haiku` is used to generate human-readable descriptions for each valid MCP tool

This explains the ~80 API calls we captured before the main conversation call.

## Token Impact

Tool definitions are the **single largest component** of every API request. With 57 tools, each having a description and JSON schema, the tools array can easily consume 15,000-20,000 tokens per turn. This is why deferred loading exists for large MCP server configurations.

---

## Tool Orchestration Engine (Source Code Revealed)

The preceding sections documented what we observe from captured API traffic. This section goes deeper, documenting the internal machinery that governs how tools are selected, validated, permission-checked, batched, executed, and hooked. All findings come from the Claude Code source tree.

### 1. The Tool Interface (`src/Tool.ts`)

Every tool implements a `Tool<Input, Output, P>` type. The interface is large (roughly 50 methods/properties), but the execution-critical ones are:

**Core lifecycle methods:**

| Method | Purpose |
|--------|---------|
| `call(args, context, canUseTool, parentMessage, onProgress?)` | Execute the tool. Returns `ToolResult<Output>` containing data, optional new messages, and an optional `contextModifier`. |
| `validateInput?(input, context)` | Tool-specific validation beyond schema parsing. Returns `{result: true}` or `{result: false, message, errorCode}`. |
| `checkPermissions(input, context)` | Tool-specific permission logic. Runs after `validateInput` passes. Returns a `PermissionResult`. |

**Concurrency and safety classification:**

| Method | Purpose |
|--------|---------|
| `isConcurrencySafe(input)` | Whether this tool call can run in parallel with others. Default: `false` (conservative). |
| `isReadOnly(input)` | Whether the tool only reads (no side effects). Default: `false`. |
| `isDestructive?(input)` | Whether the tool performs irreversible operations (delete, overwrite, send). Default: `false`. |

**Interrupt behavior:**

| Method | Purpose |
|--------|---------|
| `interruptBehavior?()` | Returns `'cancel'` (abort and discard) or `'block'` (keep running, queue new message). Default: `'block'`. |
| `requiresUserInteraction?()` | Whether the tool needs interactive user input to proceed. |

**Observation and classification:**

| Method | Purpose |
|--------|---------|
| `isSearchOrReadCommand?(input)` | Returns `{isSearch, isRead, isList?}` for UI collapse grouping. |
| `backfillObservableInput?(input)` | Mutates a clone of the input to add legacy/derived fields for hooks, SDK stream, and transcript observers. The original API-bound input is never mutated (preserves prompt cache). |
| `toAutoClassifierInput(input)` | Compact representation for the auto-mode security classifier. Returns `''` to skip. |
| `preparePermissionMatcher?(input)` | Builds a closure for matching hook `if` condition patterns (e.g., `"Bash(git *)"` rules). |

**Result size control:**

```typescript
maxResultSizeChars: number
```

When a tool result exceeds this threshold, it is persisted to disk and the model receives a truncated preview with a file path instead. Set to `Infinity` for tools like `Read` whose output must never be persisted (to avoid circular Read -> file -> Read loops).

**The `buildTool()` factory:**

All tool definitions go through `buildTool(def)`, which fills in safe defaults (fail-closed where it matters):

- `isEnabled` -> `true`
- `isConcurrencySafe` -> `false` (assume not safe)
- `isReadOnly` -> `false` (assume writes)
- `isDestructive` -> `false`
- `checkPermissions` -> `{behavior: 'allow', updatedInput}` (defer to general permission system)
- `toAutoClassifierInput` -> `''` (skip classifier; security-relevant tools must override)
- `userFacingName` -> `name`

**The `ToolResult` type:**

```typescript
type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext  // only honored for non-concurrent tools
  mcpMeta?: { _meta?: Record<string, unknown>; structuredContent?: Record<string, unknown> }
}
```

The `contextModifier` is a key mechanism: it lets a tool mutate the `ToolUseContext` for subsequent tools in the same turn. This is only honored for serial (non-concurrency-safe) tools -- concurrent tools queue their modifiers and apply them after the batch completes.

---

### 2. Tool Registry (`src/tools.ts`)

The tool registry assembles the complete pool of available tools through a layered process.

**`getAllBaseTools()` -- the exhaustive inventory:**

Returns every tool that *could* be available in the current environment. This is the single source of truth. Tools are conditionally included based on feature flags and environment:

| Condition | Tools |
|-----------|-------|
| Always | AgentTool, BashTool, FileReadTool, FileEditTool, FileWriteTool, NotebookEditTool, WebFetchTool, TodoWriteTool, WebSearchTool, TaskStopTool, AskUserQuestionTool, SkillTool, EnterPlanModeTool, ExitPlanModeV2Tool, TaskOutputTool, BriefTool, SendMessageTool, ListMcpResourcesTool, ReadMcpResourceTool |
| `!hasEmbeddedSearchTools()` | GlobTool, GrepTool (omitted in ant-native builds where bfs/ugrep are embedded in the binary) |
| `feature('PROACTIVE') \|\| feature('KAIROS')` | SleepTool |
| `feature('AGENT_TRIGGERS')` | CronCreateTool, CronDeleteTool, CronListTool |
| `feature('AGENT_TRIGGERS_REMOTE')` | RemoteTriggerTool |
| `feature('MONITOR_TOOL')` | MonitorTool |
| `feature('KAIROS')` | SendUserFileTool |
| `feature('KAIROS') \|\| feature('KAIROS_PUSH_NOTIFICATION')` | PushNotificationTool |
| `feature('KAIROS_GITHUB_WEBHOOKS')` | SubscribePRTool |
| `feature('COORDINATOR_MODE')` | (enables coordinator-specific behavior) |
| `feature('WEB_BROWSER_TOOL')` | WebBrowserTool |
| `feature('TERMINAL_PANEL')` | TerminalCaptureTool |
| `feature('CONTEXT_COLLAPSE')` | CtxInspectTool |
| `feature('HISTORY_SNIP')` | SnipTool |
| `feature('UDS_INBOX')` | ListPeersTool |
| `feature('WORKFLOW_SCRIPTS')` | WorkflowTool |
| `USER_TYPE === 'ant'` | REPLTool, ConfigTool, TungstenTool, SuggestBackgroundPRTool |
| `isTodoV2Enabled()` | TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool |
| `isWorktreeModeEnabled()` | EnterWorktreeTool, ExitWorktreeTool |
| `isAgentSwarmsEnabled()` | TeamCreateTool, TeamDeleteTool |
| `isToolSearchEnabledOptimistic()` | ToolSearchTool |
| `ENABLE_LSP_TOOL` | LSPTool |
| `isPowerShellToolEnabled()` | PowerShellTool |
| `CLAUDE_CODE_VERIFY_PLAN` | VerifyPlanExecutionTool |
| `NODE_ENV === 'test'` | TestingPermissionTool |

**`getTools(permissionContext)` -- filtering for the session:**

1. In `CLAUDE_CODE_SIMPLE` mode, returns only `[BashTool, FileReadTool, FileEditTool]` (plus coordinator tools if coordinator mode is active).
2. Filters out special tools (ListMcpResourcesTool, ReadMcpResourceTool, SyntheticOutputTool).
3. Applies `filterToolsByDenyRules()` to remove any tools blanket-denied by the permission context. Uses the same matcher as runtime permission checks, so `mcp__server` deny rules strip all tools from that server before the model ever sees them.
4. In REPL mode, hides primitive tools (Bash, Read, Edit, etc.) from direct model use since they are accessible inside the REPL VM context.
5. Filters by `isEnabled()`.

**`assembleToolPool(permissionContext, mcpTools)` -- the final merge:**

The single source of truth for combining built-in and MCP tools:

1. Gets built-in tools via `getTools()`
2. Filters MCP tools by deny rules
3. Sorts each partition alphabetically *separately* (built-ins as a contiguous prefix, MCP tools after) for prompt-cache stability -- a flat sort would interleave MCP tools into built-ins and invalidate downstream cache keys
4. Deduplicates by name via `uniqBy` (built-in tools take precedence)

---

### 3. Tool Batching and Orchestration (`src/services/tools/toolOrchestration.ts`)

When the model returns multiple `tool_use` blocks in a single response, the orchestration engine determines which can run concurrently and which must run serially.

**`partitionToolCalls()` -- grouping into batches:**

The algorithm walks the tool_use blocks in order and groups them:

```
For each tool_use block:
  1. Look up the tool and parse its input with safeParse
  2. Call isConcurrencySafe(parsedInput) -- if parse fails or throws, treat as NOT safe
  3. If safe AND the previous batch is also safe: append to that batch
  4. Otherwise: start a new batch
```

This produces an array of `Batch` objects, each tagged with `isConcurrencySafe: boolean`. The key insight: **consecutive concurrency-safe tools are merged into a single batch, but a non-safe tool always forces a new solo batch and breaks the chain.**

Example partitioning for `[Grep, Glob, Edit, Read, Read]`:

```
Batch 1: {concurrent: true,  blocks: [Grep, Glob]}   -- both read-only
Batch 2: {concurrent: false, blocks: [Edit]}          -- writes a file
Batch 3: {concurrent: true,  blocks: [Read, Read]}    -- both read-only
```

**`runTools()` -- the main loop:**

Iterates through batches in order. Each batch dispatches to one of two strategies:

**Concurrent batches** (`runToolsConcurrently`):
- Uses a `all()` utility (from `src/utils/generators.ts`) that runs async generators concurrently with a configurable max concurrency
- Max concurrency: `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` environment variable, default **10**
- Context modifiers are queued (not applied immediately) to avoid race conditions
- After the entire batch completes, queued modifiers are applied in tool-order

**Serial batches** (`runToolsSerially`):
- Runs one tool at a time
- Context modifiers are applied immediately after each tool completes
- Each tool sees the updated context from the previous tool

**In-progress tracking:**

Both paths call `setInProgressToolUseIDs` to add/remove tool IDs from an in-progress set. This powers the UI's concurrent progress display (multiple spinners, etc.).

---

### 4. The Full Tool Execution Pipeline (`src/services/tools/toolExecution.ts`)

Every tool call flows through this pipeline. The entry point is `runToolUse()`, and the main logic lives in `checkPermissionsAndCallTool()`.

**Step 0: Tool Lookup (`runToolUse`)**

```
1. Find tool by name in the current tool pool
2. If not found, check getAllBaseTools() for a legacy ALIAS match
   (e.g., old transcripts calling "KillShell" which is now aliased to "TaskStop")
3. If still not found: return <tool_use_error>No such tool available</tool_use_error>
4. If abortController.signal.aborted: return cancellation message
5. Delegate to streamedCheckPermissionsAndCallTool()
```

**Step 1: Stream Bridge (`streamedCheckPermissionsAndCallTool`)**

Creates a `Stream<MessageUpdateLazy>` and runs `checkPermissionsAndCallTool` inside it. Progress events from the `onProgress` callback are enqueued as `ProgressMessage` objects. This bridges the callback-based progress API into the async-iterable message stream.

**Step 2: The Main Pipeline (`checkPermissionsAndCallTool`)**

This is the core, running nine phases:

**Phase 1 -- Zod Schema Validation:**
```typescript
const parsedInput = tool.inputSchema.safeParse(input)
```
If parsing fails, a `formatZodValidationError` message is returned. For deferred tools (those requiring ToolSearch), a special `buildSchemaNotSentHint` check detects when the model called a tool without first loading its schema, and appends guidance: "Load the tool first: call ToolSearch with query `select:<tool_name>`, then retry."

**Phase 2 -- Custom Validation:**
```typescript
const isValidCall = await tool.validateInput?.(parsedInput.data, toolUseContext)
```
Each tool can implement tool-specific validation beyond what Zod checks. Failure returns a `<tool_use_error>` message.

**Phase 3 -- Speculative Classifier (Bash only):**
For Bash tool calls, `startSpeculativeClassifierCheck()` fires the auto-mode security classifier in parallel with subsequent phases. This is a performance optimization -- the classifier result is consumed later in the permission check. The UI indicator (`setClassifierChecking`) is NOT set here to avoid flashing "classifier running" for commands that auto-allow via prefix rules.

**Phase 4 -- Input Sanitization:**
Defense-in-depth strip of `_simulatedSedEdit` from model-provided Bash input. This field is internal-only, injected by the permission system (`SedEditPermissionRequest`) after user approval. If the model supplies it, the schema's `strictObject` should already reject it, but this is a safeguard.

Additionally, `backfillObservableInput` runs on a shallow clone of the input so hooks and observers see derived/legacy fields without mutating the original (preserving prompt cache).

**Phase 5 -- Pre-Tool Hooks:**
```typescript
for await (const result of runPreToolUseHooks(...)) { ... }
```
Pre-tool hooks can:
- **Modify input** (`updatedInput`) -- either as a passthrough (normal permission flow continues) or alongside a permission decision
- **Block execution** (`blockingError`) -- yields a deny with the hook's error message
- **Inject context** (`additionalContexts`) -- additional information appended as attachment messages
- **Prevent continuation** (`preventContinuation` + `stopReason`) -- stops the entire conversation loop
- **Make permission decisions** (`permissionBehavior: 'allow' | 'deny' | 'ask'`)

Hook timing is tracked. If pre-tool hooks exceed `HOOK_TIMING_DISPLAY_THRESHOLD_MS` (500ms), an inline timing summary is emitted for visibility. If they exceed `SLOW_PHASE_LOG_THRESHOLD_MS` (2000ms), a debug warning is logged.

**Phase 6 -- Permission Resolution:**
```typescript
const resolved = await resolveHookPermissionDecision(
  hookPermissionResult, tool, processedInput, toolUseContext,
  canUseTool, assistantMessage, toolUseID
)
```
This is the critical integration point between hooks and the rule-based permission system. See Section 5 below for the full decision matrix.

Permission resolution is also tracked for slowness in auto mode (where the classifier side-query can be slow).

**Phase 7 -- OTel Tracking:**
`tool_decision` events are emitted for all non-interactive permission outcomes (hook, rule, classifier). The `source` vocabulary maps to: `config`, `hook`, `user_permanent`, `user_temporary`, `user_reject`.

Code-edit tool decisions get special counter instrumentation.

**Phase 8 -- Tool Execution:**
```typescript
const result = await tool.call(callInput, {...toolUseContext, toolUseId}, canUseTool, assistantMessage, onProgress)
```
The actual tool runs. The `callInput` is carefully managed: if no hook/permission replaced the input, the pre-backfill original is passed so `call()` sees the model's exact field values (important for keeping transcript and VCR fixture hashes stable). If a hook did replace it, the replacement flows through.

Session activity tracking (`startSessionActivity('tool_exec')`) brackets the call.

**Phase 9 -- Post-Tool Hooks:**
```typescript
for await (const result of runPostToolUseHooks(...)) { ... }
```
Post-tool hooks can:
- Inject additional context
- Block (yielding `hook_blocking_error`)
- Prevent continuation (yielding `hook_stopped_continuation`)
- Modify MCP tool output (`updatedMCPToolOutput` -- only for MCP tools)

On failure, `runPostToolUseFailureHooks` runs instead, receiving the error string and `isInterrupt` flag.

**Result Processing:**

After `tool.call()` returns:
1. `mapToolResultToToolResultBlockParam()` converts the result to API format
2. `processPreMappedToolResultBlock()` or `processToolResultBlock()` applies the `maxResultSizeChars` budget -- oversized results are persisted to disk
3. Accept feedback and content blocks from the permission decision are appended
4. The `contextModifier` (if any) is propagated back to the orchestration layer

---

### 5. Hook-Permission Integration (`src/services/tools/toolHooks.ts`)

The `resolveHookPermissionDecision()` function encapsulates the critical security invariant: **hooks can grant convenience, but rules always have the final word.**

**Decision matrix for hook `allow`:**

```
Hook says ALLOW
  |
  +-> requiresUserInteraction AND no updatedInput?
  |     YES -> fall through to canUseTool (interactive prompt required)
  |
  +-> requireCanUseTool set?
  |     YES -> fall through to canUseTool (overlay rewriting needed)
  |
  +-> checkRuleBasedPermissions(tool, input, context)
        |
        +-> null (no rule matches) -> ALLOW (hook wins)
        +-> deny rule matches     -> DENY  (rule overrides hook)
        +-> ask rule matches      -> fall through to canUseTool (dialog required despite hook)
```

The subtle case: a hook allows execution AND provides `updatedInput` for a `requiresUserInteraction` tool (like AskUserQuestion). This counts as "interaction satisfied" -- the hook IS the user interaction (e.g., a headless wrapper that pre-collected answers). The tool proceeds without an interactive prompt, but deny/ask rules still apply.

**Decision matrix for hook `deny`:**

Straightforward -- the tool is denied. No further checks.

**Decision matrix for hook `ask` (or no hook decision):**

Falls through to the normal `canUseTool()` permission flow. If the hook returned `ask`, its `forceDecision` and `updatedInput` are forwarded so the permission dialog shows the hook's message.

---

### 6. Error Handling

**`classifyToolError()` -- telemetry-safe error classification:**

In minified/external builds, `error.constructor.name` gets mangled into short identifiers (e.g., "nJT"). This function extracts structured, logging-safe information instead:

| Error type | Classification |
|------------|---------------|
| `TelemetrySafeError` | Uses its `telemetryMessage` (already vetted), truncated to 200 chars |
| Node.js fs errors | `Error:ENOENT`, `Error:EACCES`, etc. (the errno code) |
| Named errors (name.length > 3) | `ShellError`, `ImageSizeError`, etc. (stable `.name` survives minification) |
| Generic Error | `"Error"` |
| Non-Error thrown | `"UnknownError"` |

**Zod validation errors:**

Formatted with `formatZodValidationError()`. For deferred tools, a special hint is appended if the tool's schema was never loaded via ToolSearch, explaining to the model that typed parameters (arrays, numbers, booleans) got emitted as strings because the client-side parser rejects them without the schema.

**Abort and API abort errors:**

`AbortError` and `APIUserAbortError` are NOT caught as tool errors -- they are rethrown to propagate cancellation up the stack.

**MCP-specific errors:**

`McpToolCallError` and `McpAuthError` have special handling. Auth errors (-32042) can trigger URL elicitation flows. Other MCP errors are wrapped in `<tool_use_error>` XML.

**General tool error format:**

All tool errors are wrapped in XML and marked as errors:
```json
{
  "type": "tool_result",
  "content": "<tool_use_error>Error description here</tool_use_error>",
  "is_error": true,
  "tool_use_id": "..."
}
```

**Hook errors:**

Individual hook errors are caught and yielded as `hook_error_during_execution` attachment messages. They do not crash the tool execution pipeline -- other hooks and the tool itself continue to run.

---

### 7. Progress Reporting

Tools report progress through a layered callback system:

```
tool.call() -> onProgress(ToolProgress<P>) -> Stream<MessageUpdateLazy> -> ProgressMessage -> UI
```

**How it works:**

1. `tool.call()` receives an `onProgress` callback
2. The callback creates a `ToolProgress` object with `{toolUseID, data}` where `data` is tool-specific (e.g., `BashProgress`, `MCPProgress`, `AgentToolProgress`)
3. `streamedCheckPermissionsAndCallTool()` wraps this callback, creating `ProgressMessage` objects and enqueuing them on a `Stream`
4. The REPL UI consumes the stream and calls `renderToolUseProgressMessage()` on the tool

**Pre-tool hook timing visibility:**

- `HOOK_TIMING_DISPLAY_THRESHOLD_MS` = 500ms: hooks taking longer than this get an inline timing summary showing each hook's command and duration
- `SLOW_PHASE_LOG_THRESHOLD_MS` = 2000ms: triggers a debug-level warning with hook count and total duration

**Permission phase slowness:**

In auto mode, the permission decision phase (which includes the speculative classifier side-query) is also monitored against `SLOW_PHASE_LOG_THRESHOLD_MS`. This catches cases where the collapsed view shows "Running..." with no progress tick because the classifier hasn't returned yet.

**In-progress tool tracking:**

The `setInProgressToolUseIDs` callback maintains a set of currently-executing tool IDs. The UI uses this to show multiple concurrent spinners and to determine `hasInterruptibleToolInProgress` (whether the user can interrupt the current operation).

---

### Architecture Summary

The tool system forms a seven-layer pipeline:

```
Model Response (tool_use blocks)
        |
        v
  [1] Orchestration Layer (toolOrchestration.ts)
      Partitions into concurrent/serial batches
        |
        v
  [2] Tool Lookup (toolExecution.ts: runToolUse)
      Name resolution with legacy alias fallback
        |
        v
  [3] Validation Layer
      Zod schema parse -> custom validateInput()
        |
        v
  [4] Pre-execution Layer
      Speculative classifier | input sanitization | pre-tool hooks
        |
        v
  [5] Permission Layer (toolHooks.ts: resolveHookPermissionDecision)
      Hook decisions + rule-based permissions + canUseTool dialog
        |
        v
  [6] Execution Layer
      tool.call() with progress reporting + OTel spans
        |
        v
  [7] Post-execution Layer
      Post-tool hooks | result size budgeting | context modifier propagation
```

The design philosophy is defense-in-depth: multiple independent layers each enforce their own safety invariant. The most important invariant -- that permission rules always override hooks -- is enforced in a single function (`resolveHookPermissionDecision`) shared by both the main query loop and the REPL inner-call path, keeping the permission semantics in lockstep across all execution contexts.
