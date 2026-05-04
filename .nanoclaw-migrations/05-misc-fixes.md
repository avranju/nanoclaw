# 05 — Misc fixes

Five targeted bug fixes that aren't tied to any of the bigger features. Apply each on top of the upgraded upstream tree.

For each fix below, before applying, **check whether upstream has independently landed an equivalent fix**. Use `git log upstream/main -- <file>` to look for fix commits. If upstream's fix covers the same bug, prefer upstream and skip the user version.

---

## 5.1 Self-mod install follow-up routing (`4711bd8`)

**Intent:** When the agent installs apt/npm packages via the self-modification approval flow, the host writes a follow-up "verify the new packages" prompt to the session. The fork routes this prompt back to the originating chat (Telegram, voice, etc.) instead of the internal `agent` channel, so the user sees the verification result.

**Files:** `src/modules/self-mod/apply.ts`

**How to apply:**

1. At the top of `src/modules/self-mod/apply.ts`, add imports if missing:
   ```typescript
   import { getMessagingGroup } from '../../db/messaging-groups.js';
   import type { Session } from '../../types.js';
   ```

2. In `applyInstallPackages`, replace the `writeSessionMessage` call's hard-coded routing fields with a call to a helper:
   ```typescript
   const routing = followUpRouting(session);
   writeSessionMessage(session.agent_group_id, session.id, {
     // ... other fields unchanged ...
     platformId: routing.platformId,
     channelType: routing.channelType,
     threadId: routing.threadId,
     // ...
   });
   ```

3. Add the `followUpRouting` helper at the bottom of the file (or wherever helpers live in upstream):
   ```typescript
   function followUpRouting(session: Session): {
     platformId: string;
     channelType: string;
     threadId: string | null;
   } {
     if (session.messaging_group_id) {
       const mg = getMessagingGroup(session.messaging_group_id);
       if (mg) {
         return {
           platformId: mg.platform_id,
           channelType: mg.channel_type,
           threadId: session.thread_id,
         };
       }
     }
     return {
       platformId: session.agent_group_id,
       channelType: 'agent',
       threadId: null,
     };
   }
   ```

4. Optional but recommended: copy `src/modules/self-mod/apply.test.ts` from the fork — adds 122 lines of test coverage for the routing logic.

**Schema dependency:** Requires that `Session.messaging_group_id` and `messaging_groups` table exist. If upstream has refactored to a different relationship between sessions and channels, port the intent (look up the originating channel by whatever key is current) rather than the literal column names.

**Verification:**
1. Trigger self-mod approval flow (e.g. ask the agent to install an apt package).
2. Approve the install.
3. After container rebuild, the verification follow-up message should appear in the originating Telegram (or other) chat, not as an "internal agent note."

---

## 5.2 Scheduled-task duplicate chat output (`344d1c4`) — LIKELY OBSOLETE

**Intent (historical):** Scheduled tasks communicate with the user via `send_message` MCP calls (IPC). The v1 orchestrator was *also* forwarding the agent's final text output via `deps.sendMessage()`, delivering each scheduled task twice.

**Status:** The original target file `src/task-scheduler.ts` was removed in the v2 architectural rewrite (`2835f13`). The scheduler logic now lives elsewhere (likely under `src/scheduling/` or as a method on a class in `src/group-queue.ts` / equivalent). Search for the v2 equivalent before deciding what to do.

**How to apply (only if the bug reappears):**

1. In the upgraded tree, send a scheduled task that calls `send_message` once.
2. If the user receives **one** message: skip — v2 already does the right thing.
3. If the user receives **two** messages: locate the streaming callback that runs scheduled tasks and remove the redundant chat delivery. The intent is "for scheduled tasks, the final text output is internal; only `send_message` MCP calls reach the user."

Otherwise, **skip this fix** — it was a v1-specific band-aid that v2's architecture supersedes.

---

## 5.3 Scheduled-task dedup + container wind-down (`648d551`)

**Intent:** Two related bugs in `src/group-queue.ts`:
1. A due task got stuck in `pendingTasks` indefinitely while the group's container was alive (within its 30-min idle window) — every user message reset the idle timer and pushed the task further out.
2. The 60-second scheduler poll could find the same task as due *while it was already running* (status `'active'` in DB but no longer in `pendingTasks`), and queue it a second time.

**Files:** `src/group-queue.ts`

**How to apply:**

1. Add `runningTaskId: string | null` to the `GroupState` interface and initialize it to `null` in the group-creation code path:
   ```typescript
   interface GroupState {
     // ... existing fields ...
     pendingTasks: QueuedTask[];
     runningTaskId: string | null;
     process: ChildProcess | null;
     // ...
   }
   ```

2. In `queueTask()` (the function that pushes a task onto a group's queue), update the dedup check to consider `runningTaskId` and call `closeStdin()` to wind down an active container:
   ```typescript
   // Prevent double-queuing of the same task (whether pending or currently running)
   if (state.runningTaskId === taskId || state.pendingTasks.some((t) => t.id === taskId)) {
     logger.debug({ groupJid, taskId }, 'Task already queued or running, skipping');
     return;
   }

   if (state.active) {
     state.pendingTasks.push({ id: taskId, groupJid, fn });
     logger.debug({ groupJid, taskId }, 'Container active, task queued');
     // Signal the container to wind down so the pending task can run promptly.
     // This uses the same _close sentinel as the idle timer.
     this.closeStdin(groupJid);
     return;
   }
   ```

3. In `runTask()`, set `state.runningTaskId = task.id` at the start and clear it (`state.runningTaskId = null`) in the `finally` block alongside the other state reset.

**Verification:**
1. Have a group with an active container (recent user message).
2. Schedule a task to fire 30 seconds out. Within 60s of firing, send another user message.
3. Without the fix: task is delayed indefinitely. With the fix: container winds down after the current response, task fires promptly.
4. Watch logs for "Task already queued or running, skipping" entries — these should appear if the scheduler poll catches a still-running task.

---

## 5.4 Container skills cleanup — `capabilities` and `status` (`5680e18`)

**Intent:** Both skills checked for `/workspace/project` to detect the "main" channel — a v1 mount path that no longer exists in v2, so the check always failed. Also updates path references (`group/` → `agent/`, drops `ipc/`).

**Files:**
- `container/skills/capabilities/SKILL.md` — net-new/v2-corrected (the file is user-only — see `06-skills-inventory.md`, which copies it as part of the skills inventory).
- `container/skills/status/SKILL.md` — same.
- `container/agent-runner/src/ipc-mcp-stdio.ts` — formatting only.
- `src/channels/channel-registry.test.ts` — formatting only.
- `src/db/sessions.ts` — formatting only.

**How to apply:**

The two SKILL.md files come over with the skills inventory step (`06-skills-inventory.md`). The other three files are pure prettier formatting and don't need explicit migration — they'll be styled by the project's lint/format pass post-install.

**Verification:**

After upgrade, ask the agent in any channel: "use the /status skill" or "what are your capabilities". The skill should not return the "this only works in main chat" canned response.

---

## 5.5 What's NOT here

- Persona / SSH access policy / IST timezone in `groups/main/CLAUDE.md` — these live in a gitignored data directory and are auto-preserved through the worktree swap. **No action needed.**
- `.env.example` additions (TELEGRAM_BOT_TOKEN, TELEGRAM_ONLY) — minor, optional. The actual env values are in `.env` (data, preserved). Update `.env.example` post-upgrade if you care about documenting them for future installs.
- `package.json` `packageManager: "pnpm@10.33.0"` — already in the fork's `package.json`. After upgrade, the file is replaced by upstream's; if upstream uses npm, restore the pnpm declaration manually.
