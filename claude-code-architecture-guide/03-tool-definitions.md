# Chapter 3: Tool Definitions

## Overview

Tools are the primary way Claude Code interacts with the local environment. They're defined in the `tools` array of the API request as JSON Schema objects. The model receives these as part of every API call and can request any tool via `tool_use` blocks.

## Tool Categories

From our captured session (57 tools total):

### Built-in Tools (16)

These are core Claude Code tools, always available:

| # | Tool | Purpose |
|---|------|---------|
| 1 | **Task** | Launch sub-agents for complex multi-step tasks |
| 2 | **Bash** | Execute shell commands |
| 3 | **Glob** | Fast file pattern matching |
| 4 | **Grep** | Content search with ripgrep |
| 5 | **ExitPlanMode** | Transition from planning to implementation |
| 6 | **Read** | Read files from filesystem |
| 7 | **Edit** | Edit existing files (sends diff) |
| 8 | **MultiEdit** | Edit multiple locations in a file |
| 9 | **Write** | Create/overwrite files |
| 10 | **NotebookEdit** | Edit Jupyter notebook cells |
| 11 | **WebFetch** | Fetch web content |
| 12 | **TodoWrite** | Task management (create, update, complete) |
| 13 | **WebSearch** | Web search |
| 14 | **BashOutput** | Read output from background bash commands |
| 15 | **KillShell** | Kill background shell processes |
| 16 | **SlashCommand** | Execute slash commands |

### Plugin-Added Tools (only with plugins enabled)

When the Superpowers plugin is active, additional tools appear:

| Tool | Purpose |
|------|---------|
| **Skill** | Load and invoke skill content |
| **Agent** | Enhanced agent dispatch (replaces/extends Task) |
| **AskUserQuestion** | Explicitly ask the user a question |
| **CronCreate** | Create recurring tasks |
| **CronDelete** | Delete recurring tasks |
| **CronList** | List recurring tasks |
| **TaskCreate** | Create structured tasks |
| **TaskGet** | Get task details |
| **TaskList** | List all tasks |
| **TaskOutput** | Read task output |
| **TaskStop** | Stop a running task |
| **TaskUpdate** | Update task status |
| **EnterPlanMode** | Enter planning mode |
| **EnterWorktree** | Enter a git worktree |
| **ExitWorktree** | Exit a git worktree |

### MCP Server Tools (40+)

These come from configured MCP servers. Each MCP tool is prefixed with `mcp__<server-name>__`:

**Playwright (23 tools)**
```
mcp__playwright__browser_close
mcp__playwright__browser_resize
mcp__playwright__browser_console_messages
mcp__playwright__browser_handle_dialog
mcp__playwright__browser_evaluate
mcp__playwright__browser_file_upload
mcp__playwright__browser_fill_form
mcp__playwright__browser_install
mcp__playwright__browser_press_key
mcp__playwright__browser_type
mcp__playwright__browser_navigate
mcp__playwright__browser_navigate_back
mcp__playwright__browser_network_requests
mcp__playwright__browser_run_code
mcp__playwright__browser_take_screenshot
mcp__playwright__browser_snapshot
mcp__playwright__browser_click
mcp__playwright__browser_drag
mcp__playwright__browser_hover
mcp__playwright__browser_select_option
mcp__playwright__browser_tabs
mcp__playwright__browser_wait_for
```

**CircleCI (15 tools)**
```
mcp__circleci-mcp-server__get_build_failure_logs
mcp__circleci-mcp-server__find_flaky_tests
mcp__circleci-mcp-server__get_latest_pipeline_status
mcp__circleci-mcp-server__get_job_test_results
mcp__circleci-mcp-server__config_helper
mcp__circleci-mcp-server__create_prompt_template
mcp__circleci-mcp-server__recommend_prompt_template_tests
mcp__circleci-mcp-server__run_pipeline
mcp__circleci-mcp-server__list_followed_projects
mcp__circleci-mcp-server__run_evaluation_tests
mcp__circleci-mcp-server__rerun_workflow
mcp__circleci-mcp-server__download_usage_api_data
mcp__circleci-mcp-server__find_underused_resource_classes
mcp__circleci-mcp-server__analyze_diff
mcp__circleci-mcp-server__run_rollback_pipeline
mcp__circleci-mcp-server__list_component_versions
```

**MCP Resource Access (2 tools)**
```
ListMcpResourcesTool
ReadMcpResourceTool
```

## Tool Schema Format

Each tool follows this JSON structure:

```json
{
  "name": "Bash",
  "description": "Executes a given bash command and returns its output...",
  "input_schema": {
    "type": "object",
    "properties": {
      "command": {
        "description": "The command to execute",
        "type": "string"
      },
      "timeout": {
        "description": "Optional timeout in milliseconds",
        "type": "number"
      },
      "run_in_background": {
        "description": "Run command in background",
        "type": "boolean"
      },
      "description": {
        "description": "Description of what the command does",
        "type": "string"
      }
    },
    "required": ["command"]
  }
}
```

## The Task/Agent Tool — The Most Complex Tool

The `Task` tool (or `Agent` when plugins add it) is the most complex tool definition at ~4,400 characters of description. It:

1. Lists all available agent types with their descriptions
2. Specifies which tools each agent type has access to
3. Provides usage guidelines (when to use, when not to use)
4. Supports isolation modes (worktrees)
5. Supports background execution
6. Supports model override per agent

Agent types are dynamically registered. The base set includes:
- `general-purpose` — Default, has all tools
- `statusline-setup` — Configure status line (Read, Edit only)
- `Explore` — Fast codebase exploration (read-only tools)
- `Plan` — Software architecture (read-only tools)
- `claude-code-guide` — Answer questions about Claude Code

Plugins can register additional agent types. The Superpowers plugin adds:
- `superpowers:code-reviewer` — Code review against plans

## Deferred Tool Loading

For sessions with many MCP tools, Claude Code uses **deferred tool loading**. Instead of sending full tool schemas for all MCP tools, it sends a list of tool names in a `<available-deferred-tools>` system-reminder. The model sees the names and can use a special `ToolSearch` tool to fetch the full schema on demand.

This is a token optimization — sending 40+ full MCP tool schemas on every turn would consume significant context.

```xml
<available-deferred-tools>
mcp__claude_ai_Amplitude__create_cohort
mcp__claude_ai_Amplitude__create_dashboard
mcp__claude_ai_Slack__slack_send_message
...
</available-deferred-tools>
```

The `ToolSearch` tool accepts a query and returns matching tool schemas:
```json
{
  "name": "ToolSearch",
  "parameters": {
    "query": "select:Read,Edit,Grep",
    "max_results": 5
  }
}
```

## Tool Discovery: MCP Schema Validation

During session initialization, Claude Code validates each MCP tool's JSON schema by making individual API calls:

1. Model: `opus` (for validation)
2. Each call sends one tool with a dummy message `"foo"`
3. If the schema is invalid, the tool is excluded
4. Then `claude-3-5-haiku` is used to generate human-readable descriptions for each valid MCP tool

This explains the ~80 API calls we captured before the main conversation call.

## Token Impact

Tool definitions are the **single largest component** of every API request. With 57 tools, each having a description and JSON schema, the tools array can easily consume 15,000-20,000 tokens per turn. This is why deferred loading exists for large MCP server configurations.
