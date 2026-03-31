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

1. **Fresh context** — Sub-agents start with NO conversation history from the parent. They get only the prompt the parent provides.
2. **Isolated tools** — Different agent types have different tool access (e.g., Explore agents can't write files)
3. **Independent token budget** — Sub-agent has its own context window
4. **Result return** — Only the sub-agent's final text output returns to the parent

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
    "description": "Fix failing tests",          // 3-5 word summary
    "prompt": "Full task description...",          // Complete instructions
    "subagent_type": "general-purpose",           // Agent type
    "model": "sonnet",                            // Optional model override
    "run_in_background": false,                   // Background execution
    "isolation": "worktree"                       // Optional git worktree isolation
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

1. **Parent stays lean** — Complex work is delegated, not done in the main context
2. **Fresh start per task** — No context pollution between tasks
3. **Parallel work** — Multiple independent tasks run simultaneously
4. **Specialized roles** — Each agent type has focused capabilities

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
