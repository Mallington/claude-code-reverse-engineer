# Chapter 4: System Reminders — Dynamic Context Injection

## Overview

System reminders are Claude Code's mechanism for injecting **dynamic, per-turn context** without modifying the cached system prompt. They're XML-tagged blocks embedded in the `messages` array, typically as the first content block of a user message.

## Why System Reminders Exist

The system prompt is frozen and cached via `cache_control: ephemeral`. Modifying it would:
1. Break the cache, requiring re-processing of the entire system prompt every turn
2. Increase latency and token costs

Instead, changing context is sent as `<system-reminder>` tags in user messages. The model is instructed to treat these as system-level context:

> "Tool results and user messages may include `<system-reminder>` tags. `<system-reminder>` tags contain useful information and reminders. They are automatically added by the system, and bear no direct relation to the specific tool results or user messages in which they appear."

## Where System Reminders Appear

System reminders appear as the **first text block** in a user message, before the actual user content:

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "<system-reminder>\n...context...\n</system-reminder>"
    },
    {
      "type": "text",
      "text": "actual user message here"
    }
  ]
}
```

## Types of System Reminders

### 1. Instruction Reminders
General behavioral guidelines that supplement the system prompt:
```xml
<system-reminder>
As you answer the user's questions, you can use the following context:
# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary...
</system-reminder>
```

### 2. Plugin/Hook Context (SessionStart)
Injected by plugin hooks on session start:
```xml
<system-reminder>
SessionStart hook additional context: <EXTREMELY_IMPORTANT>
You have superpowers.
**Below is the full content of your 'superpowers:using-superpowers' skill...**
</EXTREMELY_IMPORTANT>
</system-reminder>
```

### 3. Skill Catalog
Lists all available skills for the model to choose from:
```xml
<system-reminder>
The following skills are available for use with the Skill tool:
- brainstorming: You MUST use this before any creative work...
- test-driven-development: Use when implementing any feature...
- systematic-debugging: Use when encountering any bug...
</system-reminder>
```

### 4. Available Deferred Tools
Lists MCP tool names available for on-demand loading:
```xml
<available-deferred-tools>
mcp__claude_ai_Amplitude__create_cohort
mcp__claude_ai_Slack__slack_send_message
...
</available-deferred-tools>
```

### 5. Date/Time Context
```xml
<system-reminder>
# currentDate
Today's date is 2026-03-23.
</system-reminder>
```

### 6. MCP Server Instructions
Per-server usage guidance:
```xml
<system-reminder>
# MCP Server Instructions
## claude.ai Amplitude
Amplitude is a product analytics platform...
</system-reminder>
```

### 7. CLAUDE.md Content
Project-level instructions from CLAUDE.md files:
```xml
<system-reminder>
# CLAUDE.md
<content of the project's CLAUDE.md file>
</system-reminder>
```

### 8. Memory System
When auto-memory is enabled:
```xml
<system-reminder>
# Memory
<content of MEMORY.md index>
</system-reminder>
```

### 9. Task Status Reminders
Periodic nudges about task tracking:
```xml
<system-reminder>
The task tools haven't been used recently. If you're working on tasks
that would benefit from tracking progress, consider using TaskCreate...

Here are the existing tasks:
#1. [in_progress] Install claude-trace...
#2. [completed] Explore local skills...
</system-reminder>
```

## Injection Points

System reminders can be injected at multiple points in the conversation:

```
Turn 1: [system-reminder: SessionStart hook + skills + deferred tools + instructions]
         [user message]

Turn 2: [system-reminder: task status + date update]
         [user message]

Turn N: [system-reminder: periodic reminders]
         [user message]
```

### First Turn (Heaviest)
The first user message carries the most system-reminder content:
- SessionStart hook output (superpowers skill content)
- Skill catalog
- Deferred tool list
- MCP server instructions
- CLAUDE.md content
- Memory index
- Date context
- Instruction reminders

### Subsequent Turns
Later turns may include:
- Task status reminders (periodic)
- Date updates
- New context from tool results

## How the Model Processes Them

System reminders are treated as **high-priority context** by the model because:

1. They're documented in the system prompt as system-level information
2. They use XML tags that signal authoritative content
3. They contain `<EXTREMELY_IMPORTANT>` wrapper tags (from plugins)
4. They're positioned before the user's actual message

However, they're technically in the `messages` array, not the `system` parameter. This means:
- They count against the conversation token budget
- They're not cached separately
- They can be compressed/dropped during context management
- They grow with each turn

## Building Your Own System Reminder System

To recreate this pattern:

```python
def build_user_message(user_text, system_reminders):
    content = []

    # System reminders go first
    for reminder in system_reminders:
        content.append({
            "type": "text",
            "text": f"<system-reminder>\n{reminder}\n</system-reminder>"
        })

    # User message goes last
    content.append({
        "type": "text",
        "text": user_text
    })

    return {"role": "user", "content": content}
```

Key design principle: **Freeze the system prompt, inject dynamics through messages.**
