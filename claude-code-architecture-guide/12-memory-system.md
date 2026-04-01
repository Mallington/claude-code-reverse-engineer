# Chapter 12: The Memory System

Claude Code has not one but three independent memory systems, each solving a different problem. The CLAUDE.md system injects static instructions and rules into every conversation. Auto-Memory persists learned facts and preferences to disk so they survive across sessions. Session Memory maintains structured notes about the current conversation so compaction does not lose critical context. Understanding how these three systems load, store, and inject their content is essential to understanding what the model actually sees when it processes a query.

## Overview: Three Independent Memory Systems

```
+-----------------------------------------------------------------------+
|                         CLAUDE CODE MEMORY                            |
+-----------------------------------------------------------------------+
|                                                                       |
|  1. CLAUDE.md System              2. Auto-Memory           3. Session |
|     (Instructions/Rules)             (Persistent)             Memory  |
|                                                                       |
|  Sources:                         Storage:                  Storage:  |
|  - /etc/claude-code/CLAUDE.md     ~/.claude/projects/       ~/.claude/|
|  - ~/.claude/CLAUDE.md              <sanitized-root>/         projects|
|  - CLAUDE.md in project dirs          memory/                   /*/   |
|  - .claude/CLAUDE.md                    MEMORY.md (index)      session|
|  - .claude/rules/*.md                   *.md (topic files)     _mem.md|
|  - CLAUDE.local.md                      team/ (shared)               |
|  - MEMORY.md (auto-mem index)                                        |
|                                                                       |
|  Injection:                       Injection:                Injection:|
|  system-reminder in first         system prompt section      Used as  |
|  user message via                 via loadMemoryPrompt()     summary  |
|  prependUserContext()                                        during   |
|                                                              compact  |
+-----------------------------------------------------------------------+
```

The three systems are loaded independently, stored in different locations, injected at different points in the message pipeline, and serve fundamentally different purposes. The rest of this chapter examines each one in detail.

## The CLAUDE.md System

The CLAUDE.md system is the oldest and most visible memory mechanism. It loads markdown files from a defined hierarchy of locations, processes their content (stripping frontmatter, removing HTML comments, resolving `@include` directives), and injects the result as a `<system-reminder>` in the first user message.

The source of truth is `src/utils/claudemd.ts`.

### Loading Hierarchy

Files are loaded in a specific order, with later entries taking higher priority (the model pays more attention to content that appears later in context):

```
Priority (lowest → highest):

1. Managed     /etc/claude-code/CLAUDE.md + rules/*.md
               (policy-level, all users on machine)

2. User        ~/.claude/CLAUDE.md + ~/.claude/rules/*.md
               (private global instructions)

3. Project     CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md
               (checked into codebase, traversed root → CWD)

4. Local       CLAUDE.local.md
               (private project-specific, gitignored, traversed root → CWD)

5. AutoMem     MEMORY.md from auto-memory directory
               (auto-memory index, truncated)

6. TeamMem     team/MEMORY.md if team memory enabled
               (shared team memory index, truncated)
```

The loading logic in `getMemoryFiles()` implements this precisely:

```typescript
// 1. Managed
const managedClaudeMd = getMemoryPath('Managed')
result.push(...(await processMemoryFile(managedClaudeMd, 'Managed', ...)))
// + managed rules dir

// 2. User (only if userSettings source is enabled)
if (isSettingSourceEnabled('userSettings')) {
  const userClaudeMd = getMemoryPath('User')
  result.push(...(await processMemoryFile(userClaudeMd, 'User', ...)))
  // + user rules dir
}

// 3-4. Project + Local: traverse from root down to CWD
const dirs: string[] = []
let currentDir = originalCwd
while (currentDir !== parse(currentDir).root) {
  dirs.push(currentDir)
  currentDir = dirname(currentDir)
}
// Process from root downward to CWD (closer = higher priority)
for (const dir of dirs.reverse()) {
  // Project: CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md
  // Local: CLAUDE.local.md
}

// 5. AutoMem entrypoint
if (isAutoMemoryEnabled()) {
  const { info: memdirEntry } = await safelyReadMemoryFileAsync(
    getAutoMemEntrypoint(), 'AutoMem')
}

// 6. TeamMem entrypoint
if (feature('TEAMMEM') && teamMemPaths.isTeamMemoryEnabled()) {
  const { info: teamMemEntry } = await safelyReadMemoryFileAsync(
    teamMemPaths.getTeamMemEntrypoint(), 'TeamMem')
}
```

For Project and Local files, the walk goes from filesystem root down to CWD. Files closer to CWD appear later in the array and therefore get higher priority. There is also special handling for git worktrees nested inside their main repo: project-type (checked-in) files from the main repo's tree above the worktree are skipped to avoid double-loading.

### The @include Directive

CLAUDE.md files can include other files using `@` notation:

```markdown
@./relative/path.md          # Relative to the including file
@~/home/relative/path.md     # Relative to home directory
@/absolute/path.md           # Absolute path
@path-without-prefix.md      # Treated as relative (same as @./)
```

The implementation extracts `@` references from the markdown AST using the `marked` lexer. Key constraints:

- **Recursion depth cap**: `MAX_INCLUDE_DEPTH = 5`. Deeper includes are silently ignored.
- **Circular reference prevention**: A `processedPaths` Set tracks every file that has been processed. Already-seen paths (normalized for case) are skipped.
- **External include approval**: Files outside the original CWD require explicit approval via `hasClaudeMdExternalIncludesApproved` in the project config. User-level files (`~/.claude/CLAUDE.md`) always allow external includes.
- **Text-only extensions**: A hardcoded `TEXT_FILE_EXTENSIONS` Set (over 100 entries covering `.md`, `.ts`, `.py`, `.go`, `.rs`, `.json`, `.yaml`, and many more) prevents binary files from being included.
- **Code block exclusion**: `@` references inside fenced code blocks and code spans are ignored -- only leaf text nodes in the AST are scanned.

```typescript
function extractIncludePathsFromTokens(tokens, basePath): string[] {
  // Walks the marked AST recursively
  // Skips 'code' and 'codespan' token types
  // Extracts @path patterns from 'text' tokens
  // Resolves against basePath using expandPath()
  // Strips #fragment identifiers
  // Returns deduplicated absolute paths
}

const MAX_INCLUDE_DEPTH = 5
```

### Conditional Rules (Path-Based Frontmatter)

Files in `.claude/rules/` can contain a `paths` frontmatter field with glob patterns. When present, the rule is only applied when the model is working on files matching those patterns:

```markdown
---
paths: src/api/**
---
Always use async/await in API handlers.
```

The `parseFrontmatterPaths()` function extracts these patterns and stores them as `globs` on the `MemoryFileInfo`. The `ignore` library and `picomatch` are used for matching. Rules with `**` (match-all) patterns are treated as unconditional.

### Content Processing Pipeline

Every CLAUDE.md file passes through several transformations before it enters context:

1. **Frontmatter stripping**: YAML frontmatter between `---` delimiters is parsed and removed from the content body.
2. **HTML comment removal**: Block-level HTML comments (`<!-- ... -->`) are stripped using the `marked` lexer. Comments inside code blocks are preserved. Unclosed comments are left in place to avoid silently swallowing content.
3. **MEMORY.md truncation**: AutoMem and TeamMem types are truncated to `MAX_ENTRYPOINT_LINES = 200` lines and `MAX_ENTRYPOINT_BYTES = 25,000` bytes. Line truncation is applied first, then byte truncation at the last newline boundary.
4. **Content differs tracking**: If any transformation changed the content from what is on disk, `contentDiffersFromDisk` is set to `true` and `rawContent` preserves the original bytes.

```typescript
type MemoryFileInfo = {
  path: string
  type: MemoryType       // 'Managed' | 'User' | 'Project' | 'Local' | 'AutoMem' | 'TeamMem'
  content: string         // Processed content
  parent?: string         // Path of file that @included this one
  globs?: string[]        // Conditional path patterns from frontmatter
  contentDiffersFromDisk?: boolean
  rawContent?: string     // Original disk bytes when content was transformed
}
```

### Exclusion System

The `claudeMdExcludes` setting accepts picomatch glob patterns. When configured, matching file paths are excluded from loading. This only applies to User, Project, and Local types -- Managed, AutoMem, and TeamMem are never excluded:

```typescript
function isClaudeMdExcluded(filePath: string, type: MemoryType): boolean {
  if (type !== 'User' && type !== 'Project' && type !== 'Local') {
    return false
  }
  const patterns = getInitialSettings().claudeMdExcludes
  // ... picomatch matching with symlink resolution
}
```

### How CLAUDE.md Content Enters Context

The `getClaudeMds()` function formats the loaded files into a single string. Each file's content is prefixed with its path and a type description:

```
Contents of /path/to/CLAUDE.md (project instructions, checked into the codebase):

[file content]

Contents of /path/to/CLAUDE.local.md (user's private project instructions, not checked in):

[file content]
```

This string becomes the `claudeMd` key in the user context object. The `prependUserContext()` function wraps it in a `<system-reminder>` tag and prepends it as a synthetic first user message:

```typescript
export function prependUserContext(messages, context) {
  return [
    createUserMessage({
      content: `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
${context.claudeMd}
# currentDate
Today's date is ${getLocalISODate()}.

      IMPORTANT: this context may or may not be relevant to your tasks.
</system-reminder>`,
      isMeta: true,
    }),
    ...messages,
  ]
}
```

> **Key Insight:** CLAUDE.md content is not in the system prompt. It is injected as a `<system-reminder>` in a synthetic first user message. This means it sits inside the conversation turn structure, not in the system-level prefix. The `isMeta: true` flag marks it as a framework message that should not be shown to the user.

## Auto-Memory (Persistent File-Based Memory)

Auto-Memory is the system that lets Claude Code remember things across sessions. It writes individual markdown files to a per-project directory under `~/.claude/`, with a `MEMORY.md` index file that gets loaded into context. The source code lives in `src/memdir/`.

### Four Memory Types

The `memoryTypes.ts` module defines a closed four-type taxonomy:

```typescript
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]
```

Each type captures context that is NOT derivable from the current project state:

| Type | Purpose | Examples |
|------|---------|---------|
| `user` | User's role, goals, preferences, knowledge | "User is a data scientist focused on observability" |
| `feedback` | Corrections AND confirmations of approach | "Don't mock the database -- prior incident with broken migration" |
| `project` | Ongoing work, goals, decisions, deadlines | "Merge freeze begins 2026-03-05 for mobile release cut" |
| `reference` | Pointers to external systems and resources | "Pipeline bugs tracked in Linear project INGEST" |

What is explicitly excluded from memory: code patterns, architecture, file paths, project structure, git history, debugging solutions, anything already in CLAUDE.md files, and ephemeral task details.

Each memory file uses frontmatter to declare its metadata:

```markdown
---
name: database-testing-policy
description: Integration tests must use real database, not mocks
type: feedback
---

Integration tests must hit a real database, not mocks.
**Why:** Prior incident where mock/prod divergence masked a broken migration.
**How to apply:** When writing tests that touch database queries.
```

### Storage Structure

```
~/.claude/
  projects/
    <sanitized-git-root>/       # sanitizePath() on canonical git root
      memory/                   # AUTO_MEM_DIRNAME
        MEMORY.md               # Index file (loaded into context)
        user_role.md            # Individual memory files
        feedback_testing.md
        project_auth_rewrite.md
        reference_linear.md
        team/                   # Team memory subdirectory (if enabled)
          MEMORY.md
          *.md
```

The path is computed by `getAutoMemPath()`:

```typescript
export const getAutoMemPath = memoize((): string => {
  const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
  if (override) return override
  const projectsDir = join(getMemoryBaseDir(), 'projects')
  return join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
})
```

Resolution order for the base directory:
1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env var (full-path override for Cowork)
2. `autoMemoryDirectory` in settings.json (trusted sources: policy/local/user only -- projectSettings excluded for security)
3. `<memoryBase>/projects/<sanitized-git-root>/memory/` where memoryBase defaults to `~/.claude`

> **Key Insight:** The `autoMemoryDirectory` setting from project-level `.claude/settings.json` is intentionally excluded. A malicious repo could set `autoMemoryDirectory: "~/.ssh"` and gain silent write access via the filesystem write carve-out that auto-memory paths enjoy. Only policy, local, and user settings are trusted for this path.

### Enablement Chain

Auto-memory is enabled by default. The `isAutoMemoryEnabled()` function in `paths.ts` implements this priority chain (first defined wins):

```typescript
export function isAutoMemoryEnabled(): boolean {
  // 1. CLAUDE_CODE_DISABLE_AUTO_MEMORY env var (1/true -> OFF, 0/false -> ON)
  if (isEnvTruthy(envVal)) return false
  if (isEnvDefinedFalsy(envVal)) return true

  // 2. --bare / CLAUDE_CODE_SIMPLE -> OFF
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) return false

  // 3. Remote mode without persistent storage -> OFF
  if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
      && !process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) return false

  // 4. autoMemoryEnabled in settings.json (supports project-level opt-out)
  if (settings.autoMemoryEnabled !== undefined) return settings.autoMemoryEnabled

  // 5. Default: enabled
  return true
}
```

### MEMORY.md Truncation

The `MEMORY.md` index file is loaded into context but capped at strict limits to prevent it from consuming too much of the context window:

```typescript
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000  // ~125 chars/line at 200 lines
```

The `truncateEntrypointContent()` function applies line truncation first (natural boundary), then byte truncation at the last newline before the cap. When truncation occurs, a warning is appended:

```
> WARNING: MEMORY.md is 350 lines (limit: 200). Only part of it was loaded.
> Keep index entries to one line under ~200 chars; move detail into topic files.
```

### loadMemoryPrompt(): The Three Dispatch Paths

The `loadMemoryPrompt()` function in `memdir.ts` is the entry point for building the memory system prompt. It dispatches to one of three paths:

```
loadMemoryPrompt()
    |
    +-- KAIROS active? --> buildAssistantDailyLogPrompt()
    |                      (append-only date-named log files)
    |
    +-- Team memory enabled? --> buildCombinedMemoryPrompt()
    |                            (private + team directories, scope tags)
    |
    +-- Auto-memory enabled? --> buildMemoryLines()
                                 (single directory, individual mode)
```

**KAIROS mode** (assistant/long-lived sessions): Instead of maintaining MEMORY.md as a live index, the agent appends timestamped bullets to daily log files at `<memoryDir>/logs/YYYY/MM/YYYY-MM-DD.md`. A separate nightly `/dream` skill distills these logs into topic files and MEMORY.md.

**Team memory mode**: Builds a combined prompt with two directories (private + team), scope guidance per memory type (`<scope>always private</scope>`, etc.), and both MEMORY.md indexes.

**Standard mode**: Builds the prompt for a single memory directory with the four-type taxonomy, save instructions, and the MEMORY.md index content.

The prompt returned by `loadMemoryPrompt()` becomes a system prompt section (cached by the `systemPromptSection` mechanism) and is included in the model's system prompt.

### Relevance Engine: Finding Memories for a Query

Not all memories are relevant to every query. The `findRelevantMemories()` function in `findRelevantMemories.ts` uses a Sonnet side-query to select the most relevant memory files:

```
User query arrives
    |
    v
scanMemoryFiles(memoryDir)
    |  Reads all *.md files (excluding MEMORY.md)
    |  Parses frontmatter for name, description, type
    |  Caps at MAX_MEMORY_FILES = 200
    |  Sorts newest-first by mtime
    |
    v
formatMemoryManifest(memories)
    |  One line per file: [type] filename (timestamp): description
    |
    v
sideQuery to Sonnet
    |  System: "You are selecting memories useful to Claude Code..."
    |  User: query + manifest + recently-used tools
    |  JSON schema output: { selected_memories: string[] }
    |  Max 5 selected
    |
    v
Return selected file paths + mtimeMs
```

The system prompt for the selector is precise about what to include:

```typescript
const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be
useful to Claude Code as it processes a user's query. [...] Only include
memories that you are certain will be helpful based on their name and
description.
- If you are unsure if a memory will be useful, do not include it.
- If a list of recently-used tools is provided, do not select memories that
  are usage reference or API documentation for those tools (Claude Code is
  already exercising them). DO still select memories containing warnings,
  gotchas, or known issues about those tools.`
```

The `alreadySurfaced` parameter filters out files that were shown in prior turns, so the 5-slot budget is spent on fresh candidates.

### Background Memory Extraction

The `extractMemories.ts` module runs a background forked agent at the end of each query loop to extract durable memories from the conversation:

```
Main agent produces final response (no tool calls)
    |
    v
handleStopHooks (stopHooks.ts)
    |
    v
runExtraction()
    |  Checks: auto-memory enabled? Feature flag on? Not remote mode?
    |  Checks: enough new messages since last extraction?
    |  Checks: hasMemoryWritesSince() -- skip if main agent already wrote memories
    |
    v
runForkedAgent()
    |  Perfect fork of main conversation (shares prompt cache)
    |  canUseTool: Read/Grep/Glob unrestricted, read-only Bash,
    |              Edit/Write only within auto-memory directory
    |
    v
Agent writes memory files + updates MEMORY.md index
```

The mutual exclusivity logic is important: if the main agent already wrote to auto-memory paths during the conversation range being considered, the extraction agent skips that range entirely. This prevents duplicate memories.

The forked agent's tool permissions are tightly scoped via `createAutoMemCanUseTool()`:
- `Read`, `Grep`, `Glob`: unrestricted (read-only)
- `Bash`: only read-only commands (ls, find, grep, cat, etc.)
- `Edit`, `Write`: only for paths within the auto-memory directory
- `REPL`: allowed (delegates to the above checks for inner primitives)

## Session Memory

Session Memory is the most recent addition. It maintains a structured markdown file with notes about the current conversation, updated periodically by a background subagent. Its primary purpose is providing continuity through context compaction -- when the conversation is compacted, session memory serves as the structured summary.

The source code lives in `src/services/SessionMemory/`.

### Template Structure

The default template defines ten sections:

```markdown
# Session Title
_A short and distinctive 5-10 word descriptive title for the session._

# Current State
_What is actively being worked on right now? Pending tasks not yet completed._

# Task specification
_What did the user ask to build? Any design decisions or other context_

# Files and Functions
_What are the important files? What do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid?_

# Key results
_If the user asked a specific output, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
```

### Size Limits

```typescript
const MAX_SECTION_LENGTH = 2000    // ~2000 tokens per section
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12000  // total budget
```

When sections exceed their limit, the update prompt includes explicit reminders to condense. When the total exceeds 12,000 tokens, the prompt escalates to a `CRITICAL` warning requiring aggressive condensation.

### Trigger Conditions

Session memory updates are governed by three thresholds configured in `SessionMemoryConfig`:

```typescript
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,    // Context tokens before first extraction
  minimumTokensBetweenUpdate: 5000,     // Context growth between updates
  toolCallsBetweenUpdates: 3,           // Tool calls between updates
}
```

The `shouldExtractMemory()` function implements a two-phase gate:

**Phase 1 -- Initialization**: Session memory does not activate until the context window reaches `minimumMessageTokensToInit` tokens (default 10,000). This avoids extracting notes from trivially short conversations.

**Phase 2 -- Update triggers**: After initialization, extraction fires when BOTH of these conditions are met:
- Token threshold: context has grown by at least `minimumTokensBetweenUpdate` since last extraction
- Tool call threshold: at least `toolCallsBetweenUpdates` tool calls since last update

OR when:
- Token threshold is met AND the last assistant turn has no tool calls (a natural conversation break)

```typescript
const shouldExtract =
  (hasMetTokenThreshold && hasMetToolCallThreshold) ||
  (hasMetTokenThreshold && !hasToolCallsInLastTurn)
```

> **Key Insight:** The token threshold is ALWAYS required. Even if the tool call count is high, extraction will not happen until sufficient context growth has occurred. This prevents excessive extractions during rapid tool-use sequences.

### Execution Mechanism

Session memory is registered as a post-sampling hook during initialization:

```typescript
export function initSessionMemory(): void {
  if (getIsRemoteMode()) return
  if (!isAutoCompactEnabled()) return
  registerPostSamplingHook(extractSessionMemory)
}
```

The `extractSessionMemory` function:

1. Only runs on the main REPL thread (`querySource === 'repl_main_thread'`). Subagents, teammates, and other fork sources are excluded.
2. Checks the feature gate (`tengu_session_memory`) lazily on each invocation.
3. Reads the current session memory file (creating it from template if needed).
4. Runs `runForkedAgent()` with the conversation context plus an update prompt.
5. The forked agent can ONLY use `Edit` on the exact session memory file path -- all other tools are denied.

```typescript
export function createMemoryFileCanUseTool(memoryPath: string): CanUseToolFn {
  return async (tool: Tool, input: unknown) => {
    if (tool.name === FILE_EDIT_TOOL_NAME
        && typeof input === 'object' && input !== null
        && 'file_path' in input
        && input.file_path === memoryPath) {
      return { behavior: 'allow', updatedInput: input }
    }
    return { behavior: 'deny', message: `only Edit on ${memoryPath} is allowed` }
  }
}
```

The update prompt instructs the agent to preserve section headers and italic descriptions exactly, only updating content below them. It can make multiple parallel Edit calls to update every section in a single turn.

### Custom Templates

Users can customize the session memory template and prompt:

```
~/.claude/session-memory/config/
    template.md     # Custom section structure
    prompt.md       # Custom update instructions (supports {{variable}} substitution)
```

If these files do not exist, the defaults are used. The prompt supports `{{currentNotes}}` and `{{notesPath}}` variable substitution.

## How Memory Flows Into Context

Here is a consolidated view of where each memory system's content enters the model's context:

```
System Prompt
    |
    +-- loadMemoryPrompt() output ---------> Auto-Memory behavioral instructions
    |   (system prompt section)              (types, save rules, search guidance)
    |                                        MEMORY.md content (if not skipIndex)
    |
First User Message (synthetic, isMeta: true)
    |
    +-- prependUserContext() --------------> <system-reminder>
        |                                    # claudeMd
        +-- getClaudeMds(getMemoryFiles())   All CLAUDE.md files, formatted:
            |                                  Managed, User, Project, Local
            |                                  + MEMORY.md (AutoMem type)
            |                                  + team/MEMORY.md (TeamMem type)
            |
            +-- Each file formatted as:
                "Contents of /path (description):\n\n[content]"

During Compaction
    |
    +-- Session Memory content ------------> Structured summary of conversation
        (read from session memory file)      Used as substitute for full history
```

> **Key Insight:** Auto-memory content appears in TWO places: the behavioral instructions (how to use memory, save rules, type taxonomy) go into the system prompt via `loadMemoryPrompt()`, while the MEMORY.md index content goes into the first user message as part of the CLAUDE.md `<system-reminder>`. This separation means the instructions are cached with the system prompt, while the index (which changes more frequently) is in the user context.

## Team Memory

Team memory extends auto-memory with a shared directory that is synced across all authenticated organization members working on the same repository. The implementation lives in `src/memdir/teamMemPaths.ts`, `src/memdir/teamMemPrompts.ts`, and `src/services/teamMemorySync/`.

### Architecture

```
Local Machine A                    API Server                   Local Machine B
+------------------+                                           +------------------+
| ~/.claude/       |                                           | ~/.claude/       |
|   projects/X/    |    PUT /api/claude_code/team_memory       |   projects/X/    |
|     memory/      |    ?repo=owner/repo                       |     memory/      |
|       team/      | ---------> +------------------+ <-------- |       team/      |
|         MEMORY.md|            | entries: {       |           |         MEMORY.md|
|         *.md     |            |   key: content   |           |         *.md     |
|                  | <--------- |   checksums: {}  | --------> |                  |
+------------------+    GET     +------------------+    GET    +------------------+
                     (pull: server wins per-key)            (pull: server wins per-key)
```

### Enablement

Team memory requires auto-memory to be enabled (it is a subdirectory of auto-memory) and is gated behind a GrowthBook feature flag (`tengu_herring_clock`):

```typescript
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', false)
}
```

The team memory directory is `<autoMemPath>/team/`:

```typescript
export function getTeamMemPath(): string {
  return (join(getAutoMemPath(), 'team') + sep).normalize('NFC')
}
```

### Sync Semantics

The sync service in `src/services/teamMemorySync/index.ts` implements:

- **Pull**: Overwrites local files with server content (server wins per-key). Performed at session start.
- **Push**: Uploads only keys whose content hash differs from server checksums (delta upload). Server uses upsert semantics -- keys not in the PUT are preserved.
- **Deletions do NOT propagate**: Deleting a local file will not remove it from the server. The next pull restores it locally.
- **Conflict resolution**: Uses ETag-based optimistic concurrency. On 412 Precondition Failed, the client refreshes checksums via a lightweight `?view=hashes` probe and retries.

### File Watcher

The `watcher.ts` module watches the team memory directory for changes and triggers debounced pushes:

```
fs.watch(teamDir)
    |  Change detected
    v
Debounce (2000ms)
    |
    v
pushTeamMemory()
    |  Read local files
    |  Compare checksums against server
    |  Upload changed files only
    v
Server stores updated entries
```

The watcher includes push suppression for permanent failures (no OAuth, no repo, 4xx errors) to prevent infinite retry loops.

### Secret Scanning

Before uploading, `secretScanner.ts` scans memory content for credentials using curated high-confidence patterns from the gitleaks rule set. Files containing detected secrets are skipped and reported:

```typescript
type SecretMatch = {
  ruleId: string   // e.g., "github-pat", "aws-access-token"
  label: string    // Human-readable label
}
```

Rules cover AWS access tokens, GCP API keys, Azure AD secrets, GitHub PATs, Anthropic API keys, and many others. Only rules with distinctive prefixes and near-zero false-positive rates are included.

### Path Traversal Protection

The team memory path validation in `teamMemPaths.ts` is thorough, implementing defense-in-depth against path traversal attacks:

1. **String-level sanitization**: Rejects null bytes, URL-encoded traversals, Unicode normalization attacks, backslashes, absolute paths.
2. **resolve()-based containment**: `path.resolve()` eliminates `..` segments for fast initial rejection.
3. **Symlink resolution**: `realpathDeepestExisting()` walks up the directory tree resolving symlinks to catch escapes that `path.resolve()` cannot detect (e.g., a symlink inside the team dir pointing to `~/.ssh/authorized_keys`).
4. **Dangling symlink detection**: Uses `lstat()` to distinguish truly non-existent paths from dangling symlinks whose targets do not exist.

### Combined Memory Prompt

When team memory is enabled, `buildCombinedMemoryPrompt()` produces a unified prompt with:

- Two directories explained (private at `autoDir`, shared at `teamDir`)
- Memory scope section explaining private vs. team
- Per-type `<scope>` guidance in XML-style type blocks (e.g., `user` is always private, `project` strongly biases toward team)
- Explicit warning against saving sensitive data in team memories

## Key Takeaways

1. **Three independent systems, three different purposes.** CLAUDE.md provides static instructions and rules. Auto-Memory provides persistent, cross-session learning. Session Memory provides within-session continuity through compaction. They load from different locations, inject at different context points, and are gated independently.

2. **CLAUDE.md is not in the system prompt.** It is injected as a `<system-reminder>` in a synthetic first user message via `prependUserContext()`. This is a deliberate architectural choice that affects caching behavior and priority.

3. **The loading hierarchy matters.** Files loaded later get higher model attention. The order is Managed -> User -> Project (root to CWD) -> Local (root to CWD) -> AutoMem -> TeamMem. This means local overrides project, which overrides user, which overrides managed.

4. **Auto-memory uses a four-type taxonomy with strict exclusions.** Only information NOT derivable from the current project state should be saved. Code patterns, architecture, git history, and debugging solutions are explicitly excluded -- even when the user asks to save them.

5. **Memory extraction is a background forked agent.** Both auto-memory extraction and session memory updates run as post-sampling hooks using `runForkedAgent()`, sharing the parent's prompt cache. They are tightly tool-gated: auto-memory gets read-only access everywhere plus write access within its directory; session memory gets Edit-only access to its single file.

6. **The relevance engine uses a Sonnet side-query.** Rather than loading all memories, `findRelevantMemories()` scans file headers and asks Sonnet to select the top 5 most relevant, spending only 256 max tokens on the selection. Recently-used tools are excluded from selection to avoid surfacing redundant reference docs.

7. **Team memory has serious security considerations.** Path traversal protection (string sanitization + symlink resolution), secret scanning before upload, exclusion of projectSettings from path overrides, and server-wins sync semantics all reflect a threat model where the shared directory could be a vector for attacks.

8. **Session memory is designed for compaction continuity.** Its structured template with ten sections and strict token budgets (2,000 per section, 12,000 total) ensures that when the context window is compacted, the essential state of the conversation -- what is being worked on, what files matter, what errors occurred, what was learned -- survives in a compact, machine-readable form.
