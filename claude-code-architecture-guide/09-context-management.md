# Chapter 9: Context Management

## Overview

Context management is the art of fitting everything — system prompt, tools, conversation history, system reminders, skill content, tool results — into the model's context window. Claude Code uses several strategies to manage this.

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

## Context Compression

When the conversation approaches the context limit, Claude Code performs **automatic compression**:

> "The system will automatically compress prior messages in your conversation as it approaches context limits."

This involves:
1. Summarizing earlier conversation turns
2. Dropping tool results that are no longer relevant
3. Preserving recent context and system-critical information
4. Re-firing the SessionStart hook (the `compact` matcher)

The `SessionStart` hook matcher includes `startup|clear|compact`, meaning the bootstrap skill injection happens again after compression.

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
- **Savings**: 14 skills × 1500 avg = ~21,000 tokens saved if all were pre-loaded
- **Cost**: Extra tool call + round trip per skill invocation

### 5. Concise Response Guidelines
The system prompt aggressively encourages brevity:
- "Keep your responses short"
- "Minimize output tokens as much as possible"
- `max_tokens: 32000` caps response length

## The Conversation Lifecycle

```
Turn 1: [System] + [Tools] + [SystemReminder(full)] + [UserMsg]
  → Response + ToolUse
Turn 2: [System] + [Tools] + [ToolResult] + [SystemReminder(light)] + [UserMsg]
  → Response + ToolUse
...
Turn N: Context approaching limit
  → COMPRESSION: Summarize turns 1-N/2, keep turns N/2-N
  → SessionStart hook re-fires (compact event)
  → Continue with compressed history
```

## Token Tracking

Claude Code tracks token usage internally:
- Input tokens per request
- Output tokens per request
- Cache read/write tokens
- Running total for the session

The `stats-cache.json` file stores aggregate statistics.

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

### 2. Implement Deferred Loading
```python
# Don't send all tool schemas
tools = builtin_tools  # Always included
deferred_names = [t.name for t in mcp_tools]  # Names only

# Include ToolSearch tool for on-demand loading
tools.append(tool_search_definition)
system_reminders.append(f"<available-deferred-tools>{deferred_names}</available-deferred-tools>")
```

### 3. Use Sub-Agents for Isolation
```python
# Heavy research goes to sub-agent
if task_is_research:
    result = spawn_subagent(prompt, tools=readonly_tools)
    # Only result.summary enters parent context
```

### 4. Implement Compression
```python
if estimated_tokens > threshold:
    # Summarize old messages
    summary = compress_messages(messages[:midpoint])
    messages = [summary_message] + messages[midpoint:]
    # Re-inject critical context
    re_inject_session_start()
```

## Context Awareness

Claude Sonnet 4.6, Sonnet 4.5, and Haiku 4.5 have **context awareness** — they can track remaining context and adjust behavior:
- Summarize more aggressively when context is running low
- Avoid loading unnecessary skills when context is tight
- Prefer delegating to sub-agents when parent context is getting full
