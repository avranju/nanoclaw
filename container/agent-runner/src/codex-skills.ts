import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  clearContinuation,
  getStateValue,
  setStateValue,
} from './db/session-state.js';

const CODEX_SKILLS_FINGERPRINT_KEY = 'codex:nanoclaw-skills-fingerprint';

interface SkillEntry {
  name: string;
  hash: string;
}

/**
 * Codex snapshots the available skill roster into the thread's developer
 * prompt when a thread starts. Resuming an old thread after NanoClaw adds or
 * changes shared container skills leaves Codex with the old roster, even if
 * ~/.codex/skills now contains the right files. Detect those changes and
 * force a fresh Codex thread so the app-server rebuilds its skill list.
 */
export function invalidateCodexContinuationOnSkillChange(
  continuation: string | undefined,
): string | undefined {
  const fingerprint = computeNanoclawCodexSkillFingerprint();
  const previous = getStateValue(CODEX_SKILLS_FINGERPRINT_KEY);

  if (previous !== fingerprint) {
    setStateValue(CODEX_SKILLS_FINGERPRINT_KEY, fingerprint);
    if (continuation) {
      clearContinuation('codex');
      return undefined;
    }
  }

  return continuation;
}

function computeNanoclawCodexSkillFingerprint(): string {
  const skillsDir = path.join(process.env.HOME || '/home/node', '.codex', 'skills');
  const entries: SkillEntry[] = [];

  if (!fs.existsSync(skillsDir)) return hashJson(entries);

  for (const name of fs.readdirSync(skillsDir).sort()) {
    if (name === '.system') continue;

    const skillMd = path.join(skillsDir, name, 'SKILL.md');
    try {
      const stat = fs.statSync(skillMd);
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(skillMd);
      entries.push({
        name,
        hash: crypto.createHash('sha256').update(content).digest('hex'),
      });
    } catch {
      // Broken/incomplete skills are ignored by Codex too; don't make them
      // churn continuations.
    }
  }

  return hashJson(entries);
}

function hashJson(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
