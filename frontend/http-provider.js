// HttpSaveDialog — implements the AsyncGlk BrowserDialog interface for Parchment,
// routing /usr/<game>/<file> save paths through HTTP to parchment-saves backend.
// Non-/usr paths (storyfile downloads, /tmp scratch) stay in-memory.
//
// Auth comes from the Authentik forward-auth header (X-Authentik-Username).
// If /api/saves/whoami returns no user, the caller falls back to Parchment's
// default (localStorage) Dialog and shows a banner.

export class HttpSaveDialog {
    constructor(user) {
        this.async = true; // Emglken's AsyncDialog marker
        this.user = user;
        this.storyname = null;
        this.dirs = {
            storyfile: '/',
            system_cwd: '/',
            temp: '/tmp',
            working: '/usr/',
            extension: 'glksave',
        };
        this._mem = new Map();          // path -> Uint8Array (storyfiles, /tmp)
        this._writeQueue = new Map();   // path -> Uint8Array (debounced HTTP PUTs)
        this._flushTimer = null;
        this._listCache = new Map();    // game -> array of {name,size,mtime}
        this._flushDelayMs = 5000;
    }

    async init(_options) { /* nothing async */ }

    async download(url, _progress) {
        const r = await fetch(url, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`download ${url} failed: ${r.status}`);
        const buf = new Uint8Array(await r.arrayBuffer());
        const base = this._basename(url);
        const path = '/tmp/' + base;
        this._mem.set(path, buf);
        this.storyname = this._stripExt(base).toLowerCase();
        this.dirs.working = '/usr/' + this.storyname;
        return path;
    }

    async upload(filename, data, _main) {
        const path = '/tmp/' + filename;
        this._mem.set(path, data);
        this.storyname = this._stripExt(filename).toLowerCase();
        this.dirs.working = '/usr/' + this.storyname;
        return path;
    }

    async read(path) {
        const ref = this._userRef(path);
        if (ref) {
            const r = await fetch(`/api/saves/${encodeURIComponent(ref.game)}/${encodeURIComponent(ref.file)}`, {
                credentials: 'same-origin',
            });
            if (r.status === 404) return null;
            if (!r.ok) throw new Error(`read ${path}: ${r.status}`);
            return new Uint8Array(await r.arrayBuffer());
        }
        return this._mem.get(path) ?? null;
    }

    async write(files) {
        for (const [path, data] of Object.entries(files)) {
            const ref = this._userRef(path);
            if (ref) {
                this._writeQueue.set(path, data);
                this._scheduleFlush();
            } else {
                this._mem.set(path, data);
            }
        }
    }

    async delete(path) {
        const ref = this._userRef(path);
        if (ref) {
            this._writeQueue.delete(path);
            const r = await fetch(`/api/saves/${encodeURIComponent(ref.game)}/${encodeURIComponent(ref.file)}`, {
                method: 'DELETE', credentials: 'same-origin',
            });
            if (!r.ok && r.status !== 404) throw new Error(`delete ${path}: ${r.status}`);
            this._listCache.delete(ref.game);
        } else {
            this._mem.delete(path);
        }
    }

    async exists(path) {
        const ref = this._userRef(path);
        if (ref) {
            const list = await this._list(ref.game);
            return list.some(s => s.name === ref.file);
        }
        return this._mem.has(path);
    }

    async prompt(extension, save) {
        // Minimal picker UI. Replace later with styled modal.
        const game = this.storyname || this.dirs.working.replace(/^\/usr\//, '').replace(/\/$/, '');
        if (!game) return null;
        const ext = (extension || 'glksave').replace(/^\.+/, '');
        const dotExt = '.' + ext;

        if (save) {
            const name = window.prompt('Save as:', 'save');
            if (!name) return null;
            let stem = name.replace(new RegExp(this._escapeRe(dotExt) + '$'), '').trim();
            // forbid path separators / NUL / leading dot — anything else (incl. spaces) is fine
            stem = stem.replace(/[\/\\\x00]/g, '_').replace(/^\.+/, '');
            if (!stem) stem = 'save';
            return `/usr/${game}/${stem}${dotExt}`;
        }

        const list = await this._list(game);
        if (list.length === 0) {
            window.alert('No saved games found.');
            return null;
        }
        const display = list.map(s => ({
            full: s.name,
            label: s.name.replace(new RegExp(this._escapeRe(dotExt) + '$'), ''),
        }));
        const menu = display.map((d, i) => `${i + 1}. ${d.label}`).join('\n');
        const pick = window.prompt(`Restore which save?\n\n${menu}\n\nEnter number:`);
        if (pick === null) return null;
        const idx = parseInt(pick, 10) - 1;
        if (isNaN(idx) || !display[idx]) return null;
        return `/usr/${game}/${display[idx].full}`;
    }

    _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    get_dirs() { return this.dirs; }

    set_storyfile_dir(path) {
        this.dirs.storyfile = path;
        return { storyfile: path };
    }

    // ---- emglken autosave hooks (no-op on the dist/web ZVM build) ----
    async autosave_read(signature) {
        if (!signature) return null;
        const game = this.storyname || 'unknown';
        const sig = signature.replace(/[^A-Za-z0-9._-]/g, '_');
        try {
            const meta = await this.read(`/usr/${game}/_autosave_${sig}.json`);
            if (!meta) return null;
            const ram = await this.read(`/usr/${game}/_autosave_${sig}.ram`);
            const data = JSON.parse(new TextDecoder().decode(meta));
            if (ram) data.ram = Array.from(ram);
            return data;
        } catch { return null; }
    }

    async autosave_write(signature, snapshot) {
        if (!signature) return;
        const game = this.storyname || 'unknown';
        const sig = signature.replace(/[^A-Za-z0-9._-]/g, '_');
        const metaPath = `/usr/${game}/_autosave_${sig}.json`;
        const ramPath  = `/usr/${game}/_autosave_${sig}.ram`;
        if (snapshot === null) {
            await this.delete(metaPath);
            await this.delete(ramPath);
            return;
        }
        const { ram, ...rest } = snapshot;
        const json = new TextEncoder().encode(JSON.stringify(rest));
        const writes = { [metaPath]: json };
        if (ram) writes[ramPath] = ram instanceof Uint8Array ? ram : new Uint8Array(ram);
        await this.write(writes);
    }

    async autosave_clear() {
        // best-effort: no-op (we don't track signatures globally)
    }

    async flush() {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        const items = Array.from(this._writeQueue.entries());
        this._writeQueue.clear();
        for (const [path, data] of items) {
            const ref = this._userRef(path);
            if (!ref) continue;
            try {
                const r = await fetch(`/api/saves/${encodeURIComponent(ref.game)}/${encodeURIComponent(ref.file)}`, {
                    method: 'PUT',
                    body: data,
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/octet-stream' },
                });
                if (!r.ok) throw new Error(`PUT ${r.status}`);
                this._listCache.delete(ref.game);
            } catch (e) {
                console.error('parchment-saves write failed', path, e);
                // re-queue for retry
                this._writeQueue.set(path, data);
                this._scheduleFlush();
            }
        }
    }

    // ---- internals ----

    _scheduleFlush() {
        if (this._flushTimer) return;
        this._flushTimer = setTimeout(() => this.flush(), this._flushDelayMs);
    }

    _userRef(path) {
        // /usr/<game>/<file> -> {game, file}; anything else -> null
        if (!path.startsWith('/usr/')) return null;
        const parts = path.split('/');
        // ['', 'usr', '<game>', '<file...>']
        if (parts.length < 4) return null;
        const game = parts[2];
        const file = parts.slice(3).join('/');
        if (!game || !file) return null;
        return { game, file };
    }

    async _list(game) {
        if (this._listCache.has(game)) return this._listCache.get(game);
        const r = await fetch(`/api/saves/${encodeURIComponent(game)}`, { credentials: 'same-origin' });
        if (!r.ok) return [];
        const list = await r.json();
        this._listCache.set(game, list);
        return list;
    }

    _basename(p) {
        const q = p.split('?')[0];
        return q.split('/').pop();
    }

    _stripExt(name) { return name.replace(/\.[^.]+$/, ''); }
}

export async function detectAuth() {
    try {
        const r = await fetch('/api/saves/whoami', { credentials: 'same-origin' });
        if (!r.ok) return null;
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) return null;
        const body = await r.json();
        return body.user || null;
    } catch {
        return null;
    }
}

export async function showResumeHint(dialog) {
    // Derive game from URL ?story= param so we can list saves before parchment boots.
    const params = new URLSearchParams(window.location.search);
    const story = params.get('story') || '';
    const base = story.split('/').pop() || '';
    const game = base.replace(/\.[^.]+$/, '').toLowerCase();
    if (!game) return;

    const list = await dialog._list(game);
    if (!list.length) return;
    const mostRecent = list.reduce((a, b) => (b.mtime > a.mtime ? b : a));
    const dotExt = '.' + (dialog.dirs.extension || 'glksave');
    const re = new RegExp(dotExt.replace(/[.]/g, '\\.') + '$');
    const display = mostRecent.name.replace(re, '');

    const hint = document.getElementById('if-resume-hint');
    if (!hint) return;
    hint.textContent = `Last save: "${display}" — type RESTORE to load`;
    hint.style.display = 'block';
    document.getElementById('parchment')?.classList.add('with-hint');
}

export function showOfflineBanner() {
    const div = document.createElement('div');
    div.textContent = 'Not signed in — saves are stored only in this browser.';
    Object.assign(div.style, {
        position: 'fixed', top: '0', left: '0', right: '0',
        background: '#3a2a00', color: '#e8c46a',
        font: '13px/1.4 -apple-system, sans-serif',
        textAlign: 'center', padding: '6px 12px',
        borderBottom: '1px solid #5a4200',
        zIndex: '9999',
    });
    document.body.appendChild(div);
}
