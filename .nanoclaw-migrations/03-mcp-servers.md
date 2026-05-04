# 03 — MCP servers (UniFi + SSH)

Two third-party MCP servers baked into the container image. Both are forks the user maintains. They are *installed* at the image layer and *registered* per-group via `groups/<name>/container.json`'s `mcpServers` map (preserved as a data dir).

The migration only needs to handle the image-layer install. Per-group registration is auto-preserved.

---

## UniFi Network MCP

**Intent:** Expose UniFi controller queries (clients, devices, alerts, etc.) as MCP tools. The user's fork at `github.com/avranju/unifi-network-mcp` includes a TLS-skip patch for self-signed certs.

**Status:** Net-new addition to `container/Dockerfile`.

**Files:**

| File | Status |
|------|--------|
| `container/Dockerfile` | modified — add UniFi MCP RUN block |

**How to apply:**

In `container/Dockerfile`, after the global `pnpm install -g` blocks (vercel, agent-browser, claude-code, codex) and before the entrypoint copy, add:

```dockerfile
# Install UniFi Network MCP server
RUN git clone --depth 1 https://github.com/avranju/unifi-network-mcp.git /opt/unifi-network-mcp \
    && cd /opt/unifi-network-mcp \
    && npm install \
    && npm run build \
    && rm -rf /opt/unifi-network-mcp/.git
```

After the build, the entrypoint is `/opt/unifi-network-mcp/dist/index.js`.

**Env vars** (read at runtime by the binary, must exist in the container's environment):
- `UNIFI_BASE_URL` — controller URL, e.g. `https://192.168.1.1`
- `UNIFI_API_KEY`

These come from `.env` on the host. The host-side container runner already passes them through; if not (i.e. upstream's `container-runner.ts` doesn't read these keys), add them to whatever passthrough mechanism it uses. The standard env-passthrough hook in this codebase is the per-provider container-config registry (`registerProviderContainerConfig`) — but for env that's read by an MCP server regardless of provider, it's simpler to pass via the per-group `container.json` `mcpServers` env map (see registration below).

**Per-group registration** (already in `groups/main/container.json` — data dir, preserved):

The user's `mcpServers` entry should look like:
```json
{
  "mcpServers": {
    "unifi-network": {
      "command": "node",
      "args": ["/opt/unifi-network-mcp/dist/index.js"],
      "env": {
        "UNIFI_BASE_URL": "${UNIFI_BASE_URL}",
        "UNIFI_API_KEY": "${UNIFI_API_KEY}",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

(The `NODE_TLS_REJECT_UNAUTHORIZED=0` is the TLS-skip workaround for self-signed UniFi certs — commit `8bb5533`.)

If the user's existing `groups/main/container.json` is missing or empty (`"mcpServers": {}`), the user is expected to wire it up after the upgrade. **The migration tool does not write into data directories.**

**Verification:**

1. `./container/build.sh` succeeds; check for `unifi-network-mcp` clone+build steps in the log.
2. `docker run --rm <image> ls /opt/unifi-network-mcp/dist/index.js` — file exists.
3. Set `UNIFI_BASE_URL` and `UNIFI_API_KEY` in `.env`.
4. Ensure `groups/main/container.json` has the `mcpServers.unifi-network` entry above.
5. Send a message: "list connected unifi clients" — agent calls `mcp__unifi-network__*` tools and returns data.

---

## SSH MCP

**Intent:** Expose SSH command execution to the agent as MCP tools. User's fork at `git.nerdworks.dev/avranju/ssh-mcp.git` (private/internal git host).

**Status:** Net-new addition to `container/Dockerfile`.

**Files:**

| File | Status |
|------|--------|
| `container/Dockerfile` | modified — add SSH MCP RUN block |

**How to apply:**

Immediately after the UniFi MCP block, add:

```dockerfile
# Install SSH MCP server
RUN git clone --depth 1 https://git.nerdworks.dev/avranju/ssh-mcp.git /opt/ssh-mcp \
    && cd /opt/ssh-mcp \
    && npm install \
    && npm run build \
    && rm -rf /opt/ssh-mcp/.git
```

The clone URL is private — the build host must have credentials to reach `git.nerdworks.dev`. If running `./container/build.sh` from a fresh machine, ensure git config / SSH keys can authenticate to that host, OR temporarily comment out this RUN block if SSH MCP isn't needed in the new environment.

After the build, the entrypoint is `/opt/ssh-mcp/dist/index.js`.

**Required mounts** (handled in `04-container-runtime.md`):
- `~/.ssh` from host → `/home/node/.ssh` in container, read-only — for the agent's identity keys.
- `data/ssh/config.json` (optional) → `/workspace/ssh/config.json`, read-only — for any SSH MCP-specific config (host aliases, etc.).

**Per-group registration** in `groups/<name>/container.json`:
```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/opt/ssh-mcp/dist/index.js"],
      "env": {
        "SSH_CONFIG_PATH": "/workspace/ssh/config.json"
      }
    }
  }
}
```

**Verification:**

1. `./container/build.sh` succeeds; SSH MCP clone+build appears in log.
2. Inside built container: `ls /opt/ssh-mcp/dist/index.js` exists.
3. After service start, agent can call `mcp__ssh__*` tools to run commands on remote hosts referenced in `~/.ssh/config` or `/workspace/ssh/config.json`.

---

## Memory note

The user's saved memory says UniFi MCP credentials are in `.env` as `UNIFI_BASE_URL` and `UNIFI_API_KEY`. That memory is correct as of guide generation; verify after upgrade that the env values still flow into the container.

If the original UniFi MCP source URL has changed (memory says `Ruashots/unifi-network-mcp`, current Dockerfile says `avranju/unifi-network-mcp` — the fork the user switched to in commit `794f1f7`), keep the `avranju` fork URL; it has the runtime fixes the user needs.
