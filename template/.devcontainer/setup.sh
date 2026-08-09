#!/usr/bin/env bash
# Provisions the container: opencode, a browser, the agent-browser skill.
# Idempotent: safe to re-run (`bash .devcontainer/setup.sh`).
set -euo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE"

# If you know agent-browser's npm package name, skip the discovery below with:
#   AGENT_BROWSER_PKG=<package> bash .devcontainer/setup.sh
AGENT_BROWSER_PKG="${AGENT_BROWSER_PKG:-}"
AGENT_BROWSER_REPO="${AGENT_BROWSER_REPO:-https://github.com/vercel-labs/agent-browser}"
SKILL_DIR="$WORKSPACE/.opencode/skill"

step() { printf '\n\033[36m›\033[0m %s\n' "$1"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1" >&2; }

install_bun() {
  if command -v bun >/dev/null 2>&1; then
    ok "bun $(bun --version)"
    return
  fi
  step "installing bun"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  # Later shells need to find it too.
  grep -qs 'BUN_INSTALL' "$HOME/.bashrc" || {
    printf '\nexport BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n' >>"$HOME/.bashrc"
  }
  ok "bun $(bun --version)"
}

install_opencode() {
  if command -v opencode >/dev/null 2>&1; then
    ok "opencode $(opencode --version 2>/dev/null || echo '?')"
    return
  fi
  step "installing opencode"
  npm install -g opencode-ai@latest
  ok "opencode $(opencode --version 2>/dev/null || echo 'installed')"
}

install_chromium() {
  step "installing Chromium (Playwright)"
  # --with-deps pulls the system libraries; the cache is a named volume, so it persists.
  if npx --yes playwright@latest install --with-deps chromium; then
    ok "chromium ready in ${PLAYWRIGHT_BROWSERS_PATH:-the default cache}"
  else
    warn "Playwright install failed; falling back to the Debian chromium package"
    sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends chromium
  fi
}

# agent-browser's packaging is unknown here, so inspect the repository rather than guess a
# package name. Any directory holding a SKILL.md becomes an opencode skill; a package.json
# with a `bin` is installed globally.
install_agent_browser() {
  step "installing agent-browser"

  if [ -n "$AGENT_BROWSER_PKG" ]; then
    npm install -g "$AGENT_BROWSER_PKG"
    ok "$AGENT_BROWSER_PKG installed from npm"
    return
  fi

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  if ! git clone --depth 1 "$AGENT_BROWSER_REPO" "$tmp/agent-browser" 2>/dev/null; then
    warn "could not clone $AGENT_BROWSER_REPO — step skipped"
    return
  fi

  local found=0
  mkdir -p "$SKILL_DIR"
  while IFS= read -r skill; do
    local dir name
    dir="$(dirname "$skill")"
    name="$(basename "$dir")"
    rm -rf "${SKILL_DIR:?}/$name"
    cp -R "$dir" "$SKILL_DIR/$name"
    ok "skill \"$name\" copied to .opencode/skill/"
    found=1
  done < <(find "$tmp/agent-browser" -maxdepth 4 -name SKILL.md 2>/dev/null)

  if [ -f "$tmp/agent-browser/package.json" ] && grep -q '"bin"' "$tmp/agent-browser/package.json"; then
    (cd "$tmp/agent-browser" && npm install --omit=dev >/dev/null 2>&1 && npm install -g .) &&
      ok "agent-browser CLI installed from the repository" ||
      warn "installing the agent-browser CLI failed"
    found=1
  fi

  [ "$found" -eq 1 ] || warn "no SKILL.md and no bin found in $AGENT_BROWSER_REPO — check by hand"
}

install_workspace() {
  [ -f package.json ] || return 0
  step "workspace dependencies"
  bun install
  ok "dependencies installed"
}

install_bun
install_opencode
install_chromium
install_agent_browser
install_workspace

cat <<'EOF'

Container ready.
  opencode auth login          # once; credentials live in a named volume
  harness sync && harness doctor
  sudo bash .devcontainer/firewall.sh   # optional: block everything off the allowlist
EOF
