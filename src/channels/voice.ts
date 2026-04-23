import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';

import { DeepgramClient } from '@deepgram/sdk';
import { KokoroTTS } from 'kokoro-js';
import alawmulaw from 'alawmulaw';
const { mulaw } = alawmulaw;
import WebSocket, { RawData, WebSocketServer } from 'ws';

import {
  DEEPGRAM_API_KEY,
  KOKORO_MODEL_PATH,
  KOKORO_VOICE,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_VALIDATE_SIGNATURE,
  TWILIO_WEBHOOK_URL,
  VOICE_HTTP_PORT,
} from '../config.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

type CallState = 'LISTENING' | 'PROCESSING' | 'SPEAKING';

interface RealTimeVadLike {
  start(): void;
  processAudio(data: Float32Array): Promise<void>;
  flush(): Promise<void>;
}

interface TtsEngineLike {
  generate(
    text: string,
    options?: { voice?: string; speed?: number },
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

export interface CallSession {
  callSid: string;
  caller: string;
  state: CallState;
  bufferedTranscript: string;
  ws: WebSocket | null;
  streamSid: string | null;
  vad: RealTimeVadLike | null;
  vadQueue: Promise<void>;
  processingTimeout: ReturnType<typeof setTimeout> | null;
}

export interface VoiceChannelConfig {
  httpPort?: number;
  modelPath?: string;
  voice?: string;
  startTransport?: boolean;
  validateTwilioSignature?: boolean;
  loadTts?: () => Promise<TtsEngineLike>;
  createVad?: (
    onSpeechEnd: (audio: Float32Array) => void,
  ) => Promise<RealTimeVadLike>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface TwilioVoiceRequest {
  CallSid?: string;
  From?: string;
}

interface TwilioConnectedMessage {
  event: 'connected';
}

interface TwilioStartMessage {
  event: 'start';
  start: {
    accountSid?: string;
    callSid?: string;
    streamSid?: string;
    customParameters?: Record<string, string>;
  };
}

interface TwilioMediaMessage {
  event: 'media';
  streamSid?: string;
  media: {
    payload?: string;
    track?: string;
  };
}

interface TwilioStopMessage {
  event: 'stop';
  stop?: {
    callSid?: string;
    accountSid?: string;
  };
}

interface TwilioMarkMessage {
  event: 'mark';
}

type TwilioInboundMessage =
  | TwilioConnectedMessage
  | TwilioStartMessage
  | TwilioMediaMessage
  | TwilioStopMessage
  | TwilioMarkMessage;

const TWILIO_MEDIA_FRAME_SAMPLES = 160;
const PROCESSING_TIMEOUT_MS = 90_000;
const VAD_SAMPLE_RATE = 16_000;
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

function normalizeVoiceJid(jid: string): string {
  return jid.startsWith('voice:') ? jid : `voice:${jid}`;
}

function stripVoicePrefix(jid: string): string {
  return normalizeVoiceJid(jid).replace(/^voice:/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getRequestProtocol(req: IncomingMessage): 'http' | 'https' {
  return (req.headers['x-forwarded-proto'] as string | undefined) === 'https' ||
    (req.socket as { encrypted?: boolean }).encrypted
    ? 'https'
    : 'http';
}

function buildRequestUrl(req: IncomingMessage): string {
  const protocol = getRequestProtocol(req);
  const host =
    (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host;
  return `${protocol}://${host}${req.url || '/'}`;
}

function int16ToFloat32(pcm: Int16Array): Float32Array {
  const output = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    output[i] = (pcm[i] ?? 0) / 32768;
  }
  return output;
}

export function computeTwilioSignature(
  authToken: string,
  url: string,
  parameters: Record<string, string>,
): string {
  const data =
    url +
    Object.entries(parameters)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}${value}`)
      .join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function isValidTwilioSignature(
  expectedToken: string,
  req: IncomingMessage,
  parameters: Record<string, string>,
  skipValidation = false,
  urlOverride?: string,
): boolean {
  if (skipValidation) return true;
  const signature = req.headers['x-twilio-signature'];
  if (typeof signature !== 'string' || !signature) {
    return false;
  }
  const computed = computeTwilioSignature(
    expectedToken,
    urlOverride || buildRequestUrl(req),
    parameters,
  );
  const receivedBuffer = Buffer.from(signature, 'utf-8');
  const computedBuffer = Buffer.from(computed, 'utf-8');
  if (receivedBuffer.length !== computedBuffer.length) return false;
  return timingSafeEqual(receivedBuffer, computedBuffer);
}

export function buildTwilioStreamTwiML(
  streamUrl: string,
  parameters: Record<string, string>,
): string {
  const parameterXml = Object.entries(parameters)
    .map(
      ([name, value]) =>
        `<Parameter name="${xmlEscape(name)}" value="${xmlEscape(value)}" />`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(streamUrl)}">${parameterXml}</Stream></Connect></Response>`;
}

export function downsampleToRate(
  audio: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (sourceRate === targetRate) return audio;
  if (sourceRate <= 0 || targetRate <= 0) {
    throw new Error(`Invalid sample rates: ${sourceRate} -> ${targetRate}`);
  }

  const targetLength = Math.max(
    1,
    Math.round((audio.length * targetRate) / sourceRate),
  );
  const output = new Float32Array(targetLength);
  const ratio = sourceRate / targetRate;

  for (let i = 0; i < targetLength; i++) {
    const sourceIndex = i * ratio;
    const lower = Math.floor(sourceIndex);
    const upper = Math.min(audio.length - 1, lower + 1);
    const fraction = sourceIndex - lower;
    const lowerSample = audio[lower] ?? 0;
    const upperSample = audio[upper] ?? lowerSample;
    output[i] = lowerSample + (upperSample - lowerSample) * fraction;
  }

  return output;
}

export function float32ToInt16(audio: Float32Array): Int16Array {
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const sample = Math.max(-1, Math.min(1, audio[i] ?? 0));
    pcm[i] =
      sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return pcm;
}

export function encodeTwilioMediaPayloads(
  audio: Float32Array,
  sourceRate: number,
): string[] {
  const pcm8k = downsampleToRate(audio, sourceRate, 8000);
  const pcm16 = float32ToInt16(pcm8k);
  const muLaw = mulaw.encode(pcm16);

  const payloads: string[] = [];
  for (
    let offset = 0;
    offset < muLaw.length;
    offset += TWILIO_MEDIA_FRAME_SAMPLES
  ) {
    const chunk = muLaw.slice(offset, offset + TWILIO_MEDIA_FRAME_SAMPLES);
    payloads.push(Buffer.from(chunk).toString('base64'));
  }
  return payloads;
}

async function defaultCreateVad(
  onSpeechEnd: (audio: Float32Array) => void,
): Promise<RealTimeVadLike> {
  const { RealTimeVAD } = await import('avr-vad');
  const vad = await RealTimeVAD.new({ onSpeechEnd });
  return vad as unknown as RealTimeVadLike;
}

function isWebSocketOpen(ws: WebSocket | null): ws is WebSocket {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function splitIntoSpeechChunks(text: string): string[] {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

export class VoiceChannel {
  private readonly channelConfig: VoiceChannelConfig;
  private readonly setup: ChannelSetup;
  private readonly httpPort: number;
  private readonly modelPath: string;
  private readonly voice: string;
  private readonly startTransport: boolean;
  private readonly validateTwilioSignature: boolean;
  private readonly loadTtsFn: () => Promise<TtsEngineLike>;
  private readonly createVadFn: (
    onSpeechEnd: (audio: Float32Array) => void,
  ) => Promise<RealTimeVadLike>;
  private readonly now: () => Date;
  private readonly sleepFn: (ms: number) => Promise<void>;

  private connected = false;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private kokoro: TtsEngineLike | null = null;
  private deepgramClient: DeepgramClient | null = null;
  private ttsQueue: Promise<void> = Promise.resolve();

  private readonly sessions = new Map<string, CallSession>();
  private readonly jidToSession = new Map<string, CallSession>();
  private readonly socketToCallSid = new Map<WebSocket, string>();

  constructor(channelSetup: ChannelSetup, config: VoiceChannelConfig = {}) {
    this.channelConfig = config;
    this.setup = channelSetup;
    this.httpPort = config.httpPort ?? VOICE_HTTP_PORT;
    this.modelPath = config.modelPath ?? KOKORO_MODEL_PATH;
    this.voice = config.voice ?? KOKORO_VOICE;
    this.startTransport = config.startTransport ?? true;
    this.validateTwilioSignature =
      config.validateTwilioSignature ?? TWILIO_VALIDATE_SIGNATURE;
    this.loadTtsFn =
      config.loadTts ??
      (() =>
        KokoroTTS.from_pretrained(this.modelPath, {
          device: 'cpu',
          dtype: 'q8',
        }) as Promise<TtsEngineLike>);
    this.createVadFn = config.createVad ?? defaultCreateVad;
    this.now = config.now ?? (() => new Date());
    this.sleepFn = config.sleep ?? sleep;
  }

  async connect(): Promise<void> {
    this.kokoro = await this.loadTtsFn();
    this.deepgramClient = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });

    if (this.startTransport) {
      await this.startServers();
    }

    this.connected = true;
    log.info('Voice channel connected', {
      port: this.httpPort,
      hasDeepgramKey: Boolean(DEEPGRAM_API_KEY),
      hasKokoroModelPath: Boolean(this.modelPath),
      kokoroVoice: this.voice,
      hasTwilioAccountSid: Boolean(TWILIO_ACCOUNT_SID),
      hasTwilioAuthToken: Boolean(TWILIO_AUTH_TOKEN),
      validateTwilioSignature: this.validateTwilioSignature,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const session = this.jidToSession.get(normalizeVoiceJid(jid));
    if (!session) {
      log.warn('No active voice session for outbound message', { jid });
      return;
    }

    session.state = 'SPEAKING';

    try {
      await this.enqueueTtsPlayback(session, text);
    } finally {
      session.state = 'LISTENING';
      await this.flushBufferedTranscript(session);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    for (const callSid of [...this.sessions.keys()]) {
      this.removeSession(callSid);
    }
    this.wss?.close();
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    this.httpServer = null;
    this.wss = null;
    this.connected = false;
    log.info('Voice channel disconnected');
  }

  registerSession(
    callSid: string,
    caller: string,
    ws: WebSocket | null = null,
  ): CallSession {
    const normalizedCaller = stripVoicePrefix(caller);
    const existing = this.sessions.get(callSid);
    if (existing) {
      existing.caller = normalizedCaller;
      existing.ws = ws ?? existing.ws;
      return existing;
    }

    const session: CallSession = {
      callSid,
      caller: normalizedCaller,
      state: 'LISTENING',
      bufferedTranscript: '',
      ws,
      streamSid: null,
      vad: null,
      vadQueue: Promise.resolve(),
      processingTimeout: null,
    };
    const jid = normalizeVoiceJid(normalizedCaller);
    this.sessions.set(callSid, session);
    this.jidToSession.set(jid, session);
    if (ws) this.socketToCallSid.set(ws, callSid);
    return session;
  }

  removeSession(callSid: string): void {
    const session = this.sessions.get(callSid);
    if (!session) return;

    if (session.processingTimeout) {
      clearTimeout(session.processingTimeout);
      session.processingTimeout = null;
    }

    if (session.vad) {
      session.vad
        .flush()
        .catch((err) =>
          log.debug('VAD flush on session removal failed', { err, callSid }),
        );
      session.vad = null;
    }

    if (session.ws) {
      this.socketToCallSid.delete(session.ws);
      if (session.ws.readyState === WebSocket.OPEN) {
        try {
          session.ws.close();
        } catch (err) {
          log.debug('Failed to close Twilio socket cleanly', { err, callSid });
        }
      }
      session.ws = null;
    }

    this.sessions.delete(callSid);
    this.jidToSession.delete(normalizeVoiceJid(session.caller));
  }

  async handleFinalTranscript(
    callSid: string,
    transcript: string,
  ): Promise<void> {
    const session = this.sessions.get(callSid);
    if (!session) {
      log.warn('Ignoring transcript for unknown voice session', { callSid });
      return;
    }

    const trimmed = transcript.trim();
    if (!trimmed) return;

    if (session.state !== 'LISTENING') {
      session.bufferedTranscript = trimmed;
      return;
    }

    session.state = 'PROCESSING';

    const timestamp = this.now().toISOString();
    const jid = normalizeVoiceJid(session.caller);

    this.setup.onMetadata(jid, session.caller, false);

    await this.setup.onInbound(jid, null, {
      id: `${callSid}:${timestamp}`,
      kind: 'chat',
      timestamp,
      content: { text: trimmed, sender: 'Caller', senderId: jid },
    });

    this.armProcessingTimeout(session);
  }

  private async startServers(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleHttpRequest(req, res).catch((err) => {
          log.error('Voice HTTP handler failed', { err });
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          }
          res.end('internal error');
        });
      });

      const wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(
          req.url || '/',
          `http://${req.headers.host || 'localhost'}`,
        );
        if (url.pathname !== '/twilio/stream') {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          wss.emit('connection', ws, req);
        });
      });

      wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        this.handleTwilioSocket(ws, req);
      });

      server.on('error', reject);
      server.listen(this.httpPort, () => {
        this.httpServer = server;
        this.wss = wss;
        resolve();
      });
    });
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    );
    if (req.method === 'POST' && url.pathname === '/twilio/voice') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const formValues = Object.fromEntries(params.entries()) as Record<
        string,
        string
      >;
      const payload: TwilioVoiceRequest = formValues;
      if (
        !isValidTwilioSignature(
          TWILIO_AUTH_TOKEN,
          req,
          formValues,
          !this.validateTwilioSignature,
          TWILIO_WEBHOOK_URL || undefined,
        )
      ) {
        log.warn('Rejected Twilio voice webhook with invalid signature');
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      const protocol = getRequestProtocol(req) === 'https' ? 'wss' : 'ws';
      const host =
        (req.headers['x-forwarded-host'] as string | undefined) ||
        req.headers.host;
      const streamUrl = `${protocol}://${host}/twilio/stream`;
      const xml = buildTwilioStreamTwiML(streamUrl, {
        from: payload.From || '',
        callSid: payload.CallSid || '',
      });
      res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
      res.end(xml);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/twilio/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  private handleTwilioSocket(ws: WebSocket, req: IncomingMessage): void {
    ws.on('message', (data) => {
      this.handleTwilioMessage(ws, data).catch((err) => {
        log.error('Voice WebSocket message handler failed', { err });
      });
    });

    ws.on('close', () => {
      const callSid = this.socketToCallSid.get(ws);
      if (callSid) this.removeSession(callSid);
    });

    ws.on('error', (err) => {
      log.warn('Voice WebSocket error', {
        err,
        remote: req.socket.remoteAddress,
      });
    });
  }

  private async handleTwilioMessage(
    ws: WebSocket,
    data: RawData,
  ): Promise<void> {
    const payload = JSON.parse(data.toString('utf-8')) as TwilioInboundMessage;

    switch (payload.event) {
      case 'connected':
      case 'mark':
        return;

      case 'start':
        await this.handleTwilioStart(ws, payload);
        return;

      case 'media':
        this.handleTwilioMedia(ws, payload);
        return;

      case 'stop': {
        const callSid = payload.stop?.callSid || this.socketToCallSid.get(ws);
        if (callSid) this.removeSession(callSid);
        return;
      }

      default:
        log.debug('Ignoring unknown Twilio WebSocket event', { payload });
    }
  }

  private async handleTwilioStart(
    ws: WebSocket,
    payload: TwilioStartMessage,
  ): Promise<void> {
    const callSid = payload.start.callSid;
    if (!callSid) {
      log.warn('Twilio start event missing callSid', { payload });
      return;
    }

    const accountSid = payload.start.accountSid;
    if (accountSid && accountSid !== TWILIO_ACCOUNT_SID) {
      log.warn('Ignoring call from unexpected Twilio account', {
        accountSid,
        expected: TWILIO_ACCOUNT_SID,
      });
      ws.close();
      return;
    }

    const caller =
      payload.start.customParameters?.from ||
      payload.start.customParameters?.From ||
      'unknown';

    const session = this.registerSession(callSid, caller, ws);
    session.streamSid = payload.start.streamSid || null;

    const onSpeechEnd = (audio: Float32Array): void => {
      this.transcribeSpeechBuffer(callSid, audio).catch((err) =>
        log.error('Speech transcription failed', { err, callSid }),
      );
    };
    session.vad = await this.createVadFn(onSpeechEnd);
    session.vad.start();
    log.info('Voice call started', { callSid, caller });
  }

  private handleTwilioMedia(ws: WebSocket, payload: TwilioMediaMessage): void {
    const callSid = this.socketToCallSid.get(ws);
    if (!callSid) return;
    const session = this.sessions.get(callSid);
    if (!session?.vad || !payload.media.payload) return;

    const rawMulaw = Buffer.from(payload.media.payload, 'base64');
    const pcm16 = mulaw.decode(new Uint8Array(rawMulaw));
    const float32 = int16ToFloat32(pcm16);
    const upsampled = downsampleToRate(float32, 8000, VAD_SAMPLE_RATE);

    session.vadQueue = session.vadQueue
      .then(() => session.vad!.processAudio(upsampled))
      .catch((err) =>
        log.error('VAD media frame processing error', { err, callSid }),
      );
  }

  private async transcribeSpeechBuffer(
    callSid: string,
    audio: Float32Array,
  ): Promise<void> {
    if (!this.deepgramClient) {
      log.warn('Deepgram client not initialized', { callSid });
      return;
    }

    const int16 = float32ToInt16(audio);
    const audioBuffer = Buffer.from(
      int16.buffer,
      int16.byteOffset,
      int16.byteLength,
    );

    log.debug('Transcribing speech buffer', { callSid, samples: audio.length });

    let response;
    try {
      response = await this.deepgramClient.listen.v1.media.transcribeFile(
        audioBuffer,
        {
          model: 'nova-3',
          encoding: 'linear16',
          punctuate: true,
          smart_format: true,
        },
        { queryParams: { sample_rate: VAD_SAMPLE_RATE } },
      );
    } catch (err) {
      log.error('Deepgram transcription error', { err, callSid });
      return;
    }

    const transcript =
      (
        response as any
      )?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';

    log.debug('Transcription complete', { callSid, transcript });

    if (transcript) {
      await this.handleFinalTranscript(callSid, transcript);
    }
  }

  private async enqueueTtsPlayback(
    session: CallSession,
    text: string,
  ): Promise<void> {
    const task = async () => {
      if (session.processingTimeout) {
        clearTimeout(session.processingTimeout);
        session.processingTimeout = null;
      }
      if (!this.kokoro) {
        log.warn('Kokoro is not initialized', { callSid: session.callSid });
        return;
      }
      if (!isWebSocketOpen(session.ws) || !session.streamSid) {
        log.warn('Voice session is missing an active Twilio stream', {
          callSid: session.callSid,
          jid: normalizeVoiceJid(session.caller),
        });
        return;
      }

      for (const chunk of splitIntoSpeechChunks(text)) {
        const audio = await this.kokoro.generate(chunk, { voice: this.voice });
        const payloads = encodeTwilioMediaPayloads(
          audio.audio,
          audio.sampling_rate,
        );
        for (const payload of payloads) {
          if (!isWebSocketOpen(session.ws)) break;
          session.ws.send(
            JSON.stringify({
              event: 'media',
              streamSid: session.streamSid,
              media: { payload },
            }),
          );
        }
        if (!isWebSocketOpen(session.ws)) break;
        if (this.sleepFn !== sleep) {
          await this.sleepFn(0);
        }
      }
    };

    const next = this.ttsQueue.then(task, task);
    this.ttsQueue = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }

  private async flushBufferedTranscript(session: CallSession): Promise<void> {
    if (session.state !== 'LISTENING' || !session.bufferedTranscript) return;
    const buffered = session.bufferedTranscript;
    session.bufferedTranscript = '';
    await this.handleFinalTranscript(session.callSid, buffered);
  }

  private armProcessingTimeout(session: CallSession): void {
    if (session.processingTimeout) {
      clearTimeout(session.processingTimeout);
    }
    session.processingTimeout = setTimeout(() => {
      if (!this.sessions.has(session.callSid)) return;
      if (session.state !== 'PROCESSING') return;
      log.warn(
        'Voice turn timed out waiting for agent response; resuming listening',
        {
          callSid: session.callSid,
          jid: normalizeVoiceJid(session.caller),
        },
      );
      session.state = 'LISTENING';
      session.processingTimeout = null;
      void this.flushBufferedTranscript(session);
    }, PROCESSING_TIMEOUT_MS);
  }
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as
    | Record<string, unknown>
    | string
    | undefined;
  if (typeof content === 'string') return content;
  if (
    content &&
    typeof content === 'object' &&
    typeof content.text === 'string'
  ) {
    return content.text;
  }
  return null;
}

function createAdapter(): ChannelAdapter | null {
  if (
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !DEEPGRAM_API_KEY ||
    !KOKORO_MODEL_PATH
  ) {
    return null;
  }

  let voiceChannel: VoiceChannel | null = null;

  const adapter: ChannelAdapter = {
    name: 'voice',
    channelType: 'voice',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      voiceChannel = new VoiceChannel(config);
      await voiceChannel.connect();
    },

    async teardown(): Promise<void> {
      await voiceChannel?.disconnect();
      voiceChannel = null;
    },

    isConnected(): boolean {
      return voiceChannel?.isConnected() ?? false;
    },

    async deliver(
      platformId: string,
      _threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      const text = extractText(message);
      if (text === null) return undefined;
      await voiceChannel?.sendMessage(platformId, text);
      return undefined;
    },
  };

  return adapter;
}

registerChannelAdapter('voice', { factory: createAdapter });
