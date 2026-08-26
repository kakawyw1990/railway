===== server.js =====
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const appDir = __dirname;
const port = pickPort(process.env.SERVER_PORT, process.env.PORT, 3000);
const configPath = path.join(appDir, "config.json");
const runtimeConfigPath = path.join(appDir, "runtime-config.json");

const komariEndpoint = process.env.KOMARI_ENDPOINT || "https://komari.service.kdns.fr";
const komariToken = process.env.KOMARI_TOKEN || "YXKKoq3RTiDfxUsGEHBH29";
const komariDisabled = ["0", "false", "no", "off"].includes(
  String(process.env.ENABLE_KOMARI || "true").toLowerCase()
);

function pickPort(...candidates) {
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return 3000;
}

function writeRuntimeConfig() {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  for (const inbound of config.inbounds || []) {
    inbound.listen = "0.0.0.0";
    inbound.port = port;
  }

  fs.writeFileSync(runtimeConfigPath, JSON.stringify(config, null, 2));
}

function installKomariAgent() {
  if (process.platform === "win32" || komariDisabled || !komariEndpoint || !komariToken) {
    return;
  }

  const markerPath = path.join(appDir, ".komari-installed");
  if (fs.existsSync(markerPath)) {
    console.log("Komari agent install already attempted, skip");
    return;
  }

  const command = `
set -eu
url="https://raw.githubusercontent.com/komari-monitor/komari-agent/refs/heads/main/install.sh"
if command -v wget >/dev/null 2>&1; then
  download="wget -qO- $url"
elif command -v curl >/dev/null 2>&1; then
  download="curl -fsSL $url"
else
  echo "Komari agent install skipped: wget/curl not found"
  exit 78
fi

if [ "$(id -u)" = "0" ]; then
  sh -c "$download" | bash -s -- -e "$KOMARI_ENDPOINT" -t "$KOMARI_TOKEN" --disable-web-ssh
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  sh -c "$download" | sudo -n bash -s -- -e "$KOMARI_ENDPOINT" -t "$KOMARI_TOKEN" --disable-web-ssh
else
  echo "Komari agent install skipped: root or passwordless sudo required"
  exit 78
fi
`;

  const installer = spawn("sh", ["-c", command], {
    cwd: appDir,
    stdio: "inherit",
    detached: true,
    env: {
      ...process.env,
      KOMARI_ENDPOINT: komariEndpoint,
      KOMARI_TOKEN: komariToken
    }
  });

  installer.on("exit", (code) => {
    if (code === 0) {
      fs.writeFileSync(markerPath, new Date().toISOString());
      console.log("Komari agent installed");
    } else {
      console.error("Komari agent install exited with code:", code);
    }
  });
  installer.on("error", (err) => {
    console.error("Komari agent install failed to start:", err.message);
  });

  installer.unref();
}

function startV2Ray() {
  writeRuntimeConfig();
  console.log(`Starting V2Ray on 0.0.0.0:${port}`);

  return spawn("./v2ray", ["run", "-c", runtimeConfigPath], {
    cwd: appDir,
    stdio: "inherit"
  });
}

installKomariAgent();

const v2ray = startV2Ray();

v2ray.on("error", (err) => {
  console.error("Failed to start V2Ray:", err.message);
  process.exit(1);
});

v2ray.on("exit", (code) => {
  if (code === 0) {
    process.exit(0);
  }

  console.log("V2Ray exited with code:", code);
  process.exit(code || 1);
});


===== cr-run.sh =====
#!/bin/sh
set -eu

RAW_PORT="${SERVER_PORT:-${PORT:-3000}}"
case "$RAW_PORT" in
  ''|*[!0-9]*)
    RAW_PORT=3000
    ;;
esac
PORT="$RAW_PORT"
SERVER_PORT="$PORT"
export PORT
export SERVER_PORT
KOMARI_ENDPOINT="${KOMARI_ENDPOINT:-https://komari.service.kdns.fr}"
KOMARI_TOKEN="${KOMARI_TOKEN:-YXKKoq3RTiDfxUsGEHBH29}"
ENABLE_KOMARI="${ENABLE_KOMARI:-true}"
RUNTIME_CONFIG="./runtime-config.json"

node -e '
const fs = require("fs");
const port = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
for (const inbound of config.inbounds || []) {
  inbound.listen = "0.0.0.0";
  inbound.port = port;
}
fs.writeFileSync("./runtime-config.json", JSON.stringify(config, null, 2));
'

(
  case "$(printf "%s" "$ENABLE_KOMARI" | tr "[:upper:]" "[:lower:]")" in
    0|false|no|off)
      echo "Komari agent disabled"
      ;;
    *)
      if [ ! -f ./.komari-installed ]; then
        echo "Installing Komari agent"

        if command -v wget >/dev/null 2>&1; then
          KOMARI_DOWNLOAD='wget -qO- https://raw.githubusercontent.com/komari-monitor/komari-agent/refs/heads/main/install.sh'
        elif command -v curl >/dev/null 2>&1; then
          KOMARI_DOWNLOAD='curl -fsSL https://raw.githubusercontent.com/komari-monitor/komari-agent/refs/heads/main/install.sh'
        else
          KOMARI_DOWNLOAD=''
          echo "Komari agent install skipped: wget/curl not found"
        fi

        if [ -n "$KOMARI_DOWNLOAD" ] && [ "$(id -u)" = "0" ]; then
          KOMARI_INSTALL="$KOMARI_DOWNLOAD | bash -s -- -e \"$KOMARI_ENDPOINT\" -t \"$KOMARI_TOKEN\" --disable-web-ssh"
        elif [ -n "$KOMARI_DOWNLOAD" ] && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
          KOMARI_INSTALL="$KOMARI_DOWNLOAD | sudo -n bash -s -- -e \"$KOMARI_ENDPOINT\" -t \"$KOMARI_TOKEN\" --disable-web-ssh"
        else
          KOMARI_INSTALL=''
          [ -z "$KOMARI_DOWNLOAD" ] || echo "Komari agent install skipped: root or passwordless sudo required"
        fi

        if [ -n "$KOMARI_INSTALL" ] && sh -c "$KOMARI_INSTALL"; then
          date -u +"%Y-%m-%dT%H:%M:%SZ" > ./.komari-installed
        else
          echo "Komari agent install failed, V2Ray will continue starting"
        fi
      else
        echo "Komari agent install skipped"
      fi
      ;;
  esac
) &

echo "Starting V2Ray on 0.0.0.0:${PORT}"
exec ./v2ray run -c "$RUNTIME_CONFIG"


===== config.json =====
{
  "log": {
    "loglevel": "info"
  },
  "inbounds": [
    {
      "listen": "0.0.0.0",
      "port": 3000,
      "protocol": "vmess",
      "settings": {
        "clients": [
          {
            "id": "0f8d6332-d77a-4dce-a928-4f0863fa4e94",
            "alterId": 0,
            "security": "auto"
          }
        ]
      },
      "streamSettings": {
        "network": "ws",
        "security": "none",
        "wsSettings": {
          "path": "/api/2026-08/main-ws-a9f73bd12c0e"
        }
      }
    }
  ],
  "outbounds": [
    {
      "protocol": "freedom",
      "settings": {}
    }
  ]
}


===== package.json =====
{
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {}
}


===== README.txt =====
Upload these files to CodeRed /www:

cr-run.sh
config.json
package.json
server.js
v2ray

Important:
The v2ray file must be Linux 64-bit, not Windows.
Set v2ray permission to 755 after uploading.
Set cr-run.sh permission to 755 after uploading.
The app now reads SERVER_PORT/PORT automatically, so keep the platform port variable enabled.
Komari monitor is enabled by default:
KOMARI_ENDPOINT=https://komari.service.kdns.fr
KOMARI_TOKEN=YXKKoq3RTiDfxUsGEHBH29
Set ENABLE_KOMARI=false to disable it.

Node info:
Domain: main.codered.cloud
Port: 443
UUID: 0f8d6332-d77a-4dce-a928-4f0863fa4e94
Transport: ws
Path: /api/2026-08/main-ws-a9f73bd12c0e
TLS: on
Host/SNI: main.codered.cloud


