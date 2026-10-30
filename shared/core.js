// ==========================================================
// SHARED CORE -- loaded by every scene before its own script.
// Data loading (players_teams.csv / teams.csv / mappool.json /
// config.json), the tosu websocket, team + player lookups, and
// the mod-adjusted beatmap stat math.
// Everything is exposed on window.FFS.
// ==========================================================
(() => {
    const DATA_DIR = '../data';
    const ICON_DIR = '../icons';
    const ICON_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
    const PLACEHOLDER_ICON = `${ICON_DIR}/placeholder.png`;
    const FLAG_DIR = '../flags';

    // When tosu serves this folder, location.host is tosu itself.
    // Anything else (a file:// page, OBS's http://absolute/ local
    // file address) falls back to tosu's default address.
    const TOSU_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(location.host) ? location.host : '127.0.0.1:24050';

    const MOD_ORDER = ['NM', 'HD', 'HR', 'DT', 'FM', 'TB'];

    const MOD_NAMES = {
        NM: 'NO MOD',
        HD: 'HIDDEN',
        HR: 'HARD ROCK',
        DT: 'DOUBLE TIME',
        FM: 'FREEMOD',
        TB: 'TIEBREAKER',
    };

    // Same values as the showcase overlay's MOD_COLORS.
    const MOD_COLORS = {
        NM: '#f1f7ff',
        HD: '#ebbc83',
        HR: '#ff7d7d',
        DT: '#d1b7ff',
        FM: '#dc96b4',
        TB: '#fcbe38',
    };

    // ------------------------------------------------------
    // ROUND RULES
    // bestOf / locked pick boxes per team / bans per team.
    // Round names are compared uppercased.
    // ------------------------------------------------------
    function getRoundRules(roundName, overrides = {}) {
        const round = String(roundName || '').trim().toUpperCase();
        let rules;
        if (round === 'GROUP STAGE' || round === 'ROUND OF 32' || round === 'ROUND OF 16') {
            rules = { bestOf: 9, lockedSlots: 2, bans: 1 };
        } else if (round === 'QUARTERFINALS' || round === 'SEMIFINALS') {
            rules = { bestOf: 11, lockedSlots: 1, bans: 2 };
        } else {
            rules = { bestOf: 13, lockedSlots: 0, bans: 2 };
        }
        // Optional per-round overrides straight from mappool.json
        if (Number.isInteger(overrides.lockedSlots)) rules.lockedSlots = overrides.lockedSlots;
        if (Number.isInteger(overrides.bans)) rules.bans = Math.max(1, Math.min(2, overrides.bans));
        return rules;
    }

    // ------------------------------------------------------
    // CSV
    // Accepts an optional header row. Quoted fields may contain
    // commas. Columns: acronym, team name, up to 5 player ids.
    // ------------------------------------------------------
    function parseCsvRows(text) {
        const rows = [];
        let row = [];
        let field = '';
        let inQuotes = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inQuotes) {
                if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
                else if (c === '"') inQuotes = false;
                else field += c;
            } else if (c === '"') {
                inQuotes = true;
            } else if (c === ',') {
                row.push(field); field = '';
            } else if (c === '\n' || c === '\r') {
                if (c === '\r' && text[i + 1] === '\n') i++;
                row.push(field); field = '';
                rows.push(row); row = [];
            } else {
                field += c;
            }
        }
        if (field !== '' || row.length) { row.push(field); rows.push(row); }
        return rows
            .map(r => r.map(f => f.trim()))
            .filter(r => r.some(f => f !== ''));
    }

    const isId = value => /^\d+$/.test(value || '');

    // players_teams.csv: user_id, team name, username, country_code
    // One row per player; rows sharing a team name form the team.
    function parseRosterCsv(text) {
        const rows = parseCsvRows(text);
        if (rows.length && !isId(rows[0][0])) rows.shift();
        const teams = new Map();
        for (const [id, teamName, username, flag] of rows) {
            if (!isId(id) || !teamName) continue;
            const key = teamName.toLowerCase();
            if (!teams.has(key)) teams.set(key, { acronym: '', name: teamName, players: [] });
            const team = teams.get(key);
            if (team.players.length < 5) {
                team.players.push({ id: Number(id), name: username || id, flag: (flag || '').toUpperCase() });
            }
        }
        return teams;
    }

    // teams.csv: acronym, team name (used for icons/<ACRONYM>.png).
    // Extra columns with player ids are still read for teams that
    // aren't in players_teams.csv.
    function mergeTeamsCsv(teams, text) {
        const rows = parseCsvRows(text);
        if (rows.length && /acronym/i.test(rows[0][0] || '')) rows.shift();
        for (const r of rows) {
            const acronym = (r[0] || '').toUpperCase();
            const name = r[1] || '';
            if (!name) continue;
            const key = name.toLowerCase();
            if (!teams.has(key)) {
                const ids = r.slice(2, 7).filter(isId);
                teams.set(key, { acronym: '', name, players: ids.map(id => ({ id: Number(id), name: id, flag: '' })) });
            }
            if (acronym) teams.get(key).acronym = acronym;
        }
        return [...teams.values()];
    }

    // ------------------------------------------------------
    // DATA LOADING
    // ------------------------------------------------------
    async function fetchText(path) {
        const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return res.text();
    }

    async function fetchJson(path, fallback) {
        try {
            return JSON.parse(await fetchText(path));
        } catch (err) {
            if (fallback !== undefined) return fallback;
            throw err;
        }
    }

    const data = {
        teams: [],
        mappool: null,
        config: {},
    };

    async function loadAll() {
        const optionalText = path => fetchText(path).catch(err => { console.warn(err); return ''; });
        const [rosterCsv, teamsCsv, mappool, config] = await Promise.all([
            optionalText(`${DATA_DIR}/players_teams.csv`),
            optionalText(`${DATA_DIR}/teams.csv`),
            fetchJson(`${DATA_DIR}/mappool.json`),
            fetchJson(`${DATA_DIR}/config.json`, {}),
        ]);
        data.teams = mergeTeamsCsv(parseRosterCsv(rosterCsv), teamsCsv);
        data.mappool = normalizeMappool(mappool);
        data.config = config;
        return data;
    }

    // Flattens mappool.json into a list of slots in pool order:
    // { id, mod, index, code: 'NM1', map: {...beatmap info} }
    function normalizeMappool(raw) {
        const round = String(raw.round || '').toLowerCase();
        const beatmaps = raw.beatmaps || {};
        const slots = [];
        const sections = [...(raw.pool || [])].sort(
            (a, b) => MOD_ORDER.indexOf(String(a.mod).toUpperCase()) - MOD_ORDER.indexOf(String(b.mod).toUpperCase())
        );
        for (const section of sections) {
            const mod = String(section.mod).toUpperCase();
            (section.maps || []).forEach((id, i) => {
                const map = beatmaps[id] || {};
                slots.push({
                    id: Number(id),
                    mod,
                    index: i + 1,
                    code: `${mod}${i + 1}`,
                    map,
                    cover: map.cover || (map.setId ? `https://assets.ppy.sh/beatmaps/${map.setId}/covers/fullsize.jpg` : ''),
                });
            });
        }
        return {
            round,
            rules: getRoundRules(round, raw),
            statsIncludeMods: !!raw.statsIncludeMods,
            slots,
            byId: new Map(slots.map(s => [s.id, s])),
            byCode: new Map(slots.map(s => [s.code, s])),
        };
    }

    // ------------------------------------------------------
    // TEAMS / PLAYERS
    // ------------------------------------------------------
    function findTeam(clientName) {
        const key = String(clientName || '').trim().toLowerCase();
        if (!key) return null;
        return data.teams.find(t => t.name.toLowerCase() === key)
            || data.teams.find(t => t.acronym.toLowerCase() === key)
            || null;
    }

    // Resolves to the first icons/<ACRONYM>.<ext> that exists,
    // else the placeholder. Results are cached per acronym.
    const iconCache = new Map();
    function resolveTeamIcon(acronym) {
        if (!acronym) return Promise.resolve(PLACEHOLDER_ICON);
        if (iconCache.has(acronym)) return iconCache.get(acronym);
        const attempt = ICON_EXTENSIONS.reduce(
            (prev, ext) => prev.catch(() => probeImage(`${ICON_DIR}/${encodeURIComponent(acronym)}.${ext}`)),
            Promise.reject()
        ).catch(() => PLACEHOLDER_ICON);
        iconCache.set(acronym, attempt);
        return attempt;
    }

    function probeImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(src);
            img.onerror = reject;
            img.src = src;
        });
    }

    // ------------------------------------------------------
    // MOD-ADJUSTED STATS
    // mappool.json stats are nomod unless "statsIncludeMods" is
    // true. HR: CS x1.3, AR/OD x1.4 (cap 10). DT: 1.5x speed
    // (BPM, length) with AR/OD converted through their ms windows.
    // HD / FM / NM / TB are shown as-is.
    // ------------------------------------------------------
    const arToMs = ar => (ar <= 5 ? 1800 - 120 * ar : 1200 - 150 * (ar - 5));
    const msToAr = ms => (ms >= 1200 ? (1800 - ms) / 120 : 5 + (1200 - ms) / 150);
    const odToMs = od => 80 - 6 * od;
    const msToOd = ms => (80 - ms) / 6;

    function modStats(slot) {
        const m = slot.map || {};
        const s = {
            sr: Number(m.sr) || 0,
            cs: Number(m.cs) || 0,
            ar: Number(m.ar) || 0,
            od: Number(m.od) || 0,
            bpm: Number(m.bpm) || 0,
            length: Number(m.length) || 0,
            changed: [],
        };
        if (data.mappool?.statsIncludeMods) {
            if (slot.mod === 'HR') s.changed = ['cs', 'ar', 'od'];
            if (slot.mod === 'DT') s.changed = ['ar', 'od', 'bpm', 'length'];
            return s;
        }
        if (slot.mod === 'HR') {
            s.cs = Math.min(10, s.cs * 1.3);
            s.ar = Math.min(10, s.ar * 1.4);
            s.od = Math.min(10, s.od * 1.4);
            s.changed = ['cs', 'ar', 'od'];
        } else if (slot.mod === 'DT') {
            s.ar = msToAr(arToMs(s.ar) / 1.5);
            s.od = msToOd(odToMs(s.od) / 1.5);
            s.bpm = s.bpm * 1.5;
            s.length = s.length / 1.5;
            s.changed = ['ar', 'od', 'bpm', 'length'];
        }
        return s;
    }

    // 9 -> "9.0", 10.333 -> "10.33", 9.7 -> "9.7"
    function formatDiffStat(value) {
        const rounded = Math.round(value * 100) / 100;
        return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
    }

    function formatLength(seconds) {
        const total = Math.round(seconds);
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    // ------------------------------------------------------
    // TOSU WEBSOCKET (v2) with auto-reconnect
    // ------------------------------------------------------
    function connect(onData) {
        let socket;
        const open = () => {
            socket = new WebSocket(`ws://${TOSU_HOST}/websocket/v2`);
            socket.onopen = () => console.log('[tosu] connected');
            socket.onclose = () => setTimeout(open, 1500);
            socket.onerror = () => socket.close();
            socket.onmessage = event => {
                try {
                    onData(JSON.parse(event.data));
                } catch (err) {
                    console.error('[tosu] message error', err);
                }
            };
        };
        open();
    }

    // Small localStorage wrapper -- storage can be unavailable,
    // so every access is guarded and failures are ignored.
    const storage = {
        get(key, fallback) {
            try {
                const raw = localStorage.getItem(key);
                return raw ? JSON.parse(raw) : fallback;
            } catch { return fallback; }
        },
        set(key, value) {
            try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
        },
        remove(key) {
            try { localStorage.removeItem(key); } catch { /* ignore */ }
        },
    };

    window.FFS = {
        MOD_ORDER,
        MOD_NAMES,
        MOD_COLORS,
        FLAG_DIR,
        data,
        loadAll,
        connect,
        findTeam,
        resolveTeamIcon,
        modStats,
        formatDiffStat,
        formatLength,
        storage,
    };
})();
