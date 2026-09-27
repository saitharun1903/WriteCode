# Temporary hosting on an Azure VM

Azure is used here only as a plain Ubuntu machine. Nothing in the application
knows it runs on Azure: the same `setup-server.sh`, `deploy.sh`, compose file and
`.env.production` are used on Oracle Cloud (`ORACLE.md`) or any other Linux VM.

## Size: why the free VMs are not enough

Measured on the production stack (`docker-compose.prod.yml`) while running the
full smoke suite, plus the sandbox limits the worker enforces:

| Part | Memory |
| --- | --- |
| Services (Caddy, API, worker, Redis, Postgres), peak | ~320 MB |
| Ubuntu + Docker Engine | ~500 MB |
| 2 concurrent runs × 256 MB (Java visualizer: 512 MB) | up to 1 GB |
| 2 concurrent debug sessions × 512 MB | up to 1 GB |
| Building the images on the VM (Next.js, TypeScript) | 1.5 to 2.5 GB, once per deployment |

The free-account VM sizes (B1s, B2ats v2, B2pts v2) all have **1 GB RAM**: a
single debug session plus the services would not fit, and the images could not
be built. Making them fit would mean lowering the sandbox memory limits and
concurrency, which removes functionality.

**Recommended: `Standard_B2als_v2`** (2 vCPU AMD EPYC, x86-64, 4 GB RAM) with a
2 GB swap file that `setup-server.sh` creates for image builds. Sandbox limits
include swap, so programs are not slowed by it.

Azure list prices, Central India, Linux, pay-as-you-go (from
`prices.azure.com`, September 2026; 730 hours per month):

| Resource | Hourly | Monthly |
| --- | --- | --- |
| VM `Standard_B2als_v2` | US$0.0246 | US$17.96 |
| Standard static public IPv4 | US$0.005 | US$3.65 |
| OS disk, Standard SSD E6 (64 GB) | | US$5.28 |
| **Total** | **≈ US$0.037** | **≈ US$27** |

The first 100 GB of outbound traffic per month is free. Azure credit (free
trial or Azure for Students) pays for this until it runs out; the VM does not
upgrade your account to pay-as-you-go on its own.

## 1. SSH key (on your laptop)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/writecode_azure
```

You will paste the contents of `~/.ssh/writecode_azure.pub` (the public key)
into Azure. The private key stays on your laptop and is never shared.

## 2. Budget alert (free)

Portal → **Cost Management + Billing → Budgets → Add**: scope your subscription,
amount e.g. US$30/month, alert at 50%, 80% and 100% to your email.

## 3. Create the VM

Portal → **Virtual machines → Create → Azure virtual machine**.

**Basics**
- Resource group: **Create new** → `writecode-rg`
- Virtual machine name: `writecode`
- Region: **(Asia Pacific) Central India**
- Availability options: **No infrastructure redundancy required**
- Security type: **Standard**
- Image: **Ubuntu Server 24.04 LTS - x64 Gen2**
- Size: **See all sizes** → search `B2als_v2` → **Standard_B2als_v2**
- Authentication type: **SSH public key**; username `azureuser`;
  SSH public key source **Use existing public key**; paste the `.pub` file's contents
- Public inbound ports: **Allow selected ports** → **SSH (22), HTTP (80), HTTPS (443)**

**Disks**
- OS disk size: **64 GiB**; OS disk type: **Standard SSD (locally-redundant storage)**
- **Delete with VM**: checked

**Networking**
- Virtual network, subnet: the defaults (new)
- Public IP: the default new one (Standard SKU, static address)
- NIC network security group: **Basic**, same three ports
- **Delete public IP and NIC when VM is deleted**: checked
- Load balancing: **None**

**Management**
- Enable system assigned managed identity: **unchecked** (the VM needs no Azure
  credentials; this keeps the metadata endpoint from handing any out)
- Auto-shutdown: **Off** (it is a server)
- Backup: off

**Monitoring**: leave alerts off. **Advanced**: nothing.

**Review + create** shows the hourly price; check it matches the table above,
then **Create**. Note the VM's **Public IP address** on its Overview page.

Redis, Postgres, the API and the worker publish no ports; only 22, 80 and 443
are reachable, and `setup-server.sh` also enables `ufw` with the same three
ports.

## 4. Install and start, without the domain

```bash
ssh -i ~/.ssh/writecode_azure azureuser@<PUBLIC_IP>
git clone https://github.com/saitharun1903/WriteCode.git && cd WriteCode
PUBLIC_HOST=<ip-with-dashes>.sslip.io deploy/setup-server.sh
exit
ssh -i ~/.ssh/writecode_azure azureuser@<PUBLIC_IP>
cd WriteCode && deploy/deploy.sh
```

`<ip-with-dashes>.sslip.io` (e.g. `20-198-1-2.sslip.io`) is a public DNS name
that resolves to the IP inside it, so Caddy gets a real Let's Encrypt
certificate without touching writecode.in. Then from your laptop:

```bash
node deploy/smoke.mjs https://<ip-with-dashes>.sslip.io
cd apps/web && E2E_EXECUTION=1 E2E_BASE_URL=https://<ip-with-dashes>.sslip.io npx playwright test --workers=2
```

## 5. Switch to writecode.in (only after step 4 passes)

In GoDaddy's DNS for writecode.in: edit the **A** record for `@` to the VM's
public IP and remove the second `@` A record, keep `CNAME www → writecode.in`,
and leave NS, SOA, `_domainconnect` and `_dmarc` unchanged. Then on the VM:

```bash
sed -i 's/^PUBLIC_HOST=.*/PUBLIC_HOST=writecode.in/' deploy/.env.production
deploy/deploy.sh
```

## Moving to Oracle (or any VM) later

1. Back up the database on Azure:
   `docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml exec -T postgres pg_dump --clean --if-exists -U cw code_workspace | gzip > backup.sql.gz`
   and copy `backup.sql.gz` and `deploy/.env.production` to your laptop (`scp`).
2. Set up the new VM with `ORACLE.md` steps 1 to 3, but copy the saved
   `deploy/.env.production` into the clone before running `setup-server.sh`
   (it keeps an existing file), then fix `DOCKER_GID`
   (`stat -c %g /var/run/docker.sock`) and `PUBLIC_HOST` (sslip.io name) in it.
3. `deploy/deploy.sh`, then restore:
   `gunzip -c backup.sql.gz | docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml exec -T postgres psql -U cw code_workspace`
4. Test on the sslip.io name, change the GoDaddy `@` A record to the new IP,
   set `PUBLIC_HOST=writecode.in`, run `deploy/deploy.sh`.
5. Delete the Azure resource group `writecode-rg` (removes VM, disk, IP, network).

Projects themselves live in users' browsers, so nothing else needs moving.
Certificates are issued again automatically on the new server.
