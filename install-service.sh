#!/usr/bin/env bash
# Render a candy systemd unit for this machine and install it.
#   ./install-service.sh daemon   -> /etc/systemd/system/candy-localhost@.service
#                                    (+ the function shim in /usr/lib/candy)
#   ./install-service.sh dns      -> /etc/systemd/system/candy-dns.service
#   ./install-service.sh <kind> --print   -> print the rendered unit, install nothing
set -euo pipefail

kind="${1:-}"
mode="${2:-install}"
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$kind" in
  daemon) src="$dir/candy-localhost.service"; dest="/etc/systemd/system/candy-localhost@.service"
          hint="sudo systemctl enable --now candy-localhost@${SUDO_USER:-$USER}" ;;
  dns)    src="$dir/candy-dns.service"; dest="/etc/systemd/system/candy-dns.service"
          hint="sudo systemctl enable --now candy-dns" ;;
  *) echo "usage: $0 daemon|dns [--print]" >&2; exit 2 ;;
esac

user="${SUDO_USER:-$USER}"
home="$(getent passwd "$user" | cut -d: -f6)"
bun="$(command -v bun || true)"
[ -n "$bun" ] || bun="$home/.bun/bin/bun"
[ -x "$bun" ] || { echo "bun not found (looked on PATH and $home/.bun/bin)" >&2; exit 1; }
caddy="$(command -v caddy || echo /usr/bin/caddy)"

rendered="$(sed \
  -e "s#__CANDY_DIR__#$dir#g" \
  -e "s#__BUN_DIR__#$(dirname "$bun")#g" \
  -e "s#__BUN__#$bun#g" \
  -e "s#__CADDY__#$caddy#g" \
  -e "s#__USER__#$user#g" \
  -e "s#__HOME__#$home#g" \
  "$src")"

if [ "$mode" = "--print" ]; then
  printf '%s\n' "$rendered"
  exit 0
fi

printf '%s\n' "$rendered" | sudo tee "$dest" >/dev/null

# Functions: the shim runs inside each function's sandbox as that function's
# user, so it (and every module it imports) goes somewhere all users can read.
# fn-tool.ts is what the daemon runs as a function's user for config, deploys and KV/D1.
if [ "$kind" = daemon ]; then
  fn_dir=/usr/lib/candy
  sudo install -d -m 0755 "$fn_dir"
  sudo install -m 0644 \
    "$dir/fn-host.ts" "$dir/fn-protocol.ts" "$dir/fn-bindings.ts" "$dir/fn-cron.ts" "$dir/fn-console.ts" \
    "$dir/fn-config.ts" "$dir/fn-deploy.ts" "$dir/fn-tool.ts" "$dir/cron.ts" \
    "$fn_dir/"
  echo "Installed the function shim in $fn_dir"
fi

sudo systemctl daemon-reload
echo "Installed $dest"
echo "Enable with: $hint"
