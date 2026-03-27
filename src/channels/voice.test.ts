import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  DEEPGRAM_API_KEY: 'deepgram-key',
  KOKORO_MODEL_PATH: '/opt/kokoro',
  KOKORO_VOICE: 'af_heart',
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'auth-token',
  TWILIO_VALIDATE_SIGNATURE: true,
  VOICE_HTTP_PORT: 3001,
  VOICE_MIRROR_JID: 'tg:-100123',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  VoiceChannel,
} from './voice.js';
import {
  buildTwilioStreamTwiML,
  computeTwilioSignature,
  encodeTwilioMediaPayloads,
  isValidTwilioSignature,
} from './voice.js';
import { ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

function createOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    ...overrides,
  };
}

function createMirrorChannel(sent: string[] = []): Channel {
  return {
    name: 'telegram',
    async connect() {},
    async sendMessage(_jid: string, text: string) {
      sent.push(text);
    },
    isConnected() {
      return true;
    },
    ownsJid(jid: string) {
      return jid.startsWith('tg:');
    },
    async disconnect() {},
  };
}

function createChannel(opts: ChannelOpts) {
  return new VoiceChannel(opts, {
    startTransport: false,
    loadTts: async () => ({
      async generate() {
        return {
          audio: new Float32Array(480),
          sampling_rate: 24000,
        };
      },
    }),
    sleep: async () => {},
  });
}

describe('VoiceChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('dispatches a final transcript as an inbound voice message', async () => {
    const opts = createOpts();
    const channel = createChannel(opts);
    await channel.connect();
    channel.registerSession('CA123', '+15551234567');

    await channel.handleFinalTranscript('CA123', 'hello from the phone');

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'voice:+15551234567',
      expect.any(String),
      '+15551234567',
      'voice',
      false,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'voice:+15551234567',
      expect.objectContaining({
        chat_jid: 'voice:+15551234567',
        sender: '+15551234567',
        sender_name: 'Caller',
        content: 'hello from the phone',
        is_from_me: false,
      }),
    );
  });

  it('mirrors inbound and outbound turns after postConnect wires the mirror channel', async () => {
    const sent: string[] = [];
    const opts = createOpts();
    const channel = createChannel(opts);
    const mirrorChannel = createMirrorChannel(sent);

    await channel.connect();
    channel.postConnect([channel, mirrorChannel]);
    channel.registerSession('CA123', '+15551234567');

    await channel.handleFinalTranscript('CA123', 'caller turn');
    await channel.sendMessage('voice:+15551234567', 'assistant turn');

    expect(sent).toEqual(['📞 caller turn', '📞 assistant turn']);
  });

  it('keeps only the latest buffered transcript while speaking', async () => {
    const sent: string[] = [];
    const opts = createOpts();
    const channel = createChannel(opts);
    const mirrorChannel = createMirrorChannel(sent);

    await channel.connect();
    channel.postConnect([channel, mirrorChannel]);
    channel.registerSession('CA123', '+15551234567');

    await channel.handleFinalTranscript('CA123', 'first turn');
    await channel.handleFinalTranscript('CA123', 'buffered follow up');
    await channel.handleFinalTranscript('CA123', 'latest follow up');
    await channel.sendMessage('voice:+15551234567', 'assistant turn');

    expect(opts.onMessage).toHaveBeenNthCalledWith(
      1,
      'voice:+15551234567',
      expect.objectContaining({ content: 'first turn' }),
    );
    expect(opts.onMessage).toHaveBeenNthCalledWith(
      2,
      'voice:+15551234567',
      expect.objectContaining({ content: 'latest follow up' }),
    );
    expect(sent).toEqual([
      '📞 first turn',
      '📞 assistant turn',
      '📞 latest follow up',
    ]);
  });

  it('owns voice JIDs only', () => {
    const channel = createChannel(createOpts());
    expect(channel.ownsJid('voice:+15551234567')).toBe(true);
    expect(channel.ownsJid('tg:123')).toBe(false);
  });

  it('recovers from a stuck processing turn after the timeout', async () => {
    vi.useFakeTimers();
    const opts = createOpts();
    const channel = createChannel(opts);
    await channel.connect();
    channel.registerSession('CA123', '+15551234567');

    await channel.handleFinalTranscript('CA123', 'first turn');
    await channel.handleFinalTranscript('CA123', 'buffered follow up');

    await vi.advanceTimersByTimeAsync(90_000);

    expect(opts.onMessage).toHaveBeenNthCalledWith(
      2,
      'voice:+15551234567',
      expect.objectContaining({ content: 'buffered follow up' }),
    );
  });

  it('builds TwiML with custom stream parameters', () => {
    expect(
      buildTwilioStreamTwiML('wss://example.com/twilio/stream', {
        from: '+15551234567',
        callSid: 'CA123',
      }),
    ).toContain('<Stream url="wss://example.com/twilio/stream">');
  });

  it('computes a stable Twilio signature from sorted form parameters', () => {
    expect(
      computeTwilioSignature(
        'auth-token',
        'https://example.com/twilio/voice',
        {
          CallSid: 'CA123',
          From: '+15551234567',
        },
      ),
    ).toBe('FDbWAwX/zSN0COqCZvnTltKhe9c=');
  });

  it('rejects missing Twilio signatures by default', () => {
    const req = {
      headers: {},
      url: '/twilio/voice',
      socket: {},
    } as any;
    expect(
      isValidTwilioSignature('auth-token', req, { CallSid: 'CA123' }),
    ).toBe(false);
  });

  it('can explicitly allow missing Twilio signatures for local testing', () => {
    const req = {
      headers: {},
      url: '/twilio/voice',
      socket: {},
    } as any;
    expect(
      isValidTwilioSignature('auth-token', req, { CallSid: 'CA123' }, true),
    ).toBe(true);
  });

  it('encodes outbound audio into base64 Twilio media payloads', () => {
    const payloads = encodeTwilioMediaPayloads(new Float32Array(480), 24000);
    expect(payloads).toHaveLength(1);
    expect(typeof payloads[0]).toBe('string');
    expect(payloads[0].length).toBeGreaterThan(0);
  });

  it('streams TTS sentence-by-sentence instead of waiting for a full response', async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ audio: new Float32Array(480), sampling_rate: 24000 });
    const opts = createOpts();
    const channel = new VoiceChannel(opts, {
      startTransport: false,
      loadTts: async () => ({ generate }),
    });
    await channel.connect();

    const sentFrames: string[] = [];
    const ws = {
      readyState: 1,
      send: (frame: string) => sentFrames.push(frame),
      close: vi.fn(),
    } as any;
    const session = channel.registerSession('CA123', '+15551234567', ws);
    session.streamSid = 'MZ123';

    await channel.sendMessage(
      'voice:+15551234567',
      'First sentence. Second sentence?',
    );

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenNthCalledWith(1, 'First sentence.', {
      voice: 'af_heart',
    });
    expect(generate).toHaveBeenNthCalledWith(2, 'Second sentence?', {
      voice: 'af_heart',
    });
    expect(sentFrames.length).toBeGreaterThan(0);
  });
});
