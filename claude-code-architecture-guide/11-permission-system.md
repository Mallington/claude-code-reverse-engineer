# Chapter 11: Permission System

The permission system is Claude Code's security gatekeeper. It sits between tool invocation and tool execution, evaluating every action the model attempts against a layered set of rules, modes, and classifiers. The system determines one of three outcomes for each tool use: **allow** (proceed silently), **deny** (block with a message), or **ask** (prompt the user for approval). There is also an internal fourth state, **passthrough**, which signals that a tool's own permission check had no opinion and defers to higher-level logic.

## Permission Architecture Overview

When the model emits a `tool_use` block, the main loop calls `hasPermissionsToUseTool()` before executing the tool. This function orchestrates a multi-phase pipeline that checks deny rules, ask rules, tool-specific safety checks, mode-based allows, and (in auto mode) an AI classifier.

```
Model emits tool_use
        │
        ▼
┌──────────────────────────────┐
│  hasPermissionsToUseTool()   │  ← outer wrapper
│  (post-processing: dontAsk,  │
│   auto mode, headless deny)  │
│                              │
│  ┌────────────────────────┐  │
│  │ hasPermissionsToUse    │  │  ← inner pipeline
│  │ ToolInner()            │  │
│  │                        │  │
│  │ Phase 1: Deny/Ask      │  │  Steps 1a–1g
│  │ Phase 2: Mode Allow    │  │  Steps 2a–2b
│  │ Phase 3: Passthrough   │  │  Step 3
│  └────────────────────────┘  │
└──────────────────────────────┘
        │
        ▼
   allow / deny / ask
```

The key design principle is **defense in depth**: deny rules and safety checks are evaluated first and cannot be overridden by permissive modes. The `bypassPermissions` mode skips the user prompt but still respects explicit deny rules and sensitive-path safety checks.

## The Seven Permission Modes

Permission modes are defined in `src/types/permissions.ts` and control the overall stance of the permission system. Five are user-facing ("external"), and two are internal:

```typescript
// User-facing modes
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

// Internal modes (added at runtime)
export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
```

### default

Normal interactive mode. The user is prompted for approval on any tool use that does not have an explicit allow rule. This is what most users experience.

### acceptEdits

Auto-allows file edits (Write, Edit, NotebookEdit) when the target path is within the working directory. Bash commands and other tools still require approval unless covered by allow rules. This mode is the basis for the auto-mode "fast path" -- if an action would be allowed under `acceptEdits`, the classifier is skipped entirely.

### bypassPermissions

Allows all tool uses **except** those blocked by:
- Explicit deny rules (step 1a, 1d)
- Explicit ask rules on specific content (step 1f)
- Bypass-immune safety checks for sensitive paths (step 1g)

This is the `--dangerously-skip-permissions` flag. It does not skip `.git/`, `.claude/`, `.vscode/`, or shell config protections.

### dontAsk

Never prompts the user. Any tool use that would normally produce an `ask` result is converted to `deny` in the outer wrapper. Used in non-interactive/CI contexts where there is no human to approve.

### plan

Planning mode. The behavior depends on the mode the user was in before entering plan mode. If the user was in `bypassPermissions` mode (`isBypassPermissionsModeAvailable` is true), plan mode also bypasses permissions. Otherwise it behaves like `default`.

### auto (internal, feature-gated)

Uses an AI classifier to decide whether to allow or block tool uses. Only available when the `TRANSCRIPT_CLASSIFIER` build feature is enabled. The classifier examines the full conversation transcript and the pending action, then makes a security decision. See the YOLO Classifier section below.

### bubble (internal)

An internal propagation mode used when permission decisions need to bubble up through nested contexts. Not directly settable by users.

> **Key Insight:** The `auto` mode is conditionally compiled. At build time, `feature('TRANSCRIPT_CLASSIFIER')` gates the import of the classifier module. In builds where the feature is disabled, the `auto` mode string never appears in `INTERNAL_PERMISSION_MODES`, making it unselectable even if you try to set it manually.

## Permission Rules

Permission rules are the fundamental unit of configuration. Each rule is a triple of source, behavior, and value:

```typescript
type PermissionRule = {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior  // 'allow' | 'deny' | 'ask'
  ruleValue: PermissionRuleValue
}

type PermissionRuleValue = {
  toolName: string
  ruleContent?: string  // optional: restricts rule to specific content
}
```

### Rule Sources

Rules can originate from eight sources, listed in `PERMISSION_RULE_SOURCES`:

| Source | Description |
|--------|------------|
| `userSettings` | `~/.claude/settings.json` -- global per-user |
| `projectSettings` | `.claude/settings.json` -- per-project, checked into repo |
| `localSettings` | `.claude/settings.local.json` -- per-project, gitignored |
| `flagSettings` | Feature flags / remote configuration |
| `policySettings` | Organization-level policy (read-only) |
| `cliArg` | Command-line `--allowedTools` / `--disallowedTools` flags |
| `command` | Custom commands (slash commands) that declare tool permissions |
| `session` | Per-session rules accumulated from user responses to permission prompts |

Rules from all sources are merged at runtime. The `ToolPermissionContext` carries three maps -- `alwaysAllowRules`, `alwaysDenyRules`, and `alwaysAskRules` -- each keyed by source.

### Rule Value Format

Rule values use the format `"ToolName"` or `"ToolName(content)"`. The content portion specifies a constraint on the tool's input (for Bash, this is the command; for file tools, the path pattern).

```
Bash                     → deny/allow/ask ALL Bash usage
Bash(npm install)        → match only "npm install" exactly
Bash(npm:*)              → legacy prefix syntax: any command starting with "npm"
Bash(git *)              → wildcard: "git add", "git commit", bare "git"
Edit(.claude/skills/**)  → gitignore-style glob for file paths
```

### Rule Parsing

`src/utils/permissions/permissionRuleParser.ts` handles serialization and deserialization. Parentheses in content are escaped with backslashes:

```typescript
// Parsing "Bash(python -c \"print\\(1\\)\")" extracts:
//   toolName: "Bash"
//   ruleContent: 'python -c "print(1)"'

export function permissionRuleValueFromString(ruleString: string): PermissionRuleValue {
  const openParenIndex = findFirstUnescapedChar(ruleString, '(')
  if (openParenIndex === -1) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }
  // ... finds matching close paren, unescapes content
}
```

The parser also normalizes legacy tool names via `LEGACY_TOOL_NAME_ALIASES`:

```typescript
const LEGACY_TOOL_NAME_ALIASES: Record<string, string> = {
  Task: 'Agent',
  KillShell: 'TaskStop',
  AgentOutputTool: 'TaskOutput',
  BashOutputTool: 'TaskOutput',
}
```

This ensures old permission rules (e.g., `Task(Explore)`) still work after tool renames.

## Shell Rule Matching

`src/utils/permissions/shellRuleMatching.ts` implements the three matching strategies for Bash/PowerShell command rules:

```typescript
type ShellPermissionRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string }
```

### Exact Match

The command must equal the rule content exactly: `npm install` matches `npm install` but not `npm install --save`.

### Prefix Match (Legacy `:*` Syntax)

The pattern `npm:*` matches any command starting with `npm`. Implemented via `permissionRuleExtractPrefix()`, which checks for the trailing `:*` pattern.

### Wildcard Match (`*`)

Wildcard patterns compile to regular expressions. The `*` character matches any sequence of characters (including none). Escaped stars (`\*`) match literal asterisks.

```typescript
// "git *" compiles to /^git( .*)?$/s
// The trailing " *" is made optional so "git *" matches bare "git" too
// (only when the trailing wildcard is the ONLY unescaped wildcard)

export function matchWildcardPattern(pattern: string, command: string): boolean {
  // 1. Replace \* with placeholder, \\ with placeholder
  // 2. Escape regex special chars
  // 3. Convert unescaped * to .*
  // 4. Restore placeholders as literal regex escapes
  // 5. If pattern ends with " .*" and has only one wildcard,
  //    make the trailing " .*" optional: "( .*)?"
  const regex = new RegExp(`^${regexPattern}$`, 's')
  return regex.test(command)
}
```

> **Key Insight:** The `'s'` (dotAll) flag on the compiled regex is critical. Commands can contain embedded newlines (heredocs after `splitCommand_DEPRECATED` processing), and without `dotAll`, a `*` wildcard would fail to match across line boundaries.

## The Full Permission Decision Flow

The core logic lives in `hasPermissionsToUseToolInner()` at `src/utils/permissions/permissions.ts`. It runs in three phases.

### Phase 1: Deny and Ask Checks (Steps 1a-1g)

These checks fire first and **cannot be overridden** by permissive modes:

```
Step 1a: Tool-level deny rule?
         getDenyRuleForTool() → deny
              │
Step 1b: Tool-level ask rule?
         getAskRuleForTool() → ask
         (unless sandbox auto-allow applies)
              │
Step 1c: Tool-specific permission check
         tool.checkPermissions(input, context)
         → each tool implements its own logic
         (Bash checks subcommand rules, Edit checks path rules, etc.)
              │
Step 1d: Tool returned deny?
         → deny
              │
Step 1e: Tool requires user interaction?
         tool.requiresUserInteraction() && behavior === 'ask'
         → ask (even in bypass mode)
              │
Step 1f: Content-specific ask rule?
         behavior === 'ask' && decisionReason.type === 'rule'
         && rule.ruleBehavior === 'ask'
         → ask (respected even in bypass mode)
              │
Step 1g: Safety check for sensitive paths?
         behavior === 'ask' && decisionReason.type === 'safetyCheck'
         → ask (bypass-immune: .git/, .claude/, .vscode/, shell configs)
```

### Phase 2: Mode-Based Allow (Steps 2a-2b)

If no deny or ask check fired, the mode decides:

```
Step 2a: bypassPermissions mode?
         (or plan mode with isBypassPermissionsModeAvailable)
         → allow
              │
Step 2b: Tool-level allow rule?
         toolAlwaysAllowedRule() → allow
```

### Phase 3: Passthrough Conversion (Step 3)

If the tool's `checkPermissions()` returned `passthrough` (no opinion), convert it to `ask` so the user is prompted.

### Post-Processing in the Outer Wrapper

After `hasPermissionsToUseToolInner()` returns, the outer `hasPermissionsToUseTool()` applies mode-specific transformations:

```
If result is 'allow':
  → Reset consecutive denial counter (auto mode)
  → Return allow

If result is 'ask':
  ├── dontAsk mode? → Convert to deny
  ├── auto mode?    → Run AI classifier (see below)
  │   ├── Non-classifier-approvable safetyCheck? → keep as ask/deny
  │   ├── acceptEdits fast-path? → allow without classifier
  │   ├── Safe-tool allowlist? → allow without classifier
  │   └── Run classifyYoloAction() → allow or deny
  └── shouldAvoidPermissionPrompts? → Run hooks, then auto-deny
```

> **Key Insight:** The `passthrough` behavior exists so that a tool can signal "I have no opinion on this input" without forcing either `allow` or `ask`. This is important because a tool returning `allow` from `checkPermissions()` would bypass the mode check at step 2a. By returning `passthrough`, the tool delegates to the mode-based logic while still providing an `updatedInput` or suggestions.

## The YOLO Classifier (Auto Mode)

When the permission mode is `auto`, an AI classifier replaces the human approval step. The implementation lives in `src/utils/permissions/yoloClassifier.ts`.

### Architecture

The classifier is a **side query** -- a separate API call to Claude that evaluates the security of a pending action. It receives the conversation transcript (user messages and assistant tool calls, but NOT assistant text) plus the action being evaluated.

```
Main Agent Loop                    Classifier Side Query
┌──────────────┐                  ┌──────────────────────┐
│ tool_use:    │                  │ System: security      │
│ Bash(rm -rf) │ ──classifies──→ │   classifier prompt   │
│              │                  │                       │
│ [waiting...] │                  │ User: [transcript]    │
│              │                  │   + [pending action]  │
│              │                  │                       │
│              │ ←──decision───── │ <block>yes</block>    │
│              │                  │ <reason>destructive   │
│ deny: "..."  │                  │  command</reason>     │
└──────────────┘                  └──────────────────────┘
```

### Fast Paths (Classifier Bypass)

Before invoking the classifier API, three fast paths can short-circuit:

1. **Non-classifier-approvable safety checks** -- Sensitive-path violations that are not flagged as `classifierApprovable` always prompt the user (or deny in headless mode). These include Windows UNC path bypass attempts and cross-machine bridge messages.

2. **acceptEdits fast-path** -- If the tool is not Agent or REPL, the system simulates running `tool.checkPermissions()` under `acceptEdits` mode. If that would allow the action, it is allowed without a classifier call. This avoids expensive API calls for file edits in the working directory.

3. **Safe-tool allowlist** -- Read-only and metadata tools skip the classifier entirely. The list is in `src/utils/permissions/classifierDecision.ts`:

```typescript
const SAFE_YOLO_ALLOWLISTED_TOOLS = new Set([
  'Read',           // File read
  'Grep', 'Glob',   // Search
  'LSP',            // Language server
  'ToolSearch',     // Tool discovery
  'TodoWrite',      // Task management
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
  'TaskStop', 'TaskOutput',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'Sleep',
  // ... plus conditional ant-only tools
])
```

### Two-Stage XML Classifier

The classifier uses a two-stage approach:

**Stage 1 (Fast):** A low-latency call with `max_tokens=64` and `stop_sequences=['</block>']`. The model is nudged to immediately output `<block>yes</block>` or `<block>no</block>`. If the answer is "no" (allow), return immediately. If "yes" (block) or unparseable, escalate to stage 2.

**Stage 2 (Thinking):** A follow-up call with a longer `max_tokens` budget and a suffix that encourages chain-of-thought reasoning via `<thinking>` tags. This reduces false positives by giving the model space to reason about whether the action is actually dangerous.

```
Stage 1: "Err on the side of blocking. <block> immediately."
   │
   ├── <block>no</block>  → ALLOW (fast path)
   │
   └── <block>yes</block> or unparseable → Stage 2
                                              │
        "Review the classification process    │
         and follow it carefully..."          │
                                              │
        ├── <block>no</block>  → ALLOW
        └── <block>yes</block> → DENY
```

### System Prompt Construction

The classifier system prompt is assembled from template files:

```typescript
// Base prompt: auto_mode_system_prompt.txt
// Permissions section: permissions_external.txt (or permissions_anthropic.txt for ant users)

const systemPrompt = BASE_PROMPT
  .replace('<permissions_template>', PERMISSIONS_TEMPLATE)
  .replace(/<user_allow_rules_to_replace>.*<\/...>/, userAllowRules ?? defaults)
  .replace(/<user_deny_rules_to_replace>.*<\/...>/, userDenyRules ?? defaults)
  .replace(/<user_environment_to_replace>.*<\/...>/, userEnvironment ?? defaults)
```

Users configure the classifier through `settings.autoMode`:

```typescript
type AutoModeRules = {
  allow: string[]       // actions the classifier should always allow
  soft_deny: string[]   // actions the classifier should lean toward blocking
  environment: string[] // context about the user's environment
}
```

### The classify_result Tool Schema

For the legacy (non-XML) classifier path, the model reports its decision via a tool call:

```typescript
const YOLO_CLASSIFIER_TOOL_SCHEMA = {
  name: 'classify_result',
  input_schema: {
    type: 'object',
    properties: {
      thinking: { type: 'string', description: 'Brief step-by-step reasoning.' },
      shouldBlock: { type: 'boolean', description: 'Whether the action should be blocked' },
      reason: { type: 'string', description: 'Brief explanation of the decision' },
    },
    required: ['thinking', 'shouldBlock', 'reason'],
  },
}
```

### Transcript Construction

The classifier sees a compact transcript built from the conversation messages. Importantly, **assistant text is excluded** -- only `tool_use` blocks from assistant turns are included. This prevents a compromised model from crafting text that manipulates the classifier.

```typescript
export function buildTranscriptEntries(messages: Message[]): TranscriptEntry[] {
  for (const msg of messages) {
    if (msg.type === 'user') {
      // Include user text
    } else if (msg.type === 'assistant') {
      // Only include tool_use blocks — assistant text is model-authored
      // and could be crafted to influence the classifier's decision.
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') { /* include */ }
      }
    }
  }
}
```

### Denial Tracking and Fallback

`src/utils/permissions/denialTracking.ts` tracks consecutive and total classifier denials:

```typescript
export const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20,
}
```

When either limit is exceeded, the system falls back to interactive prompting so the user can review what is happening. In headless mode (no user available), exceeding the denial limit throws an `AbortError` to terminate the agent.

### Fail-Closed vs Fail-Open

When the classifier API is unavailable (network error, rate limit), behavior depends on the `tengu_iron_gate_closed` feature flag:

- **iron_gate_closed = true (default):** Fail closed -- deny the action and tell the model to retry or find an alternative approach.
- **iron_gate_closed = false:** Fail open -- fall through to normal permission handling (user prompt).

## Dangerous Patterns

`src/utils/permissions/dangerousPatterns.ts` defines patterns for commands that would let the model execute arbitrary code through interpreters, bypassing the classifier's ability to reason about what the code does.

### Cross-Platform Code Execution Patterns

These are stripped from allow rules when entering auto mode:

```typescript
export const CROSS_PLATFORM_CODE_EXEC = [
  'python', 'python3', 'python2',
  'node', 'deno', 'tsx',
  'ruby', 'perl', 'php', 'lua',
  'npx', 'bunx',
  'npm run', 'yarn run', 'pnpm run', 'bun run',
  'bash', 'sh',
  'ssh',
]
```

### Bash-Specific Patterns

Additional patterns for Bash-only contexts:

```typescript
export const DANGEROUS_BASH_PATTERNS = [
  ...CROSS_PLATFORM_CODE_EXEC,
  'zsh', 'fish',
  'eval', 'exec', 'env', 'xargs', 'sudo',
  // Anthropic-internal additions (only for ant users):
  'fa run', 'coo',
  'gh', 'gh api', 'curl', 'wget',
  'git',
  'kubectl', 'aws', 'gcloud', 'gsutil',
]
```

> **Key Insight:** The dangerous patterns are not used for runtime blocking. They are used at auto-mode entry to **strip overly broad allow rules**. If a user has `Bash(python:*)` as an allow rule, entering auto mode removes it so that `python` commands go through the classifier instead of being silently allowed. This prevents a compromised model from using `python -c "import os; os.system('curl evil.com')"` to bypass the classifier.

## Filesystem Permission Validation

`src/utils/permissions/filesystem.ts` implements path-based security checks that protect sensitive files and directories from auto-editing.

### Dangerous Files

```typescript
export const DANGEROUS_FILES = [
  '.gitconfig', '.gitmodules',
  '.bashrc', '.bash_profile',
  '.zshrc', '.zprofile', '.profile',
  '.ripgreprc',
  '.mcp.json', '.claude.json',
]
```

These are files that can execute code or exfiltrate data if modified (shell configs run on login, `.gitconfig` can set hooks, `.mcp.json` can register MCP servers).

### Dangerous Directories

```typescript
export const DANGEROUS_DIRECTORIES = [
  '.git',      // Git hooks, config = code execution
  '.vscode',   // VS Code settings, tasks = code execution
  '.idea',     // JetBrains IDE settings
  '.claude',   // Claude Code's own config
]
```

### Case-Insensitive Path Normalization

On macOS and Windows, filesystems are case-insensitive. A path like `.cLauDe/Settings.locaL.json` would bypass naive string comparison. The filesystem module normalizes all paths to lowercase for comparison:

```typescript
export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase()
}
```

This is applied unconditionally (even on Linux) for consistent security behavior. Additional defenses include:
- Path traversal detection (`..` segments)
- UNC path blocking (`\\server\share` on Windows)
- Symlink resolution for temp directories

### Skill Scoping

When editing files inside `.claude/skills/{skillName}/`, the system offers a narrower permission scope:

```typescript
export function getClaudeSkillScope(filePath: string):
  { skillName: string; pattern: string } | null {
  // Returns e.g. { skillName: "my-skill", pattern: "/.claude/skills/my-skill/**" }
  // This allows iterating on one skill without granting access to all of .claude/
}
```

The function rejects skill names containing `..`, glob metacharacters (`*`, `?`, `[`, `]`), or empty strings to prevent scope escalation.

## Key Takeaways

1. **Layered defense model.** The permission system uses multiple independent layers: explicit rules, tool-specific checks, mode-based decisions, safety checks for sensitive paths, and (in auto mode) an AI classifier. Each layer can only restrict, not expand, what the previous layers allow.

2. **Deny rules are absolute.** No mode, classifier, or fast-path can override an explicit deny rule. Safety checks for sensitive paths (`.git/`, `.claude/`, shell configs) survive even `bypassPermissions` mode.

3. **Four internal states, three external.** The `passthrough` behavior lets tools defer to higher-level logic without accidentally granting access. It is converted to `ask` before the decision reaches the user.

4. **Auto mode is a full security classifier.** The YOLO classifier sees the conversation transcript (minus model-authored text), uses a two-stage fast+thinking approach to reduce false positives, and has fail-closed behavior by default. It is not a simple allowlist -- it reasons about the security implications of each action.

5. **Dangerous patterns protect the classifier from bypass.** Overly broad allow rules for interpreters (`python:*`, `node:*`) are stripped when entering auto mode. Without this, the model could use an interpreter to run arbitrary code that the classifier never sees.

6. **Denial tracking prevents infinite loops.** After 3 consecutive or 20 total classifier denials, the system falls back to interactive prompting (or aborts in headless mode). This prevents the model from getting stuck in a deny-retry loop.

7. **Rules cascade from eight sources.** User settings, project settings, local settings, feature flags, policy settings, CLI args, commands, and session-accumulated rules are all merged. This allows organizations to enforce policy while letting users customize their experience.
