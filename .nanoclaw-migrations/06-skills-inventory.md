# 06 — User-only skill directories

These skill directories exist in the fork but not in `upstream/main`. Copy each directory verbatim from the fork's tree into the worktree.

These are markdown / scripts only — no code patching needed. They are inert until a user invokes them or (for `container/skills/*`) the agent reads them via the skill discovery mechanism wired up in `04-container-runtime.md` step 4.3.

**Verification command** (run from the worktree after copying):
```bash
diff -r /path/to/fork/.claude/skills/<name> ./.claude/skills/<name>
diff -r /path/to/fork/container/skills/<name> ./container/skills/<name>
```
Should produce no output (identical trees).

---

## .claude/skills/ (host-side, user-invocable via /<skill-name>)

| Skill | What it does | Notes |
|-------|--------------|-------|
| `add-compact` | Adds `/compact` slash command for manual context compaction | Copy as-is. Documents how to wire `/compact` through `src/session-commands.ts`, `src/index.ts`, `container/agent-runner/src/index.ts` — but the implementation work has already been done in the fork; this skill is now mostly historical doc. |
| `add-gmail` | Gmail integration (tool or full channel mode) with OAuth setup | Copy as-is. Currently inert in this fork (WhatsApp removed, Gmail integration not wired in). Useful as reference if Gmail is ever re-enabled. |
| `add-image-vision` | WhatsApp image vision via `sharp` resize + multimodal blocks | Copy as-is. Inert (WhatsApp removed). |
| `add-pdf-reader` | PDF reading via `pdftotext` / `poppler-utils` | Copy as-is. Inert (WhatsApp removed). |
| `add-reactions` | WhatsApp emoji reactions | Copy as-is. Inert (WhatsApp removed). |
| `add-telegram-swarm` | Telegram Agent Teams (per-bot identity from `TELEGRAM_BOT_POOL`) | Copy as-is. Functional — the implementation lives in `src/channels/telegram.ts` (already migrated in step 1). The skill doc helps when re-running setup. |
| `add-voice-transcription` | OpenAI Whisper transcription for WhatsApp voice notes | Copy as-is. **Not the same as the voice channel.** This is an older WhatsApp-Whisper pattern. Inert in this fork; the active voice impl is `src/channels/voice.ts` (Twilio + Deepgram + Kokoro). |
| `channel-formatting` | Convert Markdown to per-platform native syntax (WhatsApp `*bold*`, etc.) | Copy as-is. Implementation is in `src/text-styles.ts` and the formatter hook in `router.ts` — already part of upstream now or covered by other migration steps; the skill is the descriptor. |
| `update` | User's custom upstream-update skill (separate from upstream's `/update-nanoclaw`) | Copy as-is. Includes `scripts/` subdirectory. |
| `use-local-whisper` | Switch voice transcription to local whisper.cpp | Copy as-is. Inert (depends on `add-voice-transcription`, which is also inert). |

**Per user choice during extraction**, all 10 are copied — including the WhatsApp-tied ones (image-vision, pdf-reader, reactions, voice-transcription, gmail, use-local-whisper). Rationale: zero runtime cost, useful if WhatsApp is ever re-enabled.

---

## container/skills/ (agent-facing, exposed via `/app/skills/` symlinks)

| Skill | What it does | Notes |
|-------|--------------|-------|
| `capabilities` | Agent skill — describes current capabilities, tools, mounts | Includes commit `5680e18` cleanup — workspace path fixes. |
| `malayalam-translator` | Translate to colloquial spoken Malayalam | Net-new from commit `7734bce`. |
| `status` | Agent skill — quick health/context/mount snapshot | Includes commit `5680e18` cleanup — drops v1 `/workspace/project` guard. |

These are exposed to the agent via the symlink farm wired up in `04-container-runtime.md` step 4.3. Once that's in place, dropping the directories under `container/skills/` is sufficient — no further registration.

---

## Copy procedure

Concretely, after the worktree is created and step 1–5 are applied:

```bash
# From the project root (fork checkout):
PROJECT_ROOT=$(pwd)
WORKTREE="$PROJECT_ROOT/.upgrade-worktree"

# .claude/skills user-only set
for skill in add-compact add-gmail add-image-vision add-pdf-reader add-reactions \
             add-telegram-swarm add-voice-transcription channel-formatting \
             update use-local-whisper; do
  cp -r "$PROJECT_ROOT/.claude/skills/$skill" "$WORKTREE/.claude/skills/"
done

# container/skills user-only set
for skill in capabilities malayalam-translator status; do
  cp -r "$PROJECT_ROOT/container/skills/$skill" "$WORKTREE/container/skills/"
done
```

(The fork itself is the source of truth. Copy from the live tree, not from any backup or worktree path.)

---

## Verification

1. From the worktree: `ls .claude/skills/` and `ls container/skills/` — confirm all 13 names appear.
2. After full upgrade and rebuild, send `/status` from a chat — agent should respond with the v2-corrected status (no "main chat only" canned response).
3. Send a message asking for malayalam translation — agent should produce the Malayalam-script + transliteration output described in `container/skills/malayalam-translator/SKILL.md`.
