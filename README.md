# parchment-server

Per-user save backend and Z-machine autosave for
[Parchment](https://github.com/curiousdannii/parchment), the web-based
interactive fiction interpreter. Designed to run alongside the parchment
nginx container behind a forward-auth proxy (tested with Traefik + Authentik).

Manual save/restore works for every supported format (Z-machine, Glulx,
Hugo, TADS, ADRIFT). Z-machine games (`.z3`/`.z4`/`.z5`/`.z8`/`.zblorb`)
additionally **auto-restore on page reload** — your last room name and
description repaint immediately, with no synthesised "look" turn.

## Layout

- `main.go` — small Go HTTP service. Stores saves at
  `/data/<user>/<game>/<file>`. Auth via `X-Authentik-Username` header.
- `frontend/http-provider.js` — `HttpSaveDialog`: AsyncDialog implementation
  used by emglken VMs (Glulx via `git`/`glulxe`, Hugo, TADS, ADRIFT) for
  manual save/restore. Debounces writes (5s) and PUTs to `/api/saves/...`.
- `frontend/sync-dialog.js` — `SyncDialog`: synchronous-faced Dialog used
  by ZVM. Pre-warms an in-memory cache from the server (or localStorage
  when unauthenticated) before ZVM boots, answers ZVM's sync calls from
  cache, and write-throughs via `HttpSaveDialog`.
- `frontend/zvm-shim.js` — small ES re-export glued in during the build so
  the upstream Parchment build emits a `zvm.js` web entry point.
- `patches/parchment-*.patch` — applied to upstream Parchment during the
  Docker build (see [Patches](#patches)).
- `play.html` — picks the right Dialog based on the storyfile extension.
- `nginx.conf` — proxies `/api/saves/*` to the Go service; serves static
  Parchment assets under `/public/`.

## API

All requests require the `X-Authentik-Username` header (forwarded by the
Traefik `authentik-forward` middleware). The backend trusts this header and
must never be exposed without that middleware in front.

| Method | Path                              | Action                          |
|--------|-----------------------------------|---------------------------------|
| GET    | `/api/saves/whoami`               | `{user}` or 401                 |
| GET    | `/api/saves/health`               | liveness                        |
| GET    | `/api/saves/<game>`               | list saves (incl. autosave)     |
| GET    | `/api/saves/<game>/<file>`        | read save bytes                 |
| HEAD   | `/api/saves/<game>/<file>`        | exists check                    |
| PUT    | `/api/saves/<game>/<file>`        | store (max 1 MB)                |
| DELETE | `/api/saves/<game>/<file>`        | remove                          |

`<user>`, `<game>`, `<file>` must match `^[A-Za-z0-9._-]+$`. Autosave files
follow the pattern `_autosave_<signature>.json` + `_autosave_<signature>.ram`,
where `<signature>` is the Z-machine release/serial header.

## How autosave works

Z-machine autosave fires automatically between turns, at the moment the
engine yields for player input:

1. ZVM calls `Dialog.autosave_write(signature, snapshot)` with a snapshot
   containing the Z-machine RAM, stacks, PC, IO state, and the prose
   printed since the previous turn (`io.last_screen`).
2. `SyncDialog` updates its in-memory cache immediately and queues an
   HTTP PUT via `HttpSaveDialog` (debounced 5 s; flushed on `beforeunload`).
3. On the next page load, `play.html` calls `prewarm()` which fetches the
   most recent autosave pair from the server (or localStorage) before
   instantiating `SyncDialog`. ZVM's `do_autorestore` then:
   - re-creates Glk windows via `restart(0)` (AsyncGlk doesn't support
     `save_allstate`/`restore_allstate`),
   - replays the saved RAM/stacks via `restore_file`,
   - repaints `io.last_screen` to the new buffer window so the player
     sees the room name + description immediately,
   - re-issues the pending `glk_request_line_event_uni` /
     `glk_request_char_event_uni` so the next keystroke drives the engine
     normally.

No synthetic "look" command is run, so the turn counter and transcript
stay clean. The buffer scrollback before the most recent turn is lost
(asyncglk doesn't yet expose serialisable window state); status-bar text
redraws on the next turn.

For unauthenticated users, the same flow runs against localStorage keys
(`parchment:autosave:<game>:<sig>:meta` / `:ram`,
`parchment:save:<game>:<file>`).

## Patches

The Parchment build is patched in `parchment-builder` stage between the
git clone and `npm install`. Patches live in `patches/`:

| Patch | What it does |
|---|---|
| `parchment-build-js.patch` | Enables `zvm` in the web `entryPoints` so `dist/web/zvm.js` ships. |
| `parchment-launcher-ts.patch` | Uncomments the `AsyncGlk` import and always sets `options.Glk = new AsyncGlk()` so ZVM has a Glk to call. |
| `parchment-formats-ts.patch` | Swaps the `zcode` engine from `bocfel` to `zvm`; rewrites `engine.start` to read the storyfile via `Dialog.read(story.path)`. |
| `parchment-glkapi-ts.patch` | Stubs `save_allstate`/`restore_allstate` (were `throw`s) and wires the empty `do_autosave` TODO hook to call `VM.do_autosave(0)` when `GiDispa.check_autosave()` permits. |
| `parchment-zvm-runtime-js.patch` | Replaces `do_autorestore` to skip Glk-state restoration, repaint `io.last_screen`, and re-issue the pending input request. |
| `parchment-zvm-io-js.patch` | Adds `io.last_screen` accumulator: `_print` appends mainwin text; `handle_line_input` clears it on each new turn. |

Other formats (Glulx, Hugo, TADS, ADRIFT) are unaffected — they continue
to use emglken with `HttpSaveDialog` (manual save/restore only).

## Build

Local Go binary:

```sh
go build -o parchment-saves ./...
PARCHMENT_SAVES_DIR=./data PARCHMENT_SAVES_ADDR=127.0.0.1:8080 ./parchment-saves
```

Full container (Parchment build + Go + nginx):

```sh
docker build -t parchment-server .
```

In the willflix stack:

```sh
cd /willflix/docker && docker compose up -d --build parchment
```

## Container integration

Built into the parchment nginx image. The image runs both nginx (frontend)
and the Go binary (backend); nginx proxies `/api/saves/*` to
`127.0.0.1:8080`.

### Auth & public surfaces

Traefik splits routing for `zork.willflix.org`:

- `/public/*` — handled by the `parchment-static` router (priority 100,
  **no auth middleware**). Serves only Parchment engine code and shim JS:
  `web.js`, `zvm.js`, `bocfel.{js,wasm}`, `git.js`, `glulxe.js`, `hugo.js`,
  `scare.js`, `tads.js`, `web.css`, `jquery.min.js`, fonts, and our own
  `shim/http-provider.js` + `shim/sync-dialog.js`. No user data.
- everything else (`/`, `/play.html`, `/games/*`, `/api/saves/*`) —
  routed through `authentik-forward@file`, which injects
  `X-Authentik-Username` for the backend.

Public access to `/public/` is required so the launcher can bootstrap
JS/WASM before (or without) auth; nothing under it is sensitive.

If the shim's `whoami` probe returns no user, `play.html` falls back to
localStorage and shows a banner noting saves are local-only.

## Testing

End-to-end tests live separately in `/tmp/parchment-test/` and target the
container via its internal IP (bypassing Authentik) with a forged
`X-Authentik-Username` header:

```sh
docker inspect parchment --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
cd /tmp/parchment-test
for t in autosave named-save isolation offline-autosave server-roundtrip; do
    node "$t-test.js" || break
done
```

- `autosave-test` — play Zork I → reload → assert leaflet still in inventory.
- `named-save-test` — manual `save persistme` → reload → `restore` → assert leaflet.
- `isolation-test` — Zork I autosave doesn't bleed into Zork II.
- `offline-autosave-test` — localStorage path; new browser context starts fresh.
- `server-roundtrip-test` — second browser with same auth header sees the autosave.
