// SyncDialog — synchronous-faced Dialog for Parchment's ZVM (pure-JS Z-machine).
//
// ZVM and the sync GlkApi (AsyncGlk) require a Dialog with `async = false`
// and synchronous file_* / autosave_* methods. Our HTTP-backed save store is
// async, so SyncDialog pre-warms an in-memory cache from the server (or
// localStorage when unauthenticated) before ZVM boots, answers sync calls
// from the cache, and write-throughs via the existing async HttpSaveDialog.
//
// Used only for Z-machine games. Other formats (Glulx, Hugo, TADS) keep
// using HttpSaveDialog directly with emglken's AsyncDialog interface.

const LS_PREFIX = 'parchment:';

export class SyncDialog {
    constructor({ http, storyname, prewarmedAutosave, prewarmedNamedSaves }) {
        this.async = false;
        this.streaming = false;
        this.classname = 'SyncDialog';
        this.http = http || null;
        this.storyname = storyname || null;
        this._inited = false;
        this._autosaveCache = prewarmedAutosave || null;
        this._fileCache = new Map(prewarmedNamedSaves || []);
        this._mem = new Map();
        this.dirs = {
            storyfile: '/',
            system_cwd: '/',
            temp: '/tmp',
            working: storyname ? `/usr/${storyname}` : '/usr',
            extension: 'glksave',
        };
    }

    init(_options) { this._inited = true; }
    inited() { return this._inited; }
    get_dirs() { return this.dirs; }
    set_storyfile_dir(path) { this.dirs.storyfile = path; return { storyfile: path }; }
    getlibrary(_name) { return null; }

    // ---- Launcher async entry points (download / read / upload / write) ----

    async download(url, _progress) {
        const r = await fetch(url, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`download ${url}: ${r.status}`);
        const buf = new Uint8Array(await r.arrayBuffer());
        const base = url.split('?')[0].split('/').pop();
        const path = '/tmp/' + base;
        this._mem.set(path, buf);
        if (!this.storyname) this._setStory(base);
        return path;
    }

    async upload(filename, data, _main) {
        const path = '/tmp/' + filename;
        this._mem.set(path, data);
        if (!this.storyname) this._setStory(filename);
        return path;
    }

    async read(path) {
        if (this._mem.has(path)) return this._mem.get(path);
        if (this._fileCache.has(path)) return this._fileCache.get(path);
        return null;
    }

    async write(files) {
        for (const [path, data] of Object.entries(files)) {
            const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
            if (path.startsWith('/usr/')) {
                this._fileCache.set(path, buf);
                if (this.http) await this.http.write({ [path]: buf });
                else this._lsWritePath(path, buf);
            } else {
                this._mem.set(path, buf);
            }
        }
    }

    async exists(path) {
        if (this._mem.has(path) || this._fileCache.has(path)) return true;
        if (this.http) return this.http.exists(path);
        return this._lsReadPath(path) !== null;
    }

    async delete(path) {
        this._mem.delete(path);
        this._fileCache.delete(path);
        if (this.http) await this.http.delete(path);
        else this._lsRemovePath(path);
    }

    // ---- ClassicSyncDialog: sync file ref API used by AsyncGlk ----

    file_clean_fixed_name(filename, _usage) {
        return String(filename || '').replace(/[\/\\\x00]/g, '_').replace(/^\.+/, '') || 'file';
    }

    file_construct_ref(filename, usage, gameid) {
        const game = this.storyname || gameid || 'unknown';
        const ext = this._extForUsage(usage);
        const cleaned = this.file_clean_fixed_name(filename || 'save');
        const stem = cleaned.replace(new RegExp('\\.' + ext + '$', 'i'), '') || 'save';
        return {
            filename: `/usr/${game}/${stem}.${ext}`,
            gameid,
            usage,
        };
    }

    file_construct_temp_ref(usage) {
        const ext = this._extForUsage(usage);
        const name = `_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        return { filename: `/tmp/${name}`, usage };
    }

    file_ref_exists(fref) {
        if (fref.filename.startsWith('/tmp/')) return this._mem.has(fref.filename);
        return this._fileCache.has(fref.filename);
    }

    file_remove_ref(fref) {
        if (fref.filename.startsWith('/tmp/')) { this._mem.delete(fref.filename); return; }
        this._fileCache.delete(fref.filename);
        if (this.http) this.http.delete(fref.filename).catch(e => console.warn('delete failed', fref.filename, e));
        else this._lsRemovePath(fref.filename);
    }

    file_read(fref) {
        if (fref.filename.startsWith('/tmp/')) return this._mem.get(fref.filename) || null;
        return this._fileCache.get(fref.filename) || null;
    }

    file_write(fref, content, _raw_string) {
        const buf = content === '' ? new Uint8Array(0)
            : (content instanceof Uint8Array ? content : new Uint8Array(content));
        if (fref.filename.startsWith('/tmp/')) { this._mem.set(fref.filename, buf); return true; }
        this._fileCache.set(fref.filename, buf);
        if (this.http) this.http.write({ [fref.filename]: buf });
        else this._lsWritePath(fref.filename, buf);
        return true;
    }

    open(save, usage, gameid, callback) {
        const ext = this._extForUsage(usage);
        const game = this.storyname || gameid || '';
        if (save) {
            const name = window.prompt('Save as:', 'save');
            if (!name) return callback(null);
            const stem = this.file_clean_fixed_name(name).replace(new RegExp('\\.' + ext + '$', 'i'), '') || 'save';
            return callback({ filename: `/usr/${game}/${stem}.${ext}`, gameid, usage });
        }
        // Restore: list saves, prompt, prefetch chosen file into cache, then resolve.
        this._listSaves(game, ext).then(list => {
            if (!list.length) { window.alert('No saved games found.'); return callback(null); }
            const menu = list.map((n, i) => `${i + 1}. ${n.replace(new RegExp('\\.' + ext + '$', 'i'), '')}`).join('\n');
            const pick = window.prompt(`Restore which save?\n\n${menu}\n\nEnter number:`);
            if (pick === null) return callback(null);
            const idx = parseInt(pick, 10) - 1;
            if (isNaN(idx) || !list[idx]) return callback(null);
            const filename = `/usr/${game}/${list[idx]}`;
            this._fetchInto(filename).then(() => callback({ filename, gameid, usage }));
        }).catch(e => { console.warn('open() failed', e); callback(null); });
    }

    // ---- ZVM autosave hooks (synchronous, called from zvm.js + runtime.js) ----

    autosave_read(signature) {
        if (!signature || !this._autosaveCache) return null;
        if (this._autosaveCache.signature && this._autosaveCache.signature !== signature) return null;
        return this._autosaveCache;
    }

    autosave_write(signature, snapshot) {
        if (!signature) return;
        const game = this.storyname || 'unknown';
        const sig = signature.replace(/[^A-Za-z0-9._-]/g, '_');
        const metaPath = `/usr/${game}/_autosave_${sig}.json`;
        const ramPath = `/usr/${game}/_autosave_${sig}.ram`;
        if (snapshot === null) {
            this._autosaveCache = null;
            if (this.http) {
                this.http.delete(metaPath).catch(() => {});
                this.http.delete(ramPath).catch(() => {});
            } else {
                this._lsRemove(`autosave:${game}:${sig}:meta`);
                this._lsRemove(`autosave:${game}:${sig}:ram`);
            }
            return;
        }
        let ramBytes = null;
        if (snapshot.ram) {
            ramBytes = snapshot.ram instanceof Uint8Array ? snapshot.ram : Uint8Array.from(snapshot.ram);
        }
        const cached = Object.assign({}, snapshot, { signature });
        if (ramBytes) cached.ram = ramBytes;
        this._autosaveCache = cached;
        const { ram: _r, ...rest } = snapshot;
        const json = new TextEncoder().encode(JSON.stringify(rest));
        if (this.http) {
            const writes = { [metaPath]: json };
            if (ramBytes) writes[ramPath] = ramBytes;
            this.http.write(writes); // debounced internally
        } else {
            this._lsWrite(`autosave:${game}:${sig}:meta`, json);
            if (ramBytes) this._lsWrite(`autosave:${game}:${sig}:ram`, ramBytes);
        }
    }

    autosave_clear() { this._autosaveCache = null; }

    // ---- internals ----

    _setStory(filename) {
        this.storyname = filename.replace(/\.[^.]+$/, '').toLowerCase();
        this.dirs.working = '/usr/' + this.storyname;
    }

    _extForUsage(usage) {
        if (typeof usage === 'string') {
            switch (usage) {
                case 'save': return 'glksave';
                case 'data': return 'glkdata';
                case 'transcript': return 'txt';
                case 'command': return 'txt';
            }
            return usage.replace(/[^a-z0-9]/gi, '') || 'glkdata';
        }
        const masked = (usage || 0) & 0x0F;
        switch (masked) {
            case 0: return 'glkdata';
            case 1: return 'glksave';
            case 2: return 'txt';
            case 3: return 'txt';
        }
        return 'glkdata';
    }

    async _listSaves(game, ext) {
        const re = new RegExp('\\.' + ext + '$', 'i');
        if (this.http) {
            const list = await this.http._list(game);
            return list.map(s => s.name).filter(n => !n.startsWith('_autosave_') && re.test(n));
        }
        const out = [];
        const prefix = `${LS_PREFIX}save:${game}:`;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix)) {
                const file = k.slice(prefix.length);
                if (re.test(file)) out.push(file);
            }
        }
        return out;
    }

    async _fetchInto(filename) {
        if (this._fileCache.has(filename)) return;
        if (this.http) {
            try {
                const data = await this.http.read(filename);
                if (data) this._fileCache.set(filename, data);
            } catch {}
        } else {
            const v = this._lsReadPath(filename);
            if (v) this._fileCache.set(filename, v);
        }
    }

    _lsKeyForPath(path) {
        const m = path.match(/^\/usr\/([^/]+)\/(.+)$/);
        if (!m) return `${LS_PREFIX}save:${this.storyname || 'unknown'}:${path}`;
        return `${LS_PREFIX}save:${m[1]}:${m[2]}`;
    }

    _lsWrite(key, bytes) {
        try { localStorage.setItem(LS_PREFIX + key, bytesToBase64(bytes)); }
        catch (e) { console.warn('localStorage write failed', key, e); }
    }
    _lsRead(key) {
        const v = localStorage.getItem(LS_PREFIX + key);
        return v === null ? null : base64ToBytes(v);
    }
    _lsRemove(key) { localStorage.removeItem(LS_PREFIX + key); }

    _lsWritePath(path, bytes) { this._lsWrite(this._lsKeyForPath(path).slice(LS_PREFIX.length), bytes); }
    _lsReadPath(path) { return this._lsRead(this._lsKeyForPath(path).slice(LS_PREFIX.length)); }
    _lsRemovePath(path) { this._lsRemove(this._lsKeyForPath(path).slice(LS_PREFIX.length)); }
}

function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}
function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export async function prewarm({ http, game }) {
    const result = { prewarmedAutosave: null, prewarmedNamedSaves: [] };
    if (!game) return result;
    if (http) {
        try {
            const list = await http._list(game);
            const autosaves = list
                .filter(s => /^_autosave_.*\.json$/.test(s.name))
                .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
            if (autosaves.length) {
                const sig = autosaves[0].name.replace(/^_autosave_(.+)\.json$/, '$1');
                const meta = await http.read(`/usr/${game}/_autosave_${sig}.json`);
                const ram = await http.read(`/usr/${game}/_autosave_${sig}.ram`);
                if (meta) {
                    const obj = JSON.parse(new TextDecoder().decode(meta));
                    if (ram) obj.ram = ram;
                    obj.signature = sig;
                    result.prewarmedAutosave = obj;
                }
            }
            const named = list.filter(s => !s.name.startsWith('_autosave_'));
            for (const f of named) {
                const data = await http.read(`/usr/${game}/${f.name}`);
                if (data) result.prewarmedNamedSaves.push([`/usr/${game}/${f.name}`, data]);
            }
        } catch (e) { console.warn('prewarm http failed', e); }
    } else {
        try {
            const metaPrefix = `${LS_PREFIX}autosave:${game}:`;
            let bestSig = null;
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(metaPrefix) && k.endsWith(':meta')) {
                    bestSig = k.slice(metaPrefix.length, k.length - ':meta'.length);
                }
            }
            if (bestSig) {
                const metaB64 = localStorage.getItem(`${metaPrefix}${bestSig}:meta`);
                const ramB64 = localStorage.getItem(`${metaPrefix}${bestSig}:ram`);
                if (metaB64) {
                    const obj = JSON.parse(new TextDecoder().decode(base64ToBytes(metaB64)));
                    if (ramB64) obj.ram = base64ToBytes(ramB64);
                    obj.signature = bestSig;
                    result.prewarmedAutosave = obj;
                }
            }
            const savePrefix = `${LS_PREFIX}save:${game}:`;
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(savePrefix)) {
                    const file = k.slice(savePrefix.length);
                    const v = localStorage.getItem(k);
                    if (v) result.prewarmedNamedSaves.push([`/usr/${game}/${file}`, base64ToBytes(v)]);
                }
            }
        } catch (e) { console.warn('prewarm localStorage failed', e); }
    }
    return result;
}

const Z_EXTENSIONS = /\.(zblorb|zlb|z3|z4|z5|z8)$/i;
export function isZMachine(storyUrlOrName) {
    if (!storyUrlOrName) return false;
    return Z_EXTENSIONS.test(storyUrlOrName.split('?')[0]);
}
