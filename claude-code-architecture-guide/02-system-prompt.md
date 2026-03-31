# Chapter 2: System Prompt Structure

## Overview

The system prompt is the foundation of Claude Code's behavior. It's sent in the `system` parameter of every API call and stays **frozen** across turns to maximize prompt caching.

## The Two System Blocks

The system prompt consists of exactly **two text blocks**, both with `cache_control: { type: "ephemeral" }`:

### Block 0: Identity (62 chars)
```
You are a Claude agent, built on Anthropic's Claude Agent SDK.
```

This one-liner establishes the base identity. It's separated from the main instructions to allow independent caching.

### Block 1: Instructions (~14,000 chars)

The full instruction set. Here's the structural breakdown:

```
┌─────────────────────────────────────────┐
│ Security Policy (repeated twice)         │  ~300 chars
│ URL Generation Policy                    │  ~100 chars
├─────────────────────────────────────────┤
│ Help/Feedback Instructions               │  ~150 chars
├─────────────────────────────────────────┤
│ Documentation Fetching Behavior          │  ~200 chars
│ (WebFetch from docs.claude.com)          │
├─────────────────────────────────────────┤
│ Tone and Style                           │  ~3,000 chars
│ - Conciseness rules                      │
│ - Example conversations (6 examples)     │
│ - Markdown formatting guidance           │
│ - Emoji policy                           │
├─────────────────────────────────────────┤
│ Proactiveness Policy                     │  ~200 chars
├─────────────────────────────────────────┤
│ Professional Objectivity                 │  ~300 chars
├─────────────────────────────────────────┤
│ Following Conventions                    │  ~500 chars
│ - Library verification                   │
│ - Code style matching                    │
│ - Security best practices                │
├─────────────────────────────────────────┤
│ Code Style (no comments policy)          │  ~50 chars
├─────────────────────────────────────────┤
│ Task Management (TodoWrite emphasis)     │  ~1,500 chars
│ - Two detailed examples                  │
├─────────────────────────────────────────┤
│ Hooks Documentation                      │  ~100 chars
├─────────────────────────────────────────┤
│ Doing Tasks                              │  ~500 chars
│ - Task workflow                          │
│ - Lint/typecheck requirements            │
│ - Commit policy                          │
│ - system-reminder documentation          │
├─────────────────────────────────────────┤
│ Tool Usage Policy                        │  ~400 chars
│ - Task tool preference                   │
│ - WebFetch redirect handling             │
│ - Parallel tool call guidance            │
├─────────────────────────────────────────┤
│ Environment Information                  │  ~200 chars
│ <env>                                    │
│   Working directory                      │
│   Is git repo                            │
│   Platform                               │
│   OS version                             │
│   Date                                   │
│ </env>                                   │
├─────────────────────────────────────────┤
│ Model Identity                           │  ~100 chars
├─────────────────────────────────────────┤
│ Security Policy (repeated)               │  ~300 chars
├─────────────────────────────────────────┤
│ TodoWrite Reminder (repeated)            │  ~50 chars
├─────────────────────────────────────────┤
│ Code References                          │  ~200 chars
│ (file_path:line_number pattern)          │
└─────────────────────────────────────────┘
```

## Key Observations

### 1. The System Prompt is Minimal
At ~14,000 chars, the system prompt is surprisingly lean. Most of the behavioral instructions come through **system reminders** in the messages array (Chapter 4), not from the system prompt itself.

### 2. Caching Strategy
Both blocks use `cache_control: { type: "ephemeral" }`. This means:
- The API caches the exact text
- Subsequent turns reuse the cached version
- **The system prompt never changes between turns** — all dynamic content goes through system-reminders
- This saves significant tokens on multi-turn conversations

### 3. Repeated Security Instructions
The security policy appears **twice** in the system prompt — once at the top and once near the bottom. This is intentional: placement at both the start and end of a long instruction set helps the model attend to critical safety instructions regardless of attention distribution.

### 4. Environment Block
The `<env>` block is baked into the system prompt, NOT injected via system-reminders:
```
<env>
Working directory: /Users/mathew/claude-code-architecture-guide/captures
Is directory a git repo: No
Platform: darwin
OS Version: Darwin 24.5.0
Today's date: 2026-03-23
</env>
```

This means the system prompt **does change** between sessions (different directory, date, etc.), but stays frozen within a session.

### 5. What's NOT in the System Prompt

The following are **NOT** in the system prompt. They come through other channels:
- **Skills** — Injected via SessionStart hook → system-reminder
- **CLAUDE.md content** — Injected via system-reminder
- **Memory files** — Injected via system-reminder
- **Plugin instructions** — Injected via hook → system-reminder
- **Skill list** — Injected via system-reminder
- **MCP server instructions** — Injected via system-reminder
- **Available deferred tools** — Injected via system-reminder
- **Date (in system-reminder form)** — Also in system-reminder for in-session updates

## Comparison: Baseline vs Plugin-Enabled

### Without Superpowers Plugin (captured via claude-trace)
The system prompt in Block 1 is exactly as shown above — pure Claude Code instructions, no plugin content.

### With Superpowers Plugin (current session)
The system prompt block is **expanded** (seen in the current session context):
- Additional sections for memory management (`# auto memory`)
- Extended agent tool descriptions with custom agent types
- `Skill` tool added to tool definitions
- Additional `CronCreate`, `CronDelete`, `CronList` tools
- Reasoning effort settings
- Fast mode info
- More detailed tool usage instructions

The exact mechanism: the plugin's `SessionStart` hook outputs context that Claude Code merges into the system-reminder, and some plugin-registered tools and agents get added to the tool definitions and system prompt at session creation time.

## How to Modify the System Prompt

Claude Code's system prompt cannot be directly edited. However, you can influence it through:

1. **CLAUDE.md files** — Project-level instructions (injected via system-reminder)
2. **Plugins** — Can add tools, agents, hooks, skills, and SessionStart context
3. **Settings** — Some settings affect system prompt generation (e.g., model selection changes the identity line)
4. **Environment variables** — Some affect the `<env>` block

The system prompt is generated by Claude Code's internal TypeScript code and assembled at session start.
