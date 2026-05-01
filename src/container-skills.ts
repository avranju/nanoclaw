import fs from 'fs';
import path from 'path';

import type { ContainerConfig } from './container-config.js';

const CONTAINER_SKILLS_SUBPATH = path.join('container', 'skills');
const CONTAINER_SKILLS_TARGET_BASE = '/app/skills';

/**
 * Resolve the enabled shared container skills for a group.
 *
 * `skills: "all"` is evaluated from the host-side `container/skills` tree on
 * every spawn so newly-added skills become visible without rebuilding the
 * image. Explicit arrays are treated as the authoritative allowlist.
 */
export function resolveEnabledContainerSkills(
  projectRoot: string,
  containerConfig: Pick<ContainerConfig, 'skills'>,
): string[] {
  if (containerConfig.skills !== 'all') {
    return [...containerConfig.skills];
  }

  const sharedSkillsDir = path.join(projectRoot, CONTAINER_SKILLS_SUBPATH);
  if (!fs.existsSync(sharedSkillsDir)) return [];

  return fs
    .readdirSync(sharedSkillsDir)
    .filter((entry) => {
      try {
        return fs.statSync(path.join(sharedSkillsDir, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Mirror NanoClaw shared container skills into a provider's skill directory.
 *
 * Symlink targets are container paths. They are intentionally dangling on the
 * host and become valid after `container/skills` is mounted at `/app/skills`.
 * Non-NanoClaw entries (real dirs, files, or symlinks to other targets such as
 * Codex's `.system` skills) are preserved.
 */
export function syncContainerSkillSymlinks(
  skillsDir: string,
  projectRoot: string,
  containerConfig: Pick<ContainerConfig, 'skills'>,
  targetBase = CONTAINER_SKILLS_TARGET_BASE,
): void {
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = resolveEnabledContainerSkills(projectRoot, containerConfig);
  const desiredSet = new Set(desired);

  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let target: string | null = null;
    try {
      target = fs.readlinkSync(entryPath);
    } catch {
      continue;
    }

    const isManaged = target === `${targetBase}/${entry}`;
    if (isManaged && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    const desiredTarget = `${targetBase}/${skill}`;

    let currentTarget: string | null = null;
    try {
      currentTarget = fs.readlinkSync(linkPath);
    } catch {
      // Missing or not a symlink. If a real file/dir exists, leave it alone.
      if (fs.existsSync(linkPath)) continue;
    }

    if (currentTarget === desiredTarget) continue;
    if (currentTarget !== null) fs.unlinkSync(linkPath);
    fs.symlinkSync(desiredTarget, linkPath);
  }
}
