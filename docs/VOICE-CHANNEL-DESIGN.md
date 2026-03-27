# Voice Channel Design: Twilio + Deepgram + Kokoro

A design document for adding real-time voice call support to NanoClaw as a native TypeScript channel, with mirroring of voice transcripts to Telegram.

---

## Overview

This document describes how to add a voice channel to NanoClaw that:

1. Accepts inbound phone calls via Twilio
2. Transcribes speech in real time using Deepgram's live transcription WebSocket
3. Routes transcribed text through NanoClaw's existing container agent pipeline
4. Speaks the agent's response back to the caller using Kokoro TTS (local, no API cost)
5. Mirrors the full voice transcript (both sides) to an existing Telegram group as text

Everything runs inside the existing NanoClaw Node.js process as a standard `Channel` implementation. No separate server, no Python, no Pipecat.

---

## Why Not Pipecat?

Pipecat's JS package (`@pipecat-ai/client-js`) is a **client SDK** for connecting to a running Pipecat server — it cannot run a pipeline itself. The pipeline runtime only exists in Python. Since all the underlying services (Twilio, Deepgram, Kokoro) have first-class TypeScript SDKs, implementing the pipeline directly in TypeScript is simpler, better integrated, and avoids running a second process.

The main feature Pipecat's Python runtime provides that a naive TypeScript implementation lacks is **barge-in**: detecting that the caller has started speaking mid-response and immediately cancelling TTS playback. This is deferred as a v2 enhancement — Deepgram's `endpointing` parameter handles the end-of-utterance detection needed for basic turn-taking, which is sufficient for a first version.

---

## Architecture

```
Phone caller
    │
    │ (PSTN)
    ▼
Twilio
    │ WebSocket (Twilio Media Streams, µ-law 8kHz)
    ▼
VoiceChannel (src/channels/voice.ts)  ←── runs inside NanoClaw Node.js process
    │
    ├── per call: DeepgramLive WebSocket
    │       receives µ-law audio chunks from Twilio
    │       sends is_final transcripts → opts.onMessage() → SQLite → message loop
    │
    ├── per turn: NanoClaw container agent
    │       (same path as Telegram messages)
    │       sendMessage() called with agent response text
    │
    ├── per turn: Kokoro TTS (kokoro-js, loaded once at connect())
    │       synthesizes response text → Float32 PCM (24kHz)
    │       resampled to 8kHz → µ-law encoded → base64
    │       written back to Twilio WebSocket as media frames
    │
    └── per turn: mirror to Telegram (fire-and-forget)
            caller turn + agent turn both forwarded to VOICE_MIRROR_JID
```

---

## Audio Pipeline

Twilio Media Streams use µ-law (PCMU) encoded audio at 8kHz, delivered as base64-encoded JSON frames over a WebSocket. Kokoro outputs Float32 PCM at 24kHz. The conversion on the way out:

```
Kokoro Float32 PCM @ 24kHz
    → downsample to 8kHz  (simple linear interpolation or lanczos)
    → convert float → 16-bit PCM
    → encode to µ-law bytes  (mulaw npm package)
    → base64 encode
    → wrap in Twilio media frame JSON
    → write to call WebSocket
```

On ingress, Twilio's µ-law 8kHz audio goes directly to Deepgram — Deepgram accepts this encoding natively, so no conversion is needed.

**Packages:**
- `@deepgram/sdk` — live transcription WebSocket
- `kokoro-js` — local neural TTS (ONNX Runtime)
- `mulaw` — µ-law encode/decode
- `ws` — WebSocket server (Twilio streams endpoint)

---

## Turn-Taking via Deepgram Endpointing

Deepgram's live transcription API has an `endpointing` parameter (milliseconds of silence before finalizing an utterance, e.g. `300`). When Deepgram sends a transcript event with `is_final: true`, that is the signal to dispatch the transcription to the NanoClaw message loop.

While the agent is processing and TTS is playing, new Deepgram transcripts are buffered but not dispatched. This gives simple, clean turn-taking without a separate VAD step. Barge-in support (interrupting mid-TTS) is a v2 enhancement.

---

## Call Lifecycle

```
1. Twilio calls POST /twilio/voice
   → VoiceChannel responds with TwiML:
     <Response><Connect><Stream url="wss://host/twilio/stream"/></Connect></Response>

2. Twilio opens WebSocket to /twilio/stream
   → VoiceChannel creates CallSession for this callSid:
       - Opens Deepgram live transcription stream
       - Sets state = LISTENING

3. Twilio sends media frames (base64 µ-law audio)
   → VoiceChannel forwards raw bytes to Deepgram

4. Deepgram sends is_final transcript
   → VoiceChannel sets state = PROCESSING
   → Mirrors "📞 {transcript}" to Telegram
   → Calls opts.onMessage() → stored in SQLite
   → Message loop picks it up → container agent runs

5. Agent produces response text
   → sendMessage() called on VoiceChannel
   → Mirrors "📞 {response}" to Telegram
   → Kokoro synthesizes audio
   → VoiceChannel sets state = SPEAKING, streams µ-law frames to Twilio
   → On completion, sets state = LISTENING

6. Twilio sends stop frame (call ended)
   → VoiceChannel closes Deepgram stream, cleans up CallSession
```

**State per call:** `LISTENING | PROCESSING | SPEAKING`

New Deepgram transcripts received while in `PROCESSING` or `SPEAKING` states are buffered. When the state returns to `LISTENING`, any buffered transcript is dispatched as the next turn.

---

## VoiceChannel Structure

```typescript
interface CallSession {
  callSid: string;
  caller: string;               // E.164 e.g. "+15551234567"
  ws: WebSocket;                // Twilio Media Streams WebSocket
  deepgram: LiveTranscription;  // Deepgram live stream
  state: 'LISTENING' | 'PROCESSING' | 'SPEAKING';
  bufferedTranscript: string;   // transcript received during PROCESSING/SPEAKING
}

class VoiceChannel implements Channel {
  name = 'voice';
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private sessions = new Map<string, CallSession>(); // callSid → session
  private jidToSession = new Map<string, CallSession>(); // voice:+1555 → session
  private kokoro: KokoroTTS;    // loaded once at connect(), reused per turn
  private mirrorChannel: Channel | null = null;

  ownsJid(jid: string): boolean { return jid.startsWith('voice:'); }

  async connect(): Promise<void> {
    this.kokoro = await KokoroTTS.load(); // load model once
    // start HTTP + WebSocket server
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // 1. Mirror to Telegram as "📞 {text}"
    // 2. Synthesize with Kokoro
    // 3. Resample + µ-law encode
    // 4. Stream to Twilio WebSocket
    // 5. Set session state back to LISTENING
  }

  postConnect(allChannels: Channel[]): void {
    // wire up mirror channel
  }
}
```

JID is `voice:+15551234567` (caller's phone number). The same caller gets a persistent Claude session across calls. The `jidToSession` map connects the JID used by the message loop to the live call WebSocket.

---

## Kokoro Initialization

Kokoro's ONNX model takes a few seconds to load. It is loaded **once** at `connect()` time and reused for every TTS call. A single `KokoroTTS` instance is shared across all concurrent calls — Kokoro synthesis is CPU-bound and sequential, so calls that arrive while TTS is in progress for another call will queue. For a personal-use assistant this is acceptable.

Verify that `kokoro-js` uses `onnxruntime-node` (not `onnxruntime-web`) in a Node.js context before committing. The model files are large (~300MB) and should be stored outside the repo, path configured via `KOKORO_MODEL_PATH`.

---

## Configuration

Add to `.env`:

```bash
VOICE_HTTP_PORT=3001              # HTTP + WebSocket server port
VOICE_MIRROR_JID=tg:-12345678     # Telegram JID to mirror transcripts to
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
DEEPGRAM_API_KEY=...
KOKORO_MODEL_PATH=/opt/kokoro     # local path to Kokoro model files
KOKORO_VOICE=af_heart             # Kokoro voice ID
```

---

## Changes to Existing Files

| File | Change |
|------|--------|
| `src/types.ts` | Add optional `postConnect?(allChannels: Channel[]): void` to `Channel` interface |
| `src/channels/index.ts` | Add `import './voice.js'` |
| `src/index.ts` | After all channels connect, call `channel.postConnect?.(channels)` on each |

---

## New Files

| File | Purpose |
|------|---------|
| `src/channels/voice.ts` | VoiceChannel: HTTP/WS server, Deepgram STT, Kokoro TTS, mirror logic |

---

## What the Mirror Looks Like in Telegram

Every voice conversation appears in the configured Telegram group as a running transcript. All mirrored messages are prefixed with 📞 to indicate they came through voice — no caller number, no sender label:

```
📞 What's the weather in New York?
📞 It's currently 72°F and sunny in New York City.
📞 Thanks. What about tomorrow?
📞 Tomorrow expect mid-60s with some cloud cover in the afternoon.
```

Both sides of the conversation are mirrored in real time as each turn completes.

---

## Design Decisions

### Why `voice:+E164number` as JID (not `voice:{callSid}`)?

`callSid` is unique per call — every new call would create a fresh container session with no memory of prior calls. Using the phone number as the JID key gives the same caller a persistent conversation history and Claude session across calls.

### Why `postConnect()` for mirror wiring?

Channels are instantiated before any of them are connected, so they can't reference each other at construction time. `postConnect(allChannels[])` is called once after all channels have successfully connected, giving each channel a chance to wire up cross-channel dependencies without coupling implementations to each other at the type level.

### Container warmth and turn latency

The first turn of a call has container startup overhead (~2–4s). Subsequent turns in the same call are handled via the existing fast path in `startMessageLoop`: if the container is still running, messages are piped directly to its stdin via `queue.sendMessage()` without spawning a new container. This makes subsequent turns significantly faster. For best first-turn latency, the voice group's container could be pre-warmed on startup.

### Barge-in (v2)

Barge-in — detecting that the caller has started speaking mid-TTS and cancelling playback — is not implemented in v1. The call state machine buffers transcripts received during `SPEAKING` state, so the caller's next utterance is never lost; it's just not acted on until the agent finishes speaking. If this feels unnatural in practice, v2 can add a Silero VAD pass on incoming audio to detect speech onset and cancel the current TTS stream.

---

## Twilio Setup

1. Buy a phone number in the Twilio console
2. Set the number's "A call comes in" webhook to `POST https://your-host/twilio/voice`
3. Ensure the NanoClaw voice WebSocket is reachable at `wss://your-host/twilio/stream`
4. For local development, use `ngrok` or Cloudflare Tunnel to expose the voice port
