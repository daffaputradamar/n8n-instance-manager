# n8n Manager

A small admin panel that solves n8n's single-tenant problem: the free/on-prem
version of n8n has **one shared login**, which means every credential any
user saves is visible to every other user on that instance.

This app gives each user their **own n8n container**, with its own data
volume, reachable at its own path — `http://your-server:8000/{code}/` —
so credentials and workflows never mix between users. You (the admin) are
the only one who can create, start, stop, or delete instances.

## How it works

```
                        ┌─────────────────────────────┐
  you, in a browser ──▶ │   n8n-manager (this app)     │
                        │   - dashboard + auth          │
                        │   - /api/... instance control │
                        │   - /{code}/ ──▶ proxy ───────┼──▶ n8n-daffa   (container, its own volume)
                        └─────────────────────────────┘  └─▶ n8n-alice   (container, its own volume)
                                                          └─▶ n8n-teamops (container, its own volume)
```

- Each instance is a real `n8nio/n8n` Docker container, named `n8n-{code}`,
  on its own named volume `n8n-data-{code}` — so one user's credentials
  physically live in a different container/volume than another's.
- All containers join a private Docker network (`n8n-manager-net`) shared
  with the manager. **No ports are published to the host** — the manager
  reaches each container by its container name over that network, so you
  don't need to track a port per user.
- The manager sets `N8N_PATH`, `WEBHOOK_URL`, and `N8N_EDITOR_BASE_URL` on
  each container so n8n itself knows it's being served under `/{code}/`
  (this matters for the editor's asset URLs and for webhooks to resolve
  correctly).
- Optionally, you can also set a basic-auth username/password per instance,
  as a second login layer in front of that specific n8n container.

## Requirements

- A Linux host (or VM) with **Docker** and **Docker Compose** installed.
- That's it — the manager itself runs in Docker too.

## Setup

```bash
cd n8n-manager
cp .env.example .env
```

Edit `.env`:

```bash
ADMIN_USER=admin
ADMIN_PASSWORD=some-strong-password       # change this
SESSION_SECRET=a-long-random-string       # change this
PUBLIC_BASE_URL=http://YOUR_SERVER_IP:8000  # or https://automation.yourcompany.com
```

`PUBLIC_BASE_URL` matters: it's baked into each instance's webhook/editor
URLs. Set it to whatever address people will actually type in their
browser to reach this server.

Then:

```bash
docker compose up -d --build
```

Open `http://YOUR_SERVER_IP:8000`, sign in with `ADMIN_USER` /
`ADMIN_PASSWORD`, and create your first instance.

## Using the dashboard

- **New instance** — pick a code (e.g. `daffa`, `team-ops`). This becomes
  both the container name and the URL path. Owner name and a basic-auth
  login are optional.
- **Start / Stop / Restart** — controls the container directly.
- **Logs** — tails the last 200 lines from the container.
- **Delete** — removes the container. There's a separate checkbox to also
  wipe its data volume (workflows + credentials) — off by default, so you
  can delete-and-recreate a container without losing data if needed.

Each card shows the exact URL for that instance, e.g.:

```
http://YOUR_SERVER_IP:8000/daffa/
```

Give that link to the person the instance is for.

## Notes on running this behind a real domain / HTTPS

This app doesn't terminate TLS itself. If you want a real domain and
HTTPS, put a reverse proxy (Caddy, nginx, Traefik) in front of it that
forwards to `manager:8000` (or `localhost:8000`), and set
`PUBLIC_BASE_URL` to the public `https://...` address. Because routing is
path-based and handled entirely inside this app, that outer reverse proxy
only needs a single simple rule — it doesn't need to know about
individual users at all.

## Security notes

- Only one admin account exists (`ADMIN_USER` / `ADMIN_PASSWORD` in `.env`).
  There's no self-service signup — you create instances for people.
- Session cookies are `httpOnly`. There's no built-in HTTPS, so put this
  behind TLS (see above) before exposing it outside a trusted network.
- The manager container is mounted with access to `/var/run/docker.sock`,
  which effectively gives it root-equivalent control over the Docker host.
  Treat the admin login with the same care as SSH access to the server.
- Each n8n container's actual login (n8n's own basic auth, if you set one)
  is separate from the manager's admin login — the person using instance
  `daffa` never sees or needs the manager's admin credentials.

## Project layout

```
n8n-manager/
├── docker-compose.yml   # runs the manager + creates the shared network
├── Dockerfile           # manager app image
├── server.js            # Express app: auth, instance API, dynamic proxy
├── src/
│   ├── db.js            # JSON-file store for instance metadata
│   ├── docker.js        # dockerode calls: create/start/stop/remove/logs
│   └── auth.js          # session auth guard
└── public/              # dashboard UI (vanilla JS, no build step)
```
