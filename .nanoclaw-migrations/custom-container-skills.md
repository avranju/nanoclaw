# Custom Container Skills

## Intent

Three container skills added to `container/skills/` that are not present in upstream. These are skill `.md` files that teach the container agent how to perform specific tasks. They are symlinked into the container at `/app/skills/` and available as Bash tools.

## Files

### `container/skills/capabilities/SKILL.md` — NEW FILE (88 lines)

The `/capabilities` command. Generates a structured read-only report of what this NanoClaw instance can do.

**How it works:**
1. Lists skill directories from `/home/node/.claude/skills/`
2. Lists available tools (Core, Web, Orchestration, MCP)
3. Lists MCP server tools (send_message, schedule_task, etc.)
4. Checks for container tools (agent-browser, etc.)
5. Reports agent info (memory, extra mounts)

**Report format:** Clean markdown with sections for Installed Skills, Tools, Container Tools, and System.

### `container/skills/status/SKILL.md` — NEW FILE (93 lines)

The `/status` command. Quick read-only health check of the agent environment.

**How it works:**
1. Reports session context (timestamp, working dir, channel)
2. Checks workspace visibility (agent folder, global memory, extra mounts)
3. Confirms tool availability (Core, Web, Orchestration, MCP)
4. Checks container utilities (agent-browser, node version, claude version)
5. Reports scheduled tasks via MCP

**Report format:** Clean markdown with sections for Session, Workspace, Tools, Container, and Scheduled Tasks.

### `container/skills/malayalam-translator/SKILL.md` — NEW FILE (96 lines)

The Malayalam translator. Translates English text into colloquial spoken Malayalam with both Malayalam script and Roman-script transliteration.

**How it works:**
1. Produces three parts: translation note, Malayalam script (in code block), transliteration
2. Prefers casual, colloquial Malayalam (not formal/literary)
3. Handles pronoun/politeness register choices
4. Uses common colloquialisms (എന്താ not എന്ത്, etc.)
5. Provides transliteration with intuitive English approximations

**Output format:**
```
Translation note: [brief explanation]

**Malayalam:**
```
[Malayalam script text]
```

**Transliteration:** *[Romanized text]*
```

## How to apply

1. Create `container/skills/capabilities/SKILL.md` with the full file content (88 lines)
2. Create `container/skills/status/SKILL.md` with the full file content (93 lines)
3. Create `container/skills/malayalam-translator/SKILL.md` with the full file content (96 lines)

These skills will be automatically discovered by the container skill sync system (which reads all directories under `container/skills/`) and symlinked into the container at `/app/skills/`.

## Notes

- These skills are instruction-only (SKILL.md files). They don't add code — they teach the container agent how to perform tasks.
- The skills are loaded dynamically at container spawn time (when `skills: "all"` is configured).
- They are available as Bash tools inside the container agent.
