# Claude Code Architecture Guide

A comprehensive reverse-engineered reference for how Claude Code constructs, manages, and sends context to the Claude API. Based on live traffic captures (claude-trace), local file analysis, runtime observation of Claude Code v2.1.81 (March 2026), and full source code analysis.

**Goal:** Provide enough detail that you could recreate the core architecture of Claude Code's context management, skill injection, sub-agent dispatch, permission system, multi-agent orchestration, and tool system from scratch.

---

## Table of Contents

### Part 1: Core Architecture
1. [**The Request Lifecycle**](./01-request-lifecycle.md) — How a single API call is constructed from system prompt to response
2. [**System Prompt Structure**](./02-system-prompt.md) — The two system blocks, their contents, and caching strategy
3. [**Tool Definitions**](./03-tool-definitions.md) — All 57+ tools, their categories, and how they're registered

### Part 2: Context Injection
4. [**System Reminders**](./04-system-reminders.md) — Dynamic context injected into the messages array (not the system prompt)
5. [**Skills System**](./05-skills-system.md) — How skills are stored, discovered, loaded, and injected into context
6. [**Plugins & Hooks**](./06-plugins-and-hooks.md) — The plugin architecture, hook lifecycle, and SessionStart injection

### Part 3: Agent Architecture
7. [**Sub-Agents**](./07-sub-agents.md) — How Task/Agent tool dispatches child sessions with isolated context
8. [**MCP Servers**](./08-mcp-servers.md) — Model Context Protocol integration and tool discovery

### Part 4: Advanced Patterns
9. [**Context Management**](./09-context-management.md) — Caching, four-layer compression, token budgets, and the conversation lifecycle
10. [**Putting It All Together**](./10-putting-it-all-together.md) — Architecture diagram and how to build your own system

### Part 5: Deep Dives (Source Code Analysis)
11. [**Permission System**](./11-permission-system.md) — Seven permission modes, YOLO classifier, dangerous patterns, and the full decision flow
12. [**Memory System**](./12-memory-system.md) — Auto-memory, session memory, CLAUDE.md hierarchy with @include directives
13. [**Swarm/Team Multi-Agent System**](./13-swarm-team-system.md) — Team creation, three spawning backends, mailbox communication, coordinator mode
14. [**Query Engine & Conversation Loop**](./14-query-engine.md) — The core agentic loop, pre-processing pipeline, recovery paths, streaming tool execution
15. [**Settings & Configuration**](./15-settings-configuration.md) — Five-source settings hierarchy, enterprise policy, GlobalConfig, feature flags
16. [**API Client & Caching**](./16-api-client-caching.md) — Three-tier cache segmentation, beta header latching, retry logic, token estimation

### Appendices
- [**Appendix A: Captured Raw Data**](./captures/) — Raw JSONL captures from claude-trace
- [**Appendix B: Full System Prompt Text**](./appendix-b-system-prompt-full.md) — Complete system prompt as captured
- [**Appendix C: Complete Tool List**](./appendix-c-tools.md) — All tools with their parameter schemas
- [**Appendix D: Superpowers Plugin Deep Dive**](./appendix-d-superpowers.md) — Full analysis of the skills plugin architecture

---

## Quick Reference: The Big Picture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        API REQUEST                                   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ system: [                                                    │   │
│  │   { text: "You are a Claude agent...", cache: ephemeral },   │   │
│  │   { text: "<full system prompt>",      cache: ephemeral }    │   │
│  │ ]                                                            │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ tools: [                                                     │   │
│  │   { name: "Bash", ... },    // 16 built-in tools             │   │
│  │   { name: "mcp__*", ... },  // 40+ MCP server tools          │   │
│  │   { name: "ListMcpResourcesTool" }  // MCP resource access   │   │
│  │ ]                                                            │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ messages: [                                                  │   │
│  │   { role: "user", content: [                                 │   │
│  │     { text: "<system-reminder>...</system-reminder>" },      │   │
│  │     { text: "actual user prompt" }                           │   │
│  │   ]},                                                        │   │
│  │   { role: "assistant", content: [...] },  // tool_use blocks │   │
│  │   { role: "user", content: [...] },       // tool_result     │   │
│  │   ...                                                        │   │
│  │ ]                                                            │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  model: "claude-sonnet-4-20250514"                                   │
│  max_tokens: 32000                                                   │
│  temperature: 1                                                      │
│  stream: true                                                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

*Generated by analyzing Claude Code v2.1.81 on 2026-03-23. Updated 2026-03-31 with full source code analysis.*
