#!/bin/sh
# Deploy this working copy to an instance: a machine described in instances/<name>/ (see instances/README.md).
#
#   scripts/deploy.sh <name>              build the web app here, copy the code over SSH, install, restart
#   scripts/deploy.sh <name> --dry-run    show what would be copied and run, change nothing
#
# Never touches the instance's database (server/netmap.db*). server/config.json is replaced by
# instances/<name>/config.json when that file exists. Files deleted here aren't deleted there.
set -eu

DIR=$(cd "$(dirname "$0")/.." && pwd)
NAME=${1:-}; DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1
[ -n "$NAME" ] && [ -f "$DIR/instances/$NAME/instance.env" ] || {
  echo "usage: $0 <instance> [--dry-run]"; echo "instances:"; ls "$DIR/instances" | grep -v README; exit 1; }
INST="$DIR/instances/$NAME"

# instance.env: SSH_TARGET, REMOTE_DIR, RESTART (systemctl | kill | none), INSTALL_FLAGS, PORT
SSH_TARGET= REMOTE_DIR= RESTART=systemctl INSTALL_FLAGS= PORT=8090
. "$INST/instance.env"
[ -n "$SSH_TARGET" ] && [ -n "$REMOTE_DIR" ] || { echo "$INST/instance.env needs SSH_TARGET and REMOTE_DIR"; exit 1; }
HOSTNAME_ONLY=${SSH_TARGET#*@}
say() { printf '\n== %s\n' "$*"; }

say "Building the web app"
(cd "$DIR/web" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build >/dev/null)

# what goes over: the tracked files plus new ones git isn't ignoring, never instances/; plus the built web app
LIST=$(mktemp)
(cd "$DIR" && git ls-files -co --exclude-standard | grep -v '^instances/' | while read -r f; do [ -f "$f" ] && echo "$f"; done; \
  find web/dist -type f) > "$LIST"
say "$(wc -l < "$LIST") files for $NAME ($SSH_TARGET:$REMOTE_DIR)"

if [ "$DRY" = 1 ]; then
  sed 's/^/  /' "$LIST" | head -50; [ "$(wc -l < "$LIST")" -gt 50 ] && echo "  …"
  [ -f "$INST/config.json" ] && echo "  server/config.json  <- instances/$NAME/config.json"
  echo; echo "then on $SSH_TARGET: sh scripts/install.sh --skip-web $INSTALL_FLAGS; restart: $RESTART"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$SSH_TARGET" "echo reachable: \$(uname -nm); ls -d '$REMOTE_DIR' 2>/dev/null || echo '$REMOTE_DIR does not exist yet (first deploy)'"
  rm -f "$LIST"; exit 0
fi

say "Copying"
ssh "$SSH_TARGET" "mkdir -p '$REMOTE_DIR'"
(cd "$DIR" && tar -czf - -T "$LIST") | ssh "$SSH_TARGET" "cd '$REMOTE_DIR' && rm -rf web/dist && tar -xzf -"
rm -f "$LIST"
if [ -f "$INST/config.json" ]; then
  ssh "$SSH_TARGET" "umask 077 && cat > '$REMOTE_DIR/server/config.json'" < "$INST/config.json"
fi

say "Installing on $SSH_TARGET"
ssh "$SSH_TARGET" "cd '$REMOTE_DIR' && sh scripts/install.sh --skip-web $INSTALL_FLAGS"

say "Restarting ($RESTART)"
case "$RESTART" in
  systemctl) ssh "$SSH_TARGET" "sudo -n systemctl restart netmap" ;;
  # no sudo there: SIGKILL counts as a failure, so systemd (Restart=on-failure) starts it again
  kill) ssh "$SSH_TARGET" 'pid=$(systemctl show netmap -p MainPID --value); [ "$pid" != 0 ] && kill -KILL "$pid"' ;;
  none) echo "skipped" ;;
  *) echo "unknown RESTART=$RESTART"; exit 1 ;;
esac

say "Checking http://$HOSTNAME_ONLY:$PORT"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null "http://$HOSTNAME_ONLY:$PORT/api/devices" 2>/dev/null; then echo "up: http://$HOSTNAME_ONLY:$PORT"; exit 0; fi
  sleep 2
done
echo "not answering on $HOSTNAME_ONLY:$PORT yet (if it only listens on 127.0.0.1 that's expected); check: ssh $SSH_TARGET journalctl -u netmap -n 50"
exit 1
