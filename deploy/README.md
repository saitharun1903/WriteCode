# Deploying Code Workspace

One Docker-capable Linux server runs everything with Docker Compose. Users need
only a browser; programs are compiled and run in sandbox containers on this
server, never on a developer machine.

```
Internet ──▶ :443/:80  web (Caddy: automatic HTTPS, static IDE, /api + /ws proxy)
                          │ edge network
                          ▼
                         api (NestJS; validates and queues, never runs user code)
                          │ backend network (internal, no internet)
          redis ◀─────────┼──────────▶ postgres
                          ▼
                        worker ──▶ host Docker Engine ──▶ one sandbox container per run
```

| Service | Image | Published ports | Networks | Notes |
| --- | --- | --- | --- | --- |
| web | `writecode/web` (Caddy) | 80, 443 | edge | TLS certificates in the `caddy_data` volume |
| api | `writecode/api` | none | edge, backend | non-root, read-only filesystem, no capabilities |
| worker | `writecode/worker` | none | backend | non-root; Docker socket via the socket's group |
| migrate | `writecode/migrate` | none | backend | runs `prisma migrate deploy`, then exits |
| redis | `redis:7-alpine` | none | backend | append-only file in `redis_data` |
| postgres | `postgres:17-alpine` | none | backend | data in `postgres_data` |

## Server requirements

- Ubuntu 24.04 LTS (x86-64), a fixed public IPv4 address.
- Minimum 2 vCPU and 4 GB RAM (with the 2 GB swap file `setup-server.sh`
  creates on small machines) for the default 2 runs + 2 debug sessions at a
  time; 4 vCPU and 8 GB is comfortable. Each sandbox gets 1 CPU and 256 MB
  (debug sessions and the Java visualizer 512 MB). 1 GB machines are too small.
  60 GB disk: the language images are about 3 GB and are pulled on the first start.
- Provider guides: `ORACLE.md` (Always Free Arm), `AZURE.md` (temporary, x86-64).
- Inbound TCP 22, 80, 443 (and UDP 443 for HTTP/3). Nothing else.

## DNS (GoDaddy)

Keep GoDaddy's nameservers. In the domain's DNS records, first look at what is
already there, then add or edit only these (do not touch MX, SPF/TXT, DKIM or
DMARC records):

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | `@` | the server's public IPv4 address | 600 |
| CNAME | `www` | `writecode.in` | 600 |

If GoDaddy already has an `A` record for `@` (for example "Parked") edit it
rather than adding a second one, and remove any existing `A`/`CNAME` for `www`
that conflicts with the CNAME above. Caddy requests the certificates once both
names resolve to the server; until then it retries.

## First deployment

```bash
# On the server, as a sudo-capable user
git clone https://github.com/saitharun1903/WriteCode.git && cd WriteCode
PUBLIC_HOST=writecode.in deploy/setup-server.sh   # Docker, firewall, secrets
exit                                              # log in again for the docker group
cd WriteCode && deploy/deploy.sh                  # build, start, wait for readiness
```

`setup-server.sh` writes `deploy/.env.production` (mode 600) with a generated
Postgres password and client-hash salt. They never leave the server and are
not in Git.

## Updating and rolling back

```bash
deploy/deploy.sh               # deploy origin/main
deploy/deploy.sh <commit-sha>  # deploy a specific revision
```

Each deployment builds images tagged with the commit, starts them, and waits
for `https://writecode.in/api/v1/health/ready` through Caddy. If the new
version does not become ready, the previous tag (in `deploy/.last-good`) is
started again. Compose recreates containers, so a deployment has a short
restart window (typically under a minute); running programs are cut off.

To roll back by hand: `IMAGE_TAG=<older-tag> docker compose --env-file
deploy/.env.production -f deploy/docker-compose.prod.yml up -d`.

## AI assistant (optional)

The IDE's AI assistant calls Google Gemini from the API container, so the key
never reaches browsers. Add the key to `deploy/.env.production` on the server
(`GEMINI_API_KEY=...`, file mode 600, git-ignored) and run `deploy/deploy.sh`.
Without a key the assistant shows as unavailable and everything else works.
Several Gemini models are tried in order, best first (`GEMINI_MODELS`); each has
its own quota, and a model whose daily quota is used up is skipped until Google
resets it at midnight Pacific time. On the free tier the larger models allow
about 20 answers a day each, so a busy site needs a paid Gemini tier.
Limits per client: 8 questions a minute and 200 a day; across all users at most
`ASSISTANT_GLOBAL_PER_MINUTE` (default 10) requests a minute reach Gemini, to
stay inside the key's quota. Questions, code and answers are not logged.

## Health checks

| URL | Meaning |
| --- | --- |
| `/healthz` | Caddy is serving |
| `/api/v1/health/live` | API process is up |
| `/api/v1/health/ready` | Redis, Postgres and at least one worker with Docker are reachable (503 otherwise) |
| `/api/v1/health` | Detailed status used by the IDE's status bar |

Every probe has a timeout. Containers have Docker health checks; Compose starts
services only after their dependencies are healthy and migrations succeeded.

## Security notes

- The worker holds the Docker socket, which is equivalent to root on the host.
  It runs only this repository's code, as a non-root user with no capabilities,
  on a network with no internet access and no published ports. User programs run
  only in sandbox containers that have no network, a read-only root filesystem,
  no capabilities, `no-new-privileges`, and CPU, memory, PID, file-size, output
  and time limits. They never see the socket or any host path.
- Sandboxes use Docker's default runtime (runc). gVisor (`INSTALL_GVISOR=1`
  for setup, then `SANDBOX_RUNTIME=runsc`) adds a user-space kernel, but tested
  with release-20260921.0 it does not expose `/proc/*/wchan`, so programs
  waiting for typed input cannot be detected and those waits count against the
  run time limit. It stays off by default so interactive input keeps working.
- The worker removes each sandbox after its run and, on startup, removes any
  sandbox left behind by a crash.
- Logs are JSON with execution id, language, state, timings and termination
  reason. Source code and secrets are not logged; debug-adapter diagnostics may
  include short excerpts of adapter output.

## Staging on a development machine

The same images and compose file run locally with Caddy's internal certificate
authority for `https://localhost`:

```bash
# deploy/.env.staging: PUBLIC_HOST=localhost, generated secrets, DOCKER_GID=0 on Docker Desktop, IMAGE_TAG=staging
for t in api worker migrate web; do docker build --target $t -t writecode/$t:staging .; done
docker compose --env-file deploy/.env.staging -f deploy/docker-compose.prod.yml up -d --wait
cd apps/web && E2E_EXECUTION=1 E2E_BASE_URL=https://localhost E2E_IGNORE_HTTPS_ERRORS=1 npx playwright test
```

Stop the development worker first: each worker's startup cleanup removes all
sandbox containers on the Docker Engine, including the other worker's.
