# Chapter 13: The Swarm/Team System

Claude Code provides two distinct multi-agent architectures that go beyond the single-session sub-agents covered in Chapter 7. The **Swarm/Team model** (internally codenamed "tengu") creates peer agents with file-based mailboxes and a full team lifecycle. The **Coordinator mode** is a leaner orchestrator-worker pattern built on the existing AgentTool. Both allow Claude Code to fan out work across multiple agents, but they differ fundamentally in how agents are spawned, communicate, and manage permissions.

## Overview: Two Multi-Agent Architectures

```
Swarm/Team Model ("tengu")              Coordinator Mode
================================        ================================

  ┌──────────┐                            ┌─────────────┐
  │  Leader   │  TeamCreateTool           │ Coordinator  │  CLAUDE_CODE_
  │ (team-    │  TeammateTool             │              │  COORDINATOR_
  │  lead)    │  SendMessageTool          │              │  MODE=1
  └────┬──┬──┘                            └──┬──────┬───┘
       │  │                                  │      │
  ┌────┘  └────┐   File-based           ┌───┘      └───┐   AgentTool
  │            │   mailboxes            │              │   (background)
  ▼            ▼                        ▼              ▼
┌──────┐  ┌──────┐                   ┌──────┐    ┌──────┐
│Peer A│  │Peer B│                   │Worker│    │Worker│
│(tmux/│  │(tmux/│                   │  1   │    │  2   │
│iTerm/│  │in-   │                   └──────┘    └──────┘
│in-   │  │proc) │                      │              │
│proc) │  └──────┘                      │              │
└──────┘                                ▼              ▼
  ▲  ▲                           <task-notification> XML
  │  │                           returned to coordinator
  └──┘
  Peers can message
  each other directly
```

The Swarm/Team model creates a persistent team with named agents, mailboxes, and a shared task list. Agents can message each other directly and operate with significant autonomy. The Coordinator model is simpler: one coordinator spawns workers via AgentTool, workers report results as `<task-notification>` XML, and the coordinator synthesizes findings before directing further work.

> **Key Insight:** The two architectures serve different needs. The Swarm/Team model is designed for long-lived collaborative sessions where multiple agents work semi-independently on a shared task list. Coordinator mode is designed for structured workflows where one agent maintains full control of task decomposition and synthesis.

## Team Creation (TeamCreateTool)

The Swarm/Team lifecycle begins with `TeamCreateTool`, which establishes the team's on-disk state and registers the leader.

### The TeamFile Structure

When the leader calls TeamCreateTool, a team file is written to `~/.claude/teams/{teamName}/config.json`:

```typescript
type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string          // e.g., "team-lead@my-team"
  leadSessionId?: string       // Session UUID for discovery
  teamAllowedPaths?: TeamAllowedPath[]
  members: Array<{
    agentId: string            // "researcher@my-team"
    name: string               // "researcher"
    agentType?: string
    model?: string
    joinedAt: number
    tmuxPaneId: string
    cwd: string
    backendType?: BackendType  // 'tmux' | 'iterm2' | 'in-process'
    isActive?: boolean
    subscriptions: string[]
  }>
}
```

### Creation Flow

The creation process enforces a **one team per leader** constraint. If the leader already has a `teamContext` in AppState, the tool throws an error. Otherwise:

```
TeamCreateTool.call()
  │
  ├─ Check: no existing team in AppState
  ├─ Generate unique team name (slug fallback if name taken)
  ├─ Build TeamFile with leader as first member
  ├─ Write to ~/.claude/teams/{teamName}/config.json
  ├─ registerTeamForSessionCleanup(teamName)
  ├─ Reset & create task list directory
  ├─ setLeaderTeamName() for task routing
  └─ Update AppState.teamContext
```

The `registerTeamForSessionCleanup()` call ensures that teams are cleaned up when the session ends. Without this, team directories were left on disk indefinitely (referenced as gh-32730 in the source).

The task list directory is created alongside the team. Team name and task list ID are linked so that the leader and all teammates write to the same task directory.

## Three Spawning Backends

Once a team exists, teammates can be spawned through one of three backends. The backend is selected by the `--teammate-mode` flag or auto-detected from the environment.

```
┌──────────────────────────────────────────────────────┐
│                  Backend Registry                     │
│                                                       │
│  getResolvedTeammateMode() → 'tmux' | 'iterm2'      │
│                              | 'in-process'           │
│                                                       │
│  Detection priority:                                  │
│    1. Explicit --teammate-mode flag                   │
│    2. Running inside iTerm2? → iterm2                 │
│    3. Running inside tmux? → tmux                     │
│    4. tmux available? → tmux (external session)       │
│    5. Fallback → in-process                           │
└──────────────────────────────────────────────────────┘
```

### tmux Backend

The tmux backend spawns each teammate as a separate Claude Code process in its own tmux pane. When the user is not already in tmux, it creates a dedicated tmux socket named `claude-swarm-{PID}` to isolate swarm operations from the user's existing tmux sessions.

Key characteristics:
- Each teammate is a fully independent OS process
- Panes are created with colored borders and titles for visual identification
- Sequential pane creation lock prevents race conditions during parallel spawning
- A 200ms delay after pane creation allows shell initialization (rc files, prompts)

The `PaneBackendExecutor` wraps the pane backend and handles the command construction for spawning:

```typescript
// The teammate command includes inherited CLI flags and env vars
const command = `env ${buildInheritedEnvVars()} ${teammateCommand} \
  --team-name ${teamName} \
  --agent-name ${name} \
  --agent-id ${agentId} \
  ${buildInheritedCliFlags({ planModeRequired, permissionMode })} \
  --resume --prompt ${encodedPrompt}`
```

### iTerm2 Backend

The iTerm2 backend uses the `it2` CLI tool to create native iTerm2 split panes on macOS. It follows the same pattern as tmux but uses iTerm2's session management instead:

- Splits the leader's terminal pane to create teammate panes
- Tracks session IDs returned by `it2 session split`
- Falls back to tmux if `it2` CLI is not installed

### in-process Backend

The in-process backend runs teammates within the same Node.js process, using `AsyncLocalStorage` for context isolation. This is the most resource-efficient option and the default fallback.

```typescript
// TeammateIdentity: the minimal identity fields
type TeammateIdentity = {
  name: string
  teamName: string
  color?: AgentColorName
  planModeRequired?: boolean
}

// TeammateContext: full context stored in AsyncLocalStorage
// Includes agentId, agentName, teamName, color, and more
```

Critical design decisions for in-process teammates:

1. **Independent AbortController** -- Each teammate gets its own AbortController that is NOT linked to the leader's query abort. This prevents a leader query cancellation from killing all teammates.

2. **AsyncLocalStorage isolation** -- `runWithTeammateContext()` provides per-agent context so that calls like `getAgentName()` and `getTeamName()` return the correct values for each teammate, even though they share a process.

3. **InProcessTeammateTaskState** -- Each teammate is registered in `AppState.tasks` for UI rendering and progress tracking. This uses the same task framework as background AgentTool runs.

### Inherited Configuration (tmux/iTerm only)

For process-based backends, two functions propagate the leader's configuration:

**`buildInheritedCliFlags()`** propagates:
- Permission mode (`--dangerously-skip-permissions` or `--permission-mode acceptEdits`)
- Model override (`--model`)
- Settings path (`--settings`)
- Plugin directories (`--plugin-dir`)
- Teammate mode (`--teammate-mode`)
- Chrome flag (`--chrome` / `--no-chrome`)

**`buildInheritedEnvVars()`** propagates:
- API provider selection (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`)
- Custom API endpoint (`ANTHROPIC_BASE_URL`)
- Config directory (`CLAUDE_CONFIG_DIR`)
- Remote markers (`CLAUDE_CODE_REMOTE`)
- Proxy settings (`HTTPS_PROXY`, `HTTP_PROXY`, etc.)
- CA certificates (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`)

> **Key Insight:** In-process teammates share the leader's API client and MCP connections, making them significantly cheaper to spawn. Process-based teammates (tmux/iTerm) need explicit environment variable and CLI flag propagation because tmux may start a new login shell that does not inherit the parent's environment.

## Inter-Agent Communication (SendMessageTool)

All inter-agent communication flows through `SendMessageTool`, which supports both plain text messages and structured protocol messages.

### Message Types

```typescript
// Plain text message
{ to: "researcher", summary: "Status update", message: "Found the bug in auth.ts" }

// Broadcast to all teammates
{ to: "*", summary: "Plan ready", message: "Implementation plan is finalized" }

// Structured protocol messages (discriminated union)
{ to: "researcher", message: { type: "shutdown_request", reason: "Task complete" } }
{ to: "team-lead", message: { type: "shutdown_response", request_id: "...", approve: true } }
{ to: "researcher", message: { type: "plan_approval_response", request_id: "...", approve: true } }
```

Structured messages cannot be broadcast (`to: "*"`) and cannot be sent cross-session.

### Routing Logic

SendMessageTool uses a cascading routing strategy to deliver messages:

```
SendMessage.call(input)
  │
  ├─ Is to: "bridge:<session-id>"?
  │   └─ Route via Remote Control bridge (postInterClaudeMessage)
  │
  ├─ Is to: "uds:<socket-path>"?
  │   └─ Route via Unix Domain Socket (sendToUdsSocket)
  │
  ├─ Is to: a registered in-process agent name or ID?
  │   ├─ Agent running? → queuePendingMessage() (in-memory)
  │   └─ Agent stopped? → resumeAgentBackground() (auto-resume)
  │
  ├─ Is to: "*"?
  │   └─ handleBroadcast() → write to each teammate's mailbox
  │
  └─ Default: handleMessage() → write to recipient's file mailbox
```

### File-Based Mailbox System

The mailbox is the backbone of swarm communication. Each teammate has an inbox file at:

```
~/.claude/teams/{team_name}/inboxes/{agent_name}.json
```

Messages are JSON arrays of `TeammateMessage` objects:

```typescript
type TeammateMessage = {
  from: string       // Sender name
  text: string       // Message content (or JSON for protocol messages)
  timestamp: string  // ISO timestamp
  read: boolean      // Whether recipient has processed this
  color?: string     // Sender's UI color
  summary?: string   // 5-10 word preview
}
```

Agents poll their mailbox at 500ms intervals. File locking (with retry and backoff) prevents corruption when multiple agents write concurrently. The lock configuration uses 10 retries with 5-100ms timeout range.

### In-Process Message Delivery

For in-process agents, messages can take a faster path. When the target agent is found in `AppState.tasks` and is currently running, `queuePendingMessage()` adds the message to an in-memory queue that the agent checks on its next tool round. This avoids the filesystem round-trip entirely.

If the target agent has stopped (completed its initial prompt), SendMessage automatically resumes it in the background with the new message as its prompt.

## Permission Synchronization

When a teammate needs to perform a tool action that requires user approval, the permission must be routed to the leader (who has the user's terminal).

### Permission Flow

```
Worker encounters 'ask' permission
  │
  ├─ [In-Process, Bridge Available]
  │   └─ Direct ToolUseConfirmQueue bridge
  │      Worker's permission dialog appears in leader's UI
  │      with a colored "worker badge" identifying the agent
  │      Leader's user approves/rejects normally
  │
  ├─ [In-Process, Bridge Unavailable]
  │   └─ Mailbox fallback (same as process-based)
  │
  └─ [Process-Based (tmux/iTerm)]
      │
      ├─ Worker creates SwarmPermissionRequest
      ├─ Written to ~/.claude/teams/{team}/permissions/pending/{id}.json
      ├─ Permission request sent to leader's mailbox
      ├─ Leader shows approval dialog to user
      ├─ Response written to worker's mailbox
      └─ Resolution written to permissions/resolved/{id}.json
```

### Bash Classifier Auto-Approval

Before escalating a permission request to the leader's UI, in-process teammates first check if the bash classifier can auto-approve the command. The classifier result is awaited (rather than raced against user interaction, as in the main agent). This reduces unnecessary permission prompts for safe commands:

```typescript
if (tool.name === BASH_TOOL_NAME && result.pendingClassifierCheck) {
  const classifierDecision = await awaitClassifierAutoApproval(
    result.pendingClassifierCheck,
    abortController.signal,
    toolUseContext.options.isNonInteractiveSession,
  )
  if (classifierDecision) {
    return { behavior: 'allow', updatedInput: input, decisionReason: classifierDecision }
  }
}
```

### The In-Process Shortcut

The in-process permission path is particularly elegant. The `getLeaderToolUseConfirmQueue()` function returns a reference to the leader's UI confirmation queue. The worker pushes its permission request directly onto this queue, complete with a `workerBadge` that shows the agent's name and color. The user sees the same tool-specific UI (BashPermissionRequest, FileEditToolDiff, etc.) as they would for the leader's own tools.

Permission updates (like "always allow" rules) are written back to both the worker's local context and the leader's shared context via `getLeaderSetToolPermissionContext()`. The leader's mode is preserved to prevent workers' transformed permission contexts from leaking back.

### SwarmPermissionRequest Structure

```typescript
type SwarmPermissionRequest = {
  id: string              // "perm-{timestamp}-{random}"
  workerId: string
  workerName: string
  workerColor?: string
  teamName: string
  toolName: string        // "Bash", "Edit", etc.
  toolUseId: string
  description: string
  input: Record<string, unknown>
  permissionSuggestions: unknown[]
  status: 'pending' | 'approved' | 'rejected'
  resolvedBy?: 'worker' | 'leader'
  resolvedAt?: number
  feedback?: string
  updatedInput?: Record<string, unknown>
  permissionUpdates?: unknown[]
  createdAt: number
}
```

Old resolved permission files are cleaned up periodically (default: 1 hour max age) to prevent file accumulation.

## Teammate Initialization and Lifecycle

### initializeTeammateHooks()

When a teammate starts up (whether as a separate process or in-process), `initializeTeammateHooks()` configures the agent for team participation:

```
initializeTeammateHooks(setAppState, sessionId, teamInfo)
  │
  ├─ Read team file from disk
  │
  ├─ Apply team-wide allowed paths
  │   For each teamAllowedPaths entry:
  │     applyPermissionUpdate(toolName, "/{path}/**", allow)
  │
  ├─ Skip idle hook if this agent is the leader
  │
  └─ Register Stop hook:
      When teammate stops:
        ├─ setMemberActive(teamName, agentName, false)
        ├─ Create idle notification with accomplishment summary
        └─ writeToMailbox(leaderName, notification)
```

The Stop hook is critical for the swarm's lifecycle management. When a teammate finishes its work, it sends an idle notification to the leader's mailbox. This notification includes a summary of what the teammate accomplished (extracted from the last peer DM summary). The leader can then decide whether to assign new work or shut down the teammate.

### Team-Wide Path Permissions

The `teamAllowedPaths` mechanism lets the leader grant filesystem permissions that apply to all teammates. When a teammate initializes, it reads these paths from the team file and applies them as session-level permission rules. For example, if the leader grants Edit access to `/project/src/`, every teammate automatically gets Edit permission for that path subtree.

### Teammate Prompt Addendum

Every teammate receives a system prompt addendum that explains the communication constraints:

```typescript
const TEAMMATE_SYSTEM_PROMPT_ADDENDUM = `
# Agent Teammate Communication

IMPORTANT: You are running as an agent in a team. To communicate with anyone:
- Use SendMessage with to: "<name>" for specific teammates
- Use SendMessage with to: "*" sparingly for broadcasts

Just writing a response in text is not visible to others - you MUST use SendMessage.

The user interacts primarily with the team lead.
`
```

> **Key Insight:** Teammates cannot talk to the user directly. All user interaction goes through the team leader. This is enforced by the prompt addendum and the fact that teammates run in separate sessions without access to the leader's terminal (except for permission dialogs).

## Coordinator Mode

Coordinator mode is a streamlined alternative to the full Swarm/Team system. It is enabled by setting `CLAUDE_CODE_COORDINATOR_MODE=1` and is gated behind the `COORDINATOR_MODE` feature flag.

### Architecture

Unlike the Swarm/Team model, Coordinator mode does not use TeamCreateTool or the team file system. Instead, it repurposes the existing AgentTool infrastructure:

```
┌────────────────────────────────────────────────┐
│                  Coordinator                    │
│                                                 │
│  Tools: AgentTool, SendMessage, TaskStop        │
│                                                 │
│  Spawns workers via AgentTool with              │
│  subagent_type: "worker"                        │
│                                                 │
│  Workers report back as:                        │
│  <task-notification>                            │
│    <task-id>{agentId}</task-id>                 │
│    <status>completed|failed|killed</status>     │
│    <summary>...</summary>                       │
│    <result>...</result>                         │
│    <usage>                                      │
│      <total_tokens>N</total_tokens>             │
│      <tool_uses>N</tool_uses>                   │
│      <duration_ms>N</duration_ms>               │
│    </usage>                                     │
│  </task-notification>                           │
└────────────────────────────────────────────────┘
```

### Coordinator System Prompt

The coordinator receives a specialized system prompt that replaces the standard Claude Code prompt. It defines a structured workflow with four phases:

| Phase | Who | Purpose |
|-------|-----|---------|
| Research | Workers (parallel) | Investigate codebase, find files, understand problem |
| Synthesis | **Coordinator** | Read findings, craft implementation specs |
| Implementation | Workers | Make targeted changes per spec, commit |
| Verification | Workers | Test changes work |

### Key Principles

The coordinator prompt encodes several strong opinions:

1. **Parallelism is the superpower.** Independent workers should be launched concurrently. Read-only research tasks run freely in parallel; write-heavy tasks are serialized per file set.

2. **The coordinator must synthesize.** The prompt explicitly forbids lazy delegation like "based on your findings, fix the bug." The coordinator must read worker findings, understand them, and write specific implementation specs with file paths, line numbers, and exact changes.

3. **Continue vs. spawn decision.** After research completes, the coordinator must decide whether to continue the existing worker (high context overlap with next task) or spawn a fresh one (low overlap, different task domain, or need for fresh eyes on verification).

4. **Self-contained prompts.** Workers cannot see the coordinator's conversation. Every prompt must include all necessary context -- file paths, error messages, line numbers, and what "done" looks like.

### Worker Tool Access

Workers do not have access to team management tools. The coordinator prompt lists the available worker tools, which are filtered to exclude `TeamCreateTool`, `TeamDeleteTool`, `SendMessageTool`, and `SyntheticOutputTool`:

```typescript
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
```

### Scratchpad Directory

When the `tengu_scratch` feature gate is enabled, the coordinator is told about a scratchpad directory where workers can read and write without permission prompts. This enables durable cross-worker knowledge sharing through the filesystem:

```
Scratchpad directory: {scratchpadDir}
Workers can read and write here without permission prompts.
Use this for durable cross-worker knowledge.
```

### Session Mode Matching

When resuming a session, `matchSessionMode()` checks whether the current coordinator mode matches the session's stored mode. If mismatched, it flips the `CLAUDE_CODE_COORDINATOR_MODE` environment variable to match the session. This prevents confusion when a session created in coordinator mode is resumed without the flag, or vice versa.

## In-Process Runner Details

The `inProcessRunner.ts` module is the heart of in-process teammate execution. It wraps `runAgent()` with full context isolation and lifecycle management.

### Execution Flow

```
startInProcessTeammate(config)
  │
  ├─ runWithTeammateContext(config.teammateContext, async () => {
  │     runWithAgentContext(agentContext, async () => {
  │
  │       ├─ Build system prompt (default + TEAMMATE_SYSTEM_PROMPT_ADDENDUM
  │       │   or custom systemPrompt with replace/append mode)
  │       │
  │       ├─ Create canUseTool function with:
  │       │   ├─ Bash classifier pre-check
  │       │   ├─ Direct ToolUseConfirmQueue bridge (preferred)
  │       │   └─ Mailbox permission fallback
  │       │
  │       ├─ runAgent(prompt, tools, canUseTool, ...)
  │       │   ├─ Agent works on task...
  │       │   ├─ Polls mailbox every 500ms for messages
  │       │   └─ On completion → check for more tasks
  │       │
  │       ├─ On idle: waitForNextPromptOrShutdown()
  │       │   ├─ Poll mailbox for new messages (500ms)
  │       │   ├─ Check in-memory pending messages
  │       │   ├─ Try to claim next task from task list
  │       │   └─ Handle shutdown requests
  │       │
  │       └─ Cleanup:
  │           ├─ Send idle notification to leader
  │           ├─ Update task state to 'completed'/'failed'
  │           └─ Unregister perfetto agent
  │     })
  │   })
  └─ Return InProcessRunnerResult
```

### Progress Tracking

The runner updates `AppState.tasks[taskId]` throughout execution. The `InProcessTeammateTaskState` includes:
- Current status (running, completed, failed)
- Progress description from the agent's tool calls
- Recent messages for transcript viewing
- Pending user messages queue for in-flight message delivery
- An `abortController` reference for external termination

### Task Claiming

In-process teammates can auto-claim tasks from the team's shared task list. When idle (after completing initial work), the runner calls `tryClaimNextTask()` which:

1. Lists all tasks in the team's task list
2. Finds a pending task with no owner and no unresolved blockers
3. Claims it atomically (preventing other teammates from taking the same task)
4. Sets the task to `in_progress` and formats it as a prompt

### Idle Polling Loop

When a teammate finishes its work but hasn't been shut down, it enters `waitForNextPromptOrShutdown()`. This function polls at 500ms intervals for:

- **In-memory messages** from `pendingUserMessages` in the task state (from transcript viewing or SendMessage)
- **Mailbox messages** including new work assignments and shutdown requests
- **Available tasks** from the team's task list
- **Abort signal** from the leader killing the teammate

The teammate stays alive in this idle state until it receives new work or a shutdown request. Shutdown requests are delivered as structured protocol messages; the teammate's model decides whether to approve or reject the shutdown.

## Key Takeaways

1. **Two architectures, different trade-offs.** The Swarm/Team model provides peer-to-peer communication, persistent team state, and agent autonomy. Coordinator mode provides centralized control, structured workflows, and the coordinator-must-synthesize principle. Choose based on whether you need collaborative agents or directed workers.

2. **Three execution backends.** tmux and iTerm2 spawn separate processes with visual panes. In-process runs in the same Node.js process with AsyncLocalStorage isolation. In-process is cheapest (shared API client, no process overhead) but all teammates share the same process resources.

3. **File-based mailbox is the universal transport.** Regardless of backend, all agents communicate through JSON inbox files in `~/.claude/teams/{team}/inboxes/`. In-process agents can shortcut this with in-memory queues, but the mailbox remains the fallback and the only option for cross-process communication.

4. **Permission synchronization is non-trivial.** Worker agents cannot prompt the user directly. Permissions flow through either the ToolUseConfirmQueue bridge (in-process, showing the same UI as the leader) or through the mailbox system (process-based, with file-based pending/resolved directories). The bash classifier provides an auto-approval fast path before escalating to the user.

5. **The coordinator must synthesize.** The coordinator mode prompt is emphatic: never delegate understanding. The coordinator reads worker findings, identifies the approach, and writes specific implementation specs. This prevents the "telephone game" failure mode where context degrades as it passes through multiple agents.

6. **Teams are ephemeral by design.** Team files are registered for session cleanup and removed when the session ends. The one-team-per-leader constraint, combined with session-scoped cleanup, ensures teams do not accumulate on disk.

7. **Teammates cannot reach the user.** All user interaction goes through the team leader. Teammates communicate exclusively via SendMessage, and their text responses are invisible to anyone outside the agent system. This constraint is enforced by both the system prompt addendum and the architectural separation of terminal access.
