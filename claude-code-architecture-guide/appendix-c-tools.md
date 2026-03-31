# Appendix C: Complete Tool List

## Baseline Tools (Without Plugins)

Captured from Claude Code v2.1.81 via claude-trace. 57 tools in total.

### Built-in Tools

| # | Name | Required Params | Description Summary |
|---|------|----------------|---------------------|
| 1 | **Task** | prompt | Launch sub-agents for complex tasks. Supports agent types, background execution, worktree isolation. ~4,400 char description. |
| 2 | **Bash** | command | Execute shell commands. Supports timeout, background, description field. Extensive git commit/PR guidelines in description. |
| 3 | **Glob** | pattern | Fast file pattern matching (e.g., `**/*.js`). Returns paths sorted by modification time. |
| 4 | **Grep** | pattern | ripgrep-based search. Supports regex, file type filter, glob filter, context lines, output modes (content/files/count). |
| 5 | **ExitPlanMode** | — | Transition from planning to implementation mode. |
| 6 | **Read** | file_path | Read files (text, images, PDFs, notebooks). Supports line range, page range for PDFs. |
| 7 | **Edit** | file_path, old_string, new_string | Edit files by replacing exact string matches. Preferred over Write for modifications. |
| 8 | **MultiEdit** | file_path, edits[] | Multiple edits to a single file in one call. |
| 9 | **Write** | file_path, content | Create or overwrite files. Requires prior Read for existing files. |
| 10 | **NotebookEdit** | notebook_path, cell_index | Edit Jupyter notebook cells. |
| 11 | **WebFetch** | url | Fetch web content. Handles redirects, returns formatted text. |
| 12 | **TodoWrite** | todos[] | Create/update task lists. Items have id, description, status (pending/in_progress/completed). |
| 13 | **WebSearch** | query | Web search with domain filtering. Returns search results with links. |
| 14 | **BashOutput** | pid | Read output from background bash commands. |
| 15 | **KillShell** | pid | Kill background shell processes. |
| 16 | **SlashCommand** | command | Execute slash commands within the conversation. |

### MCP Tools — Playwright (23)

| Name | Purpose |
|------|---------|
| `mcp__playwright__browser_close` | Close browser |
| `mcp__playwright__browser_resize` | Resize browser window |
| `mcp__playwright__browser_console_messages` | Get console messages |
| `mcp__playwright__browser_handle_dialog` | Handle browser dialogs |
| `mcp__playwright__browser_evaluate` | Execute JavaScript |
| `mcp__playwright__browser_file_upload` | Upload files |
| `mcp__playwright__browser_fill_form` | Fill form fields |
| `mcp__playwright__browser_install` | Install browser |
| `mcp__playwright__browser_press_key` | Press keyboard key |
| `mcp__playwright__browser_type` | Type text |
| `mcp__playwright__browser_navigate` | Navigate to URL |
| `mcp__playwright__browser_navigate_back` | Go back |
| `mcp__playwright__browser_network_requests` | Get network requests |
| `mcp__playwright__browser_run_code` | Run code in browser |
| `mcp__playwright__browser_take_screenshot` | Take screenshot |
| `mcp__playwright__browser_snapshot` | Get page accessibility snapshot |
| `mcp__playwright__browser_click` | Click element |
| `mcp__playwright__browser_drag` | Drag element |
| `mcp__playwright__browser_hover` | Hover over element |
| `mcp__playwright__browser_select_option` | Select dropdown option |
| `mcp__playwright__browser_tabs` | Manage browser tabs |
| `mcp__playwright__browser_wait_for` | Wait for condition |

### MCP Tools — CircleCI (15)

| Name | Purpose |
|------|---------|
| `mcp__circleci-mcp-server__get_build_failure_logs` | Get CI build failure logs |
| `mcp__circleci-mcp-server__find_flaky_tests` | Find flaky tests |
| `mcp__circleci-mcp-server__get_latest_pipeline_status` | Get pipeline status |
| `mcp__circleci-mcp-server__get_job_test_results` | Get test results |
| `mcp__circleci-mcp-server__config_helper` | Help with CI config |
| `mcp__circleci-mcp-server__create_prompt_template` | Create prompt template |
| `mcp__circleci-mcp-server__recommend_prompt_template_tests` | Recommend tests |
| `mcp__circleci-mcp-server__run_pipeline` | Trigger pipeline run |
| `mcp__circleci-mcp-server__list_followed_projects` | List followed projects |
| `mcp__circleci-mcp-server__run_evaluation_tests` | Run evaluation tests |
| `mcp__circleci-mcp-server__rerun_workflow` | Rerun failed workflow |
| `mcp__circleci-mcp-server__download_usage_api_data` | Download usage data |
| `mcp__circleci-mcp-server__find_underused_resource_classes` | Find underused resources |
| `mcp__circleci-mcp-server__analyze_diff` | Analyze code diff |
| `mcp__circleci-mcp-server__run_rollback_pipeline` | Run rollback |
| `mcp__circleci-mcp-server__list_component_versions` | List component versions |

### MCP Tools — LangChain (1)

| Name | Purpose |
|------|---------|
| `mcp__langchain-docs__search_docs_by_lang_chain` | Search LangChain documentation |

### MCP Meta Tools (2)

| Name | Purpose |
|------|---------|
| `ListMcpResourcesTool` | List available MCP resources |
| `ReadMcpResourceTool` | Read a specific MCP resource |

## Additional Tools (With Superpowers Plugin)

These tools appear when the Superpowers plugin is enabled:

| Name | Purpose |
|------|---------|
| **Skill** | Load skill content by name. Returns full SKILL.md content. |
| **Agent** | Enhanced agent dispatch (extends Task with more agent types) |
| **AskUserQuestion** | Explicitly ask the user a question |
| **ToolSearch** | Fetch deferred tool schemas on demand |
| **TaskCreate** | Create structured task with subject, description |
| **TaskGet** | Get task details by ID |
| **TaskList** | List all tasks with status |
| **TaskOutput** | Read task/agent output |
| **TaskStop** | Stop a running task |
| **TaskUpdate** | Update task status, add dependencies |
| **CronCreate** | Create recurring tasks |
| **CronDelete** | Delete recurring tasks |
| **CronList** | List recurring tasks |
| **EnterPlanMode** | Enter planning mode |
| **EnterWorktree** | Enter a git worktree |
| **ExitWorktree** | Exit a git worktree |

## Deferred Tools (Cloud MCP Servers)

These are listed by name only and loaded on demand via ToolSearch:

- 25+ Amplitude analytics tools (`mcp__claude_ai_Amplitude__*`)
- 30+ Atlassian Jira/Confluence tools (`mcp__claude_ai_Atlassian_JIRA_Confluence__*`)
- 12+ Slack tools (`mcp__claude_ai_Slack__*`)
