#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for Code Workspace.
# Run as a sudo-capable user from a clone of the repository:
#
#   git clone https://github.com/saitharun1903/WriteCode.git && cd WriteCode
#   PUBLIC_HOST=writecode.in deploy/setup-server.sh
#
# Installs Docker Engine (from Docker's apt repository) and gVisor, opens only
# SSH/HTTP/HTTPS in the firewall, and writes deploy/.env.production with
# freshly generated secrets. It never prints the secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PUBLIC_HOST:?set PUBLIC_HOST, e.g. writecode.in}"

echo "== Docker Engine"
if ! command -v docker >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
sudo usermod -aG docker "$USER"

echo "== gVisor (runsc): a user-space kernel between user programs and the host"
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    | sudo tee /etc/apt/sources.list.d/gvisor.list >/dev/null
  sudo apt-get update && sudo apt-get install -y runsc
  sudo runsc install
  sudo systemctl restart docker
fi

echo "== Firewall: SSH, HTTP, HTTPS only"
sudo apt-get install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw --force enable

echo "== deploy/.env.production"
ENV_FILE=deploy/.env.production
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
PUBLIC_HOST=$PUBLIC_HOST
POSTGRES_PASSWORD=$(openssl rand -hex 24)
CLIENT_HASH_SALT=$(openssl rand -hex 32)
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
SANDBOX_RUNTIME=runsc
WORKER_CONCURRENCY=2
DEBUG_CONCURRENCY=2
EOF
  echo "wrote $ENV_FILE (mode 600, secrets generated locally, not printed)"
else
  echo "$ENV_FILE exists; left unchanged"
fi

echo
echo "Next: log out and back in (docker group), point DNS at this server, then run deploy/deploy.sh"
