#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for Code Workspace.
# Run as a sudo-capable user from a clone of the repository:
#
#   git clone https://github.com/saitharun1903/WriteCode.git && cd WriteCode
#   PUBLIC_HOST=writecode.in deploy/setup-server.sh
#
# Installs Docker Engine (from Docker's apt repository), opens only
# SSH/HTTP/HTTPS in the firewall, and writes deploy/.env.production with
# freshly generated secrets. It never prints the secrets. INSTALL_GVISOR=1 also
# installs gVisor (see SANDBOX_RUNTIME in deploy/.env.production.example).
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

if [ "${INSTALL_GVISOR:-0}" = 1 ] && ! command -v runsc >/dev/null; then
  echo "== gVisor (runsc), optional"
  curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    | sudo tee /etc/apt/sources.list.d/gvisor.list >/dev/null
  sudo apt-get update && sudo apt-get install -y runsc
  sudo runsc install
  sudo systemctl restart docker
fi

MEM_KB=$(awk '/^MemTotal/ {print $2}' /proc/meminfo)
if [ "$MEM_KB" -lt 6000000 ] && [ -z "$(swapon --show --noheadings)" ]; then
  # Building the images (Next.js, TypeScript) needs more memory than a 4 GB
  # machine has spare. Sandboxes are unaffected: their memory limits include
  # swap (Docker sets memory-swap equal to memory).
  echo "== 2 GB swap file (machine has under 6 GB RAM)"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== Firewall: SSH, HTTP, HTTPS only"
if [ -f /etc/iptables/rules.v4 ] && grep -q "REJECT" /etc/iptables/rules.v4; then
  # Oracle Cloud images ship iptables rules that reject everything except SSH and
  # must not be combined with ufw. Accept HTTP/HTTPS ahead of the final REJECT, then persist.
  for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443"; do
    # shellcheck disable=SC2086
    sudo iptables -C INPUT -m state --state NEW $rule -j ACCEPT 2>/dev/null \
      || sudo iptables -I INPUT "$(sudo iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')" -m state --state NEW $rule -j ACCEPT
  done
  sudo netfilter-persistent save
  echo "Oracle Cloud: also allow TCP 80, TCP 443 and UDP 443 in the subnet's security list (see deploy/ORACLE.md)."
else
  sudo apt-get install -y ufw
  sudo ufw allow OpenSSH
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw --force enable
fi

echo "== security updates and SSH brute-force protection"
# The kernel is the sandbox boundary, so it must stay patched.
sudo apt-get install -y unattended-upgrades fail2ban
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
sudo systemctl enable --now fail2ban

echo "== deploy/.env.production"
ENV_FILE=deploy/.env.production
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
PUBLIC_HOST=$PUBLIC_HOST
POSTGRES_PASSWORD=$(openssl rand -hex 24)
CLIENT_HASH_SALT=$(openssl rand -hex 32)
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
SANDBOX_RUNTIME=
WORKER_CONCURRENCY=2
DEBUG_CONCURRENCY=2
EOF
  echo "wrote $ENV_FILE (mode 600, secrets generated locally, not printed)"
else
  echo "$ENV_FILE exists; left unchanged"
fi

echo
echo "Next: log out and back in (docker group), point DNS at this server, then run deploy/deploy.sh"
