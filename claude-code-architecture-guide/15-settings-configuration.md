# Chapter 15: Settings & Configuration

Claude Code has not one but three distinct configuration systems, each serving a different purpose. **Settings** (`settings.json`) provides declarative tool and behavior configuration with a five-level merge hierarchy. **GlobalConfig** (`.claude.json`) stores persistent user state like session metrics, account info, and UI preferences. **Bootstrap State** is a runtime singleton holding ~100 fields of ephemeral session state. On top of all this, GrowthBook feature flags control gradual rollouts and experiments. This chapter traces each system from disk to runtime.

## Settings Architecture Overview

The Settings system lives in `src/utils/settings/` and manages declarative configuration -- what tools are allowed, which hooks run, what model to use, sandbox policy, and so on. It is the most complex of the three systems because it merges input from five prioritized sources, supports enterprise policy enforcement, and validates everything through Zod schemas.

```
                         Settings Architecture
  +-------------------------------------------------------------------+
  |                                                                   |
  |   Plugin Settings (absolute lowest base)                          |
  |       |                                                           |
  |       v                                                           |
  |   userSettings       ~/.claude/settings.json                      |
  |       |                                                           |
  |       v                                                           |
  |   projectSettings    .claude/settings.json                        |
  |       |                                                           |
  |       v                                                           |
  |   localSettings      .claude/settings.local.json  (gitignored)    |
  |       |                                                           |
  |       v                                                           |
  |   flagSettings       --settings CLI flag + SDK inline             |
  |       |                                                           |
  |       v                                                           |
  |   policySettings     Enterprise managed (remote/MDM/file/HKCU)    |
  |       |                                                           |
  |       v                                                           |
  |   +-----------+                                                   |
  |   | Effective |  <-- getInitialSettings() returns this            |
  |   | Settings  |                                                   |
  |   +-----------+                                                   |
  +-------------------------------------------------------------------+
```

The merge order is lowest-to-highest priority: later sources override earlier ones. The result is cached for the session and invalidated when files change.

## Settings Hierarchy (5 Sources)

From `src/utils/settings/constants.ts`, the canonical source list is defined as a const tuple:

```typescript
export const SETTING_SOURCES = [
  'userSettings',      // Priority 1 (lowest)
  'projectSettings',   // Priority 2
  'localSettings',     // Priority 3
  'flagSettings',      // Priority 4
  'policySettings',    // Priority 5 (highest)
] as const
```

Each source resolves to a file on disk:

| Priority | Source | Path | Editable? |
|----------|--------|------|-----------|
| 0 (base) | Plugin settings | From installed plugins (allowlisted keys only) | No |
| 1 | `userSettings` | `~/.claude/settings.json` | Yes |
| 2 | `projectSettings` | `$PROJECT/.claude/settings.json` | Yes |
| 3 | `localSettings` | `$PROJECT/.claude/settings.local.json` | Yes |
| 4 | `flagSettings` | `--settings` CLI flag path + SDK inline | No |
| 5 | `policySettings` | Enterprise managed (see below) | No |

Plugin settings form the absolute lowest base layer. They are merged in before any file-based source and only contain allowlisted keys (e.g., `agent`). The `loadSettingsFromDisk()` function in `settings.ts` starts the merge chain:

```typescript
function loadSettingsFromDisk(): SettingsWithErrors {
  // Start with plugin settings as the lowest priority base.
  const pluginSettings = getPluginSettingsBase()
  let mergedSettings: SettingsJson = {}
  if (pluginSettings) {
    mergedSettings = mergeWith(
      mergedSettings,
      pluginSettings,
      settingsMergeCustomizer,
    )
  }

  // Merge settings from each source in priority order
  for (const source of getEnabledSettingSources()) {
    // ... merge each source on top
  }
}
```

> **Key Insight:** Policy settings (`policySettings`) and flag settings (`flagSettings`) are always enabled and cannot be disabled via the `--setting-sources` CLI flag. This is enforced in `getEnabledSettingSources()`:
> ```typescript
> export function getEnabledSettingSources(): SettingSource[] {
>   const allowed = getAllowedSettingSources()
>   const result = new Set<SettingSource>(allowed)
>   result.add('policySettings')   // Always included
>   result.add('flagSettings')     // Always included
>   return Array.from(result)
> }
> ```

### Cowork Mode Variant

When running with the `--cowork` flag (or `CLAUDE_CODE_USE_COWORK_PLUGINS` env var), the user settings file switches from `settings.json` to `cowork_settings.json`:

```typescript
function getUserSettingsFilePath(): string {
  if (getUseCoworkPlugins() || isEnvTruthy(process.env.CLAUDE_CODE_USE_COWORK_PLUGINS)) {
    return 'cowork_settings.json'
  }
  return 'settings.json'
}
```

## Policy Settings (Enterprise Managed)

Policy settings are the highest-priority source and use a "first non-empty wins" strategy internally. When `policySettings` is requested, the system checks four sub-sources in order and returns the first one that has content:

```
  Policy Settings Resolution (first non-empty wins)
  +-------------------------------------------------+
  |  1. Remote managed settings (API, cached)       |
  |     |                                           |
  |     v  (empty? try next)                        |
  |  2. MDM settings (HKLM on Windows,              |
  |     plist on macOS)                             |
  |     |                                           |
  |     v  (empty? try next)                        |
  |  3. File-based managed settings                 |
  |     managed-settings.json                       |
  |     + managed-settings.d/*.json (drop-ins)      |
  |     |                                           |
  |     v  (empty? try next)                        |
  |  4. HKCU settings (Windows user-level registry) |
  +-------------------------------------------------+
```

The code in `getSettingsForSourceUncached()`:

```typescript
if (source === 'policySettings') {
  const remoteSettings = getRemoteManagedSettingsSyncFromCache()
  if (remoteSettings && Object.keys(remoteSettings).length > 0) {
    return remoteSettings
  }

  const mdmResult = getMdmSettings()
  if (Object.keys(mdmResult.settings).length > 0) {
    return mdmResult.settings
  }

  const { settings: fileSettings } = loadManagedFileSettings()
  if (fileSettings) {
    return fileSettings
  }

  const hkcu = getHkcuSettings()
  if (Object.keys(hkcu.settings).length > 0) {
    return hkcu.settings
  }

  return null
}
```

### File-Based Managed Settings

The file-based managed settings support a drop-in directory pattern (like systemd or sudoers). The base file `managed-settings.json` is merged first (lowest precedence), then files in `managed-settings.d/` are sorted alphabetically and merged on top:

```
  /etc/claude-code/           (or platform equivalent)
      managed-settings.json           # Base file (lowest precedence)
      managed-settings.d/
          10-otel.json                # Drop-in fragments
          20-security.json            # Later files win
          30-model-policy.json
```

This lets separate teams ship independent policy fragments without coordinating edits to a single admin-owned file. Hidden files (starting with `.`) are skipped.

### Policy Origin Tracking

The system tracks which sub-source won for diagnostic purposes via `getPolicySettingsOrigin()`, which returns one of `'remote' | 'plist' | 'hklm' | 'file' | 'hkcu' | null`. The `/status` command uses this to display which policy backend is active.

## Settings Merge Semantics

Settings merging uses `lodash-es/mergeWith` with a custom customizer. The merge behavior differs between the two contexts where it is used.

### Cross-Source Merge (loadSettingsFromDisk)

When merging sources together during `loadSettingsFromDisk()`, arrays are **concatenated and deduplicated**:

```typescript
export function settingsMergeCustomizer(
  objValue: unknown,
  srcValue: unknown,
): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return mergeArrays(objValue, srcValue)  // uniq([...target, ...source])
  }
  return undefined  // Let lodash handle default deep merge
}
```

This means permission `allow` rules from user settings and project settings accumulate rather than replace each other.

### Update Merge (updateSettingsForSource)

When writing updates to a single settings file, the customizer behaves differently -- arrays **replace** entirely and `undefined` acts as a **deletion marker**:

```typescript
const updatedSettings = mergeWith(
  existingSettings || {},
  settings,
  (
    _objValue: unknown,
    srcValue: unknown,
    key: string | number | symbol,
    object: Record<string | number | symbol, unknown>,
  ) => {
    // Handle undefined as deletion
    if (srcValue === undefined && object && typeof key === 'string') {
      delete object[key]
      return undefined
    }
    // For arrays, always replace with the provided array
    if (Array.isArray(srcValue)) {
      return srcValue
    }
    return undefined
  },
)
```

> **Key Insight:** The distinction between these two merge strategies is critical. Cross-source merging accumulates (you want project allow rules to add to user allow rules), while single-file updates replace (you want to set the exact final state of an array).

### Caching

Settings are cached at three levels:

1. **Per-file cache** (`getCachedParsedFile`): Avoids re-parsing the same JSON file
2. **Per-source cache** (`getCachedSettingsForSource`): Avoids re-computing policy resolution
3. **Session cache** (`getSessionSettingsCache`): Avoids re-running the full merge pipeline

All caches are invalidated together via `resetSettingsCache()`. The `getSettingsWithSources()` function (used by `/status`) forces a reset before reading to ensure fresh results.

### Zod Validation with Graceful Degradation

Every settings file is validated against `SettingsSchema()` using Zod's `safeParse`. Invalid fields are ignored but valid portions are used. Permission rules get special pre-validation treatment -- `filterInvalidPermissionRules()` strips bad rules before schema validation so one bad rule does not cause the entire file to be rejected:

```typescript
const data = safeParseJSON(content, false)
const ruleWarnings = filterInvalidPermissionRules(data, path)
const result = SettingsSchema().safeParse(data)
```

A re-entrancy guard (`isLoadingSettings`) prevents infinite recursion when settings loading triggers logging that tries to read settings.

## Key Settings Categories

The `SettingsSchema` in `src/utils/settings/types.ts` defines dozens of fields. Here are the major categories:

### Authentication

| Field | Purpose |
|-------|---------|
| `apiKeyHelper` | Path to script that outputs auth values |
| `awsCredentialExport` | Script for AWS credential export (Bedrock) |
| `awsAuthRefresh` | Script for AWS auth refresh |
| `gcpAuthRefresh` | Command for GCP auth refresh (Vertex AI) |
| `xaaIdp` | OIDC identity provider config (issuer, clientId, callbackPort) |

### Permissions

| Field | Purpose |
|-------|---------|
| `permissions.allow` | Array of permission rules for allowed operations |
| `permissions.deny` | Array of permission rules for denied operations |
| `permissions.ask` | Array of rules that always prompt for confirmation |
| `permissions.defaultMode` | Default permission mode (e.g., `plan`, `auto`) |
| `permissions.disableBypassPermissionsMode` | Set to `"disable"` to lock out bypass mode |
| `permissions.disableAutoMode` | Set to `"disable"` to lock out auto mode |
| `permissions.additionalDirectories` | Extra directories in permission scope |

### Model Configuration

| Field | Purpose |
|-------|---------|
| `model` | Override the default model |
| `availableModels` | Enterprise allowlist of selectable models (family aliases, version prefixes, or full IDs) |
| `modelOverrides` | Map from Anthropic model ID to provider-specific ID (e.g., Bedrock ARN) |
| `advisorModel` | Model for the server-side advisor tool |
| `effortLevel` | Persisted effort level (`low`, `medium`, `high`) |
| `fastMode` | Enable/disable fast mode |
| `alwaysThinkingEnabled` | Control extended thinking |

### MCP Servers

| Field | Purpose |
|-------|---------|
| `enableAllProjectMcpServers` | Auto-approve all project MCP servers |
| `enabledMcpjsonServers` | List of approved servers from `.mcp.json` |
| `disabledMcpjsonServers` | List of rejected servers from `.mcp.json` |
| `allowedMcpServers` | Enterprise allowlist (match by name, command, or URL) |
| `deniedMcpServers` | Enterprise denylist (takes precedence over allowlist) |

### Environment

```typescript
env: EnvironmentVariablesSchema()   // z.record(z.string(), z.coerce.string())
    .optional()
    .describe('Environment variables to set for Claude Code sessions')
```

Environment variables defined in settings are injected into the process environment. Values are coerced to strings.

### Hooks

```typescript
hooks: HooksSchema()
    .optional()
    .describe('Custom commands to run before/after tool executions')
```

Hook events include: `PreToolUse`, `PostToolUse`, `Notification`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStop`, `PreCompact`, `PostCompact`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`.

### Git & Attribution

| Field | Purpose |
|-------|---------|
| `attribution.commit` | Custom text for git commits (empty string hides it) |
| `attribution.pr` | Custom text for PR descriptions |
| `includeCoAuthoredBy` | Deprecated, use `attribution` instead |
| `includeGitInstructions` | Include built-in commit/PR workflow instructions |

### Worktree Configuration

```typescript
worktree: z.object({
  symlinkDirectories: z.array(z.string()).optional(),  // e.g., ["node_modules"]
  sparsePaths: z.array(z.string()).optional(),         // git sparse-checkout paths
})
```

### Sandbox Configuration

The `sandbox` field accepts the `SandboxSettingsSchema` with sub-fields for `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `network`, `filesystem`, `ignoreViolations`, `excludedCommands`, and more.

### Enterprise Customization Lockdown

| Field | Purpose |
|-------|---------|
| `strictPluginOnlyCustomization` | Lock surfaces (`skills`, `agents`, `hooks`, `mcp`) to plugin-only |
| `strictKnownMarketplaces` | Allowlist of marketplace sources (blocks before download) |
| `blockedMarketplaces` | Denylist of marketplace sources |
| `allowManagedHooksOnly` | Only run hooks from managed settings |
| `allowManagedPermissionRulesOnly` | Only respect managed permission rules |
| `allowManagedMcpServersOnly` | Only use admin-defined MCP allowlist |

> **Key Insight:** The `strictPluginOnlyCustomization` field accepts either a boolean (`true` locks all four surfaces) or an array of specific surfaces (`["skills", "hooks"]`). It uses a `preprocess` step that silently drops unknown surface names for forward compatibility -- an old client receiving `["skills", "commands"]` will lock `skills` and ignore `commands` rather than rejecting the entire managed-settings file.

## GlobalConfig (.claude.json)

Defined in `src/utils/config.ts`, GlobalConfig is fundamentally different from Settings. Where Settings is declarative configuration, GlobalConfig is **persistent user state** -- it tracks what has happened, not what should happen.

### Storage

```
~/.claude/.claude.json
```

The file is read and written via `getGlobalConfig()` and `saveGlobalConfig()`, protected by a lockfile for concurrent access. A re-entrancy guard prevents infinite recursion:

```typescript
// Re-entrancy guard: prevents getConfig -> logEvent -> getGlobalConfig -> getConfig
// infinite recursion when the config file is corrupted.
let insideGetConfig = false
```

### Key Fields

**Session Metrics:**
- `numStartups` -- total session count
- Per-project cost/duration/token tracking (`lastCost`, `lastDuration`, `lastTotalInputTokens`, etc.)
- `firstStartTime` -- ISO timestamp of first-ever launch

**Per-Project Config** (`projects` record, keyed by normalized path):
- `allowedTools` -- tools the user has approved for this project
- `mcpServers` -- MCP server configurations
- `hasTrustDialogAccepted` -- whether trust was granted for this directory
- `hasCompletedProjectOnboarding` -- onboarding state
- `activeWorktreeSession` -- worktree session tracking

**UI Preferences:**
- `theme` -- color theme
- `editorMode` -- vim, emacs, etc.
- `diffTool` -- terminal or auto (vscode)
- `autoCompactEnabled` -- auto-compaction toggle
- `showTurnDuration` -- "Cooked for 1m 6s" display
- `todoFeatureEnabled` -- todo panel toggle

**Account Info:**
- `oauthAccount` -- account UUID, email, org info, billing type
- `primaryApiKey` -- stored OAuth API key
- `billingType` -- subscription vs. pay-as-you-go

**Feature Tracking:**
- `hasCompletedOnboarding` -- global onboarding state
- `lastOnboardingVersion` -- tracks version-gated onboarding resets
- `cachedStatsigGates` -- cached feature gate values
- `cachedGrowthBookFeatures` -- cached GrowthBook feature values
- `growthBookOverrides` -- local overrides (ant-only, set via `/config`)

**Plugin & Marketplace State:**
- `officialMarketplaceAutoInstalled` -- whether auto-install succeeded
- `skillUsage` -- usage counts for autocomplete ranking

The GlobalConfig type has well over 100 fields and continues to grow. It serves as the catch-all for any state that needs to survive across sessions.

## Bootstrap State Singleton

Defined in `src/bootstrap/state.ts`, the Bootstrap State is a module-level singleton that holds all ephemeral runtime state for a session. It is created once at import time and never replaced:

```typescript
// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE

const STATE: State = getInitialState()

// ALSO HERE - THINK THRICE BEFORE MODIFYING
function getInitialState(): State {
  // ...~100 fields initialized...
}

// AND ESPECIALLY HERE
```

The three warning comments (at the type definition, the initializer, and the instantiation) reflect the engineering team's awareness that this singleton is a maintenance burden.

### State Categories

**Session Identity:**
- `sessionId` -- UUID for the current session
- `parentSessionId` -- for session lineage (plan mode to implementation)
- `originalCwd` -- working directory at startup (symlink-resolved)
- `projectRoot` -- stable project root, set once, never updated mid-session

**Cost & Usage Tracking:**
- `totalCostUSD`, `totalAPIDuration`, `totalToolDuration`
- `totalLinesAdded`, `totalLinesRemoved`
- `modelUsage` -- per-model token counts
- `turnToolCount`, `turnHookCount`, `turnClassifierCount`

**Model State:**
- `mainLoopModelOverride` -- runtime model override
- `initialMainLoopModel` -- model at session start
- `modelStrings` -- display strings for the current model

**Telemetry (OpenTelemetry):**
- `meter`, `meterProvider`, `tracerProvider`, `loggerProvider`
- Attributed counters: `sessionCounter`, `locCounter`, `prCounter`, `commitCounter`, `costCounter`, `tokenCounter`
- `statsStore` -- for observing metrics
- `eventLogger` -- structured event logger

**Agent State:**
- `agentColorMap` / `agentColorIndex` -- color assignment for sub-agents
- `invokedSkills` -- preservation across compaction
- `registeredHooks` -- SDK callbacks and plugin hooks
- `mainThreadAgentType` -- from `--agent` flag

**Session Flags:**
- `sessionBypassPermissionsMode` -- not persisted
- `sessionTrustAccepted` -- session-only trust for home directory
- `hasExitedPlanMode` -- tracks plan mode exits
- `scheduledTasksEnabled` -- cron task watcher gate

**Beta Header Latching:**
```
afkModeHeaderLatched     -- auto mode beta header
fastModeHeaderLatched    -- fast mode beta header
cacheEditingHeaderLatched -- cached microcompact header
thinkingClearLatched     -- thinking-clear header
```

> **Key Insight:** Once a beta header is sent in a request, it stays on for the rest of the session. This prevents cache key changes mid-session -- toggling a feature on and off would bust the ~50-70K token prompt cache, so the system latches headers to "on" permanently after first activation.

**Plugin & Channel State:**
- `inlinePlugins` -- from `--plugin-dir` flag
- `useCoworkPlugins` -- cowork mode flag
- `allowedChannels` -- channel server allowlist
- `hasDevChannels` -- dev channel flag

**Caching & Optimization:**
- `systemPromptSectionCache` -- avoids re-computing system prompt sections
- `promptCache1hAllowlist` / `promptCache1hEligible` -- prompt cache TTL gating
- `lastApiCompletionTimestamp` -- for cache miss correlation
- `pendingPostCompaction` -- tags first post-compaction API call

**SDK State:**
- `sdkBetas` -- SDK-provided beta strings
- `sdkAgentProgressSummariesEnabled`
- `initJsonSchema` -- structured output schema
- `flagSettingsInline` -- settings injected via SDK

## Feature Flags (GrowthBook)

Claude Code uses the [GrowthBook](https://www.growthbook.io/) SDK for feature flags and experiments, despite some legacy function names referencing Statsig (the previous provider). The implementation lives in `src/services/analytics/growthbook.ts`.

### Architecture

```
  Feature Flag Resolution
  +-------------------------------------------------------+
  |  1. Env var overrides (CLAUDE_INTERNAL_FC_OVERRIDES)   |
  |     (ant-only, for eval harnesses)                     |
  |     |                                                  |
  |     v  (not set? check next)                           |
  |  2. Config overrides (growthBookOverrides in .claude)   |
  |     (ant-only, set via /config Gates tab)              |
  |     |                                                  |
  |     v  (not set? check next)                           |
  |  3. In-memory remote eval values                       |
  |     (fetched from API, processed into local cache)     |
  |     |                                                  |
  |     v  (not available? check next)                     |
  |  4. Disk-cached values (cachedGrowthBookFeatures)      |
  |     (in GlobalConfig, synced after successful fetch)   |
  +-------------------------------------------------------+
```

### User Attributes

GrowthBook targeting uses these attributes:

```typescript
export type GrowthBookUserAttributes = {
  id: string                   // Device ID
  sessionId: string
  deviceID: string
  platform: 'win32' | 'darwin' | 'linux'
  apiBaseUrlHost?: string      // For enterprise proxy targeting
  organizationUUID?: string
  accountUUID?: string
  userType?: string            // 'ant' for internal users
  subscriptionType?: string
  rateLimitTier?: string
  firstTokenTime?: number
  email?: string
  appVersion?: string
  github?: GitHubActionsMetadata
}
```

### Remote Eval with Caching

GrowthBook is configured with `remoteEval: true`, meaning the server pre-evaluates all features for the given user attributes and returns the results. The client caches these values in two places:

1. **In-memory** (`remoteEvalFeatureValues` Map) -- authoritative for the current session
2. **On disk** (`cachedGrowthBookFeatures` in GlobalConfig) -- fallback for offline/timeout scenarios

A workaround exists for an API response format issue where the server returns `{ "value": ... }` instead of `{ "defaultValue": ... }`:

```typescript
// WORKAROUND: Transform remote eval response format
const f = feature as MalformedFeatureDefinition
if ('value' in f && !('defaultValue' in f)) {
  transformedFeatures[key] = { ...f, defaultValue: f.value }
}
```

### Exposure Tracking and Deduplication

Experiment exposures are logged at most once per session per feature:

```typescript
const loggedExposures = new Set<string>()

function logExposureForFeature(feature: string): void {
  if (loggedExposures.has(feature)) return
  const expData = experimentDataByFeature.get(feature)
  if (expData) {
    loggedExposures.add(feature)
    logGrowthBookExperimentTo1P({ ... })
  }
}
```

Features accessed before initialization completes are tracked in `pendingExposures` and logged retroactively once the remote eval payload arrives.

### Compile-Time Feature Flags

In addition to runtime GrowthBook flags, Claude Code uses compile-time feature flags via Bun's `feature()` from `bun:bundle`:

```typescript
import { feature } from 'bun:bundle'

// Dead code elimination -- unused branches are removed at build time
if (feature('TRANSCRIPT_CLASSIFIER')) {
  // Auto mode code, only in builds that enable this feature
}
```

These are distinct from GrowthBook runtime flags. They enable dead code elimination at build time, so features gated behind `feature()` do not exist in the compiled output unless the build configuration enables them. Examples seen in the codebase:

| Compile-Time Flag | Purpose |
|-------------------|---------|
| `TRANSCRIPT_CLASSIFIER` | Auto mode / permission classifier |
| `TEAMMEM` | Teammate memory paths |
| `CCR_AUTO_CONNECT` | Bridge auto-connect |

### Refresh and Subscriber Pattern

Systems that bake feature values into long-lived objects (like the event logger's batch config) can subscribe to refresh events:

```typescript
export function onGrowthBookRefresh(
  listener: GrowthBookRefreshListener,
): () => void {
  // Fires on every refresh; subscriber does own change detection
  const unsubscribe = refreshed.subscribe(() => callSafe(listener))
  // Catch-up: if init already completed, fire once on next microtask
  if (remoteEvalFeatureValues.size > 0) {
    queueMicrotask(() => { if (subscribed) callSafe(listener) })
  }
  return unsubscribe
}
```

This handles the race condition where GrowthBook's network response lands before subscribers register (~100ms init vs ~600ms REPL mount in some configurations).

## Key Takeaways

1. **Three distinct systems serve three purposes.** Settings is declarative config (what should happen), GlobalConfig is persistent state (what has happened), and Bootstrap State is ephemeral session state (what is happening now). Mixing these up leads to bugs.

2. **Settings merge from five sources with plugin settings as the base.** The priority order is plugin < user < project < local < flag < policy. Policy and flag settings are always enabled and cannot be disabled.

3. **Policy settings use "first non-empty wins" internally.** Remote settings beat MDM, which beats file-based managed settings, which beats HKCU. Drop-in directories (`managed-settings.d/`) allow multiple teams to ship policy fragments independently.

4. **Array merge semantics differ by context.** Cross-source merges concatenate and deduplicate arrays (accumulating rules). Single-file updates replace arrays entirely. This subtlety is the source of real bugs if misunderstood.

5. **Zod validation degrades gracefully.** Invalid fields are ignored, valid portions are used. Invalid permission rules are stripped before schema validation so one bad rule does not null the entire file.

6. **Beta headers latch on permanently.** Once a beta header (auto mode, fast mode, cache editing) is sent in an API request, it stays on for the session. This prevents prompt cache busting from feature toggles.

7. **GrowthBook replaced Statsig but legacy names remain.** The field `cachedStatsigGates` in GlobalConfig and various function names still reference Statsig. The actual SDK is GrowthBook with remote evaluation and disk-cached fallbacks.

8. **Compile-time and runtime feature flags coexist.** `feature()` from `bun:bundle` enables dead code elimination at build time. GrowthBook handles runtime targeting. They serve different purposes and are not interchangeable.

9. **GlobalConfig has a re-entrancy guard.** The `insideGetConfig` flag prevents `getConfig -> logEvent -> getGlobalConfig -> getConfig` infinite recursion when analytics sampling tries to read feature flags during config loading.

10. **Bootstrap State is a recognized tech debt.** The three warning comments ("DO NOT ADD MORE STATE HERE", "THINK THRICE BEFORE MODIFYING", "AND ESPECIALLY HERE") acknowledge that the ~100-field singleton is a maintenance burden, but it persists because it solves the practical problem of making session state available everywhere without prop drilling.
