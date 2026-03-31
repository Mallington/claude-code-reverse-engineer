# Chapter 6: Plugins & Hooks

## Overview

Plugins are the extension mechanism for Claude Code. They can add tools, agents, skills, hooks, and slash commands. The hook system is the primary way plugins inject behavior into the Claude Code lifecycle.

## Plugin Architecture

### Plugin Location
```
~/.claude/plugins/
    blocklist.json                    # Blocked plugins
    cache/
        <marketplace>/<plugin>/<version>/
            .claude-plugin/
                plugin.json           # Plugin manifest
                marketplace.json      # Marketplace metadata
            skills/                   # Skill files
            agents/                   # Agent definitions
            commands/                 # Slash commands
            hooks/                    # Hook scripts
                hooks.json            # Hook registrations
                run-hook.cmd          # Cross-platform hook runner
                session-start         # SessionStart hook script
            package.json              # NPM-style package info
```

### Plugin Manifest (plugin.json)
```json
{
  "name": "superpowers",
  "description": "Core skills library for Claude Code",
  "version": "5.0.5",
  "author": {
    "name": "Jesse Vincent",
    "email": "jesse@fsck.com"
  },
  "homepage": "https://github.com/obra/superpowers",
  "license": "MIT",
  "keywords": ["skills", "tdd", "debugging", "collaboration"]
}
```

### Enabling Plugins
Plugins are enabled in `~/.claude/settings.json`:
```json
{
  "enabledPlugins": {
    "superpowers@claude-plugins-official": true
  }
}
```

## The Hook System

Hooks are shell commands that execute at specific lifecycle events. They're Claude Code's answer to callbacks/events.

### Hook Registration (hooks.json)
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
            "async": false
          }
        ]
      }
    ]
  }
}
```

### Available Hook Events
- **SessionStart** — Fires when a new session begins, or after `clear`/`compact`
- **PreToolUse** — Fires before a tool executes
- **PostToolUse** — Fires after a tool executes
- **UserPromptSubmit** — Fires when user submits a prompt

### Hook Output Format

Hooks communicate back to Claude Code via JSON on stdout:

**For Claude Code (native):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<EXTREMELY_IMPORTANT>...context...</EXTREMELY_IMPORTANT>"
  }
}
```

**For Cursor (alternative):**
```json
{
  "additional_context": "...context..."
}
```

The `additionalContext` string is injected as a `<system-reminder>` in the next user message.

## The SessionStart Hook Deep Dive

The Superpowers plugin's `session-start` script is the most important hook. Here's what it does:

### Step 1: Check for Legacy Skills
```bash
legacy_skills_dir="${HOME}/.config/superpowers/skills"
if [ -d "$legacy_skills_dir" ]; then
    warning_message="⚠️ WARNING: Move custom skills to ~/.claude/skills"
fi
```

### Step 2: Read Bootstrap Skill
```bash
using_superpowers_content=$(cat "${PLUGIN_ROOT}/skills/using-superpowers/SKILL.md")
```

### Step 3: Escape for JSON
```bash
escape_for_json() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}
```

### Step 4: Construct Context
```bash
session_context="<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n
**Below is the full content of your 'superpowers:using-superpowers' skill:**\n\n
${using_superpowers_escaped}\n\n
</EXTREMELY_IMPORTANT>"
```

### Step 5: Output Platform-Appropriate JSON
```bash
if [ -n "${CURSOR_PLUGIN_ROOT:-}" ]; then
    # Cursor format
    printf '{"additional_context": "%s"}\n' "$session_context"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    # Claude Code format
    printf '{"hookSpecificOutput": {"hookEventName": "SessionStart",
      "additionalContext": "%s"}}\n' "$session_context"
fi
```

### Cross-Platform Support

The `run-hook.cmd` is a polyglot script that works on both Windows (cmd.exe) and Unix (bash):

```bash
: << 'CMDBLOCK'
@echo off
REM Windows: finds bash and runs the named script
...
CMDBLOCK

# Unix: runs script directly
exec bash "${SCRIPT_DIR}/${SCRIPT_NAME}" "$@"
```

## Plugin-Registered Components

### Agents
Plugins can register custom agent types in the `agents/` directory:

```markdown
<!-- agents/code-reviewer.md -->
---
name: code-reviewer
description: |
  Use this agent when a major project step has been completed...
model: inherit
---

You are a Senior Code Reviewer with expertise in...
```

These agents appear in the `Agent` tool's available agent types.

### Slash Commands
Plugins can register slash commands in `commands/`:

```markdown
<!-- commands/brainstorm.md -->
---
description: "Deprecated - use the superpowers:brainstorming skill instead"
---

Tell your human partner that this command is deprecated...
```

### Skills
See Chapter 5 for full skill system documentation.

## Settings Architecture

### Global Settings (~/.claude/settings.json)
```json
{
  "enabledPlugins": { "superpowers@claude-plugins-official": true },
  "voiceEnabled": true,
  "skipDangerousModePermissionPrompt": true,
  "model": "opus[1m]"
}
```

### Local Settings (~/.claude/settings.local.json)
```json
{
  "permissions": {
    "allow": [
      "mcp__claude_ai_Atlassian_JIRA_Confluence__getAccessibleAtlassianResources",
      "mcp__playwright__browser_snapshot"
    ]
  }
}
```

### Permission Model
Tools require permission to execute. Settings can pre-allow specific tools. The user is prompted for approval when a tool not in the allow list is invoked.

## Building Your Own Plugin

To create a plugin that integrates with Claude Code:

1. Create the directory structure with `plugin.json`, `hooks/`, `skills/`, `agents/`
2. Register hooks in `hooks.json` to inject context at lifecycle events
3. Create skills as SKILL.md files with proper frontmatter
4. Register agents as markdown files with frontmatter specifying model and description
5. Install via marketplace or manual plugin installation

The minimal plugin needs:
- `plugin.json` with name, version, description
- `hooks/hooks.json` with at least a SessionStart hook
- A hook script that outputs context injection JSON
