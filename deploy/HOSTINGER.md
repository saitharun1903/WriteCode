# Hosting on a Hostinger VPS (KVM 2)

WriteCode runs every program in its own Docker sandbox, so it needs a real
virtual machine with root access. A Hostinger **KVM 2** VPS fits well:
2 vCPU and 8 GB RAM run the whole stack in `docker-compose.prod.yml` (Caddy,
API, worker, Redis, Postgres and the sandboxes) on one machine.

What it handles, roughly (see "Capacity" below): hundreds of people editing,
about 50–100 people actively running programs, and 4 debug sessions at once.

## 1. Buy and set up the VPS in hPanel

1. Plan **KVM 2**, server location **India** (or nearest your users).
2. Skip the paid "Daily auto-backup" add-on; see "Backups" below.
3. The free domain is not needed: writecode.in stays at GoDaddy.
4. When asked for the operating system choose **plain OS → Ubuntu 24.04**, not
   an image with a control panel (cPanel, CyberPanel, Coolify…).
5. Set a strong root password in hPanel and **add your SSH public key**
   (hPanel → VPS → Settings → SSH keys). On your laptop:
   `ssh-keygen -t ed25519`, then paste the contents of `~/.ssh/id_ed25519.pub`.
   Never share the private key or the password.
6. Note the VPS's **public IPv4 address** (VPS overview page).
7. hPanel's VPS **Firewall** is off by default. If you turn it on, allow TCP 22,
   TCP 80, TCP 443 and UDP 443. `setup-server.sh` also opens exactly these
   ports in the VM's own firewall (ufw).

## 2. A user for the app (recommended)

Log in as root once and create a normal user with sudo, reusing your SSH key:

```bash
ssh root@<PUBLIC_IP>
adduser writecode                 # choose a password
usermod -aG sudo writecode
rsync --archive --chown=writecode:writecode ~/.ssh /home/writecode
exit
```

## 3. Install and start WriteCode, without the domain first

```bash
ssh writecode@<PUBLIC_IP>
git clone https://github.com/saitharun1903/WriteCode.git && cd WriteCode
PUBLIC_HOST=<ip-with-dashes>.sslip.io deploy/setup-server.sh
exit
```

(Replace the dots in the IP with dashes: 82.112.1.2 becomes
`82-112-1-2.sslip.io`.) Log in again so the `docker` group applies, then set
the KVM 2 sizes and, if you want the AI assistant, its key. Type the key into
the file yourself; never paste it into a chat or commit it:

```bash
cd WriteCode
sed -i 's/^WORKER_CONCURRENCY=.*/WORKER_CONCURRENCY=2/; s/^DEBUG_CONCURRENCY=.*/DEBUG_CONCURRENCY=4/' deploy/.env.production
nano deploy/.env.production        # set GEMINI_API_KEY=... (optional)
deploy/deploy.sh
```

The first deploy builds the images and pulls the language images (about
3 GB); allow 10–15 minutes. `https://<ip-with-dashes>.sslip.io` then serves
WriteCode with a real Let's Encrypt certificate, while writecode.in is
untouched. Check it end to end from your laptop:

```bash
node deploy/smoke.mjs https://<ip-with-dashes>.sslip.io
cd apps/web && E2E_EXECUTION=1 E2E_BASE_URL=https://<ip-with-dashes>.sslip.io npx playwright test --workers=2
```

## 4. Switch to writecode.in (only after step 3 passes)

In GoDaddy's DNS for writecode.in edit the **A** record for `@` to the VPS's
IP (replacing "WebsiteBuilder Site"), keep `CNAME www → writecode.in`, and
leave NS, SOA, `_domainconnect` and `_dmarc` unchanged. Then on the VPS:

```bash
sed -i 's/^PUBLIC_HOST=.*/PUBLIC_HOST=writecode.in/' deploy/.env.production
deploy/deploy.sh
```

Caddy obtains the certificates for writecode.in and www.writecode.in as soon
as DNS points at the VPS (usually minutes; GoDaddy's TTL can make it up to an
hour).

## Updating

```bash
cd WriteCode && deploy/deploy.sh          # deploys origin/main, rolls back on failure
```

## Capacity (KVM 2, measured timings)

- Editing, files, tests and visualizer playback run in the browser, so browsing
  and typing cost the server almost nothing.
- `WORKER_CONCURRENCY=2` runs two programs at once. A Java run takes 1–2 s end
  to end, so about 60–100 runs a minute; others wait in the queue.
- `DEBUG_CONCURRENCY=4` allows four open debug sessions; more wait for a slot.
- Each person is limited to 30 runs a minute and 3 at a time, and to 8 AI
  questions a minute and 200 a day.
- The AI assistant on Google's free Gemini tier gives roughly 100–150 answers a
  day in total across all users. A paid Gemini key removes that limit.
- For a whole class running and debugging at the same time, upgrade to KVM 4 in
  hPanel; nothing needs reinstalling.

## Backups

Projects live in users' browsers. The server keeps run records (Postgres) and
certificates (Caddy); a lost server loses no user code. Hostinger's plan
includes periodic backups (check hPanel → Backups). For your own copy of the
database:

```bash
docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml \
  exec -T postgres pg_dump -U cw code_workspace | gzip > backup-$(date +%F).sql.gz
```
