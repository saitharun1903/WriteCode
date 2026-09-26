# Free hosting on Oracle Cloud (Always Free)

WriteCode needs a machine that runs Docker Engine, because every program runs
in its own sandbox container. Free platforms for web apps (static hosts,
serverless, most free app platforms) cannot start containers, so the only
genuinely free option that runs the full stack unchanged is an Oracle Cloud
**Always Free Ampere A1** virtual machine:

- Arm (aarch64) VM with **2 OCPUs and 12 GB RAM**, 200 GB block storage in total
  across boot and block volumes, 10 TB/month outbound traffic. Free for the life
  of the account, in the account's home region.
- Everything runs on it exactly as in `docker-compose.prod.yml`: Caddy (HTTPS),
  API, worker, Redis, Postgres, and the sandbox containers. No external Redis or
  database service is needed.
- Every image the stack uses is published for Arm64.

Source: Oracle's
[Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## Before you sign up: what Oracle asks for

- **A credit or debit card, for identity verification.** Oracle places a
  temporary authorization of about US$1 (reversed immediately) and does not
  charge the card unless you upgrade the account to Pay As You Go. The 30-day
  trial credits end on their own; Always Free resources keep running.
- **A home region, chosen at sign-up and permanent.** Always Free resources
  exist only there. For India pick **India South (Hyderabad)** or **India West
  (Mumbai)**.

Things to know, from Oracle's documentation:

- **Capacity.** Arm capacity in a region is sometimes exhausted ("Out of host
  capacity"). Retry later or in another availability domain.
- **Idle reclamation.** Oracle may reclaim an Always Free VM that is idle for 7
  days, meaning all of 95th-percentile CPU below 20%, network below 20% and
  (for A1) memory below 20%. A site with very little traffic can meet that.
  Oracle does not reclaim idle instances on Pay As You Go accounts; upgrading
  keeps Always Free resources free but puts a billable card on the account,
  so it is your decision. Keep backups either way (below).

## 1. Create the VM

1. Sign up at <https://www.oracle.com/cloud/free/> and choose your home region.
2. Console → **Compute → Instances → Create instance**.
3. **Image and shape**:
   - Image: **Canonical Ubuntu 24.04** (the aarch64 build is selected for Arm shapes).
   - Shape: **Ampere → VM.Standard.A1.Flex**, **2 OCPUs, 12 GB memory**. It shows
     "Always Free-eligible".
4. **Networking**: create a new VCN with a **public subnet** and **assign a public
   IPv4 address**.
5. **SSH keys**: generate a key pair in the form and download the private key,
   or paste the public key from your laptop (`ssh-keygen -t ed25519`, then the
   contents of `~/.ssh/id_ed25519.pub`). Keep the private key to yourself.
6. **Boot volume**: 100 GB (inside the 200 GB free allowance; sandbox images
   need about 4 GB).
7. Create. Note the **public IP address**.

## 2. Open HTTP and HTTPS in Oracle's firewall

Oracle filters traffic before it reaches the VM:

Console → **Networking → Virtual cloud networks →** your VCN → **Security lists →
Default security list → Add ingress rules**, source `0.0.0.0/0`:

| Protocol | Destination port |
| --- | --- |
| TCP | 80 |
| TCP | 443 |
| UDP | 443 |

(SSH on TCP 22 is already allowed.) `setup-server.sh` opens the same ports in
the VM's own iptables rules, which Oracle's Ubuntu images also ship with.

## 3. Install and start WriteCode, without a domain first

From your laptop:

```bash
ssh -i path/to/private.key ubuntu@<PUBLIC_IP>
```

On the VM (replace the dots in the IP with dashes, e.g. 129.154.1.2 becomes
`129-154-1-2.sslip.io`):

```bash
git clone https://github.com/saitharun1903/WriteCode.git && cd WriteCode
PUBLIC_HOST=<ip-with-dashes>.sslip.io deploy/setup-server.sh
exit
```

Log in again (so the `docker` group applies), then:

```bash
cd WriteCode && deploy/deploy.sh
```

`https://<ip-with-dashes>.sslip.io` now serves WriteCode with a real Let's
Encrypt certificate, without touching writecode.in. Verify it end to end from
your laptop before changing DNS:

```bash
node deploy/smoke.mjs https://<ip-with-dashes>.sslip.io
cd apps/web && E2E_EXECUTION=1 E2E_BASE_URL=https://<ip-with-dashes>.sslip.io npx playwright test --workers=2
```

## 4. Switch to writecode.in (only after step 3 passes)

In GoDaddy's DNS for writecode.in: edit the **A** record for `@` to the VM's
public IP (replacing "WebsiteBuilder Site"), keep `CNAME www → writecode.in`,
and leave NS, SOA, `_domainconnect` and `_dmarc` unchanged. Then on the VM:

```bash
sed -i 's/^PUBLIC_HOST=.*/PUBLIC_HOST=writecode.in/' deploy/.env.production
deploy/deploy.sh
```

Caddy obtains the certificate for writecode.in and www.writecode.in once DNS
points at the VM.

## Backups

Projects live in users' browsers. The server keeps execution records
(Postgres) and certificates (Caddy). To back up the database:

```bash
docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml \
  exec -T postgres pg_dump -U cw code_workspace | gzip > backup-$(date +%F).sql.gz
```
