#!/usr/bin/env bash
# Per-checkout install identifiers — shell counterpart to src/install-slug.ts.
# Source this file, then call container_image_base / launchd_label / systemd_unit.

# Usage: install_slug [project_root]
install_slug() {
  local root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  printf '%s' "$root" | sha1sum | cut -c1-8
}

# Docker image base (no tag). e.g. nanoclaw-agent-v2-ab12cd34
container_image_base() {
  local root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  echo "nanoclaw-agent-v2-$(install_slug "$root")"
}

# launchd Label + plist basename. e.g. com.nanoclaw-v2-ab12cd34
launchd_label() {
  local root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  echo "com.nanoclaw-v2-$(install_slug "$root")"
}

# systemd unit name (no .service suffix). e.g. nanoclaw-v2-ab12cd34
systemd_unit() {
  local root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  echo "nanoclaw-v2-$(install_slug "$root")"
}
