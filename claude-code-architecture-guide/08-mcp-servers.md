# Chapter 8: MCP Servers (Model Context Protocol)

## Overview

MCP (Model Context Protocol) is an open standard for connecting AI models to external tools and data sources. Claude Code uses MCP to integrate with services like Playwright, CircleCI, Slack, Jira, Amplitude, and more.

## How MCP Tools Enter the System

### Discovery Phase (Session Initialization)

During session startup, Claude Code:

1. **Connects to configured MCP servers** — Each server exposes a list of available tools
2. **Validates tool schemas** — Makes individual API calls (model: `opus`) to validate each tool's JSON schema
3. **Generates descriptions** — Uses `claude-3-5-haiku` to create human-readable descriptions for each tool
4. **Registers tools** — Valid tools are added to the `tools` array of subsequent API calls

From our capture, this initialization produced **80+ API calls** before the first real conversation.

### Validation Calls
```json
// Entry 3-41: Schema validation (one per MCP tool)
{
  "model": "opus",
  "tools": [{ "name": "mcp__playwright__browser_press_key", "input_schema": {...} }],
  "messages": [{ "role": "user", "content": "foo" }]
}
// If the schema is malformed, the API returns an error and the tool is excluded
```

### Description Generation
```json
// Entry 42-80: Description generation (one per MCP tool)
{
  "model": "claude-3-5-haiku-20241022",
  "tools": [{ "name": "mcp__playwright__browser_press_key", "input_schema": {...} }],
  "messages": [{ "role": "user", "content": "foo" }]
}
```

## Deferred Loading

When many MCP tools are configured, Claude Code uses **deferred loading** to save tokens:

1. Tool names are listed in an `<available-deferred-tools>` block in a system-reminder
2. Full schemas are NOT sent in the `tools` array
3. A `ToolSearch` tool is provided that fetches schemas on demand

```xml
<available-deferred-tools>
mcp__claude_ai_Amplitude__create_cohort
mcp__claude_ai_Amplitude__create_dashboard
mcp__claude_ai_Atlassian_JIRA_Confluence__addCommentToJiraIssue
mcp__claude_ai_Slack__slack_send_message
...
</available-deferred-tools>
```

When the model needs a deferred tool:
```json
{
  "name": "ToolSearch",
  "input": {
    "query": "select:mcp__claude_ai_Slack__slack_send_message",
    "max_results": 1
  }
}
```

The tool result contains the full schema, and the tool becomes callable.

## MCP Server Instructions

Each MCP server can provide usage instructions that are injected as system-reminders:

```xml
<system-reminder>
# MCP Server Instructions

## claude.ai Amplitude
Amplitude is a product analytics platform. Most tools require a projectId (appId).
At the start of a session, call 'get_context' to see the user's organization...
Event and property names are project-specific — use 'get_events' to discover valid names...

## claude.ai Slack
...
</system-reminder>
```

## MCP Tool Naming Convention

All MCP tools follow the pattern:
```
mcp__<server-name>__<tool-name>
```

Examples:
- `mcp__playwright__browser_click`
- `mcp__circleci-mcp-server__get_build_failure_logs`
- `mcp__claude_ai_Slack__slack_send_message`
- `mcp__claude_ai_Atlassian_JIRA_Confluence__getJiraIssue`

The double-underscore separator allows parsing server name from tool name.

## Configured MCP Servers (This System)

### Locally Running Servers
| Server | Tools | Purpose |
|--------|-------|---------|
| playwright | 23 | Browser automation and testing |
| circleci-mcp-server | 15 | CI/CD pipeline management |
| langchain-docs | 1 | LangChain documentation search |

### Cloud-Hosted Servers (via claude.ai)
| Server | Tools | Purpose |
|--------|-------|---------|
| claude_ai_Amplitude | 25+ | Product analytics |
| claude_ai_Slack | 12+ | Slack messaging |
| claude_ai_Atlassian_JIRA_Confluence | 30+ | Jira/Confluence integration |

## MCP Server Configuration

MCP servers are configured in gateway scripts:

```bash
# ~/.claude/mcp-gateway-playwright.sh
#!/bin/bash
npx @anthropic-ai/mcp-playwright
```

```bash
# ~/.claude/mcp-gateway-circleci.sh
#!/bin/bash
CIRCLECI_TOKEN=... npx @circleci/mcp-server
```

## Resource Access

Beyond tools, MCP servers can expose **resources** — structured data the model can read:

```json
{
  "name": "ListMcpResourcesTool",
  "description": "List available MCP resources"
}
{
  "name": "ReadMcpResourceTool",
  "description": "Read a specific MCP resource"
}
```

## Building Your Own MCP Integration

To add MCP tools to a Claude Code-like system:

1. **Server Discovery** — Connect to MCP servers, enumerate available tools
2. **Schema Validation** — Validate each tool's JSON schema
3. **Description Generation** — Generate human-readable descriptions
4. **Deferred Loading** — For large tool sets, list names but load schemas on demand
5. **Tool Execution** — When the model calls an MCP tool, proxy the call to the MCP server
6. **Server Instructions** — Include per-server usage guidance in system reminders

The key insight: MCP tools are **just API tools** with an extra proxy layer. From the model's perspective, they're identical to built-in tools.
