# parchment-server

Per-user save backend for [Parchment](https://github.com/curiousdannii/parchment),
the web-based interactive fiction interpreter. Designed to run alongside the
parchment nginx container behind Traefik + Authentik forward-auth.

## Layout

- `main.go` — small HTTP service. Stores saves at `/data/<user>/<game>/<file>`.
- `frontend/http-provider.js` — JS shim implementing Parchment's `BrowserDialog`
  interface, routing save paths through this service.

## API

All requests require the `X-Authentik-Username` header (forwarded by the
Traefik `authentik-forward` middleware). The backend trusts this header and
must never be exposed without that middleware in front.

| Method | Path                              | Action                          |
|--------|-----------------------------------|---------------------------------|
| GET    | `/api/saves/whoami`               | `{user}` or 401                 |
| GET    | `/api/saves/health`               | liveness                        |
| GET    | `/api/saves/<game>`               | list saves                      |
| GET    | `/api/saves/<game>/<file>`        | read save bytes                 |
| HEAD   | `/api/saves/<game>/<file>`        | exists check                    |
| PUT    | `/api/saves/<game>/<file>`        | store (max 1 MB)                |
| DELETE | `/api/saves/<game>/<file>`        | remove                          |

`<user>`, `<game>`, `<file>` must match `^[A-Za-z0-9._-]+$`.

## Build

```sh
go build -o parchment-saves ./...
PARCHMENT_SAVES_DIR=./data PARCHMENT_SAVES_ADDR=127.0.0.1:8080 ./parchment-saves
```

## Container integration

Built into the parchment nginx image via `additional_contexts` in
`/willflix/docker/compose.yml`. The image runs both nginx (frontend) and
the Go binary (backend); nginx proxies `/api/saves/*` to `127.0.0.1:8080`.

If the shim's `whoami` probe fails, Parchment falls back to its built-in
localStorage save provider and a banner notes the saves are local-only.
