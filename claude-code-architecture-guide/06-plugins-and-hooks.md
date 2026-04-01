# Chapter 6: Plugins & Hooks

## Overview

Plugins are the extension mechanism for Claude Code. They can add tools, agents, skills, hooks, and slash commands. The hook system is the primary way plugins inject behavior into the Claude Code lifecycle.

## Plugin Architecture

### Plugin Location
```
~/.claude/plugins/
    blocklist.json                    # Blocked plugins
    cache/
        <marketplace>/<plugin>/<version>/
            .claude-plugin/
                plugin.json           # Plugin manifest
                marketplace.json      # Marketplace metadata
            skills/                   # Skill files
            agents/                   # Agent definitions
            commands/                 # Slash commands
            hooks/                    # Hook scripts
                hooks.json            # Hook registrations
                run-hook.cmd          # Cross-platform hook runner
                session-start         # SessionStart hook script
            package.json              # NPM-style package info
```

### Plugin Manifest (plugin.json)
```json
{
  "name": "superpowers",
  "description": "Core skills library for Claude Code",
  "version": "5.0.5",
  "author": {
    "name": "Jesse Vincent",
    "email": "jesse@fsck.com"
  },
  "homepage": "https://github.com/obra/superpowers",
  "license": "MIT",
  "keywords": ["skills", "tdd", "debugging", "collaboration"]
}
```

### Enabling Plugins
Plugins are enabled in `~/.claude/settings.json`:
```json
{
  "enabledPlugins": {
    "superpowers@claude-plugins-official": true
  }
}
```

## The Hook System

Hooks are shell commands that execute at specific lifecycle events. They're Claude Code's answer to callbacks/events.

### Hook Registration (hooks.json)
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
            "async": false
          }
        ]
      }
    ]
  }
}
```

### Available Hook Events
- **SessionStart** -- Fires when a new session begins, or after `clear`/`compact`
- **PreToolUse** -- Fires before a tool executes
- **PostToolUse** -- Fires after a tool executes
- **UserPromptSubmit** -- Fires when user submits a prompt

### Hook Output Format

Hooks communicate back to Claude Code via JSON on stdout:

**For Claude Code (native):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<EXTREMELY_IMPORTANT>...context...</EXTREMELY_IMPORTANT>"
  }
}
```

**For Cursor (alternative):**
```json
{
  "additional_context": "...context..."
}
```

The `additionalContext` string is injected as a `<system-reminder>` in the next user message.

## The SessionStart Hook Deep Dive

The Superpowers plugin's `session-start` script is the most important hook. Here's what it does:

### Step 1: Check for Legacy Skills
```bash
legacy_skills_dir="${HOME}/.config/superpowers/skills"
if [ -d "$legacy_skills_dir" ]; then
    warning_message="WARNING: Move custom skills to ~/.claude/skills"
fi
```

### Step 2: Read Bootstrap Skill
```bash
using_superpowers_content=$(cat "${PLUGIN_ROOT}/skills/using-superpowers/SKILL.md")
```

### Step 3: Escape for JSON
```bash
escape_for_json() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}
```

### Step 4: Construct Context
```bash
session_context="<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n
**Below is the full content of your 'superpowers:using-superpowers' skill:**\n\n
${using_superpowers_escaped}\n\n
</EXTREMELY_IMPORTANT>"
```

### Step 5: Output Platform-Appropriate JSON
```bash
if [ -n "${CURSOR_PLUGIN_ROOT:-}" ]; then
    # Cursor format
    printf '{"additional_context": "%s"}\n' "$session_context"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    # Claude Code format
    printf '{"hookSpecificOutput": {"hookEventName": "SessionStart",
      "additionalContext": "%s"}}\n' "$session_context"
fi
```

### Cross-Platform Support

The `run-hook.cmd` is a polyglot script that works on both Windows (cmd.exe) and Unix (bash):

```bash
: << 'CMDBLOCK'
@echo off
REM Windows: finds bash and runs the named script
...
CMDBLOCK

# Unix: runs script directly
exec bash "${SCRIPT_DIR}/${SCRIPT_NAME}" "$@"
```

## Plugin-Registered Components

### Agents
Plugins can register custom agent types in the `agents/` directory:

```markdown
<!-- agents/code-reviewer.md -->
---
name: code-reviewer
description: |
  Use this agent when a major project step has been completed...
model: inherit
---

You are a Senior Code Reviewer with expertise in...
```

These agents appear in the `Agent` tool's available agent types.

### Slash Commands
Plugins can register slash commands in `commands/`:

```markdown
<!-- commands/brainstorm.md -->
---
description: "Deprecated - use the superpowers:brainstorming skill instead"
---

Tell your human partner that this command is deprecated...
```

### Skills
See Chapter 5 for full skill system documentation.

## Settings Architecture

### Global Settings (~/.claude/settings.json)
```json
{
  "enabledPlugins": { "superpowers@claude-plugins-official": true },
  "voiceEnabled": true,
  "skipDangerousModePermissionPrompt": true,
  "model": "opus[1m]"
}
```

### Local Settings (~/.claude/settings.local.json)
```json
{
  "permissions": {
    "allow": [
      "mcp__claude_ai_Atlassian_JIRA_Confluence__getAccessibleAtlassianResources",
      "mcp__playwright__browser_snapshot"
    ]
  }
}
```

### Permission Model
Tools require permission to execute. Settings can pre-allow specific tools. The user is prompted for approval when a tool not in the allow list is invoked.

## Building Your Own Plugin

To create a plugin that integrates with Claude Code:

1. Create the directory structure with `plugin.json`, `hooks/`, `skills/`, `agents/`
2. Register hooks in `hooks.json` to inject context at lifecycle events
3. Create skills as SKILL.md files with proper frontmatter
4. Register agents as markdown files with frontmatter specifying model and description
5. Install via marketplace or manual plugin installation

The minimal plugin needs:
- `plugin.json` with name, version, description
- `hooks/hooks.json` with at least a SessionStart hook
- A hook script that outputs context injection JSON

---

## The Complete Hook System (Source Code Revealed)

The initial sections above covered the basics from the plugin perspective. This section goes far deeper, documenting everything the source code reveals about the hook system internals.

### Key Source Files

| File | Purpose |
|------|---------|
| `src/entrypoints/sdk/coreTypes.ts` | Canonical list of all 27 hook events (`HOOK_EVENTS` constant) |
| `src/entrypoints/sdk/coreSchemas.ts` | Zod schemas for every hook's input and output |
| `src/types/hooks.ts` | Hook JSON output schema, `HookResult`, `AggregatedHookResult`, `HookCallback` |
| `src/utils/hooks.ts` | Main hook execution engine (massive file: shell spawning, matching, JSON parsing) |
| `src/utils/hooks/execHttpHook.ts` | HTTP POST hook execution with SSRF protection |
| `src/utils/hooks/execAgentHook.ts` | Agent-based hook execution (multi-turn LLM query) |
| `src/utils/hooks/execPromptHook.ts` | Prompt-based hook execution (single-shot LLM query) |
| `src/utils/hooks/ssrfGuard.ts` | IP-level SSRF guard for HTTP hooks |
| `src/utils/hooks/AsyncHookRegistry.ts` | Registry for background async hooks |
| `src/utils/hooks/fileChangedWatcher.ts` | Chokidar-based file watcher for FileChanged hooks |
| `src/utils/hooks/hooksSettings.ts` | Hook configuration management, source display |
| `src/utils/hooks/hooksConfigManager.ts` | Hook metadata, grouping, UI support |
| `src/utils/hooks/hooksConfigSnapshot.ts` | Config snapshotting, managed-hooks-only enforcement |
| `src/utils/hooks/registerFrontmatterHooks.ts` | Registration of hooks from agent/skill frontmatter |
| `src/utils/hooks/registerSkillHooks.ts` | Registration of hooks from skills (with `once:` support) |
| `src/utils/hooks/postSamplingHooks.ts` | Internal-only post-sampling hook registry |
| `src/utils/hooks/sessionHooks.ts` | Session-scoped in-memory hook store |
| `src/utils/hooks/hookHelpers.ts` | Argument substitution, structured output enforcement |
| `src/utils/hooks/hookEvents.ts` | Event system for broadcasting hook execution lifecycle |
| `src/services/tools/toolHooks.ts` | Pre/Post tool use hook orchestration, permission resolution |

---

### 1. All Hook Events

The canonical list lives in `src/entrypoints/sdk/coreTypes.ts`. There are **27 hook events** as of the current codebase. Every hook input extends `BaseHookInput` which always includes:

```typescript
// BaseHookInput - sent to every hook as JSON on stdin
{
  session_id: string,
  transcript_path: string,
  cwd: string,
  permission_mode?: string,   // "default" | "plan" | "auto" etc.
  agent_id?: string,          // Present when firing from a subagent
  agent_type?: string,        // Agent type name, e.g. "code-reviewer"
}
```

#### Tool Lifecycle Events

**PreToolUse** -- Fires before a tool is executed. The most powerful hook for gatekeeping.

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | string | Name of the tool about to execute |
| `tool_input` | unknown | The tool's input arguments |
| `tool_use_id` | string | Unique ID for this tool invocation |

Can return: `permissionDecision` (allow/deny/ask), `updatedInput` (modify tool args), `additionalContext`, `continue: false` to stop.

Matcher: matches against `tool_name`. Example: `"matcher": "Bash"` only fires for Bash tool calls.

Exit code semantics:
- Exit 0: stdout/stderr not shown
- Exit 2: show stderr to model and **block the tool call**
- Other: show stderr to user only, tool call proceeds

**PostToolUse** -- Fires after a tool completes successfully.

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | string | Name of the tool that ran |
| `tool_input` | unknown | The tool's input arguments |
| `tool_response` | unknown | The tool's output |
| `tool_use_id` | string | Unique ID for this tool invocation |

Can return: `additionalContext`, `updatedMCPToolOutput` (rewrites MCP tool output), `continue: false`.

Matcher: matches against `tool_name`.

**PostToolUseFailure** -- Fires when a tool execution fails.

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | string | Name of the tool that failed |
| `tool_input` | unknown | The tool's input arguments |
| `tool_use_id` | string | Unique ID for this tool invocation |
| `error` | string | Error message |
| `is_interrupt` | boolean? | Whether the failure was due to user interrupt |

Matcher: matches against `tool_name`.

**PermissionRequest** -- Fires when a permission dialog would be shown.

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | string | Tool requesting permission |
| `tool_input` | unknown | The tool's input |
| `permission_suggestions` | PermissionUpdate[]? | Suggested permission updates |

Can return: `decision` with `behavior: 'allow'` (optionally with `updatedInput` and `updatedPermissions`) or `behavior: 'deny'` (with optional `message` and `interrupt` flag).

**PermissionDenied** -- Fires after the auto-mode classifier denies a tool call.

| Field | Type | Description |
|-------|------|-------------|
| `tool_name` | string | Tool that was denied |
| `tool_input` | unknown | The tool's input |
| `tool_use_id` | string | Tool invocation ID |
| `reason` | string | Denial reason |

Can return: `retry: true` to tell the model it may retry the tool call.

#### Session Lifecycle Events

**SessionStart** -- Fires when a new session begins.

| Field | Type | Description |
|-------|------|-------------|
| `source` | enum | `'startup'`, `'resume'`, `'clear'`, or `'compact'` |
| `agent_type` | string? | If started with `--agent` |
| `model` | string? | Model in use |

Can return: `additionalContext`, `initialUserMessage`, `watchPaths` (absolute paths to watch for FileChanged hooks).

Matcher: matches against `source`.

**SessionEnd** -- Fires when a session is ending.

| Field | Type | Description |
|-------|------|-------------|
| `reason` | enum | `'clear'`, `'resume'`, `'logout'`, `'prompt_input_exit'`, `'other'`, `'bypass_permissions_disabled'` |

Timeout: 1.5 seconds by default (configurable via `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` env var). Hooks run in parallel.

**Setup** -- Fires for repository setup hooks.

| Field | Type | Description |
|-------|------|-------------|
| `trigger` | enum | `'init'` or `'maintenance'` |

Can return: `additionalContext`.

#### Turn Lifecycle Events

**Stop** -- Fires right before Claude concludes its response.

| Field | Type | Description |
|-------|------|-------------|
| `stop_hook_active` | boolean | Whether a stop hook is currently active |
| `last_assistant_message` | string? | Text of last assistant message |

Exit code 2 = show stderr to model and **continue the conversation** (the model doesn't stop).

**StopFailure** -- Fires when the turn ends due to an API error (rate limit, auth failure, etc.).

| Field | Type | Description |
|-------|------|-------------|
| `error` | object | SDK error object with type and details |
| `error_details` | string? | Additional error details |
| `last_assistant_message` | string? | Text of last assistant message |

Fire-and-forget: hook output and exit codes are ignored.

Matcher: matches against error type (`rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, `unknown`).

**UserPromptSubmit** -- Fires when the user submits a prompt.

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | string | The user's prompt text |

Can return: `additionalContext`.

Exit code 2: block processing, erase original prompt, show stderr to user.

#### Subagent Events

**SubagentStart** -- Fires when a subagent (Agent tool call) is launched.

| Field | Type | Description |
|-------|------|-------------|
| `agent_id` | string | Unique agent identifier |
| `agent_type` | string | Agent type name |

Can return: `additionalContext` (injected into the subagent's context).

Matcher: matches against `agent_type`.

**SubagentStop** -- Fires before a subagent concludes its response.

| Field | Type | Description |
|-------|------|-------------|
| `stop_hook_active` | boolean | Whether a stop hook is active |
| `agent_id` | string | Agent identifier |
| `agent_transcript_path` | string | Path to agent's transcript |
| `agent_type` | string | Agent type name |
| `last_assistant_message` | string? | Text of last assistant message |

Exit code 2 = show stderr to subagent and continue (subagent keeps running).

Note: frontmatter `Stop` hooks on agents are automatically converted to `SubagentStop` during registration.

#### Compaction Events

**PreCompact** -- Fires before conversation compaction.

| Field | Type | Description |
|-------|------|-------------|
| `trigger` | enum | `'manual'` or `'auto'` |
| `custom_instructions` | string? | Current custom compact instructions |

Exit code 0: stdout is appended as custom compaction instructions.
Exit code 2: **blocks compaction entirely**.

**PostCompact** -- Fires after compaction completes.

| Field | Type | Description |
|-------|------|-------------|
| `trigger` | enum | `'manual'` or `'auto'` |
| `compact_summary` | string | The conversation summary produced by compaction |

#### Notification Event

**Notification** -- Fires when a notification is sent.

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Notification message |
| `title` | string? | Notification title |
| `notification_type` | string | Type of notification |

Matcher: matches against `notification_type` (`permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_complete`, `elicitation_response`).

#### Team/Task Events

**TeammateIdle** -- Fires when a teammate is about to go idle.

| Field | Type | Description |
|-------|------|-------------|
| `teammate_name` | string | Name of the teammate |
| `team_name` | string | Team name |

Exit code 2: show stderr to teammate and prevent idle (teammate keeps working).

**TaskCreated** -- Fires when a task is being created.

| Field | Type | Description |
|-------|------|-------------|
| `task_id` | string | Task identifier |
| `task_subject` | string | Task subject |
| `task_description` | string? | Task description |
| `teammate_name` | string? | Teammate name |
| `team_name` | string? | Team name |

Exit code 2: show stderr to model and prevent task creation.

**TaskCompleted** -- Fires when a task is marked as completed.

Same fields as TaskCreated. Exit code 2 prevents task completion.

#### Elicitation Events

**Elicitation** -- Fires when an MCP server requests user input.

| Field | Type | Description |
|-------|------|-------------|
| `mcp_server_name` | string | MCP server name |
| `message` | string | Elicitation message |
| `mode` | enum? | `'form'` or `'url'` |
| `url` | string? | URL for url-mode elicitations |
| `elicitation_id` | string? | Elicitation identifier |
| `requested_schema` | object? | Schema for requested data |

Can return: `action` (`accept`/`decline`/`cancel`) and `content` to auto-respond.

**ElicitationResult** -- Fires after a user responds to an MCP elicitation.

| Field | Type | Description |
|-------|------|-------------|
| `mcp_server_name` | string | MCP server name |
| `elicitation_id` | string? | Elicitation identifier |
| `mode` | enum? | `'form'` or `'url'` |
| `action` | enum | `'accept'`, `'decline'`, or `'cancel'` |
| `content` | object? | Response content |

Can override the response action and content.

#### Configuration Events

**ConfigChange** -- Fires when configuration files change during a session.

| Field | Type | Description |
|-------|------|-------------|
| `source` | enum | `'user_settings'`, `'project_settings'`, `'local_settings'`, `'policy_settings'`, `'skills'` |
| `file_path` | string? | Path to changed file |

Exit code 2: blocks the change from being applied to the session.

**InstructionsLoaded** -- Fires when an instruction file (CLAUDE.md or rule) is loaded.

| Field | Type | Description |
|-------|------|-------------|
| `file_path` | string | Path to the instruction file |
| `memory_type` | enum | `'User'`, `'Project'`, `'Local'`, `'Managed'` |
| `load_reason` | enum | `'session_start'`, `'nested_traversal'`, `'path_glob_match'`, `'include'`, `'compact'` |
| `globs` | string[]? | Patterns that matched |
| `trigger_file_path` | string? | File Claude touched that caused load |
| `parent_file_path` | string? | File that @-included this one |

Observability-only: does not support blocking.

#### File System Events

**CwdChanged** -- Fires after the working directory changes.

| Field | Type | Description |
|-------|------|-------------|
| `old_cwd` | string | Previous working directory |
| `new_cwd` | string | New working directory |

`CLAUDE_ENV_FILE` is set -- write bash exports there to apply env vars to subsequent BashTool commands.
Can return: `watchPaths` (array of absolute paths) to register with the FileChanged watcher.

**FileChanged** -- Fires when a watched file changes.

| Field | Type | Description |
|-------|------|-------------|
| `file_path` | string | Path to the changed file |
| `event` | enum | `'change'`, `'add'`, or `'unlink'` |

`CLAUDE_ENV_FILE` is set. Matcher specifies filenames to watch (e.g., `".envrc|.env"`).
Can return: `watchPaths` to dynamically update the watch list.

#### Worktree Events

**WorktreeCreate** -- Fires to create an isolated worktree for VCS-agnostic isolation.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Suggested worktree slug |

Stdout should contain the absolute path to the created worktree directory.

**WorktreeRemove** -- Fires to remove a previously created worktree.

| Field | Type | Description |
|-------|------|-------------|
| `worktree_path` | string | Absolute path to worktree |

---

### 2. Hook Execution Strategies

Every hook has a `type` field that determines how it is executed. There are four execution strategies plus two internal-only types.

#### Shell Execution (type: "command") -- Default

Source: `src/utils/hooks.ts`

This is the original and most common hook type. The hook engine:

1. Spawns a child process via `child_process.spawn` with the configured shell (default: `bash`)
2. Passes hook input JSON on **stdin**
3. Sets environment variables: `CLAUDE_SESSION_ID`, `CLAUDE_TRANSCRIPT_PATH`, `CLAUDE_CWD`, `CLAUDE_PLUGIN_ROOT` (for plugin hooks), `CLAUDE_ENV_FILE` (for env-related hooks)
4. Reads **stdout** for JSON responses (one JSON object per line)
5. Interprets the **exit code** to determine outcome

The timeout is 10 minutes by default (`TOOL_HOOK_EXECUTION_TIMEOUT_MS`).

**Shell selection**: hooks can specify `"shell": "bash"` (default), `"shell": "powershell"`, or other shells. On Windows, the engine searches for Git Bash, PowerShell, or falls back to `cmd.exe`.

**Async mode**: if the hook's first stdout line is `{"async": true, "asyncTimeout": 15000}`, execution moves to the background. The `AsyncHookRegistry` tracks the process and polls for completion. The async response timeout defaults to 15 seconds.

**Async rewake mode**: Stop hooks use a special `asyncRewake` path. When the hook completes with exit code 2, it enqueues a task notification that wakes the model from idle or gets injected mid-query.

**Prompt elicitation**: Long-running hooks can interactively prompt the user by writing `PromptRequest` JSON to stdout:
```json
{
  "prompt": "request-id-123",
  "message": "Select an option:",
  "options": [
    {"key": "a", "label": "Option A", "description": "..."},
    {"key": "b", "label": "Option B"}
  ]
}
```
The engine responds on the process's stdin with:
```json
{"prompt_response": "request-id-123", "selected": "a"}
```

#### HTTP Execution (type: "http")

Source: `src/utils/hooks/execHttpHook.ts`

Hooks can be configured to fire an HTTP POST request instead of spawning a shell:

```json
{
  "type": "http",
  "url": "https://my-policy-server.example.com/hooks/pre-tool-use",
  "headers": {
    "Authorization": "Bearer $MY_TOKEN"
  },
  "allowedEnvVars": ["MY_TOKEN"],
  "timeout": 30
}
```

The hook input JSON is sent as the POST body with `Content-Type: application/json`. The response body is parsed as JSON using the same schema as shell hook stdout.

Key features:
- **Env var interpolation**: Header values support `$VAR_NAME` and `${VAR_NAME}` patterns. Only variables explicitly listed in `allowedEnvVars` are resolved; others become empty strings to prevent secret exfiltration.
- **SSRF protection**: see section below.
- **URL allowlist**: admin settings can specify `allowedHttpHookUrls` patterns (glob-style with `*` wildcards). If the list is defined and the URL doesn't match, the hook is blocked.
- **Sandbox proxy routing**: when sandboxing is enabled, requests route through the sandbox network proxy which enforces a domain allowlist.
- **Timeout**: configurable per-hook (default 10 minutes).

#### Agent Execution (type: "agent")

Source: `src/utils/hooks/execAgentHook.ts`

Agent hooks spawn a **multi-turn LLM conversation** to evaluate a condition. This is used for sophisticated stop hooks that need to inspect the codebase.

```json
{
  "type": "agent",
  "prompt": "Verify that all test files pass. $ARGUMENTS",
  "model": "claude-sonnet-4-20250514",
  "timeout": 60
}
```

How it works:
1. The `$ARGUMENTS` placeholder is replaced with the hook's JSON input
2. A system prompt is injected telling the agent to verify a stop condition
3. The agent can use **all available tools** (except disallowed-for-agents tools like spawning subagents or entering plan mode)
4. The agent is given access to the conversation transcript file
5. The agent must return a structured output via `SyntheticOutputTool`: `{ok: true}` or `{ok: false, reason: "..."}`
6. Maximum 50 turns before forced abort
7. Default model is the "small fast model" (Haiku-class)

The agent runs with `isNonInteractiveSession: true` and thinking disabled. A session-level `Stop` function hook is registered to enforce that the agent calls `SyntheticOutputTool` before completing.

#### Prompt Execution (type: "prompt")

Source: `src/utils/hooks/execPromptHook.ts`

A simpler version of agent hooks: a single LLM query with no tool use. Uses `queryModelWithoutStreaming` with structured JSON output:

```json
{
  "type": "prompt",
  "prompt": "Does $ARGUMENTS indicate the task is complete?",
  "model": "claude-sonnet-4-20250514",
  "timeout": 30
}
```

The model is instructed to return `{ok: true}` or `{ok: false, reason: "..."}`. Default timeout is 30 seconds. Default model is the small fast model.

If `ok: false`, the hook returns a **blocking error** with `preventContinuation: true`.

#### Internal-Only Types

**Callback hooks** (`type: "callback"`): Registered programmatically, not via settings.json. Used internally for things like session file access analytics and commit attribution. Defined in `src/types/hooks.ts` as `HookCallback`.

**Function hooks** (`type: "function"`): Session-scoped callbacks stored in `SessionHooksState`. Used to enforce structured output in agent hooks. The function receives the current messages and returns `true` (pass) or `false` (block). Defined in `src/utils/hooks/sessionHooks.ts`.

---

### 3. Hook JSON Output Protocol

Source: `src/types/hooks.ts`

Every hook (regardless of execution strategy) communicates back using a JSON protocol. The output schema (`hookJSONOutputSchema`) is a union of two forms:

#### Async Response
```json
{
  "async": true,
  "asyncTimeout": 15000
}
```
Tells the engine to move execution to the background. The hook continues running and its eventual stdout is polled by `AsyncHookRegistry`.

#### Sync Response

The full sync response schema:

```typescript
{
  // General fields (all hook types)
  continue?: boolean,         // Whether Claude should continue (default: true)
  suppressOutput?: boolean,   // Hide stdout from transcript (default: false)
  stopReason?: string,        // Message shown when continue is false
  decision?: 'approve' | 'block',  // Simple approve/block decision
  reason?: string,            // Explanation for the decision
  systemMessage?: string,     // Warning message shown to the user

  // Event-specific output (discriminated union on hookEventName)
  hookSpecificOutput?: {
    hookEventName: '<EventName>',
    // ... event-specific fields
  }
}
```

#### Event-Specific hookSpecificOutput Fields

**PreToolUse**:
- `permissionDecision`: `'allow'`, `'deny'`, `'ask'`, or `'passthrough'`
- `permissionDecisionReason`: string explanation
- `updatedInput`: `Record<string, unknown>` -- modify the tool's input before execution
- `additionalContext`: string injected into context

**PostToolUse**:
- `additionalContext`: string
- `updatedMCPToolOutput`: rewrites the output for MCP tools

**PostToolUseFailure**:
- `additionalContext`: string

**SessionStart**:
- `additionalContext`: string
- `initialUserMessage`: string -- sets an initial user message
- `watchPaths`: string[] -- absolute paths to register with FileChanged watcher

**SubagentStart**:
- `additionalContext`: string

**UserPromptSubmit**:
- `additionalContext`: string

**Setup**:
- `additionalContext`: string

**Notification**:
- `additionalContext`: string

**PermissionDenied**:
- `retry`: boolean -- allow the model to retry the denied tool call

**PermissionRequest**:
- `decision`: either `{behavior: 'allow', updatedInput?, updatedPermissions?}` or `{behavior: 'deny', message?, interrupt?}`

**Elicitation / ElicitationResult**:
- `action`: `'accept'`, `'decline'`, or `'cancel'`
- `content`: `Record<string, unknown>`

**CwdChanged / FileChanged**:
- `watchPaths`: string[] -- paths to add/update in the file watcher

**WorktreeCreate**:
- `worktreePath`: string -- the created worktree path

---

### 4. SSRF Protection

Source: `src/utils/hooks/ssrfGuard.ts`

HTTP hooks are guarded against Server-Side Request Forgery (SSRF) attacks at the DNS resolution level. The guard is implemented as a custom `dns.lookup` function passed to axios, ensuring the validated IP is the one the socket connects to (no rebind window).

**Blocked address ranges (IPv4)**:
- `0.0.0.0/8` -- "this" network
- `10.0.0.0/8` -- private
- `100.64.0.0/10` -- shared address space / CGNAT (catches cloud metadata like Alibaba's `100.100.100.200`)
- `169.254.0.0/16` -- link-local (catches AWS metadata at `169.254.169.254`)
- `172.16.0.0/12` -- private
- `192.168.0.0/16` -- private

**Blocked address ranges (IPv6)**:
- `::` -- unspecified
- `fc00::/7` -- unique local addresses
- `fe80::/10` -- link-local
- `::ffff:<blocked-v4>` -- IPv4-mapped IPv6 in blocked range (prevents hex-form bypass like `::ffff:a9fe:a9fe`)

**Intentionally allowed**:
- `127.0.0.0/8` (loopback) -- local dev policy servers are a primary use case
- `::1` (IPv6 loopback)

**Bypass conditions** (guard is skipped):
- When sandbox network proxy is active (proxy enforces its own domain allowlist)
- When an env-var HTTP proxy is configured (proxy does DNS, guard would validate proxy IP instead of target)

The guard includes full IPv6 expansion logic (`expandIPv6Groups`) to handle all representation variants including compressed and dotted-decimal trailing forms.

---

### 5. Async Hook Registry

Source: `src/utils/hooks/AsyncHookRegistry.ts`

When a hook returns `{"async": true}`, its running process is registered in a global `Map<string, PendingAsyncHook>`:

```typescript
type PendingAsyncHook = {
  processId: string,          // UUID for tracking
  hookId: string,             // Telemetry ID
  hookName: string,           // Display name
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion',
  toolName?: string,
  pluginId?: string,
  startTime: number,
  timeout: number,            // Default: 15000ms
  command: string,
  responseAttachmentSent: boolean,
  shellCommand?: ShellCommand,
  stopProgressInterval: () => void,
}
```

The registry is polled via `checkForAsyncHookResponses()`:
1. For each pending hook, check if `shellCommand.status === 'completed'`
2. If completed, read stdout and parse for JSON (skipping lines with `{async: true}`)
3. Mark as delivered, emit hook response events, clean up

Special behavior:
- When a `SessionStart` hook completes asynchronously, the session env cache is invalidated (so environment changes from the hook take effect)
- Killed processes are cleaned up immediately
- `finalizePendingAsyncHooks()` kills remaining hooks at shutdown

---

### 6. File Change Watcher

Source: `src/utils/hooks/fileChangedWatcher.ts`

The file change watcher uses **chokidar** to monitor files specified by `FileChanged` hook matchers and dynamically added watch paths.

Initialization (`initializeFileChangedWatcher`):
1. Check if any `CwdChanged` or `FileChanged` hooks exist in config
2. If yes, register a cleanup handler and resolve watch paths
3. Watch paths come from two sources:
   - **Static**: matcher field values (e.g., `".envrc|.env"`) resolved relative to cwd
   - **Dynamic**: paths returned by hooks in `watchPaths` output field
4. Start chokidar with `ignoreInitial: true`, `awaitWriteFinish` (500ms stability threshold)

Events monitored: `change`, `add`, `unlink`.

When the cwd changes (`onCwdChangedForHooks`):
1. Clear env files for the old cwd
2. Execute `CwdChanged` hooks
3. Collect new `watchPaths` from hook output
4. Restart chokidar with resolved paths against the new cwd

The watcher supports a notification callback for displaying hook errors/messages to the user.

---

### 7. Hook Configuration

#### Settings-Based Registration

Source: `src/utils/hooks/hooksSettings.ts`

Hooks are registered in `settings.json` under the `hooks` key:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "my-lint-check.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Hooks are loaded from multiple settings sources with defined priority:
1. **User settings** (`~/.claude/settings.json`)
2. **Project settings** (`.claude/settings.json`)
3. **Local settings** (`.claude/settings.local.json`)
4. **Plugin hooks** (registered via plugin `hooks.json`)
5. **Session hooks** (in-memory, temporary)
6. **Built-in hooks** (internal callbacks)

Each source has a display string for the UI (e.g., "User Settings", "Project Settings").

Hook identity is determined by: type + command/prompt/url + shell (for command hooks) + `if` condition. Two hooks with the same command but different `if` conditions are distinct.

#### Config Snapshotting

Source: `src/utils/hooks/hooksConfigSnapshot.ts`

At startup, `captureHooksConfigSnapshot()` takes a snapshot of the hooks configuration. This snapshot is used for all hook execution during the session, providing consistency.

The snapshot respects policy enforcement:
- If `policySettings.disableAllHooks === true`: empty config (no hooks run)
- If `policySettings.allowManagedHooksOnly === true`: only managed/policy hooks
- If `disableAllHooks` is set in non-managed settings: managed hooks still run (non-managed settings cannot disable managed hooks)
- If `strictPluginOnlyCustomization` for hooks: only policy hooks run, but plugin hooks are assembled separately and are unaffected

The snapshot can be updated mid-session via `updateHooksConfigSnapshot()` (which also resets the settings cache to read fresh from disk).

#### Frontmatter Hook Registration

Source: `src/utils/hooks/registerFrontmatterHooks.ts`

Agents and skills can declare hooks in their frontmatter. These are registered as **session-scoped hooks** via `addSessionHook()`:

```yaml
---
hooks:
  Stop:
    - hooks:
        - type: command
          command: "verify-output.sh"
---
```

Key behavior: when registering hooks for an **agent**, `Stop` hooks are automatically converted to `SubagentStop` (since subagents trigger `SubagentStop`, not `Stop`).

#### Skill Hook Registration

Source: `src/utils/hooks/registerSkillHooks.ts`

Skill hooks support a `once: true` flag. When set, the hook is automatically removed after its first successful execution via an `onHookSuccess` callback that calls `removeSessionHook()`.

Skills can also specify a `skillRoot` which is set as `CLAUDE_PLUGIN_ROOT` in the hook's environment.

#### Session Hooks Store

Source: `src/utils/hooks/sessionHooks.ts`

Session hooks are stored in a `Map<string, SessionStore>` (keyed by session ID or agent ID). The Map is deliberately used instead of a Record for performance: `.set()` is O(1) vs O(N) spread for Records, which matters when parallel agents register many hooks in one tick.

Session hooks include:
- **Command/prompt/http hooks**: registered from frontmatter or programmatically
- **Function hooks**: callbacks with a check function and error message, used for enforcement (e.g., structured output)

---

### 8. Tool Hooks Integration

Source: `src/services/tools/toolHooks.ts`

This is where hooks connect to the tool execution pipeline.

#### runPreToolUseHooks()

An async generator that yields one of several result types:

```typescript
| { type: 'message', message: ... }             // Attachment for UI
| { type: 'hookPermissionResult', ... }         // Permission decision
| { type: 'hookUpdatedInput', updatedInput }    // Modified tool input
| { type: 'preventContinuation', ... }          // Stop the turn
| { type: 'stopReason', stopReason }            // Reason for stopping
| { type: 'additionalContext', message }        // Context injection
| { type: 'stop' }                              // Abort tool execution
```

Flow:
1. Calls `executePreToolHooks()` which runs all matching hooks
2. For each hook result:
   - If `blockingError`: yields a `deny` permission result
   - If `preventContinuation`: yields stop signals
   - If `permissionBehavior` is set: yields the appropriate permission result (`allow`, `deny`, or `ask`)
   - If `updatedInput` without permission decision: yields the modified input (normal permission flow continues)
   - If `additionalContexts`: yields context injection messages
   - If aborted: yields cancellation and stops

#### runPostToolUseHooks()

An async generator for post-execution hooks:

1. Iterates through `executePostToolHooks()` results
2. Handles: cancellation, blocking errors, `preventContinuation` (stops the turn), `additionalContexts`, `updatedMCPToolOutput` (rewrites MCP tool output)
3. Deduplicates `hook_blocking_error` attachments (JSON decision hooks yield both `blockingError` and a `hook_blocking_error` attachment; the function skips the attachment to avoid duplication)

#### resolveHookPermissionDecision()

This function encapsulates a critical invariant: **hook `allow` does NOT bypass settings.json deny/ask rules**. Rules always win.

```
Hook says "allow" + Rule says "deny"  =>  DENIED (rule wins)
Hook says "allow" + Rule says "ask"   =>  ASK (dialog shown)
Hook says "allow" + No rule           =>  ALLOWED (hook wins)
Hook says "deny"                      =>  DENIED
Hook says "ask"                       =>  ASK (with hook's message)
No hook decision                      =>  Normal permission flow
```

Full resolution logic:

1. **Hook allow**: check `requiresUserInteraction` (some tools need it -- but if hook provided `updatedInput`, the hook IS the interaction). Then call `checkRuleBasedPermissions()`:
   - If rule returns `null` (no matching rule): allow proceeds
   - If rule returns `deny`: deny overrides the hook
   - If rule returns `ask`: user dialog is shown despite hook approval
2. **Hook deny**: immediately deny
3. **Hook ask or no decision**: normal permission flow, with optional `forceDecision` to customize the dialog

Also handles `requireCanUseTool` guard (SDK mode where all tools need explicit permission).

---

### 9. Post-Sampling Hooks (Internal Only)

Source: `src/utils/hooks/postSamplingHooks.ts`

This is an **internal-only** hook mechanism not exposed through `settings.json`. It provides a programmatic registry for callbacks that fire after each model sampling completes.

```typescript
type PostSamplingHook = (context: REPLHookContext) => Promise<void> | void

type REPLHookContext = {
  messages: Message[],
  systemPrompt: SystemPrompt,
  userContext: { [k: string]: string },
  systemContext: { [k: string]: string },
  toolUseContext: ToolUseContext,
  querySource?: QuerySource,
}
```

Hooks are registered via `registerPostSamplingHook()` and executed sequentially. Errors are logged but do not fail the sampling. This is used by features like session memory that need to observe every model response.

---

### 10. Hook Event Broadcasting

Source: `src/utils/hooks/hookEvents.ts`

Hook execution events are broadcast through a separate event system (decoupled from the main message stream).

Three event types:
- **started**: hook began execution
- **progress**: periodic stdout/stderr updates (polled at 1-second intervals)
- **response**: hook completed with output, exit code, and outcome

**Always-emitted events**: `SessionStart` and `Setup` hooks always emit events regardless of configuration (backwards compatibility).

**Opt-in events**: All other hook events require `includeHookEvents` option or `CLAUDE_CODE_REMOTE` mode. This keeps the event stream low-noise for typical CLI use.

Events are buffered (up to 100) before a handler is registered, ensuring no events are lost during startup.

---

### 11. Workspace Trust Requirement

Source: `src/utils/hooks.ts` (`shouldSkipHookDueToTrust`)

All hooks require workspace trust before executing. This is a defense-in-depth measure because hooks execute arbitrary commands from `.claude/settings.json`.

```typescript
function shouldSkipHookDueToTrust(): boolean {
  // SDK (non-interactive) mode: trust is implicit
  if (!getIsNonInteractiveSession()) return false
  // Interactive mode: all hooks require trust dialog acceptance
  return !checkHasTrustDialogAccepted()
}
```

Historical context: this was added after vulnerabilities where SessionEnd hooks could execute when a user declined the trust dialog, and SubagentStop hooks could fire before trust was established.

---

### 12. Hook Conditional Execution

Hooks support an `if` field for conditional execution based on tool input:

```json
{
  "type": "command",
  "command": "git-guard.sh",
  "if": "Bash(git push*)"
}
```

The `if` condition uses a simple pattern matching syntax: `ToolName(pattern)` where the pattern is matched against the tool's input. Two hooks with the same command but different `if` conditions are treated as distinct hooks.

---

### Summary: Architecture Diagram

```
settings.json / hooks.json / frontmatter / programmatic
                    |
                    v
    +-------------------------------+
    | hooksConfigSnapshot           |  <-- Captured at startup
    | (frozen config for session)   |
    +-------------------------------+
                    |
                    v
    +-------------------------------+
    | Hook Matcher                  |  <-- Filters by event + tool_name/source/etc.
    | (pipe-separated patterns)     |
    +-------------------------------+
                    |
        +-----------+-----------+-----------+
        |           |           |           |
        v           v           v           v
    +-------+   +-------+   +-------+   +-------+
    | Shell |   | HTTP  |   | Agent |   |Prompt |
    | exec  |   | POST  |   | (LLM) |   | (LLM) |
    +-------+   +-------+   +-------+   +-------+
        |           |           |           |
        v           v           v           v
    +-------------------------------+
    | JSON Output Protocol          |  <-- Unified response schema
    | (sync or async)               |
    +-------------------------------+
                    |
        +-----------+-----------+
        |                       |
        v                       v
    +----------------+   +-------------------+
    | Sync Result    |   | Async Registry    |
    | (immediate)    |   | (polled later)    |
    +----------------+   +-------------------+
                    |
                    v
    +-------------------------------+
    | Result Aggregation            |
    | - permission decisions        |
    | - blocking errors             |
    | - additional context          |
    | - input modifications         |
    | - continuation prevention     |
    +-------------------------------+
                    |
                    v
    +-------------------------------+
    | Permission Resolution         |
    | (hook allow != bypass rules)  |
    +-------------------------------+
```
