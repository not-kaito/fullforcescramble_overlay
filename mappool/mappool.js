// ==========================================================
// MAPPOOL SCENE
// Picks, bans, chat, team header/lineups, and the pick banner.
// Relies on window.FFS (shared/core.js) and Gameplay (gameplay.js).
// ==========================================================
const TEAMS = ['red', 'blue'];
const PICK_SLOTS_PER_TEAM = 6;
const CHAT_MAX_MESSAGES = 60;
const TEAM_OVERRIDE_KEY = 'ffs-team-override';
// Ban card always shows 2 boxes; rounds with 1 ban lock the 2nd
const BAN_SLOTS_PER_TEAM = 2;

const $ = id => document.getElementById(id);

// ----------------------------------------------------------
// STATE
// bans/picks hold beatmap ids in slot order (index 0 = the box
// closest to the team's lineup card). Persisted per round so an
// OBS refresh mid-match doesn't wipe the board.
// ----------------------------------------------------------
const state = {
    bans: { red: [], blue: [] },
    // { id, n (pick order across both teams), winner: null | 'red' | 'blue' }
    picks: { red: [], blue: [] },
    pickCounter: 0,
    autoPick: true,
    // Match points on the lineup cards. Owned by the overlay: +1 to
    // the winner after each pool map, roster clicks fix mistakes.
    score: { red: 0, blue: 0 },
    // Tiebreaker loaded (only allowed when tied one point from the win)
    tbPicked: false,
    // Only one phase at a time: { type: 'pick' | 'ban', team } or null.
    // Not persisted -- a refresh always comes back idle.
    phase: null,
};

// Values from tosu we only act on when they change
const live = {
    connected: false,
    lobbyName: { red: '', blue: '' },
    shownName: { red: undefined, blue: undefined },
    chatKeys: [],
    chatSignature: '',
    beatmapId: undefined,
};

// Manual team names typed in the control panel. When set, they
// win over the names tosu reads from the lobby.
let teamOverride = FFS.storage.get(TEAM_OVERRIDE_KEY, null);

// Manual rosters (improv teams): osu! user ids per side. A side with
// ids here uses them for its lineup instead of the CSV roster.
const MANUAL_ROSTER_KEY = 'ffs-manual-roster';
let manualRoster = FFS.storage.get(MANUAL_ROSTER_KEY, null);

// id -> { name, flag } for every player we know about: everyone in
// players_teams.csv, plus anyone tosu has seen in the lobby (it
// reports each client's id, username and country). The osu! API
// itself can't be called from an overlay page (no CORS), so ids that
// are in neither show as "#id" until that player joins the lobby.
const knownPlayers = new Map();
// Players learned from the lobby are remembered across refreshes
const LOBBY_PLAYERS_KEY = 'ffs-lobby-players';

// Resolved per-side team info for the header, lineup and banner
const teamInfo = {
    red: { team: null, icon: '../icons/placeholder.png' },
    blue: { team: null, icon: '../icons/placeholder.png' },
};

let pool = null;            // FFS.data.mappool
let bannerTimer = null;
let tbTimers = [];

// "TB" instead of "TB1" -- there's only ever one tiebreaker
const slotLabel = slot => (slot.mod === 'TB' ? 'TB' : slot.code);

const storageKey = () => `ffs-mappool-state:${pool?.round || 'unknown'}`;

function saveState() {
    const { phase, ...persisted } = state;
    FFS.storage.set(storageKey(), persisted);
}

function loadState() {
    const saved = FFS.storage.get(storageKey(), null);
    if (!saved) return;
    const valid = id => pool.byId.has(id) && pool.byId.get(id).mod !== 'TB';
    for (const team of TEAMS) {
        state.bans[team] = (saved.bans?.[team] || []).filter(valid).slice(0, pool.rules.bans);
        state.picks[team] = (saved.picks?.[team] || []).filter(p => valid(p.id));
    }
    state.autoPick = saved.autoPick !== false;
    state.pickCounter = Number(saved.pickCounter) || 0;
    state.tbPicked = !!saved.tbPicked;
    for (const team of TEAMS) {
        state.score[team] = Math.max(0, Number(saved.score?.[team]) || 0);
    }
}

// ----------------------------------------------------------
// LOOKUPS
// ----------------------------------------------------------
function usageOf(id) {
    for (const team of TEAMS) {
        if (state.bans[team].includes(id)) return { type: 'ban', team };
        if (state.picks[team].some(p => p.id === id)) return { type: 'pick', team };
    }
    if (state.tbPicked && pool.byId.get(id)?.mod === 'TB') return { type: 'tb' };
    return null;
}

// Tiebreaker is only playable when both teams sit one point from
// the win (Bo9: 4-4, Bo11: 5-5, Bo13: 6-6).
function isTiebreakerScore() {
    const matchPoint = Math.ceil(pool.rules.bestOf / 2) - 1;
    return state.score.red === matchPoint && state.score.blue === matchPoint;
}

const openPickCount = () => PICK_SLOTS_PER_TEAM - pool.rules.lockedSlots;

const isPhase = (type, team) => state.phase?.type === type && state.phase.team === team;

function setStatus(message) {
    $('cp-status').textContent = message;
}

// ==========================================================
// BUILD (once per data load)
// ==========================================================
function buildBoard() {
    $('round-tag').textContent = pool.round.toUpperCase() || 'ROUND';

    for (const team of TEAMS) {
        const banCard = $(`${team}-bans`);
        banCard.innerHTML = '';
        for (let i = 0; i < BAN_SLOTS_PER_TEAM; i++) {
            const slot = document.createElement('div');
            slot.className = 'ban-slot';
            slot.innerHTML = '<div class="slot-bg"></div><div class="ban-label"></div>';
            banCard.appendChild(slot);
        }

        const picks = $(`${team}-picks`);
        picks.innerHTML = '';
        for (let i = 0; i < PICK_SLOTS_PER_TEAM; i++) {
            const slot = document.createElement('div');
            slot.className = 'pick-slot';
            slot.innerHTML =
                '<div class="slot-bg"></div>' +
                '<div class="slot-result"></div>' +
                '<div class="slot-code"></div>' +
                '<div class="slot-status"></div>';
            picks.appendChild(slot);
        }
    }

    buildPoolGrid();
    buildTeamList();
}

// Two rows per mod: map 1 top, map 2 under it, map 3 to the
// right of map 1, and so on.
function buildPoolGrid() {
    const grid = $('pool-grid');
    grid.innerHTML = '';
    for (const mod of FFS.MOD_ORDER) {
        const slots = pool.slots.filter(s => s.mod === mod);
        if (!slots.length) continue;

        const group = document.createElement('div');
        group.className = 'pool-mod';
        for (let c = 0; c < slots.length; c += 2) {
            const col = document.createElement('div');
            col.className = 'pool-col';
            col.appendChild(createPoolCard(slots[c]));
            if (slots[c + 1]) col.appendChild(createPoolCard(slots[c + 1]));
            group.appendChild(col);
        }
        grid.appendChild(group);
    }
}

function createPoolCard(slot) {
    const card = document.createElement('div');
    card.className = 'pool-card';
    card.dataset.id = slot.id;
    card.style.setProperty('--mod-color', FFS.MOD_COLORS[slot.mod]);
    // The tiebreaker can't be picked or banned by a team
    if (slot.mod === 'TB') card.classList.add('tiebreaker');

    const bg = document.createElement('div');
    bg.className = 'pool-bg';
    if (slot.cover) bg.style.backgroundImage = `url('${slot.cover}')`;

    const code = document.createElement('span');
    code.className = 'pool-code';
    code.textContent = slotLabel(slot);

    card.append(bg, code);
    card.addEventListener('click', () => onPoolLeftClick(slot));
    card.addEventListener('contextmenu', e => {
        e.preventDefault();
        onPoolRightClick(slot);
    });
    return card;
}

// Autocomplete list for the manual team name inputs
function buildTeamList() {
    const list = $('team-list');
    list.innerHTML = '';
    for (const team of FFS.data.teams) {
        const option = document.createElement('option');
        option.value = team.name;
        list.appendChild(option);
    }
}

// ==========================================================
// RENDER (after every state change)
// ==========================================================
function render() {
    if (!pool) return;
    for (const team of TEAMS) {
        renderBans(team);
        renderPicks(team);
    }
    renderPoolCards();
    renderScores();
    renderControlPanel();
}

function renderScores() {
    for (const team of TEAMS) $(`${team}-score`).textContent = state.score[team];
    Gameplay.renderPoints();
}

function renderBans(team) {
    const slots = $(`${team}-bans`).children;
    const nextEmpty = state.bans[team].length;
    for (let i = 0; i < slots.length; i++) {
        const el = slots[i];
        const id = state.bans[team][i];
        const slot = id !== undefined ? pool.byId.get(id) : null;
        const label = el.querySelector('.ban-label');
        const bg = el.querySelector('.slot-bg');
        const isLocked = !slot && i >= pool.rules.bans;
        const isBanning = !slot && !isLocked && isPhase('ban', team) && i === nextEmpty;

        el.classList.toggle('filled', !!slot);
        el.classList.toggle('locked', isLocked);
        el.classList.toggle('banning', isBanning);

        if (slot) {
            bg.style.backgroundImage = slot.cover ? `url('${slot.cover}')` : '';
            label.className = 'ban-label';
            label.textContent = `BAN: ${slot.code}`;
        } else if (isLocked) {
            label.className = 'ban-label';
            label.textContent = 'LOCKED';
        } else if (isBanning) {
            label.className = 'ban-label dots';
            label.textContent = 'Loading';
        } else {
            label.className = 'ban-label';
            label.textContent = 'EMPTY BAN';
        }
    }
}

function renderPicks(team) {
    const slots = $(`${team}-picks`).children;
    const picks = state.picks[team];
    const firstLocked = openPickCount();
    for (let i = 0; i < slots.length; i++) {
        const el = slots[i];
        const pick = picks[i];
        const slot = pick ? pool.byId.get(pick.id) : null;
        const status = el.querySelector('.slot-status');
        const isLocked = !slot && i >= firstLocked;
        const isPicking = !slot && !isLocked && isPhase('pick', team) && i === picks.length;

        el.classList.toggle('filled', !!slot);
        el.classList.toggle('locked', isLocked);
        el.classList.toggle('picking', isPicking);
        // WON / LOST from the picking team's point of view
        const result = pick?.winner ? (pick.winner === team ? 'won' : 'lost') : null;
        el.classList.toggle('result-won', result === 'won');
        el.classList.toggle('result-lost', result === 'lost');

        el.querySelector('.slot-bg').style.backgroundImage = slot?.cover ? `url('${slot.cover}')` : '';
        const code = el.querySelector('.slot-code');
        code.textContent = slot ? slot.code : '';
        code.style.color = slot ? FFS.MOD_COLORS[slot.mod] : '';

        el.querySelector('.slot-result').textContent = result ? result.toUpperCase() : '';

        status.className = isPicking ? 'slot-status dots' : 'slot-status';
        status.textContent = isLocked ? 'LOCKED' : isPicking ? 'Picking' : 'OPEN';
    }
}

function renderPoolCards() {
    for (const card of document.querySelectorAll('.pool-card')) {
        const use = usageOf(Number(card.dataset.id));
        card.classList.toggle('banned', use?.type === 'ban');
        card.classList.toggle('picked-red', use?.type === 'pick' && use.team === 'red');
        card.classList.toggle('picked-blue', use?.type === 'pick' && use.team === 'blue');
        card.classList.toggle('picked-tb', use?.type === 'tb');
    }
}

function renderControlPanel() {
    const phase = state.phase;
    $('cp-phase').textContent = phase
        ? `${phase.team.toUpperCase()} is ${phase.type === 'pick' ? 'picking' : 'banning'}… (Esc to cancel)`
        : 'Idle';
    for (const button of document.querySelectorAll('[data-phase]')) {
        const [type, team] = button.dataset.phase.split('-');
        button.classList.toggle('active', isPhase(type, team));
    }
    const auto = $('cp-autopick');
    auto.textContent = state.autoPick ? 'On' : 'Off';
    auto.classList.toggle('active', state.autoPick);

    $('cp-team-source').textContent = teamOverride
        ? 'Using manual names'
        : 'Using lobby names from the tournament client';
}

// ==========================================================
// PHASES
// Only one can be active. Starting another while one is active
// is refused -- press Esc (or Cancel) first.
// ==========================================================
function startPhase(type, team) {
    if (state.phase) {
        if (!isPhase(type, team)) {
            const p = state.phase;
            setStatus(`${p.team.toUpperCase()} is still ${p.type === 'pick' ? 'picking' : 'banning'}. Press Esc first.`);
        }
        return;
    }
    if (type === 'ban' && state.bans[team].length >= pool.rules.bans) {
        setStatus(`${team.toUpperCase()} has no empty ban slot. Right click a banned map to undo it.`);
        return;
    }
    if (type === 'pick' && state.picks[team].length >= openPickCount()) {
        setStatus(`${team.toUpperCase()} has no open pick boxes left.`);
        return;
    }
    state.phase = { type, team };
    render();
}

function cancelPhase() {
    if (!state.phase) return;
    state.phase = null;
    render();
}

// ==========================================================
// ACTIONS
// ==========================================================
function banMap(slot) {
    const team = state.phase.team;
    state.bans[team].push(slot.id);
    state.phase = null;
    saveState();
    render();
    setStatus(`${team.toUpperCase()} banned ${slot.code}`);
}

function pickMap(slot) {
    const team = state.phase.team;
    const picks = state.picks[team];
    picks.push({ id: slot.id, n: ++state.pickCounter, winner: null });
    state.phase = null;
    saveState();
    render();
    revealPickSlot(team, picks.length - 1);
    showBanner(slot, team);
    setStatus(`${team.toUpperCase()} picked ${slot.code}`);
}

// Uses the map for the active phase. Returns false if nothing happened.
function selectMap(slot) {
    // The tiebreaker ignores pick/ban phases entirely
    if (slot.mod === 'TB') return pickTiebreaker(slot);
    if (!state.phase) {
        setStatus('Start a phase first: 1 / 2 to pick, click a team name to ban.');
        return false;
    }
    if (usageOf(slot.id)) {
        setStatus(`${slot.code} is already picked or banned. Right click it to undo.`);
        return false;
    }
    if (state.phase.type === 'ban') banMap(slot);
    else pickMap(slot);
    return true;
}

// Undoes whatever happened to this map, whoever did it.
function undoMap(slot) {
    const use = usageOf(slot.id);
    if (!use) return;
    if (use.type === 'tb') {
        state.tbPicked = false;
        saveState();
        render();
        setStatus('Undid the tiebreaker');
        return;
    }
    if (use.type === 'ban') {
        state.bans[use.team] = state.bans[use.team].filter(id => id !== slot.id);
    } else {
        state.picks[use.team] = state.picks[use.team].filter(p => p.id !== slot.id);
    }
    saveState();
    render();
    setStatus(`Undid ${use.team.toUpperCase()}'s ${use.type} of ${slot.code}`);
}

// Loaded by the referee (song change) or clicked in the pool. Only
// allowed at match point for both teams; cancels any open phase.
function pickTiebreaker(slot) {
    if (state.tbPicked) {
        setStatus('The tiebreaker is already loaded. Right click it to undo.');
        return false;
    }
    if (!isTiebreakerScore()) {
        const matchPoint = Math.ceil(pool.rules.bestOf / 2) - 1;
        setStatus(`Tiebreaker only at ${matchPoint}-${matchPoint} (now ${state.score.red}-${state.score.blue})`);
        return false;
    }
    state.phase = null;
    state.tbPicked = true;
    saveState();
    render();
    showTiebreaker(slot);
    setStatus('Tiebreaker!');
    return true;
}

// Marks who won a pick (WON / LOST on its card) without touching
// the score. Applies to the most recent pick when no id is given.
function setPickWinner(winner, id) {
    const all = TEAMS.flatMap(team => state.picks[team]);
    const pick = id !== undefined
        ? all.find(p => p.id === id)
        : all.sort((a, b) => b.n - a.n)[0];
    if (!pick) return;
    pick.winner = winner;
    saveState();
    render();
}

// Manual score fix (roster clicks). Never below 0.
function changeScore(team, delta) {
    state.score[team] = Math.max(0, state.score[team] + delta);
    saveState();
    renderScores();
}

function resetMatch() {
    state.bans = { red: [], blue: [] };
    state.picks = { red: [], blue: [] };
    state.score = { red: 0, blue: 0 };
    state.pickCounter = 0;
    state.tbPicked = false;
    state.phase = null;
    hideBanner();
    saveState();
    render();
    setStatus('Match reset');
}

// ----------------------------------------------------------
// Hook for a custom "box fills in" animation. Return a promise
// if a later step should wait for it.
// ----------------------------------------------------------
function revealPickSlot(team, index) {
    const el = $(`${team}-picks`).children[index];
    if (!el) return Promise.resolve();
    el.classList.remove('revealing');
    void el.offsetWidth;
    el.classList.add('revealing');
    return new Promise(resolve => setTimeout(() => {
        el.classList.remove('revealing');
        resolve();
    }, 500));
}

// ==========================================================
// PICK BANNER
// ==========================================================
function showBanner(slot, side, { test = false } = {}) {
    const map = slot.map || {};
    const stats = FFS.modStats(slot);
    const modColor = FFS.MOD_COLORS[slot.mod];
    const banner = $('pick-banner');
    hideBanner();

    banner.classList.remove('on-red', 'on-blue', 'show');
    banner.classList.add(`on-${side}`);

    $('banner-team-icon').src = teamInfo[side].icon;
    $('banner-team-label').textContent = side.toUpperCase();

    $('banner-bg').style.backgroundImage = slot.cover ? `url('${slot.cover}')` : '';
    $('banner-title').textContent = map.title || `Beatmap ${slot.id}`;
    $('banner-artist').textContent = map.artist || '';
    $('banner-mapper').textContent = map.mapper ? `mapped by ${map.mapper}` : '';
    $('banner-sr').textContent = `${stats.sr.toFixed(2)}★`;
    const code = $('banner-code');
    code.textContent = slot.code;
    code.style.color = modColor;

    const values = {
        cs: FFS.formatDiffStat(stats.cs),
        ar: FFS.formatDiffStat(stats.ar),
        od: FFS.formatDiffStat(stats.od),
        bpm: String(Math.round(stats.bpm)),
        length: FFS.formatLength(stats.length),
    };
    for (const [key, value] of Object.entries(values)) {
        const el = $(`banner-${key}`);
        el.textContent = value;
        el.style.color = stats.changed.includes(key) ? modColor : '';
    }

    void banner.offsetWidth;   // restart the CSS animations
    banner.classList.add('show');

    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => finishPickAnimation(test), bannerSeconds() * 1000);
}

const bannerSeconds = () => Number(FFS.data.config.pickBannerSeconds) || 8;

// Once a pick card (or the tiebreaker card) has had its time on
// screen, hide it and go to the gameplay scene.
function finishPickAnimation(test) {
    hideBanner();
    if (!test && FFS.data.config.switchToGameplayAfterPick !== false) {
        Gameplay.switchScene('gameplay');
    }
}

function hideBanner() {
    clearTimeout(bannerTimer);
    tbTimers.forEach(clearTimeout);
    tbTimers = [];
    $('pick-banner').classList.remove('show');
    $('tb-banner').classList.remove('show', 'revealed');
}

// ==========================================================
// MARQUEE -- endless, slow scroll to the right
// Repeats `makeUnit()` until one set is wider than the strip,
// doubles the set, then slides the track right by exactly one set
// (CSS marquee-right), so the loop never shows a seam.
// ==========================================================
function fillMarquee(container, makeUnit, pxPerSecond = 40) {
    container.innerHTML = '';
    const track = document.createElement('div');
    track.className = 'marquee-track';
    const set = document.createElement('div');
    set.className = 'marquee-set';
    track.appendChild(set);
    container.appendChild(track);

    let guard = 0;
    do {
        set.appendChild(makeUnit());
    } while (set.offsetWidth < container.offsetWidth && ++guard < 60);

    track.appendChild(set.cloneNode(true));
    track.style.animationDuration = `${Math.max(1, set.offsetWidth / pxPerSecond)}s`;
}

// One country flag + name, as used by the lineups
function playerChip(player) {
    const chip = document.createElement('span');
    chip.className = 'marquee-player';
    if (player.flag) {
        const flag = document.createElement('img');
        flag.className = 'marquee-flag';
        flag.src = `${FFS.FLAG_DIR}/${player.flag}.png`;
        flag.onerror = () => flag.remove();
        chip.appendChild(flag);
    }
    chip.appendChild(document.createTextNode(player.name));
    return chip;
}

// ==========================================================
// TIEBREAKER CARD
// Covers both team rows: a yellow "TIEBREAKER" card whose text
// shoots up and settles in the middle, then after 2s the map
// itself (background, artist - title, difficulty, mapper).
// ==========================================================
const TB_INTRO_MS = 2000;

function showTiebreaker(slot, { test = false } = {}) {
    const map = slot.map || {};
    const banner = $('tb-banner');
    hideBanner();

    $('tb-bg').style.backgroundImage = slot.cover ? `url('${slot.cover}')` : '';
    $('tb-title').textContent = [map.artist, map.title].filter(Boolean).join(' - ') || `Beatmap ${slot.id}`;
    $('tb-diff').textContent = map.difficulty ? `[${map.difficulty}]` : '';
    $('tb-mapper').textContent = map.mapper ? `mapped by ${map.mapper}` : '';
    fillMarquee($('tb-label'), () => {
        const word = document.createElement('span');
        word.className = 'marquee-word';
        word.textContent = 'TIEBREAKER';
        return word;
    });

    void banner.offsetWidth;   // restart the CSS animations
    banner.classList.add('show');
    tbTimers.push(setTimeout(() => banner.classList.add('revealed'), TB_INTRO_MS));
    tbTimers.push(setTimeout(() => finishPickAnimation(test), TB_INTRO_MS + bannerSeconds() * 1000));
}

// ==========================================================
// MOUSE / KEYBOARD
// ==========================================================
const onPoolLeftClick = slot => selectMap(slot);
const onPoolRightClick = slot => undoMap(slot);

function bindInputs() {
    for (const team of TEAMS) {
        $(`${team}-header`).addEventListener('click', () => startPhase('ban', team));

        // Roster card (mappool) and team block (gameplay):
        // left click +1, right click -1
        for (const card of document.querySelectorAll(`.lineup-card.${team}, .gp-team.${team}`)) {
            card.addEventListener('click', () => changeScore(team, 1));
            card.addEventListener('contextmenu', e => {
                e.preventDefault();
                changeScore(team, -1);
            });
        }
    }

    // Right click anywhere else shouldn't open a menu in OBS
    window.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('keydown', e => {
        // Don't steal keys while typing a team name
        if (e.target instanceof Element && e.target.closest('input')) {
            if (e.key === 'Enter') {
                if (e.target.closest('#cp-manual')) applyManualRoster();
                else applyTeamOverride();
            }
            return;
        }
        if (e.key === 'Escape') cancelPhase();
        else if (e.key === '1') startPhase('pick', 'red');
        else if (e.key === '2') startPhase('pick', 'blue');
        else if (e.key === 'q' || e.key === 'Q') startPhase('ban', 'red');
        else if (e.key === 'e' || e.key === 'E') startPhase('ban', 'blue');
        else if (e.key === 'm' || e.key === 'M') Gameplay.switchScene('mappool');
        else if (e.key === 'g' || e.key === 'G') Gameplay.switchScene('gameplay');
        else if (e.key === 'w' || e.key === 'W') Gameplay.switchScene('winner');
    });

    const actions = {
        'scene-mappool': () => Gameplay.switchScene('mappool'),
        'scene-gameplay': () => Gameplay.switchScene('gameplay'),
        'scene-winner': () => Gameplay.switchScene('winner'),
        'finish-now': () => Gameplay.finishMap(),
        'cancel-phase': cancelPhase,
        'toggle-autopick': () => {
            state.autoPick = !state.autoPick;
            saveState();
            render();
        },
        'apply-teams': applyTeamOverride,
        'swap-teams': () => {
            const red = $('cp-red-team').value;
            $('cp-red-team').value = $('cp-blue-team').value;
            $('cp-blue-team').value = red;
            applyTeamOverride();
        },
        'lobby-teams': clearTeamOverride,
        'apply-roster': applyManualRoster,
        'clear-roster': clearManualRoster,
        'winner-red': () => setPickWinner('red'),
        'winner-blue': () => setPickWinner('blue'),
        'winner-clear': () => setPickWinner(null),
        'test-banner': () => {
            const slot = pool.slots.find(s => s.mod === 'DT') || pool.slots[0];
            if (slot) showBanner(slot, state.phase?.team || 'red', { test: true });
        },
        'test-tiebreaker': () => {
            const slot = pool.slots.find(s => s.mod === 'TB');
            if (slot) showTiebreaker(slot, { test: true });
        },
        'reload-data': init,
        // OBS browser sources can't show confirm() dialogs (they hang
        // the page), so the button asks for a second click instead.
        'reset': button => {
            if (button.dataset.armed) {
                clearTimeout(Number(button.dataset.armed));
                delete button.dataset.armed;
                button.textContent = 'Reset match';
                resetMatch();
                return;
            }
            button.textContent = 'Click again to reset';
            button.dataset.armed = setTimeout(() => {
                delete button.dataset.armed;
                button.textContent = 'Reset match';
            }, 3000);
        },
    };
    $('control-panel').addEventListener('click', e => {
        const button = e.target.closest('button');
        if (!button) return;
        if (button.dataset.phase) {
            const [type, team] = button.dataset.phase.split('-');
            startPhase(type, team);
        } else if (actions[button.dataset.action]) {
            actions[button.dataset.action](button);
        }
    });
}

// ==========================================================
// TEAMS (header + lineup)
// Names come from the lobby title via tosu ("FFS: (A) vs (B)"),
// unless manual names are set in the control panel.
// ==========================================================
function refreshTeams() {
    for (const side of TEAMS) {
        const name = teamOverride ? teamOverride[side] : live.lobbyName[side];
        if (live.shownName[side] !== name) {
            live.shownName[side] = name;
            applyTeam(side, name);
        }
    }
    renderControlPanel();
}

function applyTeamOverride() {
    const red = $('cp-red-team').value.trim();
    const blue = $('cp-blue-team').value.trim();
    if (!red && !blue) return clearTeamOverride();
    teamOverride = { red, blue };
    FFS.storage.set(TEAM_OVERRIDE_KEY, teamOverride);
    refreshTeams();
    const unknown = TEAMS.filter(side => teamOverride[side] && !FFS.findTeam(teamOverride[side]));
    setStatus(unknown.length
        ? `Not in players_teams.csv: ${unknown.map(s => teamOverride[s]).join(', ')}`
        : 'Manual team names applied');
}

function clearTeamOverride() {
    teamOverride = null;
    FFS.storage.remove(TEAM_OVERRIDE_KEY);
    $('cp-red-team').value = '';
    $('cp-blue-team').value = '';
    refreshTeams();
    setStatus('Using lobby team names');
}

function applyTeam(side, name) {
    const fallbackName = side === 'red' ? 'RED TEAM' : 'BLUE TEAM';
    const team = FFS.findTeam(name);
    teamInfo[side].team = team;

    $(`${side}-name`).textContent = team?.name || name || fallbackName;
    $(`${side}-acronym`).textContent = team?.acronym || (side === 'red' ? 'RED' : 'BLU');
    renderLineup(side);
    Gameplay.renderTeam(side);

    FFS.resolveTeamIcon(team?.acronym).then(src => {
        if (teamInfo[side].team !== team) return;   // team changed meanwhile
        teamInfo[side].icon = src;
        $(`${side}-icon`).src = src;
        Gameplay.renderTeam(side);
    });
}

// The lineup for a side: manual ids if any, else the CSV team's.
function rosterFor(side) {
    const ids = manualRoster?.[side] || [];
    if (ids.length) {
        return ids.map(id => ({ id, ...(knownPlayers.get(id) || { name: `#${id}`, flag: '' }) }));
    }
    return teamInfo[side].team?.players || [];
}

function renderLineup(side) {
    const list = $(`${side}-lineup`);
    list.innerHTML = '';
    for (const player of rosterFor(side)) {
        const row = document.createElement('div');
        row.className = 'lineup-player';
        if (player.flag) {
            const flag = document.createElement('img');
            flag.className = 'lineup-flag';
            flag.src = `${FFS.FLAG_DIR}/${player.flag}.png`;
            flag.onerror = () => flag.remove();
            row.appendChild(flag);
        }
        const name = document.createElement('span');
        name.textContent = player.name;
        row.appendChild(name);
        list.appendChild(row);
    }
}

// ==========================================================
// MANUAL ROSTERS
// ==========================================================
function rebuildKnownPlayers() {
    for (const [id, player] of Object.entries(FFS.storage.get(LOBBY_PLAYERS_KEY, {}))) {
        knownPlayers.set(Number(id), player);
    }
    // The CSV wins over anything remembered from a lobby
    for (const team of FFS.data.teams) {
        for (const p of team.players) {
            if (p.name && p.name !== String(p.id)) knownPlayers.set(p.id, { name: p.name, flag: p.flag || '' });
        }
    }
}

// Lobby clients fill in anyone the CSV doesn't have
function learnLobbyPlayers(clients) {
    const learned = {};
    for (const c of clients || []) {
        const id = Number(c?.user?.id);
        const name = c?.user?.name;
        if (!(id > 0) || !name) continue;
        const flag = String(c.user.country || '').toUpperCase();
        const known = knownPlayers.get(id);
        if (!known || known.name !== name || (!known.flag && flag)) {
            knownPlayers.set(id, { name, flag: known?.flag || flag });
            learned[id] = knownPlayers.get(id);
        }
    }
    if (!Object.keys(learned).length) return;

    // Only touch storage when someone new actually turned up
    FFS.storage.set(LOBBY_PLAYERS_KEY, { ...FFS.storage.get(LOBBY_PLAYERS_KEY, {}), ...learned });
    if (manualRoster) {
        TEAMS.forEach(renderLineup);
        renderRosterStatus();
    }
}

function readRosterInputs() {
    const roster = { red: [], blue: [] };
    for (const input of document.querySelectorAll('[data-roster]')) {
        const id = Number(input.value.replace(/\D/g, ''));
        if (id > 0 && !roster[input.dataset.roster].includes(id)) roster[input.dataset.roster].push(id);
    }
    return roster;
}

function fillRosterInputs() {
    for (const side of TEAMS) {
        const inputs = document.querySelectorAll(`[data-roster="${side}"]`);
        inputs.forEach((input, i) => { input.value = manualRoster?.[side]?.[i] ?? ''; });
    }
}

function applyManualRoster() {
    const roster = readRosterInputs();
    if (!roster.red.length && !roster.blue.length) return clearManualRoster();
    manualRoster = roster;
    FFS.storage.set(MANUAL_ROSTER_KEY, manualRoster);
    fillRosterInputs();          // tidy: duplicates / gaps removed
    TEAMS.forEach(renderLineup);
    renderRosterStatus();
    setStatus('Manual rosters applied');
}

function clearManualRoster() {
    manualRoster = null;
    FFS.storage.remove(MANUAL_ROSTER_KEY);
    fillRosterInputs();
    TEAMS.forEach(renderLineup);
    renderRosterStatus();
    setStatus('Manual rosters cleared');
}

function renderRosterStatus() {
    const node = $('cp-roster-status');
    if (!manualRoster) {
        node.textContent = 'Not in use: lineups come from players_teams.csv';
        return;
    }
    node.textContent = TEAMS.map(side => {
        const ids = manualRoster[side] || [];
        if (!ids.length) return `${side.toUpperCase()}: CSV roster`;
        const missing = ids.filter(id => !knownPlayers.has(id));
        return `${side.toUpperCase()}: ${ids.length - missing.length}/${ids.length} found`
            + (missing.length ? ` (waiting for ${missing.map(id => `#${id}`).join(', ')} to join the lobby)` : '');
    }).join('\n');
}

// ==========================================================
// CHAT
// tosu reads the chat straight out of the tournament client.
// Messages are matched by content (not by count) so a capped or
// scrolling message list still only adds what's new. New lines
// appear at the bottom and push older ones up and out the top.
// ==========================================================
const chatKey = msg => `${msg.timestamp}|${msg.name}|${msg.message}`;

function updateChat(messages) {
    const signature = `${messages.length}|${messages.length ? chatKey(messages[messages.length - 1]) : ''}`;
    if (signature === live.chatSignature) return;
    live.chatSignature = signature;

    const keys = messages.map(chatKey);
    const start = findNewChatStart(live.chatKeys, keys);
    const logs = document.querySelectorAll('.chat-log');
    if (start === 0) logs.forEach(log => { log.innerHTML = ''; });   // new lobby, or first load
    const animate = start > 0;
    live.chatKeys = keys;

    const hideMp = FFS.data.config.hideMpCommands !== false;
    for (let i = start; i < messages.length; i++) {
        const msg = messages[i];
        const text = String(msg.message || '');
        if (hideMp && text.toLowerCase().startsWith('!mp')) continue;
        for (const log of logs) log.appendChild(createChatRow(msg, text, animate));
    }
    for (const log of logs) {
        while (log.children.length > CHAT_MAX_MESSAGES) log.firstChild.remove();
    }
}

// Index in `next` where unseen messages begin: right after the
// last message we already rendered. Matches the longest run (up
// to 3) of our newest messages so repeated lines like "gl" don't
// confuse it. 0 means start over (new lobby).
function findNewChatStart(prev, next) {
    for (let overlap = Math.min(3, prev.length); overlap > 0; overlap--) {
        const tail = prev.slice(-overlap);
        for (let i = next.length - 1; i >= overlap - 1; i--) {
            let match = true;
            for (let j = 0; j < overlap; j++) {
                if (next[i - overlap + 1 + j] !== tail[j]) { match = false; break; }
            }
            if (match) return i + 1;
        }
    }
    return 0;
}

function createChatRow(msg, text, animate) {
    const row = document.createElement('div');
    row.className = `chat-msg ${String(msg.team || '').toLowerCase()}`;
    if (animate) row.classList.add('enter');

    const time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = msg.timestamp || '';

    const name = document.createElement('span');
    name.className = 'chat-name';
    name.textContent = `${msg.name}:`;

    const body = document.createElement('span');
    body.className = 'chat-text';
    body.textContent = text;

    row.append(time, name, body);
    return row;
}

// ==========================================================
// TOSU UPDATES
// ==========================================================
function onTosu(data) {
    const tourney = data.tourney;
    if (!tourney || !pool) return;

    if (!live.connected) {
        live.connected = true;
        setStatus('Connected to tosu');
    }

    live.lobbyName.red = tourney.team?.left || '';
    live.lobbyName.blue = tourney.team?.right || '';
    refreshTeams();

    if (Array.isArray(tourney.chat)) updateChat(tourney.chat);

    // Song change in the lobby -> pick for the team in pick phase
    const beatmapId = Number(data.beatmap?.id) || 0;
    if (beatmapId && beatmapId !== live.beatmapId) {
        const isFirst = live.beatmapId === undefined;
        live.beatmapId = beatmapId;
        if (!isFirst) onSongChange(beatmapId);
    }

    learnLobbyPlayers(tourney.clients);
    Gameplay.onTosu(data);
}

function onSongChange(beatmapId) {
    const slot = pool.byId.get(beatmapId);
    if (!slot) return setStatus(`Song changed: ${beatmapId} (not in pool)`);

    const autoPickEnabled = state.autoPick && FFS.data.config.autoPickOnSongChange !== false;
    if (!autoPickEnabled) return setStatus(`Song changed: ${slot.code} (auto-pick off)`);
    if (slot.mod === 'TB') return pickTiebreaker(slot);
    if (state.phase?.type !== 'pick') return setStatus(`Song changed: ${slot.code} (no pick phase active)`);
    selectMap(slot);
}

// ==========================================================
// INIT
// ==========================================================
async function init() {
    try {
        await FFS.loadAll();
    } catch (err) {
        console.error(err);
        setStatus(`Could not load data:\n${err.message}`);
        return;
    }
    pool = FFS.data.mappool;
    state.phase = null;
    loadState();
    buildBoard();
    rebuildKnownPlayers();
    fillRosterInputs();
    renderRosterStatus();
    if (teamOverride) {
        $('cp-red-team').value = teamOverride.red || '';
        $('cp-blue-team').value = teamOverride.blue || '';
    }
    live.shownName = { red: undefined, blue: undefined };
    refreshTeams();
    render();
    setStatus(live.connected ? 'Data reloaded' : 'Waiting for tosu…');
}

bindInputs();
init().then(() => {
    Gameplay.init();
    FFS.connect(onTosu);
});

// Handy from the browser console
window.overlay = { state, switchScene: Gameplay.switchScene, setPickWinner, showBanner, showTiebreaker, resetMatch };
