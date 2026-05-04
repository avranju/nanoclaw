# 04 — Container runtime additions

All edits in this section live in `src/container-runner.ts` (host-side) plus the small `src/container-skills.ts` helper. They add mounts and skill-sync logic to the container spawn path.

`container-runner.ts` is one of the most-edited files upstream-side too. After upstream merge, the file structure may have shifted — locate the equivalent injection sites in the new file rather than blindly replacing chunks.

---

## 4.1 SSH key passthrough

**Intent:** Mount the host user's `~/.ssh/` directory into every container at `/home/node/.ssh` (read-only) so the agent can SSH to remote hosts using the user's identity keys. Pairs with the SSH MCP server (`03-mcp-servers.md`) but is also useful standalone for any `Bash` SSH the agent does.

**Files:** `src/container-runner.ts`

**How to apply:**

In the `buildMounts()` function (or whatever upstream's equivalent is), add this block alongside the other host-derived mount additions:

```typescript
// SSH keys — read-only so agents can SSH to remote hosts.
const sshDir = path.join(os.homedir(), '.ssh');
if (fs.existsSync(sshDir)) {
  mounts.push({
    hostPath: sshDir,
    containerPath: '/home/node/.ssh',
    readonly: true,
  });
}
```

Required imports at top of file (likely already present):
```typescript
import os from 'os';
import path from 'path';
import fs from 'fs';
```

The exact location in the fork is `src/container-runner.ts` lines 445–453, immediately after the per-session/group standard mounts and before the Telegram-incoming mount. Adjust to the equivalent location in the upgraded file.

**Verification:**

Inside a running container: `ls /home/node/.ssh/` should list the host's SSH keys (read-only). `ssh -T git@github.com` (or any remote) should authenticate using one of those keys.

---

## 4.2 Telegram incoming attachments mount

**Intent:** Telegram's channel adapter writes downloaded photos/documents to `data/telegram-incoming/` on the host. Mount that directory into every container at `/workspace/telegram-incoming` (read-only) so the agent can read attachments by `localPath`.

**Files:** `src/container-runner.ts`

**How to apply:**

Add this block in `buildMounts()` immediately after the SSH key mount block:

```typescript
// Telegram incoming attachments — shared read-only so the agent can access
// images and files sent via Telegram without per-group copies.
const telegramIncomingDir = path.join(DATA_DIR, 'telegram-incoming');
if (fs.existsSync(telegramIncomingDir)) {
  mounts.push({
    hostPath: telegramIncomingDir,
    containerPath: '/workspace/telegram-incoming',
    readonly: true,
  });
}
```

`DATA_DIR` is the existing constant at the top of `container-runner.ts` (or imported from `config.ts`). If upstream renamed it, adapt accordingly.

The host directory is auto-created by Telegram's adapter on first download — no migration step needed for the directory itself. `data/` is preserved through the worktree swap.

**Verification:**

Send a photo via Telegram → check `data/telegram-incoming/<filename>` exists on host → from inside the container, `ls /workspace/telegram-incoming/` shows the same filename.

---

## 4.3 Container skills sync (symlink farm)

**Intent:** Expose `container/skills/*` (NanoClaw shared agent-facing skills) to both the Claude SDK (`~/.claude/skills/`) and the Codex provider (`$CODEX_HOME/skills/`) at runtime via dangling symlinks pointing at `/app/skills/<name>` (the path inside the image where `container/skills/` is COPYed). This avoids rebuilding the image when skills are added or changed.

**Files:**
- `src/container-skills.ts` (helper) — net-new
- `src/container-runner.ts` — modified, calls the helper

**How to apply:**

1. Copy `src/container-skills.ts` from the fork verbatim. It exports two functions:
   - `resolveEnabledContainerSkills(projectRoot, containerConfig): string[]` — returns the list of enabled skill directory names. `containerConfig.skills === 'all'` is evaluated at spawn time by reading `container/skills/`; an explicit array is treated as the authoritative allowlist.
   - `syncContainerSkillSymlinks(targetDir, projectRoot, containerConfig): void` — creates `<targetDir>/<skillName>` symlinks pointing at `/app/skills/<skillName>` (dangling on host, valid after image mount).

2. In `src/container-runner.ts`, before the per-session mounts are pushed, call the sync helper twice — once for the Claude SDK skills dir and once for the Codex skills dir if the active provider is `codex`:

   ```typescript
   syncContainerSkillSymlinks(
     path.join(claudeDir, 'skills'),
     projectRoot,
     containerConfig,
   );

   // Codex discovers user skills from $CODEX_HOME/skills, not from
   // ~/.claude/skills. Mirror the same shared NanoClaw skills into the
   // per-session Codex home so `container/skills/*/SKILL.md` shows up as
   // native Codex skills without baking them into the image.
   if (provider === 'codex') {
     syncContainerSkillSymlinks(
       path.join(sessDir, 'codex', 'skills'),
       projectRoot,
       containerConfig,
     );
   }
   ```

   `claudeDir`, `sessDir`, `projectRoot`, `containerConfig`, and `provider` are all local variables already in scope at the relevant point in `buildMounts()` / `prepareContainerSession()`. Match upstream's variable names.

3. Add the import at the top:
   ```typescript
   import { syncContainerSkillSymlinks } from './container-skills.js';
   ```

**Important constants in `container-skills.ts`:**

```typescript
const CONTAINER_SKILLS_SUBPATH = path.join('container', 'skills');
const CONTAINER_SKILLS_TARGET_BASE = '/app/skills';
```

If upstream changes where `container/skills/` is COPYed inside the image, `CONTAINER_SKILLS_TARGET_BASE` must change to match. Verify with `grep COPY container/Dockerfile | grep skills`.

**Verification:**

1. Add a new skill directory: `mkdir container/skills/foo && echo '# foo' > container/skills/foo/SKILL.md`.
2. Trigger a container spawn (send a message to the bot).
3. From inside the container: `ls -la /home/node/.claude/skills/foo` should show a symlink → `/app/skills/foo`. The `SKILL.md` should be readable through the symlink.
4. (Codex only) `ls -la $CODEX_HOME/skills/foo` shows the same symlink in the Codex home.

---

## 4.4 What's NOT in this migration

These were considered and explicitly skipped per user request:

- **Anthropic-compatible endpoint passthrough** (commit `ef1caa9`) — would have added env passthrough for `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `NANOCLAW_MODEL` in `container-runner.ts` plus mirror changes in `setup/verify.ts` and `setup/environment.test.ts`. **Skip.**
- **`get_context_usage` MCP tool** (commit `6170369`) — would have added token tracking in `container/agent-runner/src/index.ts` and a tool definition in `ipc-mcp-stdio.ts`. **Skip.**

Do not attempt to reapply either. If grep finds references to `ANTHROPIC_BASE_URL`, `NANOCLAW_MODEL`, or `get_context_usage` in the fork's HEAD and they're tied to these features, leave them out of the new tree.
