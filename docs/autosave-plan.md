# Autosave Plan: Revive ZVM with Sync-Cache Dialog

This is a self-contained implementation plan. The fresh agent picking this up has none of the prior conversation context — read this top to bottom before starting.

## What this is

This repo (`parchment-server`) is a Docker image that bundles:
- The Parchment Interactive Fiction interpreter (`dist/web/`) built from `https://github.com/curiousdannii/parchment.git`
- A small Go HTTP service (`main.go`) that persists per-user save files under `/data/<user>/<game>/<file>`
- An nginx reverse-proxy in front of both
- A custom Dialog implementation (`frontend/http-provider.js`) that backs Parchment's save/load with HTTP calls to the Go service

The container is deployed at `zork.willflix.org` behind Authentik forward-auth (Traefik middleware). The user is identified by the `X-Authentik-Username` header that nginx forwards to the Go service.

**Manual save/restore works today** — the user types `save myname` and the engine prompts for a filename, calls `Dialog.write({path: bytes})`, and our `HttpSaveDialog` POSTs to `/api/saves/<game>/<file>`.

**Autosave does NOT work today.** The user has to type `save` themselves; reloading the page starts a fresh game.

## Why autosave doesn't work

Parchment's `dist/web/` build uses **bocfel** (WASM Z-machine) for `.z3/.z4/.z5/.z8` files (see `src/common/formats.ts` in upstream parchment, lines around 152–176). Bocfel runs through the AsyncGlk wrapper.

In upstream `src/upstream/asyncglk/src/glkapi/glkapi.ts` around line 262:

```ts
// Autorestore state?
...
// TODO
// if (this.do_autosave) {}
```

The autosave hook is a literal empty `if` block in a TODO comment. Setting `parchment_options.do_vm_autosave: 1` flips the flag but nothing acts on it. We verified this end-to-end with Playwright: patched `Dialog.write` to log every call, played four turns of Zork as an authed user, waited 8s past the 5s flush debounce — zero autosave writes happened.

**ZVM** (the pure-JS Z-machine in `src/upstream/ifvms.js/src/zvm.js`) has fully-implemented autosave (`Dialog.autosave_read(signature)` and `Dialog.autosave_write(signature, snapshot)` calls at `src/upstream/ifvms.js/src/zvm.js:107` and `src/upstream/ifvms.js/src/zvm/runtime.js:235`). But ZVM was removed from the `dist/web/` build in upstream commit `5e1a6ba` ("Update the Inform 7 template to use AsyncDialog and Emglken"). The source files (`src/upstream/ifvms.js/`) are still present as a submodule.

The blocker for using ZVM as-is: ZVM's autosave Dialog API is **synchronous** — `const snapshot = Dialog.autosave_read(signature)`, no `await`. Our `HttpSaveDialog` is async (`this.async = true`). Sync ZVM cannot directly call async HTTP.

## Goal

Z-machine games (Zork I/II/III, Enchanter, Sorcerer, Wishbringer, Spellbreaker, Beyond Zork) auto-restore on page reload. Manual `save <name>` / `restore <name>` continues to work for any game where the user wants explicitly named saves. Both persist server-side per-user.

Other formats (Glulx, Hugo, TADS) are out of scope — they continue to work with manual save/restore via bocfel/emglken/HttpSaveDialog as today.

## Approach

Revive ZVM as the engine for `zcode` formats. Provide it with a `SyncDialog` — a sync-faced wrapper that:
- Pre-warms an in-memory cache from the server before ZVM boots
- Answers ZVM's sync `autosave_read`/`file_read` calls from the in-memory cache
- On sync writes, updates the cache immediately and queues a write-through to the server via the existing `HttpSaveDialog.write` (which already debounces 5s and POSTs to `/api/saves/<game>/<file>`)

For unauthenticated users (no `X-Authentik-Username` header — the offline path), `SyncDialog` falls back to localStorage as the canonical store, mirroring the current offline-banner UX. Authed users do not touch localStorage.

## Step-by-step

### Step 1 — Revive ZVM in the parchment build

Three changes to the upstream parchment source tree, applied during the Docker build between `git clone` and `npm install`.

#### 1a. Recreate `src/common/zvm.js`

This file existed before commit `5e1a6ba`. Its content is a 6-line ES re-export:

```js
// Export ZVM engine
import ZVM from '../upstream/ifvms.js/src/zvm.js'
import ZVMDispatch from '../upstream/ifvms.js/src/zvm/dispatch.js'
export {ZVM, ZVMDispatch}
```

Add it to the parchment-server repo as `frontend/zvm-shim.js`. The Dockerfile copies it into `/src/src/common/zvm.js` after cloning.

#### 1b. Patch `build.js` to include zvm in the web target

In upstream parchment's `build.js`, around lines 115–135, the web build's `entryPoints` block has:

```js
//zvm: 'src/common/zvm.js',
```

Uncomment that line so the build emits `dist/web/zvm.js`.

#### 1c. Patch `src/common/formats.ts` to use ZVM for zcode

Around lines 149–179 the `zcode` format block has the ZVM engine commented out (in `/* ... */`) and the bocfel engine active:

```ts
{
    id: 'zcode',
    blorbable: true,
    extensions: /\.(zblorb|zlb|z3|z4|z5|z8)/i,
    engines: [
        /*{
            id: 'zvm',
            load: ['zvm.js'],
            start: (_story: StoryOptions, options, requires) => { ... },
        },*/

        {
            id: 'bocfel',
            load: ['bocfel.js', 'bocfel.wasm'],
            start: generic_emglken_vm,
        },
    ],
},
```

Swap them: uncomment the ZVM block, comment out the bocfel block. (Other formats — `glulx`, `hugo`, `tads`, etc. — keep using bocfel/emglken; only `zcode` switches.)

#### 1d. Apply via Dockerfile

Easiest implementation: keep two patch files in the repo:

- `patches/parchment-build-js.patch`
- `patches/parchment-formats-ts.patch`

Apply in the Dockerfile after `git clone`, before `npm install`:

```dockerfile
COPY frontend/zvm-shim.js patches/ /tmp/work/
RUN cp /tmp/work/zvm-shim.js /src/src/common/zvm.js \
 && cd /src \
 && patch -p1 < /tmp/work/parchment-build-js.patch \
 && patch -p1 < /tmp/work/parchment-formats-ts.patch \
 && npm install \
 && ./build.js tools web
```

After this step, `dist/web/` contains `zvm.js` (a small entry-point bundle) alongside the existing `bocfel.js`, `git.js`, etc. The Dockerfile's `COPY --from=parchment-builder /src/dist/web/ /usr/share/nginx/html/public/` line picks it up automatically.

### Step 2 — Build a `SyncDialog`

New file: `frontend/sync-dialog.js`. Exported from this file: `class SyncDialog`.

#### Discover the exact sync interface ZVM expects

Before writing the class, grep the ifvms.js source for everything ZVM calls on `Dialog`:

```sh
cd /tmp/parchment-src  # cloned earlier; if absent, re-clone
grep -rn 'Dialog\.\|this\.options\.Dialog\.\|opts\.Dialog\.' src/upstream/ifvms.js/src/ | grep -v '^Binary'
```

Expected method set (verify with grep above before coding — ZVM is small but the prior summary may have missed a method):

- `autosave_read(signature)` → returns snapshot object or null. **Sync.**
- `autosave_write(signature, snapshot|null)` → snapshot is `{ram: Uint8Array, ...metadata}`. null means delete. **Sync.**
- `file_ref_for_filename(name, usage)` → returns `{filename, usage}` or similar opaque ref. **Sync.**
- `file_construct_ref(name, usage, gameid)` → similar. **Sync.**
- `file_remove_ref(ref)` → delete. **Sync.**
- `file_write(ref, content)` → write bytes. **Sync.**
- `file_read(ref)` → read bytes or null. **Sync.**
- `prompt(extension, callback)` → ask user for filename. Callback-based.
- `get_dirs()` → returns `{storyfile, working, ...}` — already implemented in HttpSaveDialog, can delegate.
- `set_storyfile_dir(path)` → already in HttpSaveDialog.

If grep turns up additional methods, add them and document.

#### SyncDialog construction

```js
class SyncDialog {
    constructor({ http, storyname, prewarmedAutosave, prewarmedNamedSaves }) {
        this.async = false;       // ZVM checks this; must be falsy
        this.http = http;          // HttpSaveDialog instance (or null in offline mode)
        this.storyname = storyname;
        this._autosaveCache = prewarmedAutosave; // { ram: Uint8Array, ...meta } or null
        this._fileCache = new Map(prewarmedNamedSaves); // path -> Uint8Array
        this.dirs = { storyfile: '/', system_cwd: '/', temp: '/tmp', working: '/usr/', extension: 'glksave' };
    }
    // ... methods below
}
```

#### Key methods

- `autosave_read(signature)`: return `this._autosaveCache` if present and matching signature, else null. Pre-warm ensures cache is populated before ZVM ever calls.
- `autosave_write(signature, snapshot)`: update `this._autosaveCache` synchronously; if `this.http` (authed), call `this.http.write({...})` to enqueue HTTP write to `/usr/<game>/_autosave_<sig>.json` and `.ram`. If unauthed, write to `localStorage` keyed `parchment_autosave:<game>:<sig>` (JSON-serialize the snapshot, convert RAM Uint8Array to a base64 string — see `src/upstream/asyncglk/docs/dialog-localstorage.md` for the expected encoding).
- `file_write(ref, content)`: update `this._fileCache.set(ref.path, content)`. If authed, call `this.http.write(...)`. If not, mirror to localStorage.
- `file_read(ref)`: return `this._fileCache.get(ref.path)` or null. If a fetch is needed (cache miss for an authed user — rare; user picked a save not in the prewarm list), this becomes problematic because the call is sync. Mitigation: prewarm fetches all named save contents up front (small files, single round-trip per game).
- `prompt(extension, callback)`: delegate to `HttpSaveDialog.prompt`-style UX. Existing implementation in `frontend/http-provider.js` is already friendly (allows spaces, hides extension). Reuse the same prompt UI; resolve the callback with the picked filename.

#### Offline (no auth) mode

When `http === null`, all writes go to localStorage with keys:
- `parchment_autosave:<game>:<signature>` — JSON `{ram: <base64>, ...meta}`
- `parchment_save:<game>:<name>` — base64 bytes

On startup, prewarm reads localStorage instead of the server.

### Step 3 — Pre-warm before ZVM boots

In `play.html`, the current top-level await is:

```html
<script type="module">
import { HttpSaveDialog, detectAuth, showOfflineBanner, showResumeHint } from '/public/shim/http-provider.js';
const user = await detectAuth();
let dialog = null;
if (user) {
    dialog = new HttpSaveDialog(user);
    window.parchment_options = Object.assign({}, window.parchment_options, {
        Dialog: dialog,
        do_vm_autosave: 1,
    });
    showResumeHint(dialog).catch(() => {});
} else {
    showOfflineBanner();
}
await import('/public/web.js');
</script>
```

Change to:

```html
<script type="module">
import { HttpSaveDialog, detectAuth, showOfflineBanner } from '/public/shim/http-provider.js';
import { SyncDialog, prewarm } from '/public/shim/sync-dialog.js';

const user = await detectAuth();
const params = new URLSearchParams(location.search);
const story = params.get('story') || '';
const game = (story.split('/').pop() || '').replace(/\.[^.]+$/, '').toLowerCase();

const http = user ? new HttpSaveDialog(user) : null;
const prewarmed = await prewarm({ http, game });
const dialog = new SyncDialog({ http, storyname: game, ...prewarmed });

if (user) {
    document.getElementById('if-user').textContent = user;
} else {
    showOfflineBanner();
}

window.parchment_options = Object.assign({}, window.parchment_options, {
    Dialog: dialog,
    do_vm_autosave: 1,
});

await import('/public/web.js');
</script>
```

`prewarm({http, game})`:
- If authed: `GET /api/saves/<game>` (already exists, returns array of filenames). For each `_autosave_<sig>.json` paired with `.ram`, fetch both, deserialize the snapshot. For other (named) save files, fetch contents and store in a Map. Return `{prewarmedAutosave, prewarmedNamedSaves}`.
- If unauth: read all `parchment_autosave:<game>:*` and `parchment_save:<game>:*` from localStorage, deserialize, return.

Network failures during prewarm: log and continue with empty cache — game starts fresh, user can retry by reload. Don't block the page on a flaky GET.

### Step 4 — Show resume hint

The existing `showResumeHint` in `http-provider.js` displays a banner like "Last save: 2026-05-04 12:34" if the user has saves for this game. Keep that; it's useful UX.

After Step 3, the autosave will be auto-restored, so the hint should distinguish between *autosave* (we're already restored) vs *named saves* (user can type `restore <name>`). Suggested copy:
- If auto-restored: small hint "Resumed from autosave. Type RESTART to start over."
- If named saves exist but no autosave: existing "Last save: ..." text.

Implementation: pass `prewarmedAutosave !== null` flag to `showResumeHint`.

### Step 5 — Beforeunload flush

Add a `beforeunload` listener that forces `HttpSaveDialog.flush()` so any pending debounced writes go out before the tab closes. Use `navigator.sendBeacon` if available; otherwise `fetch` with `keepalive: true`.

This is needed because ZVM may write the autosave near the end of the user's session, then they close the tab before the 5s debounce timer fires.

### Step 6 — Tests

Existing test infrastructure lives at `/tmp/parchment-test/`:
- `test.js` — unauth e2e (lands page, plays a game)
- `auth-test.js` — authed e2e via `extraHTTPHeaders: {'X-Authentik-Username': 'testuser'}`
- Playwright already installed; chromium binary at `~/.cache/ms-playwright/chromium_headless_shell-1217/`

Tests run against the container directly (bypassing Authentik) at `http://172.30.0.36/`. Get the current container IP with:
```
docker inspect parchment --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
```

Add new tests in `/tmp/parchment-test/`:

1. **`autosave-test.js`** (authed). Load Zork I, type `n`, `n`, `open mailbox`, `take leaflet`, wait for the 5s flush, reload, type `inventory`. Assert the response contains "leaflet". This is the goalpost test — currently fails, must pass after the change.

2. **`named-save-test.js`** (authed). Load Zork I, `n`, `save persistme`, accept default-or-friendly filename in the prompt, reload, `restore persistme`, `inventory`. Assert "leaflet".

3. **`isolation-test.js`** (authed). Autosave Zork I, then load Zork II. Assert Zork II shows the Zork II opening text, NOT Zork I state.

4. **`offline-autosave-test.js`** (unauth — no header). Same as autosave-test but using localStorage path. Reload should restore. Open a fresh browser context (`browser.newContext()`) and assert Zork I starts fresh (proves the autosave is per-browser, not server-shared).

5. **`server-roundtrip-test.js`** (authed). Play Zork I in browser A, then `GET /api/saves/zork1` and assert the autosave files exist on the server. Open browser B with the same `X-Authentik-Username`, load Zork I, type `inventory`, assert "leaflet" — proves server is the canonical store and round-trips across browsers.

For each test: hook `Dialog.write` and `Dialog.autosave_write` via `addInitScript` to log every path written, the same pattern used in the existing `auth-test.js` Step 4. Helps debug if a test fails.

### Step 7 — Deploy and verify

Build and redeploy (the `parchment` service in the willflix compose stack at `/willflix/docker/compose.yml`):

```sh
cd /willflix/docker && docker compose up -d --build parchment
```

Wait ~5s for nginx + Go service to come up. Verify the new files exist:

```sh
docker exec parchment ls /usr/share/nginx/html/public/ | grep -E '^(zvm|sync-dialog)'
# expect: zvm.js, sync-dialog.js (under shim/)
```

Then run the test suite:

```sh
cd /tmp/parchment-test && for t in autosave named-save isolation offline-autosave server-roundtrip; do
    echo "=== $t ==="
    node "$t-test.js" || break
done
```

All five must pass before considering the task complete.

## Risks and unknowns

1. **Does ifvms.js/ZVM still build cleanly with current esbuild config?** The submodule pin is `8b8804495b28bac0f54029011bdb90bc7c5d5f69`. Should work — esbuild config in `build.js` uses standard ESM resolution. If the build fails, look for new TS or import-syntax requirements in ZVM source that wasn't supported when it was last in the entryPoints list. De-risk by running `./build.js web` locally on the patched parchment tree before writing any SyncDialog code.

2. **Does ZVM accept our SyncDialog signature?** Verify with the grep in Step 2 — get the exact method set right. If a method is missing, ZVM throws on first call. Tests will surface this immediately.

3. **`do_vm_autosave: 1` propagation through ZVM's launcher.** The flag is in parchment's URL/option allowlist (verified — `src/common/launcher.ts:38`). The ZVM engine block in formats.ts does:
   ```ts
   const vm_options = Object.assign({}, options, { vm, GiDispa: ... })
   vm.prepare(file_data, vm_options)
   ```
   So `do_vm_autosave` passes through. Verify by adding a `console.log(this.options.do_vm_autosave)` near `zvm.js:103` if tests show autosave never firing.

4. **localStorage encoding for unauth mode.** Use the asyncglk-documented base32768 encoding (see `src/upstream/asyncglk/docs/dialog-localstorage.md`) so unauth saves remain interoperable if we ever change paths. If too fiddly, fall back to base64 of a Uint8Array — only constraint is round-trip stability.

5. **Bocfel still gets fetched even though we don't use it for `.z3`.** That's fine — it's needed for `.ulx`/`.gblorb` (Glulx). Just make sure `dist/web/bocfel.js` and `dist/web/bocfel.wasm` still ship in the image.

6. **The `/fonts/` nginx alias** added in the prior round (see `nginx.conf`) must remain. Don't remove it during cleanup.

## Out of scope

- Glulx/Hugo/TADS autosave (would require completing the AsyncGlk TODO upstream).
- Cross-tab sync (single-tab use is assumed; user opening Zork I in two tabs gets last-writer-wins).
- Multi-device sync (works automatically via server, but no conflict resolution if both devices play simultaneously).
- Migration of any existing localStorage saves from before this change.
- Changes to non-Z-machine games.

## Files this plan touches

In the parchment-server repo:
- **New**: `frontend/zvm-shim.js`
- **New**: `frontend/sync-dialog.js`
- **New**: `patches/parchment-build-js.patch`
- **New**: `patches/parchment-formats-ts.patch`
- **Modified**: `Dockerfile` (apply patches between clone and npm install; copy sync-dialog.js into image)
- **Modified**: `play.html` (use SyncDialog + prewarm)
- **Unchanged**: `main.go` (Go service requires no changes — autosave files use the same `/api/saves/<game>/<file>` pattern as named saves)
- **Unchanged**: `frontend/http-provider.js` (HttpSaveDialog stays as-is; SyncDialog wraps it)
- **Unchanged**: `nginx.conf` (no new routes)

In `/willflix/docker/`:
- **Unchanged** — compose stack rebuilds the image, no config change needed.

## Estimate

2–3 hours active work:
- 30 min: build patches + verify ZVM builds (Steps 1, 7-verify)
- 60 min: SyncDialog implementation (Step 2)
- 30 min: prewarm + play.html wiring (Steps 3, 4, 5)
- 60 min: write + run all five tests (Step 6), debug any failures

## Background context the fresh agent will want

- The existing custom Dialog impl is at `frontend/http-provider.js` — read it before writing SyncDialog. It already handles the async write-debouncing and prompt UX.
- The Go service is at `main.go`. Endpoints relevant here: `GET /api/saves/<game>` (list), `GET /api/saves/<game>/<file>` (read), `PUT /api/saves/<game>/<file>` (write). Already supports any filename matching `validFile()` (rejects path separators, leading dots, "."/".."), so paths like `_autosave_<sig>.json` and `_autosave_<sig>.ram` work without server changes.
- The Authentik forward-auth is configured at the Traefik layer in `/willflix/docker/compose.yml`. The `parchment-static` Traefik router bypasses auth for `/public/` (so unauthed users can still load JS/WASM). Don't need to touch this.
- The container is rebuilt and restarted via `cd /willflix/docker && docker compose up -d --build parchment`. Build context is `/home/will/code/parchment-server/` (set as the `build:` path in compose.yml).
- Test against the container's internal IP to bypass auth: `docker inspect parchment --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`. With `extraHTTPHeaders: {'X-Authentik-Username': 'testuser'}` Playwright simulates an authed user.
- Today's parchment build output (`dist/web/`) ships these engines: `bocfel`, `git`, `glulxe`, `hugo`, `scare`, `tads`, plus `ie.js` (Inform 6 frontend), `web.js` (launcher), `web.css`, `jquery.min.js`. After this change, `zvm.js` joins the list.
