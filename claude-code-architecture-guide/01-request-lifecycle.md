# Chapter 1: The Request Lifecycle

## Overview

Every time you type a message into Claude Code, it constructs a complete API request to the Anthropic Messages API. This chapter traces that request from keystroke to response.

## The Sequence

```
User types message
       │
       ▼
┌─────────────────────┐
│ 1. Pre-processing    │ ← Hooks fire (SessionStart on first message)
│    - Run hooks       │   Plugin hooks inject additional context
│    - Gather context  │   System reminders assembled
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 2. Request Assembly  │ ← The core construction step
│    - System prompt   │   Two blocks with ephemeral caching
│    - Tool definitions│   Built-in + MCP tools
│    - Messages array  │   Full conversation + system-reminders
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 3. API Call          │ ← POST /v1/messages?beta=true
│    - Streaming SSE   │   Response streams back in real-time
│    - Tool use blocks │   Model may request tool calls
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 4. Tool Execution    │ ← If model requested tool_use
│    - Execute tool    │   Bash, Read, Write, etc.
│    - Collect result  │   stdout, file content, etc.
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 5. Continue Loop     │ ← Append tool_result, call API again
│    - Append messages │   Full conversation grows
│    - New API call    │   Until model produces text-only response
└─────────────────────┘
```

## Phase 1: Pre-Processing

### Hook Execution
Before the first user message is processed, Claude Code fires the `SessionStart` hook. Plugins register hook handlers in their `hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|clear|compact",
      "hooks": [{
        "type": "command",
        "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
        "async": false
      }]
    }]
  }
}
```

The hook script outputs JSON with `hookSpecificOutput.additionalContext`, which gets injected as a `<system-reminder>` in the first user message. This is how the Superpowers plugin injects its "using-superpowers" skill content on every session start.

### Context Gathering
Claude Code collects:
- Current working directory and git status
- Platform/OS information
- Date
- CLAUDE.md contents (if present)
- Memory files (if configured)
- Plugin-injected context

## Phase 2: Request Assembly

The complete API request has this structure:

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 32000,
  "temperature": 1,
  "stream": true,
  "system": [
    {
      "type": "text",
      "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      "cache_control": { "type": "ephemeral" }
    },
    {
      "type": "text",
      "text": "<~14,000 chars of detailed system instructions>",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "tools": [ /* 57+ tool definitions */ ],
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "<system-reminder>...</system-reminder>" },
        { "type": "text", "text": "actual user message" }
      ]
    }
  ],
  "metadata": { /* session tracking */ }
}
```

### Key Design Decisions

1. **System prompt is split into two blocks** — The first is a one-liner identity ("You are a Claude agent..."), the second is the full instruction set. Both have `cache_control: ephemeral` to enable prompt caching across turns.

2. **Dynamic context goes in messages, not system** — The system prompt stays frozen to maximize cache hits. Changing context (dates, CLAUDE.md, plugin output, skill content) is injected as `<system-reminder>` tags inside user messages.

3. **Tools are defined at the API level** — Not in the system prompt text. The API's `tools` parameter carries full JSON schemas for every available tool.

## Phase 3: API Call

Claude Code uses streaming:
```
POST https://api.anthropic.com/v1/messages?beta=true
Content-Type: application/json
```

The `?beta=true` query parameter enables beta features (extended context, tool use improvements).

Responses stream as Server-Sent Events (SSE). The model may return:
- **text blocks** — Direct output shown to user
- **tool_use blocks** — Requests to execute tools

## Phase 4: Tool Execution

When the model returns a `tool_use` block:

```json
{
  "type": "tool_use",
  "id": "toolu_abc123",
  "name": "Bash",
  "input": { "command": "ls -la" }
}
```

Claude Code:
1. Checks permission (allowed list, user approval if needed)
2. Executes the tool locally
3. Captures the result
4. Creates a `tool_result` message

## Phase 5: The Loop

The tool result is appended as a new user message:

```json
{
  "role": "user",
  "content": [{
    "type": "tool_result",
    "tool_use_id": "toolu_abc123",
    "content": "total 16\ndrwxr-xr-x  5 user  staff  160 Mar 23 ..."
  }]
}
```

Then the entire conversation (system + all messages so far) is sent back to the API. This loop continues until the model produces a response with only text blocks (no tool_use), indicating it's done and waiting for the next user input.

## Token Budget

From captured data:
- **System prompt**: ~14,000 chars across 2 blocks
- **Tool definitions**: ~57 tools, each with full JSON schema (the largest single component)
- **Max response tokens**: 32,000
- **Available context**: Depends on model (200K for Sonnet, 1M for Opus)

## Initialization Calls

Before the main conversation begins, Claude Code makes several setup API calls:

1. **Auth/quota check** — `GET /api/oauth/claude_cli/client_data`
2. **Feature flag check** — `GET /api/organization/{id}/claude_code_sonnet_1m_access`
3. **MCP tool schema validation** — ~40 individual calls using model `opus` with dummy messages to validate each MCP tool's JSON schema
4. **MCP tool description generation** — ~40 calls using `claude-3-5-haiku` to generate user-facing descriptions for MCP tools

Only after all initialization is complete does the main conversation call (entry 81 in our capture) fire.
