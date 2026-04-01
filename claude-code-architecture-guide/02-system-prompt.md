# Chapter 2: System Prompt Structure

## Overview

The system prompt is the foundation of Claude Code's behavior. It's sent in the `system` parameter of every API call and stays **frozen** across turns to maximize prompt caching.

## The Two System Blocks

The system prompt consists of exactly **two text blocks**, both with `cache_control: { type: "ephemeral" }`:

### Block 0: Identity (62 chars)
```
You are a Claude agent, built on Anthropic's Claude Agent SDK.
```

This one-liner establishes the base identity. It's separated from the main instructions to allow independent caching.

### Block 1: Instructions (~14,000 chars)

The full instruction set. Here's the structural breakdown:

```
┌─────────────────────────────────────────┐
│ Security Policy (repeated twice)         │  ~300 chars
│ URL Generation Policy                    │  ~100 chars
├─────────────────────────────────────────┤
│ Help/Feedback Instructions               │  ~150 chars
├─────────────────────────────────────────┤
│ Documentation Fetching Behavior          │  ~200 chars
│ (WebFetch from docs.claude.com)          │
├─────────────────────────────────────────┤
│ Tone and Style                           │  ~3,000 chars
│ - Conciseness rules                      │
│ - Example conversations (6 examples)     │
│ - Markdown formatting guidance           │
│ - Emoji policy                           │
├─────────────────────────────────────────┤
│ Proactiveness Policy                     │  ~200 chars
├─────────────────────────────────────────┤
│ Professional Objectivity                 │  ~300 chars
├─────────────────────────────────────────┤
│ Following Conventions                    │  ~500 chars
│ - Library verification                   │
│ - Code style matching                    │
│ - Security best practices                │
├─────────────────────────────────────────┤
│ Code Style (no comments policy)          │  ~50 chars
├─────────────────────────────────────────┤
│ Task Management (TodoWrite emphasis)     │  ~1,500 chars
│ - Two detailed examples                  │
├─────────────────────────────────────────┤
│ Hooks Documentation                      │  ~100 chars
├─────────────────────────────────────────┤
│ Doing Tasks                              │  ~500 chars
│ - Task workflow                          │
│ - Lint/typecheck requirements            │
│ - Commit policy                          │
│ - system-reminder documentation          │
├─────────────────────────────────────────┤
│ Tool Usage Policy                        │  ~400 chars
│ - Task tool preference                   │
│ - WebFetch redirect handling             │
│ - Parallel tool call guidance            │
├─────────────────────────────────────────┤
│ Environment Information                  │  ~200 chars
│ <env>                                    │
│   Working directory                      │
│   Is git repo                            │
│   Platform                               │
│   OS version                             │
│   Date                                   │
│ </env>                                   │
├─────────────────────────────────────────┤
│ Model Identity                           │  ~100 chars
├─────────────────────────────────────────┤
│ Security Policy (repeated)               │  ~300 chars
├─────────────────────────────────────────┤
│ TodoWrite Reminder (repeated)            │  ~50 chars
├─────────────────────────────────────────┤
│ Code References                          │  ~200 chars
│ (file_path:line_number pattern)          │
└─────────────────────────────────────────┘
```

## Key Observations

### 1. The System Prompt is Minimal
At ~14,000 chars, the system prompt is surprisingly lean. Most of the behavioral instructions come through **system reminders** in the messages array (Chapter 4), not from the system prompt itself.

### 2. Caching Strategy
Both blocks use `cache_control: { type: "ephemeral" }`. This means:
- The API caches the exact text
- Subsequent turns reuse the cached version
- **The system prompt never changes between turns** — all dynamic content goes through system-reminders
- This saves significant tokens on multi-turn conversations

### 3. Repeated Security Instructions
The security policy appears **twice** in the system prompt — once at the top and once near the bottom. This is intentional: placement at both the start and end of a long instruction set helps the model attend to critical safety instructions regardless of attention distribution.

### 4. Environment Block
The `<env>` block is baked into the system prompt, NOT injected via system-reminders:
```
<env>
Working directory: /Users/mathew/claude-code-architecture-guide/captures
Is directory a git repo: No
Platform: darwin
OS Version: Darwin 24.5.0
Today's date: 2026-03-23
</env>
```

This means the system prompt **does change** between sessions (different directory, date, etc.), but stays frozen within a session.

### 5. What's NOT in the System Prompt

The following are **NOT** in the system prompt. They come through other channels:
- **Skills** — Injected via SessionStart hook → system-reminder
- **CLAUDE.md content** — Injected via system-reminder
- **Memory files** — Injected via system-reminder
- **Plugin instructions** — Injected via hook → system-reminder
- **Skill list** — Injected via system-reminder
- **MCP server instructions** — Injected via system-reminder
- **Available deferred tools** — Injected via system-reminder
- **Date (in system-reminder form)** — Also in system-reminder for in-session updates

## Comparison: Baseline vs Plugin-Enabled

### Without Superpowers Plugin (captured via claude-trace)
The system prompt in Block 1 is exactly as shown above — pure Claude Code instructions, no plugin content.

### With Superpowers Plugin (current session)
The system prompt block is **expanded** (seen in the current session context):
- Additional sections for memory management (`# auto memory`)
- Extended agent tool descriptions with custom agent types
- `Skill` tool added to tool definitions
- Additional `CronCreate`, `CronDelete`, `CronList` tools
- Reasoning effort settings
- Fast mode info
- More detailed tool usage instructions

The exact mechanism: the plugin's `SessionStart` hook outputs context that Claude Code merges into the system-reminder, and some plugin-registered tools and agents get added to the tool definitions and system prompt at session creation time.

---

## System Prompt Build Pipeline (Source Code Revealed)

The sections above were inferred from network captures. What follows is derived directly from Claude Code's TypeScript source, revealing the full machinery behind what the network sees.

### 1. The Section Memoization System

**Source:** `src/constants/systemPromptSections.ts`

The system prompt is not a static string. It is assembled from named **sections**, each backed by a compute function. Two factory functions create these sections:

```
systemPromptSection(name, compute)
```
Creates a memoized section. The compute function runs once; the result is cached in `STATE.systemPromptSectionCache` for the lifetime of the session. Subsequent turns return the cached value without re-executing the compute function.

```
DANGEROUS_uncachedSystemPromptSection(name, compute, reason)
```
Creates a **volatile** section that recomputes on every turn. The `cacheBreak: true` flag forces resolution to bypass the cache. This is intentionally dangerous because it invalidates prompt caching -- every time the value changes, the API must re-tokenize and re-cache the entire system prompt suffix. A mandatory `reason` parameter documents why the cache-breaking is necessary.

Currently, only one section uses this: **`mcp_instructions`**, with the reason `'MCP servers connect/disconnect between turns'`. MCP servers can come and go mid-session (async connect, `/reload-plugins`), so their instructions cannot be cached.

Resolution is parallel:

```
resolveSystemPromptSections(sections) -> Promise<(string | null)[]>
```

This resolves all sections concurrently via `Promise.all()`. For each section, if `cacheBreak` is false and the cache has an entry, the cached value is returned. Otherwise the compute function executes and the result is stored in the cache.

The cache is cleared on `/clear` and `/compact` via `clearSystemPromptSections()`, which also resets beta header latches so the fresh conversation gets fresh evaluation of feature flags.

### 2. getSystemPrompt() -- The Master Builder

**Source:** `src/constants/prompts.ts`, function `getSystemPrompt()`

This is the central function that builds the system prompt array. It takes the tool list, model ID, additional working directories, and MCP client connections. It returns `string[]` -- an array of prompt sections that will later be joined with `\n\n` separators.

There are three code paths:

**Path A: CLAUDE_CODE_SIMPLE mode.** When `CLAUDE_CODE_SIMPLE` env var is truthy, the entire system prompt collapses to a single line:
```
You are Claude Code, Anthropic's official CLI for Claude.

CWD: /path/to/cwd
Date: 2026-03-31
```
This is a minimal mode for testing or simple automation.

**Path B: Proactive/KAIROS mode.** When the `PROACTIVE` or `KAIROS` build feature is enabled and `proactiveModule.isProactiveActive()` returns true, the prompt switches to an autonomous agent persona: `"You are an autonomous agent. Use the available tools to do useful work."` This path includes system reminders, memory, environment info, MCP instructions, scratchpad, function result clearing, summarize-tool-results guidance, and a lengthy proactive-mode section with pacing/sleep/terminal-focus instructions.

**Path C: Normal mode (the default).** This is the path that produces the prompt most users see. It builds the prompt in two halves separated by `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`:

**Static sections (before boundary):**
1. `getSimpleIntroSection()` -- Identity and security policy (CYBER_RISK_INSTRUCTION). When an output style is active, the identity line changes to reference it.
2. `getSimpleSystemSection()` -- System rules: markdown rendering, permission modes, system-reminder tag semantics, hooks, auto-compression.
3. `getSimpleDoingTasksSection()` -- Task execution guidance: code style rules, security practices, help/feedback instructions. **Conditionally skipped** when an output style has `keepCodingInstructions: false`.
4. `getActionsSection()` -- Reversibility and blast-radius policy for risky operations (destructive ops, shared-state mutations, third-party uploads).
5. `getUsingYourToolsSection()` -- Tool usage preferences: dedicated tools over Bash, task management, parallel tool calls.
6. `getSimpleToneAndStyleSection()` -- Emoji policy, conciseness, file-path:line-number references, GitHub issue format, no colons before tool calls.
7. `getOutputEfficiencySection()` -- Conciseness instructions. **Different for ant-internal vs external users** (see below).

**Dynamic sections (after boundary), managed by the memoization registry:**
1. `session_guidance` -- Session-specific tool guidance (AskUserQuestion, AgentTool behavior, skill commands, explore agents, verification agent).
2. `memory` -- Loaded via `loadMemoryPrompt()` from the memdir system.
3. `ant_model_override` -- Ant-internal only model-specific suffix.
4. `env_info_simple` -- Environment information (see section 5 below).
5. `language` -- Language preference: `"Always respond in {language}."` if configured.
6. `output_style` -- Output style prompt text when a non-default style is active.
7. `mcp_instructions` -- **DANGEROUS uncached.** MCP server instructions from connected servers with instructions fields.
8. `scratchpad` -- Scratchpad directory instructions if enabled.
9. `frc` -- Function Result Clearing section (for cached microcompact feature).
10. `summarize_tool_results` -- Instruction to write down important info from tool results before they are cleared.
11. `numeric_length_anchors` -- **Ant-only.** Explicit word limits: "keep text between tool calls to <=25 words. Keep final responses to <=100 words unless the task requires more detail."
12. `token_budget` -- Token budget instructions (behind `TOKEN_BUDGET` feature flag).
13. `brief` -- Brief/KAIROS proactive section (behind `KAIROS`/`KAIROS_BRIEF` feature flags).

**USER_TYPE conditional logic:** The `USER_TYPE` environment variable (set to `'ant'` for Anthropic internal builds) gates several differences:
- Ant-internal gets extra code style bullets in `getSimpleDoingTasksSection()`: explicit no-comments policy, comment removal guidance, thoroughness counterweight, false-claims mitigation, bug-reporting guidance (recommending `/issue` or `/share` commands).
- Ant-internal gets a different `getOutputEfficiencySection()` focused on "communicating with the user" (flowing prose, inverted pyramid, no fragments) rather than the external version's terse "output efficiency" bullet points.
- Ant-internal gets `numeric_length_anchors` in the dynamic sections.
- Ant-internal can get `isolation: "remote"` guidance for agents.

### 3. SYSTEM_PROMPT_DYNAMIC_BOUNDARY

**Source:** `src/constants/prompts.ts`

```typescript
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

This sentinel string is inserted into the system prompt array **only when** `shouldUseGlobalCacheScope()` returns true, which requires the first-party Anthropic API. Third-party providers (Bedrock, Vertex) never see it.

Its purpose is to separate globally-cacheable content from per-session content. When `splitSysPromptPrefix()` in `src/utils/api.ts` processes the system prompt array, it looks for this boundary:

- **Everything before the boundary** is joined and tagged with `cacheScope: 'global'`. This content is identical across all users and organizations -- it can be cached at the infrastructure level.
- **Everything after the boundary** is joined with `cacheScope: null` (no global caching). This content includes session-specific data like environment info, language preferences, MCP instructions, and memory.

When the boundary is absent (third-party providers, or `skipGlobalCacheForSystemPrompt` is true), the system falls back to `cacheScope: 'org'` for the main content block, which caches within an organization but not globally.

The actual cache segmentation in `splitSysPromptPrefix()` produces up to four blocks:
1. Attribution header (`cacheScope: null`) -- billing/version metadata
2. CLI sysprompt prefix (`cacheScope: null` in global mode, `'org'` otherwise) -- the identity one-liner
3. Static content before boundary (`cacheScope: 'global'`) -- all the instruction text
4. Dynamic content after boundary (`cacheScope: null`) -- per-session data

### 4. Output Styles

**Source:** `src/constants/outputStyles.ts`

Output styles change how Claude communicates. Three built-in modes exist:

- **default** (mapped to `null` in config) -- No style modifications. Standard Claude Code behavior.
- **Explanatory** -- Educational mode. Adds `"Insight"` blocks (using star figures as decorators) before and after code. The identity line changes to: `"You are an interactive CLI tool that helps users according to your 'Output Style' below..."`. Has `keepCodingInstructions: true`, so `getSimpleDoingTasksSection()` is still included.
- **Learning** -- Interactive hands-on mode. Asks the user to write small code pieces (2-10 lines) for design decisions, business logic, and algorithms. Uses `TODO(human)` markers in code. Includes "Learn by Doing" request blocks with context/task/guidance. Also has `keepCodingInstructions: true`.

When `keepCodingInstructions` is `false` (possible with custom/plugin styles), `getSimpleDoingTasksSection()` is entirely skipped from the system prompt, removing all code-style rules and task management guidance.

Style priority resolution in `getOutputStyleConfig()`:
1. **Forced plugin style** -- Any plugin output style with `forceForPlugin: true` takes highest priority. If multiple plugins force styles, the first one wins (with a debug warning).
2. **Settings** -- `settings.outputStyle` from user/project/managed settings.
3. **Built-in** -- Falls back to default.

Custom styles can also be loaded from the output styles directory or from plugins, layered in priority order: built-in < plugin < user settings < project settings < managed (policy) settings.

### 5. Environment Info Assembly

**Source:** `computeSimpleEnvInfo()` in `src/constants/prompts.ts`

This function builds the `env_info_simple` section in the dynamic half. It runs `getIsGit()` and `getUnameSR()` in parallel, then assembles:

```
# Environment
You have been invoked in the following environment:
 - Primary working directory: /path/to/cwd
 - Is a git repository: Yes
 - Platform: darwin
 - Shell: zsh
 - OS Version: Darwin 24.5.0
 - You are powered by the model named Claude Opus 4.6. The exact model ID is claude-opus-4-6[1m].
 - Assistant knowledge cutoff is May 2025.
 - The most recent Claude model family is Claude 4.5/4.6. Model IDs -- Opus 4.6: 'claude-opus-4-6', Sonnet 4.6: 'claude-sonnet-4-6', Haiku 4.5: 'claude-haiku-4-5-20251001'. When building AI applications, default to the latest and most capable Claude models.
 - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).
 - Fast mode for Claude Code uses the same Claude Opus 4.6 model with faster output. It does NOT switch to a different model. It can be toggled with /fast.
```

When `USER_TYPE === 'ant'` and "undercover" mode is active (for public-facing PR work), all model names, IDs, knowledge cutoffs, model family listings, and Claude Code availability info are suppressed from the environment block to prevent leaking unannounced model information.

There is also a legacy `computeEnvInfo()` function (used by `enhanceSystemPromptWithEnvDetails()` for subagents) that produces a slightly different format with an `<env>` XML block instead of markdown bullets.

### 6. Agent Prompt Construction

**Source:** `src/tools/AgentTool/prompt.ts` and `enhanceSystemPromptWithEnvDetails()` in `src/constants/prompts.ts`

Subagents do not receive the full parent system prompt. Their prompt construction follows a different path:

**The default agent prompt** (`DEFAULT_AGENT_PROMPT`) is a stripped-down instruction:
```
You are an agent for Claude Code, Anthropic's official CLI for Claude.
Given the user's message, you should use the tools available to complete
the task. Complete the task fully -- don't gold-plate, but don't leave it
half-done. When you complete the task, respond with a concise report
covering what was done and any key findings -- the caller will relay this
to the user, so it only needs the essentials.
```

Custom agents (from plugins or the agents directory) can provide their own system prompt via `getSystemPrompt()`, which replaces the default entirely.

**`enhanceSystemPromptWithEnvDetails()`** takes an existing system prompt array and appends:
1. **Notes** -- Agent-specific behavioral guidance: always use absolute file paths (cwd resets between bash calls), share relevant file paths in final response, avoid emojis, no colons before tool calls.
2. **DiscoverSkills guidance** (conditional) -- If the experimental skill search feature is enabled, guidance on how to use the DiscoverSkills tool.
3. **Environment info** -- Full `computeEnvInfo()` output with cwd, git status, platform, shell, OS version, model identity, and knowledge cutoff.

**`buildEffectiveSystemPrompt()`** (in `src/utils/systemPrompt.ts`) handles the priority resolution for what system prompt an interactive session uses:
1. Override system prompt (e.g., loop mode) -- replaces everything
2. Coordinator system prompt (coordinator mode)
3. Agent system prompt (when a main-thread agent is set)
   - In proactive mode: agent prompt is **appended** to the default
   - Otherwise: agent prompt **replaces** the default
4. Custom system prompt (via `--system-prompt` flag)
5. Default system prompt (the standard getSystemPrompt() output)

`appendSystemPrompt` is always added at the end (except when override is set).

### 7. The Complete Assembly Sequence

Here is the full pipeline from source to API request, traced through the actual call chain:

```
Step 1: getSystemPrompt()
   |  Builds section array: [static sections..., BOUNDARY?, dynamic sections...]
   |  Dynamic sections resolved in parallel via resolveSystemPromptSections()
   |  Returns string[]
   v
Step 2: fetchSystemPromptParts()           [src/utils/queryContext.ts]
   |  Calls in parallel:
   |    - getSystemPrompt(tools, model, dirs, mcpClients)
   |    - getUserContext()    -> { claudeMd: "...", currentDate: "Today's date is..." }
   |    - getSystemContext()  -> { gitStatus: "..." }
   |  Returns { defaultSystemPrompt, userContext, systemContext }
   v
Step 3: buildEffectiveSystemPrompt()       [src/utils/systemPrompt.ts]
   |  Resolves priority: override > coordinator > agent > custom > default
   |  Appends appendSystemPrompt if present
   |  Returns SystemPrompt (branded string[])
   v
Step 4: appendSystemContext()              [src/utils/api.ts]
   |  Appends systemContext entries (gitStatus, cacheBreaker) to the system prompt array
   |  Returns string[]
   v
Step 5: query() -> callModel()            [src/query.ts -> src/services/api/claude.ts]
   |  Prepends to system prompt array:
   |    - getAttributionHeader(fingerprint)   "x-anthropic-billing-header: cc_version=..."
   |    - getCLISyspromptPrefix()             "You are Claude Code, Anthropic's official CLI..."
   |  Appends conditionally:
   |    - ADVISOR_TOOL_INSTRUCTIONS (if advisor model active)
   |    - CHROME_TOOL_SEARCH_INSTRUCTIONS (if Chrome MCP tools present)
   |  Filters empty strings via .filter(Boolean)
   v
Step 6: prependUserContext()               [src/utils/api.ts]
   |  Creates a synthetic user message (isMeta: true) at position 0:
   |    <system-reminder>
   |    As you answer the user's questions, you can use the following context:
   |    # claudeMd
   |    {CLAUDE.md content}
   |    # currentDate
   |    Today's date is 2026-03-31.
   |    IMPORTANT: this context may or may not be relevant to your tasks.
   |    </system-reminder>
   |  Prepends this before all user messages
   v
Step 7: buildSystemPromptBlocks()          [src/services/api/claude.ts]
   |  Calls splitSysPromptPrefix() which segments the string[] into blocks:
   |    Block 0: attribution header (cacheScope: null)
   |    Block 1: CLI prefix identity (cacheScope: null or 'org')
   |    Block 2: static instructions (cacheScope: 'global' if boundary present, else 'org')
   |    Block 3: dynamic per-session content (cacheScope: null)
   |  Maps each block to TextBlockParam { type: 'text', text, cache_control }
   v
Step 8: Final API request
   |  system: TextBlockParam[] (the blocks from step 7)
   |  messages: Message[] (with userContext prepended as system-reminder)
   |  tools: tool schemas with cache_control on last element
   |  betas, model, thinking config, etc.
```

The key insight is that what appears as "two system blocks" in network captures is actually the result of a multi-stage pipeline. The boundary between "Block 0" and "Block 1" in the original chapter's analysis corresponds to the `splitSysPromptPrefix()` segmentation, where the identity prefix is separated from the instruction body for independent cache control.

---

## How to Modify the System Prompt

Claude Code's system prompt cannot be directly edited. However, you can influence it through:

1. **CLAUDE.md files** -- Project-level instructions loaded by `getUserContext()` and injected as a `<system-reminder>` user message prepended to the conversation. This is the primary customization mechanism for end users.
2. **Plugins** -- Can add tools, agents, hooks, skills, and SessionStart context. Plugin output styles with `forceForPlugin: true` can override the identity line and skip coding instructions entirely.
3. **Settings** -- `outputStyle` changes the prompt persona and may skip code-style sections. `language` adds a language preference section. Model selection changes the identity line and knowledge cutoff.
4. **Environment variables** -- `CLAUDE_CODE_SIMPLE` collapses the entire prompt to one line. `USER_TYPE=ant` enables internal-only sections. Various feature flags gate experimental sections.
5. **MCP servers** -- Connected MCP servers with `instructions` fields get a DANGEROUS_uncached section that recomputes every turn.
6. **Custom system prompt** -- The `--system-prompt` CLI flag or programmatic `customSystemPrompt` parameter replaces the default entirely (skipping both `getSystemPrompt()` and `getSystemContext()`).
7. **Append system prompt** -- The `appendSystemPrompt` parameter adds content after all other system prompt assembly, useful for SDK integrations.

## Key Takeaways

1. **The system prompt is not a template -- it is compiled.** A memoization registry (`systemPromptSection`) manages named sections with lazy evaluation and session-scoped caching. Only one section (`mcp_instructions`) is intentionally volatile.

2. **There are three tiers of cache scope.** The `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel separates globally-cacheable content (identical across all users) from per-session content. `splitSysPromptPrefix()` produces up to four blocks with `global`, `org`, or `null` cache scopes. This is why the system prompt is frozen within a session -- changing it would invalidate potentially hundreds of thousands of cached tokens.

3. **CLAUDE.md is not in the system prompt.** It is loaded by `getUserContext()` and injected as a synthetic user message with `<system-reminder>` tags, prepended before the actual conversation. This keeps it out of the system prompt cache entirely.

4. **Git status is appended via systemContext, not baked into sections.** `getSystemContext()` fetches git status separately and `appendSystemContext()` adds it as a trailing entry in the system prompt array. This is distinct from the `<env>` block (which contains `Is a git repository: Yes/No`).

5. **Subagents get a different prompt.** They receive `DEFAULT_AGENT_PROMPT` (or a custom agent prompt) enhanced with `enhanceSystemPromptWithEnvDetails()`, not the full parent system prompt. This keeps subagent context lean.

6. **Ant-internal builds diverge significantly.** The `USER_TYPE=ant` gate enables: extra code-style bullets, a different output-efficiency section (prose-focused vs terse), numeric length anchors, false-claims mitigation, verification agent guidance, remote isolation for agents, and an undercover mode that strips all model identity from the prompt.

7. **The assembly pipeline has seven stages.** From `getSystemPrompt()` through `buildSystemPromptBlocks()`, the system prompt passes through section resolution, context fetching, priority resolution, context appending, prefix/header prepending, user context injection, and finally cache-scope segmentation into `TextBlockParam[]` blocks for the API.
