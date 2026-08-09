#!/usr/bin/env bash
# Outbound allowlist: everything is blocked except the hosts listed below.
# Optional, but this is the real isolation once a role has `bash: allow`.
#
#   sudo bash .devcontainer/firewall.sh
#
# Re-run after a container rebuild; the rules do not survive it.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || {
  echo "run as root: sudo bash .devcontainer/firewall.sh" >&2
  exit 1
}

# Reachable hosts. Add your own model providers here.
ALLOWED_DOMAINS=(
  registry.npmjs.org
  github.com
  api.github.com
  codeload.github.com
  objects.githubusercontent.com
  opencode.ai
  models.dev
  api.anthropic.com
  openrouter.ai
  cdn.playwright.dev
  playwright.azureedge.net
)

command -v iptables >/dev/null || apt-get update -qq && apt-get install -y -qq iptables ipset dnsutils

ipset destroy harness-allow 2>/dev/null || true
ipset create harness-allow hash:net

for domain in "${ALLOWED_DOMAINS[@]}"; do
  mapfile -t addresses < <(dig +short A "$domain" | grep -E '^[0-9.]+$' || true)
  if [ "${#addresses[@]}" -eq 0 ]; then
    echo "! $domain did not resolve, skipped" >&2
    continue
  fi
  for address in "${addresses[@]}"; do ipset add harness-allow "$address" -exist; done
  echo "✓ $domain (${#addresses[@]} address(es))"
done

# The host network, so a model server running outside the container stays reachable.
HOST_NETWORK="$(ip route | awk '/default/ {print $3}')"
[ -n "$HOST_NETWORK" ] && ipset add harness-allow "$HOST_NETWORK" -exist

iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set harness-allow dst -j ACCEPT
iptables -P OUTPUT DROP

echo
echo "Allowlist active. Check it with:"
echo "  curl -sS -m 5 https://registry.npmjs.org >/dev/null && echo 'npm OK'"
echo "  curl -sS -m 5 https://example.com >/dev/null || echo 'rest of the web blocked (expected)'"
