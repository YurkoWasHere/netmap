#!/bin/sh
# netmap installer: dependencies, the web build, a config file and (optionally) a systemd service.
# Run it from anywhere; it works on the folder it lives in. Safe to run again (e.g. after git pull).
#
#   scripts/install.sh                      install / update in place
#   scripts/install.sh --with-node          also download Node.js into ./node (when the system's is too old)
#   scripts/install.sh --listen 0.0.0.0     reachable from other machines (default: this machine only)
#   scripts/install.sh --service            install and start the systemd service (asks for sudo)
set -eu

NODE_VERSION=24.21.0          # used by --with-node
MIN_NODE=22.13                # node:sqlite without a flag
DIR=$(cd "$(dirname "$0")/.." && pwd)
WITH_NODE=0 SERVICE=0 LISTEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --with-node) WITH_NODE=1 ;;
    --service) SERVICE=1 ;;
    --listen) LISTEN="$2"; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)"; exit 1 ;;
  esac
  shift
done

say() { printf '\n== %s\n' "$*"; }

# ---- Node.js
if [ "$WITH_NODE" = 1 ] && [ ! -x "$DIR/node/bin/node" ]; then
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; armv7l) ARCH=armv7l ;;
    *) echo "no Node.js download for $(uname -m); install Node $MIN_NODE+ yourself"; exit 1 ;;
  esac
  say "Downloading Node.js $NODE_VERSION ($ARCH) into $DIR/node"
  TMP=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz" -o "$TMP/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  (cd "$TMP" && grep " node-v$NODE_VERSION-linux-$ARCH.tar.xz\$" SHASUMS256.txt | sed 's/ .*//' > want && \
    [ "$(sha256sum node.tar.xz | cut -d' ' -f1)" = "$(cat want)" ]) || { echo "checksum mismatch"; exit 1; }
  mkdir -p "$DIR/node" && tar -xJf "$TMP/node.tar.xz" -C "$DIR/node" --strip-components=1
  rm -rf "$TMP"
fi
if [ -x "$DIR/node/bin/node" ]; then PATH="$DIR/node/bin:$PATH"; export PATH; fi
command -v node >/dev/null || { echo "Node.js $MIN_NODE+ is needed: install it, or run with --with-node"; exit 1; }
NODE=$(command -v node)
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number),[x,y]='$MIN_NODE'.split('.').map(Number);process.exit(a>x||(a===x&&b>=y)?0:1)"; then
  echo "Node.js $(node -v) is too old (need $MIN_NODE+). Run with --with-node to use a private copy."; exit 1
fi
say "Using Node.js $(node -v) ($NODE)"

# ---- dependencies and the web build
say "Installing server dependencies"
(cd "$DIR/server" && npm ci --omit=dev --no-audit --no-fund)
say "Building the web app"
(cd "$DIR/web" && npm ci --no-audit --no-fund && npm run build)

# ---- config (never overwritten; holds no secrets, device logins live in the database)
if [ ! -f "$DIR/server/config.json" ]; then
  cp "$DIR/server/config.example.json" "$DIR/server/config.json"
  say "Created server/config.json"
fi
if [ -n "$LISTEN" ]; then
  node -e "const f=process.argv[1],c=JSON.parse(require('fs').readFileSync(f,'utf8'));c.host=process.argv[2];require('fs').writeFileSync(f,JSON.stringify(c,null,2)+'\n')" "$DIR/server/config.json" "$LISTEN"
  say "Listening on $LISTEN (server/config.json)"
fi

# ---- systemd service
if [ "$SERVICE" = 1 ]; then
  U=$(id -un) G=$(id -gn)
  say "Installing the systemd service (runs as $U)"
  sed -e "s|@USER@|$U|g" -e "s|@GROUP@|$G|g" -e "s|@DIR@|$DIR|g" -e "s|@NODE@|$NODE|g" "$DIR/deploy/netmap.service" > "$DIR/server/netmap.service.tmp"
  sudo install -m 644 "$DIR/server/netmap.service.tmp" /etc/systemd/system/netmap.service
  rm -f "$DIR/server/netmap.service.tmp"
  sudo systemctl daemon-reload
  sudo systemctl enable netmap
  sudo systemctl restart netmap
  echo "Started. Logs: journalctl -u netmap -f"
else
  say "Done. Start it with:  cd $DIR/server && $NODE server.js"
fi
PORT=$(node -e "console.log(require('$DIR/server/config.json').port||8090)")
HOST=$(node -e "const h=require('$DIR/server/config.json').host||'127.0.0.1';console.log(h==='0.0.0.0'?'<this machine>':h)")
echo "Then open http://$HOST:$PORT"
