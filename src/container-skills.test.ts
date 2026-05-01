import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveEnabledContainerSkills,
  syncContainerSkillSymlinks,
} from './container-skills.js';

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-'));
  temps.push(dir);
  return dir;
}

function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveEnabledContainerSkills', () => {
  it('discovers all shared container skill directories deterministically', () => {
    const root = tempDir();
    mkdirp(path.join(root, 'container', 'skills', 'zeta'));
    mkdirp(path.join(root, 'container', 'skills', 'alpha'));
    fs.writeFileSync(path.join(root, 'container', 'skills', 'README.md'), 'x');

    expect(resolveEnabledContainerSkills(root, { skills: 'all' })).toEqual([
      'alpha',
      'zeta',
    ]);
  });

  it('uses explicit skill arrays as the authoritative allowlist', () => {
    const root = tempDir();
    mkdirp(path.join(root, 'container', 'skills', 'ignored'));

    expect(
      resolveEnabledContainerSkills(root, { skills: ['malayalam-translator'] }),
    ).toEqual(['malayalam-translator']);
  });
});

describe('syncContainerSkillSymlinks', () => {
  it('mirrors enabled shared skills with container-path symlinks', () => {
    const root = tempDir();
    const skillsDir = path.join(tempDir(), 'skills');
    mkdirp(path.join(root, 'container', 'skills', 'malayalam-translator'));

    syncContainerSkillSymlinks(skillsDir, root, { skills: 'all' });

    expect(fs.readlinkSync(path.join(skillsDir, 'malayalam-translator'))).toBe(
      '/app/skills/malayalam-translator',
    );
  });

  it('removes stale managed symlinks but preserves provider-owned entries', () => {
    const root = tempDir();
    const skillsDir = path.join(tempDir(), 'skills');
    mkdirp(skillsDir);
    mkdirp(path.join(root, 'container', 'skills', 'kept'));
    fs.symlinkSync('/app/skills/stale', path.join(skillsDir, 'stale'));
    fs.symlinkSync('/codex/system/skill', path.join(skillsDir, '.system'));
    mkdirp(path.join(skillsDir, 'real-dir'));

    syncContainerSkillSymlinks(skillsDir, root, { skills: 'all' });

    expect(fs.existsSync(path.join(skillsDir, 'stale'))).toBe(false);
    expect(fs.readlinkSync(path.join(skillsDir, '.system'))).toBe(
      '/codex/system/skill',
    );
    expect(fs.statSync(path.join(skillsDir, 'real-dir')).isDirectory()).toBe(
      true,
    );
    expect(fs.readlinkSync(path.join(skillsDir, 'kept'))).toBe(
      '/app/skills/kept',
    );
  });
});
