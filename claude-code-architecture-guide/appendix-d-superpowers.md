# Appendix D: Superpowers Plugin Deep Dive

## Overview

Superpowers (v5.0.5) by Jesse Vincent is the most significant Claude Code plugin. It adds a complete software development workflow built on composable "skills." This appendix documents its full architecture.

## Directory Structure

```
~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.5/
├── .claude-plugin/
│   ├── plugin.json              # Plugin manifest
│   └── marketplace.json         # Marketplace metadata
├── .cursor-plugin/
│   └── plugin.json              # Cursor-specific manifest
├── .codex/
│   └── INSTALL.md               # Codex installation instructions
├── .opencode/
│   ├── plugins/superpowers.js   # OpenCode plugin adapter
│   └── INSTALL.md               # OpenCode installation instructions
├── agents/
│   └── code-reviewer.md         # Custom agent: code review
├── commands/
│   ├── brainstorm.md            # /brainstorm (deprecated → skill)
│   ├── execute-plan.md          # /execute-plan (deprecated → skill)
│   └── write-plan.md            # /write-plan (deprecated → skill)
├── hooks/
│   ├── hooks.json               # Hook registrations
│   ├── hooks-cursor.json        # Cursor-specific hooks
│   ├── run-hook.cmd             # Cross-platform polyglot runner
│   └── session-start            # SessionStart hook script
├── skills/
│   ├── brainstorming/
│   │   ├── SKILL.md
│   │   ├── visual-companion.md
│   │   └── spec-document-reviewer-prompt.md
│   ├── dispatching-parallel-agents/
│   │   └── SKILL.md
│   ├── executing-plans/
│   │   └── SKILL.md
│   ├── finishing-a-development-branch/
│   │   └── SKILL.md
│   ├── receiving-code-review/
│   │   └── SKILL.md
│   ├── requesting-code-review/
│   │   ├── SKILL.md
│   │   └── code-reviewer.md     # Reviewer prompt template
│   ├── subagent-driven-development/
│   │   ├── SKILL.md
│   │   ├── implementer-prompt.md
│   │   ├── spec-reviewer-prompt.md
│   │   └── code-quality-reviewer-prompt.md
│   ├── systematic-debugging/
│   │   ├── SKILL.md
│   │   ├── root-cause-tracing.md
│   │   ├── defense-in-depth.md
│   │   └── condition-based-waiting.md
│   ├── test-driven-development/
│   │   ├── SKILL.md
│   │   └── testing-anti-patterns.md
│   ├── using-git-worktrees/
│   │   └── SKILL.md
│   ├── using-superpowers/
│   │   ├── SKILL.md             # Bootstrap skill (auto-loaded)
│   │   └── references/
│   │       ├── codex-tools.md
│   │       └── gemini-tools.md
│   ├── verification-before-completion/
│   │   └── SKILL.md
│   └── writing-skills/
│       ├── SKILL.md
│       ├── anthropic-best-practices.md
│       ├── persuasion-principles.md
│       ├── testing-skills-with-subagents.md
│       └── examples/
│           └── CLAUDE_MD_TESTING.md
├── docs/                        # Plans and specs
├── tests/                       # Skill tests
├── CHANGELOG.md
├── GEMINI.md                    # Gemini CLI integration
├── LICENSE                      # MIT
├── package.json
├── README.md
└── RELEASE-NOTES.md
```

## The Workflow Pipeline

Superpowers implements a complete development workflow as a chain of skills:

```
1. brainstorming
   │  "What are we building? Let me understand before coding."
   │  → Asks questions one at a time
   │  → Proposes 2-3 approaches
   │  → Presents design in sections
   │  → Writes spec document
   │  → Spec review loop (subagent)
   │  → User approval gate
   │
   ▼
2. using-git-worktrees
   │  "Let me create an isolated workspace."
   │  → Finds/creates worktree directory
   │  → Creates feature branch
   │  → Installs dependencies
   │  → Verifies clean test baseline
   │
   ▼
3. writing-plans
   │  "Let me break this into bite-sized tasks."
   │  → Maps file structure
   │  → Creates task list with exact file paths
   │  → Each step is 2-5 minutes of work
   │  → TDD steps: write test → run → implement → run → commit
   │  → Plan review loop (subagent)
   │
   ▼
4. subagent-driven-development (or executing-plans)
   │  "Let me dispatch agents to implement each task."
   │  For each task:
   │  ├── Dispatch implementer subagent
   │  │   → Implements task with TDD
   │  │   → Self-reviews
   │  │   → Reports: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
   │  ├── Dispatch spec reviewer subagent
   │  │   → Verifies implementation matches spec
   │  │   → "Do Not Trust the Report" — verifies independently
   │  ├── Dispatch code quality reviewer subagent
   │  │   → Reviews code quality, architecture, patterns
   │  └── Mark task complete
   │
   ▼
5. finishing-a-development-branch
      "Implementation complete. What next?"
      → Verify tests pass
      → Present 4 options: merge / PR / keep / discard
      → Execute chosen option
      → Clean up worktree
```

## Skill Design Philosophy

### "Iron Laws"
Each discipline skill has a non-negotiable core rule:

| Skill | Iron Law |
|-------|----------|
| TDD | "No production code without a failing test first" |
| Debugging | "No fixes without root cause investigation first" |
| Verification | "No completion claims without fresh verification evidence" |
| Writing Skills | "No skill without a failing test first" |

### Rationalization Prevention
Skills include explicit "Common Rationalizations" tables that counter every known excuse:

```markdown
| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Just this once" | No exceptions. |
```

### Red Flags Lists
Skills include thought patterns that signal violation:

```markdown
## Red Flags - STOP and Follow Process
If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "I don't fully understand but this might work"
ALL of these mean: STOP. Return to Phase 1.
```

## Sub-Agent Prompt Templates

The SDD skill includes three prompt templates for its sub-agents:

### Implementer
- Gets full task text + context (never reads plan file)
- Has escalation path: DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT
- Self-reviews before reporting

### Spec Reviewer
- Opens with "CRITICAL: Do Not Trust the Report"
- Must read actual code, not trust implementer's claims
- Binary output: ✅ Spec compliant or ❌ Issues found

### Code Quality Reviewer
- Only dispatched AFTER spec review passes
- Uses the code-reviewer agent type
- Checks architecture, patterns, testing, maintainability

## Cross-Platform Support

Superpowers works across multiple coding agent platforms:

| Platform | Mechanism |
|----------|-----------|
| **Claude Code** | Plugin marketplace, hooks, Skill tool |
| **Cursor** | Plugin system, hooks-cursor.json |
| **Codex** | Manual install, INSTALL.md |
| **OpenCode** | Manual install, superpowers.js adapter |
| **Gemini CLI** | gemini-extension.json, GEMINI.md |

## The Bootstrap Mechanism

The entire system depends on one critical hook: `SessionStart`.

```
Session starts
    ↓
hooks.json registers SessionStart hook
    ↓
run-hook.cmd invokes session-start script
    ↓
session-start reads using-superpowers/SKILL.md
    ↓
Wraps in <EXTREMELY_IMPORTANT> tags
    ↓
Returns as hookSpecificOutput.additionalContext
    ↓
Claude Code injects as <system-reminder> in first user message
    ↓
Model reads skill, learns about skill system
    ↓
Model checks skill catalog for relevant skills
    ↓
Model invokes Skill tool to load specific skills
    ↓
Skills guide model behavior
```

Without this single hook, the entire skill system would be invisible to the model.
