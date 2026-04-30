import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { inboundDbPath, initSessionFolder } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { applyInstallPackages } from './apply.js';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-test-self-mod',
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
  };
});

vi.mock('../../container-runner.js', () => ({
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
  killContainer: vi.fn(),
}));

function now(): string {
  return new Date().toISOString();
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-main',
    messaging_group_id: 'mg-tg',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-main',
    name: 'main',
    folder: 'main',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-tg',
    channel_type: 'telegram',
    platform_id: 'tg:5473909832',
    name: 'Raj',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('applyInstallPackages', () => {
  it('routes the post-rebuild verification prompt to the original chat', async () => {
    const session = makeSession();
    createSession(session);
    initSessionFolder(session.agent_group_id, session.id);

    await applyInstallPackages({
      session,
      payload: { apt: ['jq'], npm: [] },
      userId: 'telegram:5473909832',
      notify: vi.fn(),
    });

    const db = new Database(inboundDbPath(session.agent_group_id, session.id));
    const row = db
      .prepare(
        `SELECT kind, platform_id, channel_type, thread_id, content
         FROM messages_in
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get() as {
      kind: string;
      platform_id: string;
      channel_type: string;
      thread_id: string | null;
      content: string;
    };
    db.close();

    expect(row.kind).toBe('chat');
    expect(row.platform_id).toBe('tg:5473909832');
    expect(row.channel_type).toBe('telegram');
    expect(row.thread_id).toBeNull();
    expect(JSON.parse(row.content).text).toContain(
      'Packages installed (jq) and container rebuilt',
    );
  });
});
