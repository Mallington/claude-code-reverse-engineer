# Chapter 7: Sub-Agents

## Overview

Sub-agents are independent Claude sessions spawned by the main session to handle specific tasks. They're the primary mechanism for parallelism, context isolation, and specialized work in Claude Code.

## How Sub-Agents Work

When the model calls the `Agent` (or `Task`) tool, Claude Code:

1. Creates a **new API session** with its own system prompt and messages
2. Gives the sub-agent a **subset of tools** based on its type
3. Runs the sub-agent to completion or until it returns a result
4. Returns the sub-agent's output as a `tool_result` to the parent session

```
Parent Session                    Sub-Agent Session
┌─────────────┐                  ┌─────────────────┐
│ System Prompt│                  │ Sub-Agent System │
│ + Tools      │                  │ Prompt + Tools   │
│ + History    │                  │ (fresh, no hist) │
│              │                  │                  │
│ Agent(       │ ──spawns──────→ │ Prompt:          │
│   prompt,    │                  │ "Fix tests in    │
│   type       │                  │  foo.test.ts"    │
│ )            │                  │                  │
│              │                  │ [works...]       │
│              │                  │ [calls tools...] │
│              │ ←──result────── │ "Fixed 3 tests"  │
│              │                  └─────────────────┘
│ tool_result: │
│ "Fixed 3..."│
└─────────────┘
```

### Key Properties

1. **Fresh context** -- Sub-agents start with NO conversation history from the parent. They get only the prompt the parent provides.
2. **Isolated tools** -- Different agent types have different tool access (e.g., Explore agents can't write files)
3. **Independent token budget** -- Sub-agent has its own context window
4. **Result return** -- Only the sub-agent's final text output returns to the parent

## Agent Types and Their Tools

### general-purpose (default)
**Tools:** All tools (Bash, Read, Write, Edit, Glob, Grep, etc.)
**Use:** Complex tasks requiring full filesystem access

### Explore
**Tools:** Read-only tools (Glob, Grep, Read, Bash for read commands, WebFetch, WebSearch)
**NOT:** Agent, Edit, Write, NotebookEdit, ExitPlanMode
**Use:** Fast codebase exploration, research, finding files

### Plan
**Tools:** Same as Explore (read-only)
**Use:** Software architecture, implementation planning

### claude-code-guide
**Tools:** Glob, Grep, Read, WebFetch, WebSearch
**Use:** Answering questions about Claude Code itself

### superpowers:code-reviewer (plugin)
**Tools:** All tools
**Use:** Code review against plans and standards

## Agent Tool Parameters

```json
{
  "name": "Agent",
  "input": {
    "description": "Fix failing tests",
    "prompt": "Full task description...",
    "subagent_type": "general-purpose",
    "model": "sonnet",
    "run_in_background": false,
    "isolation": "worktree"
  }
}
```

## Sub-Agent System Prompts

Sub-agents get a **different** system prompt than the parent. It's a condensed version focused on task execution rather than user interaction. Key differences:

- No user interaction instructions (sub-agents talk to their parent, not the user)
- Task-focused directives
- Restricted tool descriptions based on agent type
- No skill catalog (skills are not automatically available to sub-agents)

## The Superpowers Sub-Agent Pattern

The Superpowers plugin uses sub-agents extensively through its **Subagent-Driven Development** workflow:

### 1. Implementer Sub-Agent
Given full task text + context, implements a single task:
```
Agent(
  description: "Implement Task 3: Add verification function",
  prompt: """
    You are implementing Task 3: Add verification function

    ## Task Description
    [FULL TEXT from plan - pasted, not referenced]

    ## Context
    [Scene-setting: where this fits, dependencies]

    ## Your Job
    1. Implement exactly what the task specifies
    2. Write tests (TDD)
    3. Verify implementation
    4. Commit
    5. Self-review
    6. Report back with status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
  """
)
```

### 2. Spec Reviewer Sub-Agent
Verifies implementation matches specification:
```
Agent(
  description: "Review spec compliance for Task 3",
  prompt: """
    You are reviewing whether an implementation matches its specification.

    ## What Was Requested
    [FULL TEXT of requirements]

    ## CRITICAL: Do Not Trust the Report
    The implementer finished suspiciously quickly. Verify everything independently.
    Read the actual code. Compare to requirements line by line.

    Report: ✅ Spec compliant OR ❌ Issues found: [list]
  """
)
```

### 3. Code Quality Reviewer Sub-Agent
Reviews code quality using the code-reviewer agent type:
```
Agent(
  description: "Code quality review for Task 3",
  subagent_type: "superpowers:code-reviewer",
  prompt: """
    Review implementation of Task 3.
    BASE_SHA: abc123
    HEAD_SHA: def456
    Check: architecture, patterns, testing, maintainability
  """
)
```

### The Full Orchestration Loop

```
Parent (coordinator):
  ├── Dispatch Implementer → [implements] → returns status
  ├── Dispatch Spec Reviewer → [reviews] → ✅ or ❌
  │   └── If ❌: Dispatch Implementer again to fix
  ├── Dispatch Code Quality Reviewer → [reviews] → ✅ or ❌
  │   └── If ❌: Dispatch Implementer again to fix
  └── Mark task complete, move to next
```

## Parallel Agent Dispatch

Multiple agents can run simultaneously:

```json
// Single message with multiple Agent tool calls
[
  { "name": "Agent", "input": { "description": "Fix test file A", "prompt": "..." } },
  { "name": "Agent", "input": { "description": "Fix test file B", "prompt": "..." } },
  { "name": "Agent", "input": { "description": "Fix test file C", "prompt": "..." } }
]
```

All three run concurrently. Claude Code waits for all to complete before returning results.

## Background Agents

Agents can run in the background while the parent continues:

```json
{
  "name": "Agent",
  "input": {
    "prompt": "Run full test suite and report results",
    "run_in_background": true
  }
}
```

The parent is notified when the background agent completes. No polling needed.

## Worktree Isolation

Agents can run in isolated git worktrees:

```json
{
  "name": "Agent",
  "input": {
    "prompt": "Refactor authentication module",
    "isolation": "worktree"
  }
}
```

This creates a temporary git worktree, giving the agent its own copy of the repository. Changes are on a separate branch. If the agent makes no changes, the worktree is cleaned up automatically.

## Context Management Implications

Sub-agents are a **context management strategy**:

1. **Parent stays lean** -- Complex work is delegated, not done in the main context
2. **Fresh start per task** -- No context pollution between tasks
3. **Parallel work** -- Multiple independent tasks run simultaneously
4. **Specialized roles** -- Each agent type has focused capabilities

The trade-off: sub-agents have no memory of previous sub-agent work. The parent must provide all necessary context in the prompt.

## API Call Pattern

Each sub-agent generates its own API calls:
- Same endpoint (`/v1/messages?beta=true`)
- Own system prompt (sub-agent variant)
- Own tools list (filtered by agent type)
- Own message history (starts fresh)
- May use different model (if `model` parameter specified)

A session using subagent-driven-development with 5 tasks and 2 reviewers per task would make:
- 1 parent session (multiple API calls for the conversation)
- 5 implementer sub-agents (each with multiple turns)
- 5 spec reviewer sub-agents
- 5 code quality reviewer sub-agents
- = 15+ separate sub-agent sessions

---

## AgentTool Internals (Source Code Revealed)

This section documents the internal architecture of the Agent tool based on the actual source code at `src/tools/AgentTool/`.

### 1. AgentTool File Structure

The AgentTool lives in `src/tools/AgentTool/` and consists of:

| File | Purpose |
|------|---------|
| `AgentTool.tsx` | Main tool definition (157K+ tokens). Handles input validation, agent selection, sync/async dispatch, fork vs. fresh-agent routing, worktree setup, remote isolation |
| `runAgent.ts` | Core agent execution loop. Builds system prompt, connects MCP servers, resolves tools, runs the `query()` loop, records transcripts |
| `prompt.ts` | Agent tool prompt construction. Generates the tool description text shown to the model, including agent listings, fork guidance, and usage examples |
| `constants.ts` | Tool name constants (`Agent`, legacy `Task`), one-shot agent type set |
| `builtInAgents.ts` | Registry function `getBuiltInAgents()` that assembles the built-in agent list |
| `loadAgentsDir.ts` | Loads custom agents from `.claude/agents/` markdown files and JSON definitions. Defines the `AgentDefinition` type hierarchy |
| `forkSubagent.ts` | Fork-based sub-agent: inherits parent context, shares prompt cache, runs in background |
| `agentMemory.ts` | Persistent agent memory (scoped to user/project/local) |
| `agentMemorySnapshot.ts` | Snapshot-based memory initialization and sync |
| `agentToolUtils.ts` | Tool filtering and resolution (`resolveAgentTools`, `filterToolsForAgent`) |
| `agentColorManager.ts` | Color assignment for multi-agent terminal output |
| `agentDisplay.ts` | Agent listing, override resolution, model display |
| `resumeAgent.ts` | Resumes a previously paused/background agent from its persisted transcript |
| `UI.tsx` | React/Ink UI components for rendering agent progress in the terminal |

### 2. Built-In Agent Types (Deep Dive)

Built-in agents are registered in `builtInAgents.ts` via `getBuiltInAgents()`. The function conditionally assembles the list based on feature flags and environment:

```
getBuiltInAgents()
  ├── ALWAYS: general-purpose, statusline-setup
  ├── IF areExplorePlanAgentsEnabled(): Explore, Plan
  ├── IF non-SDK entrypoint: claude-code-guide
  ├── IF VERIFICATION_AGENT flag + GrowthBook: verification
  └── IF COORDINATOR_MODE: returns coordinator-specific agents instead
```

SDK users can disable all built-ins with `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=true`.

#### general-purpose

- **Source:** `built-in/generalPurposeAgent.ts`
- **Tools:** `['*']` (wildcard -- all available tools)
- **Model:** Uses `getDefaultSubagentModel()` (not hardcoded)
- **System prompt:** Generic task-completion prompt with guidelines about file searching, analysis, and not creating unnecessary files
- **Key detail:** The default agent when `subagent_type` is omitted (and fork is not enabled)

#### Explore

- **Source:** `built-in/exploreAgent.ts`
- **Tools:** All tools EXCEPT `Agent`, `ExitPlanMode`, `FileEdit`, `FileWrite`, `NotebookEdit` (uses `disallowedTools` list)
- **Model:** `haiku` for external users, `inherit` for Anthropic internal (with GrowthBook override at runtime)
- **System prompt:** "You are a file search specialist" with strict READ-ONLY MODE prohibition
- **Optimizations:**
  - `omitClaudeMd: true` -- skips CLAUDE.md hierarchy from context (saves ~5-15 Gtok/week across 34M+ spawns)
  - Git status is also stripped from system context
  - Minimum 3 queries enforced (`EXPLORE_AGENT_MIN_QUERIES = 3`)
- **One-shot:** Listed in `ONE_SHOT_BUILTIN_AGENT_TYPES` -- skips agentId/SendMessage trailer to save ~135 chars per invocation

#### Plan

- **Source:** `built-in/planAgent.ts`
- **Tools:** Same disallowed list as Explore; also inherits Explore's tool list (`tools: EXPLORE_AGENT.tools`)
- **Model:** `inherit` (uses parent's model)
- **System prompt:** "Software architect and planning specialist" with structured process (Understand Requirements -> Explore -> Design -> Detail). Requires output ending with "Critical Files for Implementation" list
- **Optimizations:** Same as Explore (`omitClaudeMd: true`, git status stripped, one-shot)

#### verification

- **Source:** `built-in/verificationAgent.ts`
- **Tools:** All tools EXCEPT `Agent`, `ExitPlanMode`, `FileEdit`, `FileWrite`, `NotebookEdit`
- **Model:** `inherit`
- **Color:** `red`
- **Background:** `true` (always runs as background task)
- **Feature-gated:** Requires both `VERIFICATION_AGENT` compile flag and `tengu_hive_evidence` GrowthBook flag
- **System prompt:** Extremely detailed adversarial verification prompt. Key philosophy: "Your job is not to confirm the implementation works -- it's to try to break it." Includes:
  - Self-awareness of two failure patterns (verification avoidance, being seduced by the first 80%)
  - Strategy matrix for different change types (frontend, backend, CLI, infra, mobile, data/ML, etc.)
  - Adversarial probe requirements (concurrency, boundary values, idempotency, orphan operations)
  - Strict output format: every check must have Command run / Output observed / Result
  - Final VERDICT: PASS | FAIL | PARTIAL
- **Critical reminder:** Re-injected at every user turn: "This is a VERIFICATION-ONLY task"
- **Cannot modify project files** but CAN write ephemeral test scripts to `/tmp`

#### claude-code-guide

- **Source:** `built-in/claudeCodeGuideAgent.ts`
- **Tools:** `Glob`, `Grep`, `Read`, `WebFetch`, `WebSearch` (explicit allowlist)
- **Model:** `haiku`
- **Permission mode:** `dontAsk` (never prompts for permissions)
- **System prompt:** Help agent spanning three domains: Claude Code CLI, Claude Agent SDK, Claude API. Fetches documentation from `code.claude.com/docs/en/claude_code_docs_map.md` and `platform.claude.com/llms.txt`. Dynamically includes user's current configuration (custom skills, agents, MCP servers, settings)
- **Only included for non-SDK entrypoints** (excluded when `CLAUDE_CODE_ENTRYPOINT` is `sdk-ts`, `sdk-py`, or `sdk-cli`)

#### statusline-setup

- **Source:** `built-in/statuslineSetup.ts`
- **Tools:** `Read`, `Edit` only
- **Model:** `sonnet`
- **Color:** `orange`
- **System prompt:** Specialized for converting shell PS1 prompts to Claude Code status line commands. Knows about PS1 escape sequences, ANSI colors, and `~/.claude/settings.json` structure

### 3. Custom Agent Definitions

Custom agents are loaded from `.claude/agents/` directories via `loadAgentsDir.ts`.

#### Agent Definition Type Hierarchy

```typescript
type AgentDefinition = BuiltInAgentDefinition | CustomAgentDefinition | PluginAgentDefinition

// Built-in: dynamic prompt via getSystemPrompt(), source: 'built-in'
// Custom: prompt from markdown body or JSON, source: SettingSource
// Plugin: from plugin packages, source: 'plugin'
```

#### Loading Sources and Priority

Agents are loaded from multiple sources and merged with a priority system. Higher-priority sources override lower ones when agent types collide:

```
1. built-in        (lowest -- always loaded)
2. plugin          (from plugin packages)
3. userSettings    (~/.claude/agents/)
4. projectSettings (.claude/agents/ in project)
5. flagSettings    (from CLI flags / JSON)
6. policySettings  (managed/enterprise -- highest)
```

The function `getActiveAgentsFromList()` deduplicates by `agentType`, with later groups overriding earlier ones. This means a project-level agent with the same name as a built-in will replace it.

#### Markdown Agent Format

Custom agents use markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: When to use this agent
tools:
  - Read
  - Glob
  - Grep
  - Bash
disallowedTools:
  - Agent
model: sonnet          # or 'inherit', or a full model ID
effort: high           # low/medium/high or integer
permissionMode: acceptEdits
color: blue
background: true       # always run as background
memory: user           # user/project/local persistent memory
isolation: worktree    # run in git worktree
maxTurns: 50
skills:
  - my-skill
mcpServers:
  - slack              # reference existing server by name
  - myserver:          # or inline definition
      command: node
      args: [server.js]
hooks:
  SubagentStart:
    - command: echo starting
initialPrompt: "Load context first"
---

Your agent system prompt goes here in the markdown body.

This is what the agent sees as its system prompt.
```

#### JSON Agent Format

Agents can also be defined as JSON objects (used by `flagSettings` and programmatic registration):

```json
{
  "my-agent": {
    "description": "When to use this agent",
    "prompt": "Your system prompt here",
    "tools": ["Read", "Glob"],
    "model": "sonnet",
    "maxTurns": 50
  }
}
```

Validated with Zod schemas (`AgentJsonSchema`, `AgentsJsonSchema`).

#### MCP Server Requirements

Agents can declare `requiredMcpServers` -- patterns that must match at least one configured MCP server name (case-insensitive substring match) for the agent to be available. Agents whose requirements are not met are filtered out by `filterAgentsByMcpRequirements()`.

### 4. runAgent() -- The Core Agent Loop

The `runAgent()` function in `runAgent.ts` is the execution engine for all sub-agents. It is an async generator that yields messages back to the caller.

#### Execution Flow

```
runAgent(agentDefinition, promptMessages, toolUseContext, ...)
  │
  ├── 1. Resolve model
  │     getAgentModel(agent.model, mainLoopModel, override, permissionMode)
  │
  ├── 2. Create agentId (or use override)
  │
  ├── 3. Build initial messages
  │     [forkContextMessages (filtered)] + [promptMessages]
  │
  ├── 4. Resolve user/system context
  │     ├── getUserContext() / getSystemContext()
  │     ├── Omit CLAUDE.md for read-only agents (omitClaudeMd flag)
  │     └── Omit git status for Explore/Plan agents
  │
  ├── 5. Configure permission mode
  │     ├── Agent can override (unless parent is bypassPermissions/acceptEdits/auto)
  │     ├── Async agents: shouldAvoidPermissionPrompts = true
  │     └── Bubble mode: surfaces prompts to parent terminal
  │
  ├── 6. Resolve tools
  │     ├── useExactTools? → use availableTools directly (fork path)
  │     └── Otherwise: resolveAgentTools(agentDef, availableTools, isAsync)
  │
  ├── 7. Build system prompt
  │     ├── override.systemPrompt? → use directly (fork path)
  │     └── Otherwise: getAgentSystemPrompt() → enhanceSystemPromptWithEnvDetails()
  │
  ├── 8. Execute SubagentStart hooks
  │     Collects additional context from hooks
  │
  ├── 9. Register frontmatter hooks (scoped to agent lifecycle)
  │
  ├── 10. Preload skills from agent frontmatter
  │      Resolves skill names, loads content, adds as user messages
  │
  ├── 11. Initialize agent-specific MCP servers
  │      ├── String refs: connect to existing server (shared client)
  │      └── Inline defs: create new client (cleaned up on agent exit)
  │
  ├── 12. Create subagent context (createSubagentContext)
  │      ├── Sync: shares setAppState, abortController with parent
  │      └── Async: fully isolated with new AbortController
  │
  ├── 13. Record initial messages to sidechain transcript
  │
  ├── 14. THE QUERY LOOP
  │      for await (message of query({
  │        messages, systemPrompt, userContext, systemContext,
  │        canUseTool, toolUseContext, querySource, maxTurns
  │      }))
  │        ├── Forward API metrics (TTFT) to parent
  │        ├── Handle max_turns_reached → break
  │        ├── Record each message to sidechain transcript
  │        └── yield message to caller
  │
  └── 15. Cleanup (finally block)
        ├── Clean up agent-specific MCP servers
        ├── Clear session hooks
        ├── Clean up prompt cache tracking
        ├── Release file state cache
        ├── Release perfetto tracing
        ├── Remove agent's todo entries
        └── Kill background bash tasks spawned by agent
```

#### Key Implementation Details

**Thinking is disabled for sub-agents** (except fork children). Regular sub-agents get `thinkingConfig: { type: 'disabled' }` to control output token costs. Fork children inherit the parent's thinking config for cache-identical API prefixes.

**Async agents are marked as non-interactive sessions** (`isNonInteractiveSession: true`), which affects tool behavior. Fork children inherit the parent's setting.

**The query loop is the same `query()` function** used by the main session. Sub-agents are not special -- they are full sessions running the same engine. The only differences are the context, tools, and system prompt they receive.

**Transcripts are recorded to sidechain storage** (`recordSidechainTranscript`), keyed by `agentId`. This enables agent resume and the `/agents` transcript viewer.

### 5. Fork Agents

Fork agents are a distinct execution mode introduced by the `FORK_SUBAGENT` feature flag. They differ fundamentally from regular sub-agents.

#### How Fork Differs from Fresh Agents

| Aspect | Fresh Agent (subagent_type specified) | Fork (subagent_type omitted) |
|--------|---------------------------------------|------------------------------|
| Context | Starts empty -- only gets the prompt | Inherits parent's full conversation |
| System prompt | Agent-specific prompt | Parent's exact system prompt (byte-identical) |
| Tools | Filtered per agent type | Parent's exact tool pool |
| Prompt cache | Cold start | Shares parent's cache (major perf win) |
| Thinking | Disabled | Inherits parent's thinking config |
| Background | Optional | Always background |
| Model | Per agent definition | Always inherits parent model |

#### Source: `forkSubagent.ts`

The fork agent is defined as a synthetic `BuiltInAgentDefinition`:

```typescript
export const FORK_AGENT = {
  agentType: 'fork',
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',  // surfaces permission prompts to parent terminal
  source: 'built-in',
  getSystemPrompt: () => '',  // unused -- parent's rendered prompt is passed directly
}
```

#### Fork Message Construction

`buildForkedMessages()` constructs the child's conversation by:

1. Cloning the parent's assistant message (all tool_use, thinking, text blocks)
2. Building tool_result blocks with identical placeholder text (`"Fork started -- processing in background"`)
3. Appending a per-child directive text block

Only the final directive block differs per child, maximizing prompt cache hits across parallel forks.

#### The Fork Child Directive

Every fork child receives a strict preamble (`buildChildMessage()`) wrapped in `<fork_boilerplate>` tags:

- "You are a forked worker process. You are NOT the main agent."
- Rule 1: "Do NOT spawn sub-agents; execute directly"
- Rule 6: "Do NOT emit text between tool calls. Use tools silently, then report once at the end"
- Required output format: Scope / Result / Key files / Files changed / Issues
- Report must stay under 500 words

#### Recursive Fork Prevention

`isInForkChild()` scans conversation history for the `<fork_boilerplate>` tag. If found, the Agent tool rejects fork attempts. Fork children keep the Agent tool in their pool (for cache-identical tool definitions) but cannot use it to fork again.

#### Worktree Notice for Forks

When a fork runs in a worktree, it receives an additional notice explaining that paths from inherited context refer to the parent's working directory and must be translated to the worktree root.

#### Fork Prompt Guidance (shown to parent model)

When fork is enabled, the Agent tool prompt includes a "When to fork" section with specific guidance:

- Fork open-ended research questions (they inherit context and share cache)
- Fork implementation work requiring more than a couple edits
- "Don't peek" -- do not Read the fork's output file mid-flight
- "Don't race" -- never fabricate or predict fork results
- Fork prompts are directives (what to do), not briefings (what the situation is)

### 6. Agent Memory

Agents can have persistent memory that survives across sessions. Defined in `agentMemory.ts`.

#### Memory Scopes

| Scope | Location | Shared? |
|-------|----------|---------|
| `user` | `~/.claude/agent-memory/<agentType>/` (or `$CLAUDE_CODE_REMOTE_MEMORY_DIR`) | Across all projects for this user |
| `project` | `<cwd>/.claude/agent-memory/<agentType>/` | With team via version control |
| `local` | `<cwd>/.claude/agent-memory-local/<agentType>/` | Not checked into VCS |

#### How Memory Works

1. When an agent with `memory` enabled is spawned, `loadAgentMemoryPrompt()` is called during system prompt construction
2. It ensures the memory directory exists (fire-and-forget `mkdir`)
3. It calls `buildMemoryPrompt()` from the memdir module, which reads all `.md` files in the memory directory
4. The memory content is appended to the agent's system prompt
5. The entrypoint file is `MEMORY.md` in the memory directory
6. Agents with memory enabled and a restricted tool list automatically get `FileWrite`, `FileEdit`, `FileRead` injected into their tools so they can update their own memory

Each scope has specific guidelines injected into the prompt:
- `user`: "keep learnings general since they apply across all projects"
- `project`: "tailor your memories to this project" (shared via VCS)
- `local`: "tailor your memories to this project and machine"

#### Memory Snapshots

`agentMemorySnapshot.ts` provides a snapshot-based initialization system for memory:

1. Project-level snapshots live in `<cwd>/.claude/agent-memory-snapshots/<agentType>/snapshot.json`
2. On agent load, `checkAgentMemorySnapshot()` compares snapshot timestamp vs. local `.snapshot-synced.json`
3. Three outcomes:
   - `none`: no snapshot or already synced
   - `initialize`: no local memory exists -- copy snapshot files to local memory directory
   - `prompt-update`: newer snapshot available -- the agent definition gets a `pendingSnapshotUpdate` flag
4. `initializeFromSnapshot()` copies all files (except `snapshot.json` itself) from snapshot dir to local memory
5. `replaceFromSnapshot()` first removes existing `.md` files, then copies snapshot contents

### 7. Worktree Isolation (Deep Dive)

When `isolation: "worktree"` is specified, the agent operates in a temporary git worktree.

#### How It Works

1. `AgentTool.tsx` creates a temporary git worktree before calling `runAgent()`
2. The agent's `cwd` is overridden to the worktree path via `runWithCwdOverride()`
3. The worktree path is persisted to agent metadata (`writeAgentMetadata`) for resume support
4. On completion:
   - If no changes: worktree is cleaned up automatically
   - If changes made: worktree path and branch are returned in the result
5. On resume: `resumeAgent.ts` checks if the worktree still exists (`fsp.stat`), bumps its mtime to prevent stale cleanup, and restores the cwd override

#### Worktree + Fork Interaction

Fork agents spawned with worktree isolation receive a `buildWorktreeNotice()` message explaining:
- The inherited context refers to the parent's working directory
- Paths must be translated to the worktree root
- Files should be re-read before editing (parent may have modified them)
- Changes stay isolated in the worktree

### 8. Tool Filtering and Resolution

Tool access for sub-agents is controlled by multiple layers defined in `agentToolUtils.ts` and `src/constants/tools.ts`.

#### Layer 1: Global Agent Disallowed Tools (`ALL_AGENT_DISALLOWED_TOOLS`)

Always blocked for all agents:
- `TaskOutput` (reading another agent's output)
- `ExitPlanMode` (v2)
- `EnterPlanMode`
- `Agent` tool itself (unless Anthropic internal -- `USER_TYPE === 'ant'`)

#### Layer 2: Custom Agent Extra Restrictions (`CUSTOM_AGENT_DISALLOWED_TOOLS`)

Applied only to non-built-in agents. Currently inherits all of Layer 1 (no additional restrictions at present).

#### Layer 3: Async Agent Allowed Tools (`ASYNC_AGENT_ALLOWED_TOOLS`)

Background agents are restricted to a specific allowlist:
- `Read`, `WebSearch`, `TodoWrite`, `Grep`, `WebFetch`, `Glob`
- `Bash` (all shell tool names)
- `Edit`, `Write`, `NotebookEdit`
- `Skill`, `SyntheticOutput`, `ToolSearch`
- `EnterWorktree`, `ExitWorktree`

Notably absent from async: the `Agent` tool (no nested background agents), `SendMessage`.

Exception: in-process teammates with agent swarms enabled can use `Agent` (sync only) and task coordination tools.

#### Layer 4: Agent Definition Filtering (`resolveAgentTools`)

Each agent definition can specify:
- `tools: ['Read', 'Grep', ...]` -- explicit allowlist (only these tools available)
- `tools: ['*']` or `tools: undefined` -- wildcard (all available after filtering)
- `disallowedTools: ['Agent', 'Write', ...]` -- denylist (removed from whatever tools are available)

The resolution process:
1. Start with the full tool pool (assembled by the caller with the agent's permission mode)
2. Apply `filterToolsForAgent()` (layers 1-3 above)
3. Remove any tools in `disallowedTools`
4. If tools is a specific list, intersect with available tools (validate, warn about invalid names)
5. Special case: `Agent(worker, researcher)` in tools list creates `allowedAgentTypes` restriction

### 9. Agent Display and Communication

#### Color Management (`agentColorManager.ts`)

Each agent type can be assigned a display color from 8 options: red, blue, green, yellow, purple, orange, pink, cyan. Colors map to theme-specific values (`red_FOR_SUBAGENTS_ONLY`, etc.).

- Built-in agents can set color in their definition (e.g., verification = red, statusline-setup = orange)
- Custom agents set color via `color` frontmatter field
- `general-purpose` always returns `undefined` (no color -- uses default)
- Colors are stored in a global map (`getAgentColorMap()`) and initialized when agents load

#### Agent Display Utilities (`agentDisplay.ts`)

Provides consistent display logic used by both the CLI `/agents` command and interactive UI:

- **Source groups** with ordered display: User -> Project -> Local -> Managed -> Plugin -> CLI arg -> Built-in
- **Override resolution:** Detects when a higher-priority agent shadows a lower-priority one (e.g., project agent overrides built-in)
- **Model display:** Resolves the effective model alias for display

#### UI Components (`UI.tsx`)

React/Ink components for terminal rendering of agent progress:

- Groups consecutive search/read operations into summary lines ("Searched 5 files, read 3 files")
- Shows up to `MAX_PROGRESS_MESSAGES_TO_SHOW = 3` progress messages
- Renders agent name with type-specific color via `getAgentColor()`
- Uses `CtrlOToExpand` / `SubAgentProvider` for expandable sub-agent output
- Shows duration, token count, and tool use stats on completion

#### Agent Listing in Tool Description

The list of available agents is embedded in the Agent tool's prompt. To optimize prompt caching, this list can be moved to an attachment message (controlled by `shouldInjectAgentListInMessages()` / GrowthBook flag `tengu_agent_list_attach`):

- **Inline mode (default):** Agent list is part of the tool description. Any change (MCP connect, plugin reload) busts the tool-schema cache.
- **Attachment mode:** Agent list lives in a `<system-reminder>` message. Tool description stays static, preserving the prompt cache.

This optimization addresses ~10.2% of fleet cache_creation tokens caused by dynamic tool descriptions.

### 10. Agent Resume

Agents can be resumed from their persisted transcripts via `resumeAgent.ts`.

#### Resume Flow

1. Load the agent's transcript and metadata from session storage (`getAgentTranscript`, `readAgentMetadata`)
2. Filter the transcript: remove whitespace-only assistant messages, orphaned thinking blocks, unresolved tool uses
3. Reconstruct content replacement state from the transcript
4. Check if the original worktree still exists (fall back to parent cwd if not; bump mtime if yes)
5. Determine agent type from metadata (fork, named type, or fall back to general-purpose)
6. For fork resume: reconstruct or reuse the parent's system prompt
7. Register as an async agent task
8. Call `runAgent()` with the resumed messages plus the new prompt

Resume skips permission re-gating (the original spawn already passed checks) and name-registry writes (the original entry persists).

### 11. The Agent Tool Prompt (What the Model Sees)

The prompt shown to the parent model (in `prompt.ts`) varies based on several conditions:

#### Coordinator Mode
Coordinators get a slim prompt -- just the agent listing and basic instructions. The coordinator system prompt already covers usage notes and examples.

#### Fork Mode
When fork is enabled, the prompt includes:
- "When to fork" section with detailed guidance
- Fork-specific examples (research audit, migration review)
- Directive-style prompt writing guidance ("since the fork inherits your context, the prompt is a directive")

#### Standard Mode
The full prompt includes:
- Agent type listing with tools and when-to-use descriptions
- "When NOT to use" section (use Read/Glob instead for simple lookups)
- Usage notes: short description requirement, result visibility, background vs foreground guidance
- Concurrency note for non-Pro subscribers ("launch multiple agents concurrently")
- Standard examples showing agent dispatch after code writing and greeting response

#### Dynamic Agent List Optimization
Each agent line follows the format:
```
- type: whenToUse (Tools: tool1, tool2, ...)
```
Tool descriptions show the effective tools after applying both allowlist and denylist filters.
