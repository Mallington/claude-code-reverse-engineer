# Chapter 5: The Skills System

## Overview

Skills are the most sophisticated context injection mechanism in the Claude Code ecosystem. They're markdown documents that provide the model with specialized knowledge, workflows, and behavioral patterns. Skills are **not** in the system prompt — they're loaded on demand through the `Skill` tool and injected into the conversation.

## How Skills Get Into Context

The skill loading process has three layers:

```
Layer 1: Skill CATALOG (always in context)
  ↓  Listed in <system-reminder> at session start
  ↓  Model sees names + descriptions of ALL available skills
  ↓
Layer 2: BOOTSTRAP skill (always in context)
  ↓  "using-superpowers" SKILL.md content injected via SessionStart hook
  ↓  Tells model HOW to use skills and WHEN to invoke them
  ↓
Layer 3: Individual skills (loaded on demand)
  ↓  Model calls Skill tool → skill content returned as tool_result
  ↓  Full SKILL.md content enters conversation context
```

### Layer 1: The Skill Catalog

At session start, a system-reminder lists all available skills with their names and descriptions:

```xml
<system-reminder>
The following skills are available for use with the Skill tool:

- brainstorming: You MUST use this before any creative work - creating features,
  building components, adding functionality, or modifying behavior.
- test-driven-development: Use when implementing any feature or bugfix,
  before writing implementation code
- systematic-debugging: Use when encountering any bug, test failure,
  or unexpected behavior, before proposing fixes
- writing-plans: Use when you have a spec or requirements for a multi-step task,
  before touching code
- subagent-driven-development: Use when executing implementation plans
  with independent tasks in the current session
...
</system-reminder>
```

The model uses these descriptions to decide which skill to invoke. This is why skill descriptions must focus on **triggering conditions** ("Use when..."), not workflow summaries.

### Layer 2: The Bootstrap Skill

The `using-superpowers` skill is special — it's injected into the **first user message** via the SessionStart hook, meaning the model reads it before it can do anything else:

```xml
<system-reminder>
SessionStart hook additional context: <EXTREMELY_IMPORTANT>
You have superpowers.

**Below is the full content of your 'superpowers:using-superpowers' skill:**

---
name: using-superpowers
description: Use when starting any conversation...
---

<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply...
YOU ABSOLUTELY MUST invoke the skill.
</EXTREMELY-IMPORTANT>

## The Rule
**Invoke relevant or requested skills BEFORE any response or action.**
...
</EXTREMELY_IMPORTANT>
</system-reminder>
```

This bootstrap establishes:
1. That skills exist and must be used
2. How to access them (via `Skill` tool)
3. Priority rules (process skills first, then implementation skills)
4. Red flags for rationalization avoidance

### Layer 3: On-Demand Loading

When the model decides to use a skill, it calls the `Skill` tool:

```json
{
  "type": "tool_use",
  "name": "Skill",
  "input": {
    "skill_name": "superpowers:brainstorming"
  }
}
```

The tool returns the full SKILL.md content as a `tool_result`. This content then lives in the conversation context for the remainder of the session.

## Skill Injection Mechanism: The SessionStart Hook

The Superpowers plugin's `hooks/session-start` script is the key:

```bash
#!/usr/bin/env bash
# 1. Read the using-superpowers skill content
using_superpowers_content=$(cat "${PLUGIN_ROOT}/skills/using-superpowers/SKILL.md")

# 2. Wrap it in context injection JSON
session_context="<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n
**Below is the full content of your 'superpowers:using-superpowers' skill...**\n\n
${using_superpowers_escaped}\n\n
</EXTREMELY_IMPORTANT>"

# 3. Output as hookSpecificOutput for Claude Code to inject
printf '{\n  "hookSpecificOutput": {\n
  "hookEventName": "SessionStart",\n
  "additionalContext": "%s"\n  }\n}\n' "$session_context"
```

Claude Code takes the `additionalContext` from the hook output and wraps it in a `<system-reminder>` tag in the first user message.

## Skill Storage Location

Skills live on disk in specific directories:

### Plugin Skills (installed via marketplace)
```
~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/
    brainstorming/
        SKILL.md              # Main skill document
        visual-companion.md   # Supporting file
        spec-document-reviewer-prompt.md  # Subagent prompt
    test-driven-development/
        SKILL.md
        testing-anti-patterns.md
    systematic-debugging/
        SKILL.md
        root-cause-tracing.md
        defense-in-depth.md
        condition-based-waiting.md
    ...
```

### Personal Skills (user-created)
```
~/.claude/skills/
    my-custom-skill/
        SKILL.md
```

## Skill File Format

Every skill has YAML frontmatter and markdown body:

```markdown
---
name: skill-name-with-hyphens
description: Use when [triggering conditions] - third person, max 1024 chars
---

# Skill Name

## Overview
Core principle in 1-2 sentences.

## When to Use
- Specific triggers and symptoms
- When NOT to use

## The Process / Core Pattern
[The actual instructions]

## Common Mistakes
What goes wrong + fixes

## Red Flags
STOP conditions

## Integration
Related skills with REQUIRED markers
```

### Critical Design Insight: Description Field

The `description` field is **the most important part** of a skill. It's what appears in the skill catalog (Layer 1) and determines whether the model loads the skill.

**The description must ONLY contain triggering conditions, never workflow summaries.**

Why: Testing revealed that when a description summarizes the workflow, the model follows the description instead of reading the full skill. A description saying "dispatches subagent per task with code review between tasks" caused the model to do ONE review, even though the skill's body specified TWO reviews.

## The Complete Skill Catalog (Superpowers v5.0.5)

### Core Workflow Skills
| Skill | Trigger |
|-------|---------|
| `using-superpowers` | Session start (auto-loaded via hook) |
| `brainstorming` | Before any creative work |
| `writing-plans` | When you have a spec, before code |
| `executing-plans` | When executing a plan in a separate session |
| `subagent-driven-development` | When executing plans with independent tasks |
| `dispatching-parallel-agents` | 2+ independent tasks |

### Quality Skills
| Skill | Trigger |
|-------|---------|
| `test-driven-development` | Before writing implementation code |
| `systematic-debugging` | Any bug, test failure, unexpected behavior |
| `verification-before-completion` | Before claiming work is complete |

### Collaboration Skills
| Skill | Trigger |
|-------|---------|
| `requesting-code-review` | After completing tasks/features |
| `receiving-code-review` | When receiving review feedback |
| `using-git-worktrees` | Starting isolated feature work |
| `finishing-a-development-branch` | Implementation complete, all tests pass |

### Meta Skills
| Skill | Trigger |
|-------|---------|
| `writing-skills` | Creating or editing skills |

## Skill Chaining

Skills reference each other through `REQUIRED SUB-SKILL` markers:

```
brainstorming
    → writing-plans (after design approval)
        → subagent-driven-development OR executing-plans
            → test-driven-development (per task)
            → requesting-code-review (between tasks)
            → finishing-a-development-branch (after all tasks)
                → using-git-worktrees (cleanup)
```

This creates a full workflow pipeline, but each skill is loaded individually and only when needed.

## Token Impact

Each loaded skill consumes conversation context:
- **Skill catalog** (Layer 1): ~500-800 tokens (always present)
- **Bootstrap skill** (Layer 2): ~1,200 tokens (always present)
- **Individual skills** (Layer 3): 500-3,000 tokens each (on demand)

A session using brainstorming → writing-plans → subagent-driven-development might have 5,000+ tokens of skill content in context. This is why skills should be concise and why the system loads them on demand rather than all at once.
