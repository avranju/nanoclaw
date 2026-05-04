# NanoClaw Migration Guide

Generated: 2026-05-04T17:17Z
Base (merge-base with upstream/main): `8f91d3be576b830081f2a802e2f2d426b010f8f7`
HEAD at generation: `4c045fed175fb2c44abbcefb950b556173b8594d`
Upstream/main at generation: `1404f7feb632fca83dcd0cfe81a09d5be7763dc1`

This is a Tier 3 migration. The fork is far ahead of base (1160 upstream commits, 72 user commits, ~30 of which are real customizations). The reapply order matters; follow the migration plan.

---

## Migration plan

Reapply customizations in this order on a fresh `upstream/main` checkout:

1. **Channels** (`01-channels.md`) — copy `src/channels/telegram.ts` and `src/channels/voice.ts`, register both in `src/channels/index.ts`, add their dependencies to `package.json`.
2. **Codex provider** (`02-codex-provider.md`) — copy host-side `src/providers/codex.ts` and container-side `container/agent-runner/src/providers/codex*.ts`, register in both provider barrels, add `@openai/codex` install to Dockerfile.
3. **MCP servers in container image** (`03-mcp-servers.md`) — add UniFi and SSH MCP RUN blocks to Dockerfile.
4. **Container runtime additions** (`04-container-runtime.md`) — SSH key mount, Telegram incoming dir mount, container skills sync. These all live in `src/container-runner.ts`.
5. **Misc fixes** (`05-misc-fixes.md`) — self-mod install follow-up routing, scheduled-task dedup + final-output suppression, container/skills/{capabilities,status} v1-guard cleanup.
6. **User-only skills** (`06-skills-inventory.md`) — copy 10 directories under `.claude/skills/` and 3 under `container/skills/` from the user's tree.

### Staging

After step 1: `npm run build` should succeed. Telegram and voice channels register but don't run unless their env vars are set.

After step 2: container build (`./container/build.sh`) should succeed. Codex provider available when `provider: "codex"` is set in a group's `container.json`.

After step 3: container build still succeeds. UniFi and SSH MCP binaries installed at `/opt/unifi-network-mcp` and `/opt/ssh-mcp` inside the image; activation happens per-group via `mcpServers` in `groups/<name>/container.json` (data dir, preserved automatically).

After step 5: full build, lint, test should pass. Run live test if desired.

### Risk areas

- **`src/channels/index.ts`** — upstream may have extended this barrel. The fork only ships `cli`, `telegram`, `voice` imports. After upstream merge, *add* the telegram/voice imports next to whatever upstream now ships; do not blow away upstream's other imports.
- **`src/container-runner.ts`** — upstream's v2 rewrote this file substantially. The fork's customizations (SSH mount, Telegram-incoming mount, skill symlinks) are point edits. Locate the equivalent injection sites in the new upstream; do not bulk-replace.
- **`container/Dockerfile`** — upstream may have reorganized. Append RUN blocks at the existing "tools install" section; don't move existing layers.
- **Codex provider** — upstream now ships its own Codex support (skill `add-codex`). Verify whether upstream's implementation supersedes the user's. If so, prefer upstream's; if not, keep the fork's. **Resolve at step 2 before continuing.**

### Skill interactions

- **Telegram channel** is required for `add-telegram-swarm` skill content to be meaningful (the swarm skill references `TELEGRAM_BOT_POOL` and the per-bot identity assignment in `telegram.ts`).
- **Voice channel** is fully self-contained. The `add-voice-transcription` skill in `.claude/skills/` is *unrelated* — it documents an old WhatsApp Whisper integration and is kept only as historical doc; the actual voice feature lives in `src/channels/voice.ts`.
- **Container skills sync** in step 4 is a prerequisite for both Codex and Claude providers to expose `container/skills/*` to the agent. Apply step 4 before relying on `container/skills/{capabilities,status,malayalam-translator}` in step 6.

---

## Applied skills (from upstream)

This fork does **not** apply skills via the `Merge branch 'skill/*'` pattern. Skill directories under `.claude/skills/` are present as plain files (no merge commits). On upgrade, copy the user-only skill directories listed in `06-skills-inventory.md`; let upstream supply everything else.

---

## Customizations that are intentionally NOT migrated

The user explicitly skipped these during extraction:

- **Anthropic-compatible endpoint passthrough** (commit `ef1caa9`) — not needed.
- **`get_context_usage` MCP tool** (commit `6170369`) — not needed.

Ignore these commits during reapplication.

---

## Customizations that are auto-preserved

These live in gitignored directories and survive the worktree swap untouched. **Do not copy them; they are not part of the upgrade flow.**

- `groups/main/CLAUDE.md` — bot persona ("blip", Deadpool/Marvin tone), SSH-access policy, IST timezone.
- `groups/main/container.json` — provider selection (`"provider": "codex"`), `mcpServers` entries for UniFi and SSH if the user has wired them.
- `data/` — sessions, codex auth, IPC state.
- `store/` — SQLite DB.
- `.env` — TELEGRAM_BOT_TOKEN, TWILIO_*, DEEPGRAM_API_KEY, KOKORO_*, UNIFI_*, OPENAI_API_KEY, etc.

`.gitignore` excludes `groups/*`, `data/`, `store/`, `.env*`. The upgrade flow never touches these paths.

---

## Workflow files

`.github/workflows/{bump-version,skill-drift,update-tokens}.yml` were deleted in the fork (`7d67a4e`). Per user choice, **do NOT re-delete** during upgrade — let upstream's current workflow set come through.

---

## Sections

- [01 — Channels (Telegram + Voice)](01-channels.md)
- [02 — Codex provider](02-codex-provider.md)
- [03 — MCP servers (UniFi + SSH)](03-mcp-servers.md)
- [04 — Container runtime additions](04-container-runtime.md)
- [05 — Misc fixes](05-misc-fixes.md)
- [06 — User-only skill directories](06-skills-inventory.md)
