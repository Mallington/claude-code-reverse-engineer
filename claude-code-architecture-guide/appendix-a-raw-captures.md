# Appendix A: Raw Captured Data

All data captured from Claude Code v2.1.81 using `claude-trace` on 2026-03-23. The session was launched in a non-git directory with model `sonnet` and prompt: `"Say hello and list your available tools, then exit"`.

**Total API calls captured: 84 entries** in a single session startup + one-turn conversation.

---

## Session Timeline

```
Entry 0:  GET  /api/oauth/claude_cli/client_data          → 200  (Auth)
Entry 1:  GET  /api/organization/{id}/sonnet_1m_access     → 200  (Feature flags)
Entry 2:  POST /v1/messages?beta=true  [haiku, "quota"]    → 404  (Quota check)
Entry 3-41:  POST /v1/messages/count_tokens?beta=true      → 404  (MCP schema validation, 39 calls)
Entry 42-80: POST /v1/messages?beta=true [haiku, "count"]  → 404  (MCP description gen, 39 calls)
Entry 81: POST /v1/messages?beta=true  [sonnet, MAIN CALL] → 200  (The actual conversation)
Entry 82-83: Cleanup calls
```

---

## Raw Example 1: Auth Call (Entry 0)

```json
{
  "request": {
    "timestamp": "2026-03-23T17:12:16.449Z",
    "method": "GET",
    "url": "https://api.anthropic.com/api/oauth/claude_cli/client_data",
    "headers": {
      "authorization": "Bearer [REDACTED]",
      "anthropic-client-platform": "claude-code",
      "anthropic-client-version": "2.1.81",
      "user-agent": "claude-code/2.1.81"
    },
    "body": null
  },
  "response": {
    "timestamp": "2026-03-23T17:12:16.634Z",
    "status_code": 200,
    "body": {
      "client_data": { /* account info */ }
    }
  }
}
```

**Purpose:** Authenticates the CLI and retrieves account configuration.

---

## Raw Example 2: Quota Check (Entry 2)

```json
{
  "request": {
    "method": "POST",
    "url": "https://api.anthropic.com/v1/messages?beta=true",
    "body": {
      "model": "claude-3-5-haiku-20241022",
      "max_tokens": 1,
      "messages": [
        {
          "role": "user",
          "content": "quota"
        }
      ],
      "metadata": {
        "user_id": "user_5fa933...session_2c313fb9..."
      }
    }
  },
  "response": {
    "status_code": 404
  }
}
```

**Purpose:** Checks model availability/quota. Uses Haiku with `max_tokens: 1` and a dummy message `"quota"`. The 404 here indicates the model routing is happening server-side.

---

## Raw Example 3: MCP Schema Validation (Entry 3)

```json
{
  "request": {
    "method": "POST",
    "url": "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
    "body": {
      "model": "opus",
      "tools": [
        {
          "name": "mcp__playwright__browser_press_key",
          "description": "Press a key on the keyboard",
          "input_schema": {
            "type": "object",
            "properties": {
              "key": {
                "type": "string",
                "description": "Name of the key to press or a character to generate, such as `ArrowLeft` or `a`"
              }
            },
            "required": ["key"],
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "additionalProperties": false
          }
        }
      ],
      "messages": [
        {
          "role": "user",
          "content": "foo"
        }
      ]
    }
  },
  "response": {
    "status_code": 404,
    "body": {
      "type": "error",
      "error": {
        "type": "not_found_error",
        "message": "model: opus"
      }
    }
  }
}
```

**Purpose:** Validates each MCP tool's JSON schema by calling the `count_tokens` endpoint. Sends one tool at a time with a dummy `"foo"` message. The endpoint validates the schema is well-formed. Repeated for all 39 MCP tools (entries 3-41).

---

## Raw Example 4: MCP Description Generation (Entry 42)

```json
{
  "request": {
    "method": "POST",
    "url": "https://api.anthropic.com/v1/messages?beta=true",
    "body": {
      "model": "claude-3-5-haiku-20241022",
      "tools": [
        {
          "name": "mcp__playwright__browser_press_key",
          "description": "Press a key on the keyboard",
          "input_schema": { /* ... */ }
        }
      ],
      "messages": [
        {
          "role": "user",
          "content": "count"
        }
      ]
    }
  },
  "response": {
    "status_code": 404
  }
}
```

**Purpose:** Generates/validates human-readable tool descriptions. Uses Haiku for speed/cost. Repeated for all 39 MCP tools (entries 42-80).

---

## Raw Example 5: THE MAIN API CALL (Entry 81)

This is the actual conversation request. Below is the **complete, unabridged** structure:

### Request Envelope

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 32000,
  "temperature": 1,
  "stream": true,
  "metadata": {
    "user_id": "user_5fa933...session_2c313fb9..."
  }
}
```

### System Prompt (2 blocks)

```json
"system": [
  {
    "type": "text",
    "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    "cache_control": { "type": "ephemeral" }
  },
  {
    "type": "text",
    "text": "\nYou are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.\n\nIMPORTANT: Assist with defensive security tasks only. Refuse to create, modify, or improve code that may be used maliciously...\n\n# Tone and style\nYou should be concise, direct...\n\n<example>\nuser: 2 + 2\nassistant: 4\n</example>\n...\n\n# Task Management\nYou have access to the TodoWrite tools...\n\n# Doing tasks\nThe user will primarily request you perform software engineering tasks...\n\n<env>\nWorking directory: /Users/mathew/claude-code-architecture-guide/captures\nIs directory a git repo: No\nPlatform: darwin\nOS Version: Darwin 24.5.0\nToday's date: 2026-03-23\n</env>\nYou are powered by the model named Sonnet 4. The exact model ID is claude-sonnet-4-20250514.\n\nAssistant knowledge cutoff is January 2025.\n...",
    "cache_control": { "type": "ephemeral" }
  }
]
```

*Block 0: 62 characters. Block 1: 13,854 characters. See Appendix B for complete text.*

### Tools Array (57 tools)

Below are 4 representative tools shown in full. The complete set of 57 tools is in `captures/raw-request-body-complete.json`.

#### Tool: Bash (8,638 char description)

```json
{
  "name": "Bash",
  "description": "Executes a given bash command and returns its output.\n\nThe working directory persists between commands, but shell state does not...\n\nIMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed...\n\n# Instructions\n - If your command will create new directories or files, first use this tool to run `ls`...\n - Always quote file paths that contain spaces...\n - Try to maintain your current working directory...\n - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes)...\n - You can use the `run_in_background` parameter...\n\n# Committing changes with git\n\nOnly create commits when requested by the user...\n\nGit Safety Protocol:\n- NEVER update the git config\n- NEVER run destructive git commands...\n- NEVER skip hooks...\n\n1. run git status + git diff + git log in parallel...\n2. Analyze all staged changes...\n3. Add files + create commit + run git status...\n\n# Creating pull requests\nUse the gh command via the Bash tool for ALL GitHub-related tasks...\n\n# Other common operations\n- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments",
  "input_schema": {
    "type": "object",
    "properties": {
      "command": {
        "description": "The command to execute",
        "type": "string"
      },
      "timeout": {
        "description": "Optional timeout in milliseconds (max 600000)",
        "type": "number"
      },
      "description": {
        "description": "Clear, concise description of what this command does...\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls → \"List files in current directory\"...\n\nFor commands that are harder to parse at a glance..., add enough context...",
        "type": "string"
      },
      "run_in_background": {
        "description": "Set to true to run this command in the background...",
        "type": "boolean"
      }
    },
    "required": ["command"]
  }
}
```

#### Tool: Read (1,865 char description)

```json
{
  "name": "Read",
  "description": "Reads a file from the local filesystem. You can access any file directly by using this tool.\nAssume this tool is able to read all files on the machine...\n\nUsage:\n- The file_path parameter must be an absolute path, not a relative path\n- By default, it reads up to 2000 lines starting from the beginning...\n- Results are returned using cat -n format, with line numbers starting at 1\n- This tool allows Claude Code to read images (eg PNG, JPG, etc)...\n- This tool can read PDF files (.pdf). For large PDFs... provide the pages parameter...\n- This tool can read Jupyter notebooks (.ipynb files)...\n- This tool can only read files, not directories...\n- You can call multiple tools in a single response...\n- If you read a file that exists but has empty contents you will receive a system reminder warning...",
  "input_schema": {
    "type": "object",
    "properties": {
      "file_path": {
        "description": "The absolute path to the file to read",
        "type": "string"
      },
      "offset": {
        "description": "The line number to start reading from. Only provide if the file is too large to read at once",
        "type": "number"
      },
      "limit": {
        "description": "The number of lines to read. Only provide if the file is too large to read at once.",
        "type": "number"
      }
    },
    "required": ["file_path"]
  }
}
```

#### Tool: Task (4,415 char description)

```json
{
  "name": "Task",
  "description": "Launch a new agent that has its own conversation and can use tools to accomplish a task...\n\nAvailable agent types:\n- general-purpose: General purpose agent for complex, multi-step tasks... (Tools: *)\n\nWhen NOT to use the Task tool:\n- If you want to read a specific file path, use the Read tool...\n- If you are searching for a specific class definition...\n\nUsage notes:\n- Always include a short description (3-5 words) summarizing what the agent will do\n- Launch multiple agents concurrently whenever possible...\n- The result returned by the agent is not visible to the user...\n- You can optionally run agents in the background...",
  "input_schema": {
    "type": "object",
    "properties": {
      "description": {
        "description": "A short (3-5 word) description of the task",
        "type": "string"
      },
      "prompt": {
        "description": "The task for the agent to perform",
        "type": "string"
      },
      "subagent_type": {
        "description": "The type of specialized agent to use",
        "type": "string"
      }
    },
    "required": ["prompt"]
  }
}
```

#### Tool: mcp__playwright__browser_click (27 char description)

```json
{
  "name": "mcp__playwright__browser_click",
  "description": "Click an element on the page",
  "input_schema": {
    "type": "object",
    "properties": {
      "element": {
        "type": "string",
        "description": "Human-readable element description used to obtain permission to interact with the element"
      },
      "ref": {
        "type": "string",
        "description": "Exact target element reference from the page snapshot"
      },
      "doubleClick": {
        "type": "boolean",
        "description": "Whether to double-click the element. Defaults to false."
      },
      "button": {
        "type": "string",
        "description": "The mouse button to use for clicking.",
        "enum": ["left", "right", "middle"]
      },
      "modifiers": {
        "type": "array",
        "description": "Modifier keys to press during the click.",
        "items": {
          "type": "string",
          "enum": ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"]
        }
      }
    },
    "required": ["element", "ref"]
  }
}
```

### Messages Array (1 message, 2 content blocks)

```json
"messages": [
  {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# important-instruction-reminders\nDo what has been asked; nothing more, nothing less.\nNEVER create files unless they're absolutely necessary for achieving your goal.\nALWAYS prefer editing an existing file to creating a new one.\nNEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n\n      \n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>"
      },
      {
        "type": "text",
        "text": "Say hello and list your available tools, then exit"
      }
    ]
  }
]
```

**Key observations:**
- The user message is split into 2 content blocks
- Block 1 is a `<system-reminder>` with instruction reminders — injected automatically, not typed by user
- Block 2 is the actual user prompt
- This is the **simplest possible case** — no skills, no CLAUDE.md, no hooks (because the session was run from a non-git, non-plugin directory)

---

## Raw Example 6: What a Plugin-Enabled Session Looks Like

This is reconstructed from the **current active session** (not the claude-trace capture). In a plugin-enabled session, the first user message is much heavier:

```json
"messages": [
  {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-03-23.\n\n      IMPORTANT: this context may or may not be relevant...\n</system-reminder>"
      },
      {
        "type": "text",
        "text": "<system-reminder>\nSessionStart hook additional context: <EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n**Below is the full content of your 'superpowers:using-superpowers' skill:**\n\n---\nname: using-superpowers\ndescription: Use when starting any conversation...\n---\n\n<EXTREMELY-IMPORTANT>\nIf you think there is even a 1% chance a skill might apply...\nYOU ABSOLUTELY MUST invoke the skill.\n</EXTREMELY-IMPORTANT>\n\n## The Rule\n**Invoke relevant or requested skills BEFORE any response...**\n\n## Red Flags\n| Thought | Reality |\n| \"This is just a simple question\" | Questions are tasks. Check for skills. |\n...\n</EXTREMELY_IMPORTANT>\n</system-reminder>"
      },
      {
        "type": "text",
        "text": "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- brainstorming: You MUST use this before any creative work...\n- test-driven-development: Use when implementing any feature...\n- systematic-debugging: Use when encountering any bug...\n- writing-plans: Use when you have a spec...\n- subagent-driven-development: Use when executing implementation plans...\n- executing-plans: Use when you have a written implementation plan...\n- dispatching-parallel-agents: Use when facing 2+ independent tasks...\n- verification-before-completion: Use when about to claim work is complete...\n- requesting-code-review: Use when completing tasks...\n- receiving-code-review: Use when receiving code review feedback...\n- using-git-worktrees: Use when starting feature work...\n- finishing-a-development-branch: Use when implementation is complete...\n- using-superpowers: Use when starting any conversation...\n- writing-plans: Use when you have a spec...\n- writing-skills: Use when creating new skills...\n</system-reminder>"
      },
      {
        "type": "text",
        "text": "<available-deferred-tools>\nmcp__claude_ai_Amplitude__create_cohort\nmcp__claude_ai_Amplitude__create_dashboard\nmcp__claude_ai_Slack__slack_send_message\nmcp__claude_ai_Atlassian_JIRA_Confluence__getJiraIssue\n...(100+ tool names)...\n</available-deferred-tools>"
      },
      {
        "type": "text",
        "text": "the actual user prompt goes here"
      }
    ]
  }
]
```

**Key differences from baseline:**
- **5+ content blocks** in the first user message (vs 2 in baseline)
- **SessionStart hook output** — Full using-superpowers skill injected via `<EXTREMELY_IMPORTANT>` tags
- **Skills catalog** — All available skills listed with descriptions
- **Deferred tools list** — 100+ MCP tool names in `<available-deferred-tools>`
- **Date context** — Separate system-reminder with current date
- **Additional tools** — Skill, Agent, TaskCreate, ToolSearch, etc. added to tools array

---

## File Index

All raw data files are in `captures/`:

| File | Contents |
|------|----------|
| `raw-request-body-complete.json` | Complete unmodified JSON request body from Entry 81 (154,932 chars) |
| `raw-main-request-annotated.json` | Same data with annotations and tool summaries |
| `raw-main-response.json` | The SSE streaming response |
| `raw-response-body-complete.json` | Complete response body |
| `system-block-0.txt` | System prompt block 0 (62 chars) |
| `system-block-1.txt` | System prompt block 1 (13,854 chars) |
| `tools-list.json` | All 57 tool definitions with full schemas |
| `representative-tools-full.json` | 10 representative tools with complete schemas |
| `message-0-user.json` | The user message with system-reminders |
| `all-entries-summary.json` | Summary of all 84 API calls |
| `full-request-body.json` | Alternative copy of complete request |
| `.claude-trace/baseline-capture.jsonl` | Raw JSONL from claude-trace (all 84 entries) |
| `.claude-trace/baseline-capture.html` | HTML visualization from claude-trace |
