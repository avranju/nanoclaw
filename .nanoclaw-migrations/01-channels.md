# 01 — Channels: Telegram + Voice

Two net-new channel modules. Both are mostly self-contained — copy as-is, register in the channel barrel, install dependencies, ensure config is read from `.env`.

---

## Telegram channel

**Intent:** Full Telegram bot integration — text in/out, photo + document download, approval-card inline keyboards, mention translation (`@<botname>` → `@<ASSISTANT_NAME>` so the trigger pattern matches), Markdown parse-mode with plain-text fallback, and a bot-pool mode for agent-swarm scenarios where each subagent appears as a different bot identity.

**Status:** Net-new. Upstream has no Telegram channel.

**Files:**

| File | Status | Purpose |
|------|--------|---------|
| `src/channels/telegram.ts` | net-new (~557 lines) | Channel adapter, polling, send, attachments, approval cards, bot pool |
| `src/channels/index.ts` | modified | Add `import './telegram.js';` to register the adapter at startup |

**How to apply:**

1. Copy `src/channels/telegram.ts` from the user's tree (the fork's HEAD) into the worktree at the same path.
2. In the worktree's `src/channels/index.ts`, add `import './telegram.js';` next to whatever upstream registers (probably `import './cli.js';` and possibly others). Do NOT delete upstream's other imports — only add Telegram. The expected post-edit minimum is:
   ```typescript
   import './cli.js';
   import './telegram.js';
   ```
3. Add to `package.json` dependencies:
   ```json
   "grammy": "^1.39.3"
   ```
4. Ensure `src/config.ts` reads these env vars via its `readEnvFile()` call (or equivalent in the new upstream). If upstream's config has changed shape, add the keys wherever channel env is handled:
   - `TELEGRAM_BOT_TOKEN` (required for the channel to start)
   - `TELEGRAM_BOT_POOL` (optional, comma-separated list of bot tokens for swarm mode)

**Key implementation patterns to verify after copy:**

- **Markdown fallback** — `sendWithMarkdown()` near top of file: tries `parse_mode: 'Markdown'`, falls back to plain text on 400 (Markdown parse error). Other 4xx errors re-throw.
- **Approval cards** — When outbound `content.type === 'ask_question'`, the adapter renders inline keyboards. Callback data format: `ncq:<questionId>:<value>`. The `callback_query` handler parses this back into a structured response.
- **Mention translation** — When the message has a `mention` entity matching the bot's own `@username`, the adapter rewrites the leading mention to `@<ASSISTANT_NAME>` so the trigger regex (configured for `@<assistant>`) fires.
- **Bot pool / swarm** — `initBotPool(tokens)` and `sendPoolMessage()` give each `groupFolder:sender` key a sticky bot from the pool. The pool bot's display name is set via `setMyName()` to match the agent name. Skipped silently if `TELEGRAM_BOT_POOL` is empty.
- **Photos / documents** — Downloaded via `ctx.getFile()`, saved to `data/telegram-incoming/<filename>` (the `telegram-incoming` host dir is mounted into the container — see `04-container-runtime.md`), passed to the agent as an attachment with `localPath`.
- **JID format** — Chats use `tg:<chatId>`, senders use `tg:<userId>`.

**Typing indicator note:**

The fork's `telegram.ts` only implements one-shot `setTyping(...)`. The keepalive loop is centralized in `src/modules/typing/index.ts` (now upstream-canonical). Do not re-add per-adapter keepalive intervals. After upstream merge, verify that `router.ts` calls `startTypingRefresh()` on inbound and `delivery.ts` calls `stopTypingRefresh()` / `pauseTypingRefreshAfterDelivery()` at the right points. If upstream has restructured these hooks, port the calls to the new locations.

**Verification:**

1. Set `TELEGRAM_BOT_TOKEN` in `.env`.
2. `npm run build && npm run dev`.
3. From a Telegram chat where the bot is a member, send `/chatid` — bot replies with `tg:<id>` registration string.
4. Send `/ping` — bot replies with `<ASSISTANT_NAME> is online.`
5. Send a normal message that triggers the agent — agent responds.
6. Send a photo with caption — agent reports it received an image attachment.
7. (Swarm only) Set `TELEGRAM_BOT_POOL` to two extra bot tokens, trigger a multi-agent task — distinct bot identities appear in the chat.

---

## Voice channel

**Intent:** Inbound phone calls via Twilio Media Streams (WebSocket) → batch speech-to-text via Deepgram → agent processes turn → Kokoro TTS synthesizes reply → audio streamed back to caller. Includes VAD (avr-vad) for endpointing, µ-law ↔ PCM codec conversion, sample-rate resampling, and a per-call state machine (LISTENING / PROCESSING / SPEAKING) with buffered turn-taking.

**Status:** Net-new. Upstream has no voice channel.

**Files:**

| File | Status | Purpose |
|------|--------|---------|
| `src/channels/voice.ts` | net-new (~894 lines) | Full channel: HTTP webhook, WebSocket server, VAD, STT, TTS, codec conversion |
| `docs/VOICE-CHANNEL-DESIGN.md` | net-new | Architecture/design doc — useful background, optional to copy |
| `src/channels/index.ts` | modified | Add `import './voice.js';` |

**How to apply:**

1. Copy `src/channels/voice.ts` and (optionally) `docs/VOICE-CHANNEL-DESIGN.md` from the fork into the worktree.
2. Add to `src/channels/index.ts`:
   ```typescript
   import './voice.js';
   ```
3. Add to `package.json` dependencies:
   ```json
   "@deepgram/sdk": "^5.0.0",
   "alawmulaw": "^6.0.0",
   "avr-vad": "^1.0.9",
   "kokoro-js": "^1.2.1",
   "ws": "^8.20.0"
   ```
4. Add to `package.json` `overrides` block (creates one if absent):
   ```json
   "overrides": {
     "onnxruntime-node": "1.24.3"
   }
   ```
   This pins the ONNX runtime that `kokoro-js` resolves through, avoiding native binding mismatches.
5. Ensure these env vars are read from `.env` (config.ts):
   - `VOICE_HTTP_PORT` (default 3001)
   - `VOICE_MIRROR_JID` (optional Telegram JID to mirror transcripts)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VALIDATE_SIGNATURE`, `TWILIO_WEBHOOK_URL`
   - `DEEPGRAM_API_KEY`
   - `KOKORO_MODEL_PATH`, `KOKORO_VOICE` (default `'af_heart'`)

**Key implementation patterns to verify after copy:**

- **Self-disable when unconfigured** — `createAdapter()` returns `null` if any of `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `DEEPGRAM_API_KEY`, `KOKORO_MODEL_PATH` is missing. The channel barrel must tolerate `null` returns from `createAdapter()` and skip registration silently.
- **Call session state machine** — `CallSession.state: 'LISTENING' | 'PROCESSING' | 'SPEAKING'`. Transcripts arriving during PROCESSING/SPEAKING are buffered and flushed when state returns to LISTENING. PROCESSING_TIMEOUT_MS = 90s.
- **VAD via avr-vad** — `RealTimeVAD.new({ onSpeechEnd })` from `avr-vad`. On `onSpeechEnd`, the buffered Float32 audio is sent to Deepgram as a batch transcription (NOT streaming).
- **Codec pipeline (inbound)** — Twilio sends µ-law 8 kHz base64 → decode to PCM16 → convert to Float32 → upsample to 16 kHz for VAD.
- **Codec pipeline (outbound)** — Kokoro returns Float32 24 kHz → downsample to 8 kHz → quantize to PCM16 → µ-law encode → base64 chunks → Twilio Media Streams `media` events.
- **Kokoro queueing** — TTS generation is serialized via a `ttsQueue` promise chain so concurrent turn replies don't compete on the model. Text is split by sentence boundary; each chunk synthesizes and streams independently.
- **Twilio signature validation** — HMAC-SHA1 of body + URL. Bypass with `TWILIO_VALIDATE_SIGNATURE=false` for local dev.
- **TwiML response** — `/twilio/voice` POST returns TwiML that `<Connect>`s a `<Stream>` to the WebSocket endpoint with `from` and `callSid` parameters.

**Verification:**

1. Set `VOICE_*`, `TWILIO_*`, `DEEPGRAM_API_KEY`, `KOKORO_MODEL_PATH` in `.env`. Point `KOKORO_MODEL_PATH` at the local Kokoro ONNX model directory.
2. `npm install` should resolve `onnxruntime-node@1.24.3` for kokoro-js.
3. `npm run build && npm run dev`. Logs should show "voice channel listening on :3001" or equivalent.
4. `curl http://localhost:3001/twilio/health` → `{"ok": true}`.
5. Configure a Twilio phone number webhook to `https://<your-host>/twilio/voice`. Call the number. The agent should hear you, reply, and you should hear synthesized speech back.
6. If `VOICE_MIRROR_JID` is set, transcripts of the call should also appear in that Telegram chat.

---

## Common shared file

`src/channels/index.ts` after both edits — minimum content:

```typescript
// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.

import './cli.js';
import './telegram.js';
import './voice.js';
```

If upstream has additional default channel imports here, keep them; only ensure `telegram` and `voice` are present.
