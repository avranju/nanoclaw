# Provider Decoupling: Multi-LLM Support

> Proposal to decouple NanoClaw from the Claude Agent SDK, enabling any LLM or coding agent provider to be used per-group.

## Status

**Proposal** — not yet implemented.

## Current State

The host orchestrator (`src/`) communicates with agent containers via a **provider-agnostic protocol**: JSON over stdin, structured results over stdout markers (`OUTPUT_START_MARKER`/`OUTPUT_END_MARKER`). The host already doesn't know about Claude internals.

All Claude-specific code is concentrated inside the container:

| Component | Coupling Level | What's Claude-Specific |
|-----------|---------------|----------------------|
| `container/agent-runner/src/index.ts` | **Heavy** | `@anthropic-ai/claude-agent-sdk` `query()`, tool names, hooks, message types, session model |
| `container/Dockerfile` | **Medium** | `npm install -g @anthropic-ai/claude-code` |
| `src/container-runner.ts` | **Light** | `.claude/` session dirs, `CLAUDE_CODE_*` env vars, skills sync to `.claude/skills/` |
| `src/credential-proxy.ts` | **Medium** | Anthropic API auth patterns (`x-api-key`, OAuth token exchange) |
| `src/remote-control.ts` | **Full** | Spawns `claude remote-control` CLI, parses `claude.ai` URLs |
| `CLAUDE.md` / skills | **Convention** | Claude Code auto-loads these; other agents need explicit loading |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | **None** | MCP is an open protocol — works with any MCP-compatible agent |

## Design Principle

**Treat the container boundary as the abstraction layer.**

Rather than building TypeScript interfaces inside a single container, we create **separate container images per provider**. Each image contains its own agent runner implementation but shares the same:

- `ContainerInput`/`ContainerOutput` stdin/stdout protocol
- MCP server (`ipc-mcp-stdio.ts`) for NanoClaw tools
- IPC file conventions for host communication

This keeps each provider self-contained with its own dependencies and avoids a lowest-common-denominator abstraction that loses provider-specific capabilities.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Host Orchestrator (src/)                            │
│                                                      │
│  index.ts ─► container-runner.ts ─► spawn container  │
│                    │                                  │
│          ┌────────┴────────┐                         │
│          │ provider config │                         │
│          └────────┬────────┘                         │
│                   │                                  │
│    ┌──────────────┼──────────────┐                   │
│    ▼              ▼              ▼                    │
│  claude:latest  openai:latest  custom:latest         │
│  (container)    (container)    (container)           │
│                                                      │
│  Each container implements:                          │
│  - Reads ContainerInput from stdin                   │
│  - Writes ContainerOutput to stdout markers          │
│  - Runs ipc-mcp-stdio.ts for NanoClaw tools         │
│  - Polls /workspace/ipc/input/ for follow-ups        │
└──────────────────────────────────────────────────────┘
```

## Container Protocol (unchanged)

The existing protocol is already provider-agnostic. No changes needed.

### Input (stdin)

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}
```

### Output (stdout, wrapped in markers)

```typescript
interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}
```

### IPC (filesystem)

- `/workspace/ipc/input/*.json` — follow-up messages piped during a running session
- `/workspace/ipc/input/_close` — sentinel to end the session
- `/workspace/ipc/messages/*.json` — outbound messages (via MCP `send_message`)
- `/workspace/ipc/tasks/*.json` — task scheduling commands (via MCP tools)

## Changes Required

### 1. Add `provider` to Group Config

Each registered group specifies which provider to use. Defaults to `claude` for backward compatibility.

```typescript
// src/types.ts
interface RegisteredGroup {
  name: string;
  folder: string;
  isMain?: boolean;
  trigger?: string;
  requiresTrigger?: boolean;
  provider?: string;           // NEW: "claude" | "openai" | "aider" | custom
  containerConfig?: {
    timeout?: number;
    additionalMounts?: string[];
  };
}
```

### 2. Map Providers to Container Images

```typescript
// src/config.ts
export const PROVIDER_IMAGES: Record<string, string> = {
  claude: process.env.CONTAINER_IMAGE_CLAUDE || 'nanoclaw-agent-claude:latest',
  openai: process.env.CONTAINER_IMAGE_OPENAI || 'nanoclaw-agent-openai:latest',
  // Fallback: use the value directly as an image name
};

export function getContainerImage(provider?: string): string {
  const p = provider || 'claude';
  return PROVIDER_IMAGES[p] || p;
}
```

### 3. Generalize `container-runner.ts`

Replace Claude-specific conventions with provider-agnostic ones.

#### Session directories

```diff
- const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
+ const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, 'agent-config');
```

#### Settings file

Move from Claude Code's `settings.json` to a generic `provider.json` that each container interprets:

```typescript
// Written by host, read by container
interface ProviderConfig {
  provider: string;
  // Provider-specific settings passed through opaquely
  settings: Record<string, unknown>;
}
```

Claude containers read `provider.json` and map it back to `.claude/settings.json`. Other containers read what they need.

#### Container image selection

```diff
- args.push(CONTAINER_IMAGE);
+ args.push(getContainerImage(group.provider));
```

#### Skills directory

Instead of syncing to `.claude/skills/`, sync to a generic `/workspace/skills/` mount. Each provider's entrypoint is responsible for loading skills in its own format, or can read them as plain markdown.

### 4. Generalize Credential Proxy

Support multiple upstream targets based on the provider.

```typescript
interface ProxyRoute {
  provider: string;
  upstream: string;           // e.g., "https://api.anthropic.com"
  authHeader: string;         // e.g., "x-api-key" or "Authorization"
  authValue: string;          // the secret
  authPrefix?: string;        // e.g., "Bearer " for Authorization header
}
```

Or, simpler: **remove the credential proxy entirely** and rely on OneCLI for all credential injection. OneCLI already handles this for containers and is provider-agnostic.

### 5. Make Remote Control Optional

Remote control is a Claude-only feature. Gate it behind the provider check:

```typescript
// In handleRemoteControl()
if (group.provider && group.provider !== 'claude') {
  await channel.sendMessage(chatJid, 'Remote control is only available with the Claude provider.');
  return;
}
```

### 6. Create Provider Container Templates

Each provider gets its own directory under `container/`:

```
container/
├── shared/                    # Shared across all providers
│   ├── ipc-mcp-stdio.ts      # MCP server (moved from agent-runner/)
│   └── protocol.ts           # ContainerInput/Output types
├── claude/                    # Claude provider
│   ├── Dockerfile
│   ├── agent-runner/
│   │   ├── package.json       # depends on @anthropic-ai/claude-agent-sdk
│   │   └── src/index.ts       # current agent-runner, uses query()
│   └── build.sh
├── openai/                    # OpenAI provider (example)
│   ├── Dockerfile
│   ├── agent-runner/
│   │   ├── package.json       # depends on openai SDK
│   │   └── src/index.ts       # implements same stdin/stdout protocol
│   └── build.sh
└── build-all.sh               # Builds all provider images
```

Each provider's `agent-runner/src/index.ts` must:

1. Read `ContainerInput` from stdin
2. Run the agent with its provider-specific SDK
3. Emit `ContainerOutput` via `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER`
4. Start the shared MCP server for NanoClaw tools
5. Poll `/workspace/ipc/input/` for follow-up messages
6. Exit on `_close` sentinel

### 7. Rename `CLAUDE.md` Convention (Optional)

This is low-priority. `CLAUDE.md` is well-understood and can simply be loaded explicitly by non-Claude agents:

```typescript
// In any provider's agent runner
const memoryFile = '/workspace/group/CLAUDE.md';
if (fs.existsSync(memoryFile)) {
  systemPrompt += '\n\n' + fs.readFileSync(memoryFile, 'utf-8');
}
```

Alternatively, rename to `AGENT.md` with a symlink for backward compatibility:

```bash
# In entrypoint.sh
[ -f /workspace/group/CLAUDE.md ] && ln -sf CLAUDE.md /workspace/group/AGENT.md
```

## Implementation Order

| Phase | Task | Effort | Delivers |
|-------|------|--------|----------|
| 1 | Add `provider` field to `RegisteredGroup`, default to `"claude"` | 1 hour | Schema ready, zero behavior change |
| 2 | Map `provider` → container image in `container-runner.ts` | 2 hours | Different groups can use different images |
| 3 | Extract `ipc-mcp-stdio.ts` and protocol types to `container/shared/` | 2 hours | Reusable across providers |
| 4 | Move current `container/` to `container/claude/`, update `build.sh` | 3 hours | Clean separation |
| 5 | Generalize session dirs and settings in `container-runner.ts` | 4 hours | Remove `.claude/` assumptions |
| 6 | Gate remote-control behind provider check | 30 min | Clean provider boundaries |
| 7 | Generalize or remove credential proxy | 4 hours | Multi-provider auth |
| 8 | Build first alternative provider (e.g., OpenAI Codex) | 2-3 days | Proves the abstraction |
| **Total** | | **~5-6 days** | |

Phases 1–4 can ship as a single PR with no behavior change (all groups default to `claude`). Phases 5–7 are refinements. Phase 8 is the validation.

## Migration

Zero breaking changes. All existing groups default to `provider: "claude"` and use the same container image. The `register_group` MCP tool gains an optional `provider` parameter. Existing `CLAUDE.md` files, skills, and sessions continue to work.

## Open Questions

1. **Session portability** — Can a group switch providers mid-conversation? Probably not (session formats differ). Switching providers should start a fresh session.
2. **Tool compatibility** — Claude Code provides `Bash`, `Read`, `Write`, etc. as built-in tools. Other providers need equivalent tool implementations. The MCP tools (`send_message`, `schedule_task`, etc.) work everywhere since MCP is an open standard.
3. **Skill format** — Claude Code skills are markdown files in `.claude/skills/`. Other providers may need different formats. Could standardize on plain markdown that each provider interprets.
4. **Context window management** — Claude SDK handles compaction automatically via `PreCompact` hooks. Other providers need their own context management strategy.
