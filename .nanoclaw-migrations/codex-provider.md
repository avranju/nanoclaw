# Codex Agent Provider

## Intent

Add OpenAI Codex as an agent provider alongside Claude. The user's host `~/.codex/auth.json` is used for authentication. Codex runs via `codex app-server` inside the container.

## Files

### Host-side (src/)

#### `src/providers/codex.ts` — NEW FILE

Host-side container config for the `codex` provider. Copies `~/.codex/auth.json` into the per-session directory and passes through `OPENAI_API_KEY`, `CODEX_MODEL`, and `OPENAI_BASE_URL` env vars.

```typescript
/**
 * Host-side container config for the `codex` provider.
 *
 * Codex reads auth and MCP config from ~/.codex. We give each session its
 * own private copy of that directory so:
 *
 * - The user's host ~/.codex/auth.json reaches the container without us
 *   touching their host config.toml (which the host's own `codex` CLI
 *   might be using).
 * - The in-container provider can rewrite config.toml freely on every
 *   wake with container-appropriate MCP server paths, without racing
 *   other sessions or leaking per-session paths back to the host.
 *
 * Env passthrough covers the two knobs that are read at runtime:
 *   OPENAI_API_KEY  — fallback auth when auth.json isn't a subscription token
 *   CODEX_MODEL     — model override if the user wants something other than the default
 *   OPENAI_BASE_URL — rare, but supports API-compatible alternates
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  // Copy the host's auth.json into the per-session dir if it exists.
  // We only copy auth.json, not the full ~/.codex — config.toml would
  // get clobbered by the container on every wake anyway.
  const hostHome = ctx.hostEnv.HOME;
  if (hostHome) {
    const hostAuth = path.join(hostHome, '.codex', 'auth.json');
    if (fs.existsSync(hostAuth)) {
      fs.copyFileSync(hostAuth, path.join(codexDir, 'auth.json'));
    }
  }

  const env: Record<string, string> = {};
  for (const key of [
    'OPENAI_API_KEY',
    'CODEX_MODEL',
    'OPENAI_BASE_URL',
  ] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [
      {
        hostPath: codexDir,
        containerPath: '/home/node/.codex',
        readonly: false,
      },
    ],
    env,
  };
});
```

#### `src/providers/index.ts` — MODIFY

Append this import line to the barrel file (after existing imports, before the closing comment):

```typescript
import './codex.js';
```

Note: The upstream barrel file already exists but is empty (no imports). The comment in the file says "Skills add a new provider by appending one import line below."

#### `src/providers/provider-container-registry.ts` — NO CHANGE

This file already exists in upstream with the same content. No modification needed.

### Container-side (container/agent-runner/src/)

#### `container/agent-runner/src/providers/codex.ts` — NEW FILE

The in-container Codex provider implementation. Wraps `codex app-server` via JSON-RPC. Implements:
- System prompt assembly with `@<path>` import resolution
- Thread management (start/resume with stale thread detection)
- Turn-based event streaming
- 5-minute hard timeout per turn

Key functions:
- `resolveClaudeImports(content, baseDir, seen)` — Expands `@<path>` directives in CLAUDE.md files
- `readAgentAndGlobalClaudeMd()` — Reads per-group CLAUDE.md and CLAUDE.local.md
- `composeBaseInstructions(promptAddendum)` — Composes the system prompt
- `CodexProvider` class — Implements `AgentProvider` interface
- `runOneTurn()` — Per-turn event pump with JSON-RPC notification handling

The provider registers itself via `registerProvider('codex', (opts) => new CodexProvider(opts))`.

#### `container/agent-runner/src/providers/codex-app-server.ts` — NEW FILE

JSON-RPC transport layer for `codex app-server`. Contains:
- `spawnCodexAppServer(configOverrides)` — Spawns `codex app-server --listen stdio://`
- `sendCodexRequest()` / `sendCodexResponse()` — JSON-RPC request/response
- `attachCodexAutoApproval()` — Auto-approves all Codex approval prompts (sandbox is the security boundary)
- `initializeCodexAppServer()` — Sends `initialize` JSON-RPC call
- `startOrResumeCodexThread()` — Thread start/resume with stale thread fallback
- `startCodexTurn()` — Starts a turn
- `writeCodexMcpConfigToml(servers)` — Writes `~/.codex/config.toml` for MCP server discovery
- `createCodexConfigOverrides()` — Returns `['features.use_linux_sandbox_bwrap=false']`
- `tomlBasicString()` — Escapes strings for TOML basic strings
- `STALE_THREAD_RE` — Regex for detecting stale thread errors: `/thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread/i`

#### `container/agent-runner/src/providers/codex.factory.test.ts` — NEW FILE

Unit tests for the Codex provider factory. Tests provider creation and configuration.

#### `container/agent-runner/src/providers/index.ts` — NEW FILE (or MODIFY if exists)

Provider self-registration barrel. Append `import './codex.js';` after the existing imports:

```typescript
// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Skills add a new provider by appending one import line below.

import './claude.js';
import './codex.js';
import './mock.js';
```

Note: Check if this file exists in upstream. If it does, only add the codex import. If it doesn't, create the file with the above content.

#### `container/agent-runner/src/codex-skills.ts` — NEW FILE

Skill fingerprinting for Codex continuation invalidation. When NanoClaw adds or changes shared container skills, Codex threads that were resumed from old state have stale skill rosters. This module:
- Computes a SHA-256 fingerprint of all skills in `~/.codex/skills/`
- Stores the fingerprint in session state
- On each poll, compares fingerprint and clears the Codex continuation if changed
- Forces Codex to start a fresh thread with the updated skill roster

Key export: `invalidateCodexContinuationOnSkillChange(continuation)` — Returns `undefined` (force fresh thread) if skills changed, otherwise returns the continuation unchanged.

#### `container/agent-runner/src/db/session-state.ts` — MODIFY

Add the Codex fingerprint key constant. This file already exists in upstream. Look for the session state key definitions and add:

```typescript
const CODEX_SKILLS_FINGERPRINT_KEY = 'codex:nanoclaw-skills-fingerprint';
```

Then ensure `getStateValue()` and `setStateValue()` are used by `codex-skills.ts`.

#### `container/agent-runner/src/poll-loop.ts` — MODIFY

Import and call `invalidateCodexContinuationOnSkillChange` from `codex-skills.ts` when processing pending messages. The function should be called with the current continuation before starting a new turn.

#### `src/container-runner.ts` — MODIFY

Add Codex skill synchronization. When spawning a container for the Codex provider, sync the shared container skills into `~/.codex/skills/` in the session directory.

#### `src/container-skills.test.ts` — NEW FILE

Tests for container skill synchronization, including Codex skill fingerprinting.

#### `src/container-skills.ts` — MODIFY

Add Codex-specific skill sync logic. The `syncContainerSkillSymlinks` function should also handle Codex's `~/.codex/skills/` directory when the provider is `codex`.

### Dockerfile

#### `container/Dockerfile` — MODIFY

Add Codex version pinning. In the build-time arguments section, add:

```dockerfile
ARG CODEX_VERSION=0.124.0
```

Add Codex installation in the pnpm install section:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@openai/codex@${CODEX_VERSION}"
```

### Container CLAUDE.md

The `container/CLAUDE.md` file exists and is identical to upstream. No changes needed.

## How to apply

1. Create `src/providers/codex.ts` with the full file content above
2. Append `import './codex.js';` to `src/providers/index.ts`
3. Create `container/agent-runner/src/providers/codex.ts` with the full file content above
4. Create `container/agent-runner/src/providers/codex-app-server.ts` with the full file content above
5. Create `container/agent-runner/src/providers/codex.factory.test.ts` with the test file content
6. Append `import './codex.js';` to `container/agent-runner/src/providers/index.ts` (create file if missing)
7. Create `container/agent-runner/src/codex-skills.ts` with the full file content above
8. Add `CODEX_SKILLS_FINGERPRINT_KEY` constant to `container/agent-runner/src/db/session-state.ts`
9. Import and call `invalidateCodexContinuationOnSkillChange` in `container/agent-runner/src/poll-loop.ts`
10. Add Codex skill sync logic to `src/container-skills.ts` and `src/container-runner.ts`
11. Add Codex version pinning and installation to `container/Dockerfile`
12. Create `src/container-skills.test.ts` with the test file content

## Notes

- The Codex provider is a full replacement for the Claude provider — it's not a tool, it's an alternative agent runtime
- Codex runs via `codex app-server` (JSON-RPC over stdio), not via the OpenAI SDK
- Auth is via `~/.codex/auth.json` (OpenAI subscription token) or `OPENAI_API_KEY` env var
- MCP servers are configured via `~/.codex/config.toml`, rewritten on every container spawn
- All approval prompts are auto-approved (the container sandbox is the security boundary)
