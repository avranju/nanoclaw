# 02 — Codex agent provider

**Intent:** Use OpenAI Codex (`codex app-server` over JSON-RPC stdio) as an alternative agent provider, alongside the default Claude provider. Per-session `~/.codex` directory, auth.json copy from host, runtime-rewritten `config.toml` for MCP, native skill discovery via `$CODEX_HOME/skills`, and skill-roster fingerprinting that invalidates resumed threads when shared skills change.

**Status:** Net-new in source code. Upstream only ships the `add-codex` skill *documentation* at `.claude/skills/add-codex/SKILL.md` — the actual implementation files (host config + container provider + app-server transport + skill fingerprinting) are fork additions that resulted from running that skill historically.

**IMPORTANT pre-check:** Before applying, verify that upstream's current `add-codex` skill hasn't started shipping the implementation itself. If upstream has added any of the files below, prefer upstream's version and skip the corresponding copy step. As of guide generation:
- `git ls-tree -r --name-only upstream/main | grep -i codex` returned only `.claude/skills/add-codex/SKILL.md` — no implementation files. Safe to copy.

---

## Files to copy

| File | Status |
|------|--------|
| `src/providers/codex.ts` | net-new — host-side container config |
| `src/providers/index.ts` | modified — add `import './codex.js';` |
| `container/agent-runner/src/providers/codex.ts` | net-new — provider impl, JSON-RPC client to app-server |
| `container/agent-runner/src/providers/codex-app-server.ts` | net-new — stdio JSON-RPC transport primitives |
| `container/agent-runner/src/providers/codex.factory.test.ts` | net-new — tests |
| `container/agent-runner/src/providers/index.ts` | modified — add `import './codex.js';` |
| `container/agent-runner/src/codex-skills.ts` | net-new — skill-roster fingerprinting + thread invalidation |
| `container/Dockerfile` | modified — install `@openai/codex@${CODEX_VERSION}` globally |

The fork has these already; copy them straight from the fork tree into the worktree at the same paths.

---

## How to apply

1. **Copy the source files** above from the fork into the worktree at identical paths.

2. **Register on host:** ensure `src/providers/index.ts` includes the codex import. Expected minimum content (preserve any other entries upstream adds):
   ```typescript
   // Host-side provider container-config barrel.
   // Skills add a new provider by appending one import line below.
   import './codex.js';
   ```

3. **Register in container:** ensure `container/agent-runner/src/providers/index.ts` includes the codex import. Expected minimum:
   ```typescript
   // Provider self-registration barrel.
   import './claude.js';
   import './codex.js';
   import './mock.js';
   ```

4. **Dockerfile edits:** in `container/Dockerfile`, add (or preserve) the build arg and the global install. The version is currently pinned to 0.124.0:
   ```dockerfile
   ARG CODEX_VERSION=0.124.0

   # ...later, in the global install section alongside vercel/agent-browser/claude-code:
   RUN --mount=type=cache,target=/root/.cache/pnpm \
       pnpm install -g "@openai/codex@${CODEX_VERSION}"
   ```
   These should sit next to the other `pnpm install -g` blocks — do not invent a new layer.

5. **Wire up skill mirroring (cross-reference):** the per-session `codex/skills/` symlink farm is created by `syncContainerSkillSymlinks()` in `src/container-runner.ts`. That call is part of `04-container-runtime.md` — apply that section before relying on shared skills inside Codex sessions.

6. **No package.json change required.** `@openai/codex` is installed at the container layer via pnpm, not as a project dependency.

---

## How it's invoked at runtime

Selection priority (highest first):
1. Group's `groups/<name>/container.json` has `"provider": "codex"`.
2. Session-level provider override.
3. `AGENT_PROVIDER=codex` env var (global default).

The default current-fork `groups/main/container.json` ships with `"provider": "codex"` — that file is in a data dir and is preserved automatically by the worktree swap.

Per-session host-side hook (in `src/providers/codex.ts`):
- Creates `data/sessions/<group>/codex/` directory.
- Copies `~/.codex/auth.json` from host into the per-session dir if present.
- Passes through env vars: `OPENAI_API_KEY`, `CODEX_MODEL`, `OPENAI_BASE_URL`.

In-container behavior (in `container/agent-runner/src/providers/codex.ts`):
- Spawns `codex app-server` over stdio.
- Speaks JSON-RPC: `initialize`, `thread/resume`, `thread/turn`, etc.
- Auto-approves tool calls per attached approval policy.
- Rewrites `~/.codex/config.toml` at every spawn with container-appropriate MCP server config.
- Inlines `@imports` from CLAUDE.md into the system prompt (Codex doesn't follow `@./` references the way Claude SDK does).
- Holds turn-mid `push()` calls in a queue and drains between turns.
- 5-minute per-turn timeout.
- On thread resume errors matching `STALE_THREAD_RE`, silently falls back to a fresh thread.

Skill-roster invalidation (in `container/agent-runner/src/codex-skills.ts`):
- Computes SHA256 across `$CODEX_HOME/skills/*/SKILL.md` contents.
- Stores the fingerprint in session state under `codex:nanoclaw-skills-fingerprint`.
- On next resume, if the fingerprint changed, the stored continuation is cleared so Codex starts a fresh thread and re-snapshots the skill roster.

---

## Verification

1. Container image builds cleanly: `./container/build.sh`. Look for the `pnpm install -g @openai/codex@0.124.0` step in the build log.
2. Inside a built container: `which codex` should resolve, and `codex --version` should print `0.124.0` (or whatever `CODEX_VERSION` is set to).
3. Set `OPENAI_API_KEY` in `.env` (or have a valid `~/.codex/auth.json` on host with a Codex subscription token).
4. Confirm `groups/main/container.json` has `"provider": "codex"`.
5. Send a message that triggers the agent. Logs should show `Starting v2 agent-runner (provider: codex)` and `[codex-app-server] ...` traffic.
6. Add a new file to `container/skills/` mid-session (e.g. `container/skills/test-skill/SKILL.md`), send another message — logs should show the skill fingerprint changing and the existing Codex thread being abandoned in favor of a fresh one.

---

## Notes on upstream interaction

- The user's `4c045fe` ("Sync container skills into Codex provider") is the most recent commit in this area — its content is what `02-codex-provider.md` describes. After upstream merge, if upstream has independently changed how `container/skills/` is exposed to providers, the symlink-sync logic may need a small adjustment. Check `src/container-skills.ts` and `src/container-runner.ts` for diffs from upstream before assuming the fork's version is correct.
- The `add-codex` skill at `.claude/skills/add-codex/SKILL.md` should NOT be re-run after migration — its purpose is to scaffold the implementation files, which we're copying directly.
