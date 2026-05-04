# NanoClaw Migration Guide

Generated: 2026-05-04
Base: 8f91d3be576b830081f2a802e2f2d426b010f8f7
HEAD at generation: 4c045fed175fb2c44abbcefb950b556173b8594d
Upstream: 1404f7feb632fca83dcd0cfe81a09d5be7763dc1

## Migration Plan

This is a Tier 3 migration. The fork has undergone a full v2 architectural rewrite from upstream.
Customizations are layered on top of the v2 base.

**Order of operations:**
1. Reapply all upstream skill branches
2. Copy custom container skills (capabilities, malayalam-translator, status)
3. Apply Codex agent provider (host-side + container-side)
4. Apply Telegram channel adapter
5. Verify build

**Risk areas:**
- Codex provider files are entirely new — no upstream conflict risk
- Telegram channel is entirely new — no upstream conflict risk
- Container skills are entirely new — no upstream conflict risk
- Dockerfile has Codex version pinning — may conflict with upstream changes to the Dockerfile structure

## Applied Skills

All 47 skills from upstream, used as-is (no customizations beyond default):

| Skill | Upstream Branch |
|-------|----------------|
| add-atomic-chat-tool | skill/add-atomic-chat-tool |
| add-codex | skill/codex |
| add-compact | skill/compact |
| add-dashboard | skill/add-dashboard |
| add-discord | skill/add-discord |
| add-emacs | skill/emacs |
| add-gcal-tool | skill/add-gcal-tool |
| add-gchat | skill/add-gchat |
| add-github | skill/add-github |
| add-gmail | skill/add-gmail |
| add-gmail-tool | skill/add-gmail-tool |
| add-image-vision | skill/add-image-vision |
| add-imessage | skill/add-imessage |
| add-karpathy-llm-wiki | skill/add-karpathy-llm-wiki |
| add-linear | skill/add-linear |
| add-macos-statusbar | skill/add-macos-statusbar |
| add-matrix | skill/add-matrix |
| add-ollama-provider | skill/add-ollama-provider |
| add-ollama-tool | skill/add-ollama-tool |
| add-opencode | skill/add-opencode |
| add-pdf-reader | skill/add-pdf-reader |
| add-reactions | skill/add-reactions |
| add-resend | skill/add-resend |
| add-signal | skill/add-signal |
| add-slack | skill/add-slack |
| add-teams | skill/add-teams |
| add-telegram | skill/add-telegram |
| add-vercel | skill/add-vercel |
| add-voice-transcription | skill/add-voice-transcription |
| add-webex | skill/add-webex |
| add-wechat | skill/add-wechat |
| add-whatsapp | skill/add-whatsapp |
| add-whatsapp-cloud | skill/add-whatsapp-cloud |
| channel-formatting | skill/channel-formatting |
| claw | (utility skill, no branch) |
| convert-to-apple-container | skill/apple-container |
| customize | (operational skill, no branch) |
| init-first-agent | (operational skill, no branch) |
| init-onecli | (operational skill, no branch) |
| manage-channels | (operational skill, no branch) |
| manage-mounts | (operational skill, no branch) |
| migrate-from-openclaw | skill/migrate-from-openclaw |
| migrate-nanoclaw | skill/migrate-nanoclaw |
| setup | (operational skill, no branch) |
| update-nanoclaw | skill/update-nanoclaw-skill-v2 |
| update-skills | (operational skill, no branch) |
| use-local-whisper | skill/use-local-whisper |
| use-native-credential-proxy | skill/native-credential-proxy |
| x-integration | skill/x-integration |

## Skill Interactions

No known inter-skill conflicts. All skills were applied as-is.

## Customizations

See section files for details:

- [Codex Agent Provider](codex-provider.md) — Multi-provider LLM support (Codex + Claude)
- [Telegram Channel](telegram-channel.md) — Telegram bot channel adapter
- [Custom Container Skills](custom-container-skills.md) — capabilities, malayalam-translator, status
