// ==========================================================
// GAMEPLAY SCENE + MATCH FLOW + SCENE SWITCHING
// Loaded before mappool.js; uses its globals (state, pool,
// teamInfo, render, saveState, ...) only at call time.
//
// Flow (driven by tosu's tourney.ipcState):
//   WaitingForClients / Playing -> switch to gameplay, show scores
//   Ranking (map finished)      -> +1 to the winner right away, mark the
//                                  map's card WON/LOST (once per map)
//   Ranking -> Idle (results    -> hide scores, show chat, switch to
//   screen closed)                 mappool, play the point animations,
//                                  start the other team's pick phase.
// ==========================================================
const Gameplay = (() => {
    const IPC = { Initialising: 0, Idle: 1, WaitingForClients: 2, Playing: 3, Ranking: 4 };
    const IPC_NAMES = ['Initialising', 'Idle', 'Waiting for clients', 'Playing', 'Ranking'];
    const SCENE_KEY = 'ffs-scene';
    const STAGE_CENTER = 960;
    const STAGE_EDGE = 24;          // scores never go closer to the edge than this
    const SCORE_GAP = 18;           // gap between a score and the center line

    const other = team => (team === 'red' ? 'blue' : 'red');
    const el = id => document.getElementById(id);
    const config = key => FFS.data.config[key];

    const match = {
        scene: 'mappool',
        ipcState: undefined,
        scoresVisible: false,
        target: { red: 0, blue: 0 },     // live scores from tosu
        shown: { red: 0, blue: 0 },      // animated values on screen
        playedBeatmapId: null,
        nowPlayingKey: '',
        awaitingReturn: false,           // results screen is up
        finalScores: null,
        // One point per map: set when the point is given, cleared only
        // when the next map starts. Starts true so nothing is awarded
        // until a map is actually played after the page loads.
        awarded: true,
        pendingReturn: null,             // animations to play on return
    };

    // ------------------------------------------------------
    // SCENES
    // ------------------------------------------------------
    function switchScene(name, { force = false } = {}) {
        if (match.scene === name && !force) return;   // already there
        match.scene = name;
        for (const scene of document.querySelectorAll('.scene')) {
            scene.classList.toggle('active', scene.id === `scene-${name}`);
        }
        const video = el(name === 'winner' ? 'winner-video' : 'bg-video');
        if (video && (name === 'mappool' || name === 'winner')) video.play().catch(() => {});
        if (name !== 'mappool') hideBanner();
        if (name === 'winner') startWinnerScreen();
        else stopWinnerScreen();
        FFS.storage.set(SCENE_KEY, name);
        renderPanel();
    }

    // ------------------------------------------------------
    // WINNER SCENE
    // Blank for 2s, then the team that reached the winning score
    // (first to ceil(bestOf / 2): 5 in a Bo9). If nobody has, the
    // screen stays blank and the panel status says why.
    // ------------------------------------------------------
    const WINNER_DELAY_MS = 2000;
    let winnerTimer = null;

    function matchWinner() {
        const firstTo = Math.ceil(pool.rules.bestOf / 2);
        for (const team of TEAMS) {
            if (state.score[team] >= firstTo && state.score[team] > state.score[other(team)]) return team;
        }
        return null;
    }

    function startWinnerScreen() {
        stopWinnerScreen();
        winnerTimer = setTimeout(() => {
            const firstTo = Math.ceil(pool.rules.bestOf / 2);
            const winner = matchWinner();
            const score = `${state.score.red}-${state.score.blue}`;
            if (!winner) {
                setStatus(`Winner screen: no team has ${firstTo} points yet (${score}), showing nothing`);
                return;
            }
            const scene = el('scene-winner');
            scene.classList.remove('red', 'blue');
            scene.classList.add(winner);
            el('winner-icon').src = teamInfo[winner].icon;
            el('winner-name').textContent = el(`${winner}-name`).textContent;
            el('winner-score').textContent = `${state.score[winner]} - ${state.score[other(winner)]}`;

            // "flag name - flag name - ... " scrolling right, with extra
            // space after the last player so the loop point is clear
            const roster = el('winner-roster');
            const players = rosterFor(winner);
            roster.style.display = players.length ? '' : 'none';
            if (players.length) {
                fillMarquee(roster, () => {
                    const unit = document.createElement('span');
                    unit.className = 'marquee-unit';
                    players.forEach((player, i) => {
                        if (i) unit.appendChild(document.createTextNode(' - '));
                        unit.appendChild(playerChip(player));
                    });
                    unit.appendChild(document.createTextNode('\u00A0\u00A0\u00A0'));
                    return unit;
                }, 50);
            }
            void scene.offsetWidth;
            scene.classList.add('revealed');
            setStatus(`Winner screen: ${el('winner-name').textContent} (${winner.toUpperCase()}) wins ${score}`);
        }, WINNER_DELAY_MS);
    }

    function stopWinnerScreen() {
        clearTimeout(winnerTimer);
        winnerTimer = null;
        el('scene-winner')?.classList.remove('revealed');
    }

    // ------------------------------------------------------
    // TOSU
    // ------------------------------------------------------
    function onTosu(data) {
        const tourney = data.tourney;
        match.target = readScores(tourney);

        const ipcState = Number(tourney.ipcState);
        if (ipcState !== match.ipcState) {
            const previous = match.ipcState;
            match.ipcState = ipcState;
            if (previous === undefined) {
                // Loaded mid-map (e.g. an OBS refresh): pick up where the
                // client is without triggering a scene switch
                setScoresVisible(ipcState === IPC.Playing || ipcState === IPC.Ranking);
                if (ipcState === IPC.Playing || ipcState === IPC.Ranking) {
                    match.playedBeatmapId = Number(data.beatmap?.id) || null;
                }
                // Mid-map: the point is still to come. On the results
                // screen it was most likely given before the refresh.
                match.awarded = ipcState !== IPC.Playing;
                if (ipcState === IPC.Ranking) match.awaitingReturn = true;
            } else {
                onIpcChange(previous, ipcState, data);
            }
            renderPanel();
        }

        // Redraw whenever anything shown changes (map, its stats, or
        // its pick status), not just the id -- stats can arrive a
        // moment after the map loads, and warmups may have no id.
        const info = nowPlayingInfo(data);
        const key = JSON.stringify(info);
        if (key !== match.nowPlayingKey) {
            match.nowPlayingKey = key;
            renderNowPlaying(info);
        }
    }

    // Team totals are summed from each client so the tournament's EZ
    // rule can be applied: any mod combo containing EZ (EZ, EZHD,
    // EZFL, ...) counts that player's score x`ezMultiplier` (2) on
    // top of the game's own 0.5x. tosu's totalScore is only the
    // fallback when no clients are reported.
    function hasEZ(mods) {
        if (!mods) return false;
        return (Number(mods.number) & 2) === 2
            || /EZ/i.test(String(mods.name || ''))
            || (Array.isArray(mods.array) && mods.array.some(m => String(m?.acronym ?? m).toUpperCase() === 'EZ'));
    }

    function readScores(tourney) {
        const clients = tourney.clients || [];
        if (clients.length) {
            const ezMultiplier = Number(config('ezMultiplier')) || 2;
            const sum = side => clients
                .filter(c => c.team === side)
                .reduce((acc, c) => {
                    const score = Number(c.play?.score) || 0;
                    return acc + (hasEZ(c.play?.mods) ? score * ezMultiplier : score);
                }, 0);
            return { red: sum('left'), blue: sum('right') };
        }
        const total = tourney.totalScore;
        if (total && Number.isFinite(total.left) && Number.isFinite(total.right)) {
            return { red: total.left, blue: total.right };
        }
        return { red: 0, blue: 0 };
    }

    function onIpcChange(previous, current, data) {
        if (current === IPC.WaitingForClients || current === IPC.Playing) {
            match.awaitingReturn = false;
            match.finalScores = null;
            match.pendingReturn = null;
            match.awarded = false;           // a new map: its point is up for grabs
            match.playedBeatmapId = Number(data.beatmap?.id) || match.playedBeatmapId;
            setScoresVisible(true);
            if (config('autoSwitchToGameplay') !== false) switchScene('gameplay');
        } else if (current === IPC.Ranking) {
            // Final scores are locked in here (the client may reset
            // them once the results screen closes) and the point is
            // given immediately.
            match.finalScores = { ...match.target };
            match.awaitingReturn = true;
            awardPoint();
        } else if (current === IPC.Idle && previous === IPC.Ranking && match.awaitingReturn) {
            finishMap();
        }
    }

    // ------------------------------------------------------
    // MAP FINISHED -> POINT (at most once per map)
    // ------------------------------------------------------
    function awardPoint() {
        if (match.awarded) return;
        match.awarded = true;

        const scores = match.finalScores || { ...match.target };
        const winner = scores.red > scores.blue ? 'red' : scores.blue > scores.red ? 'blue' : null;
        const beatmapId = match.playedBeatmapId;
        const slot = pool?.byId.get(beatmapId);
        if (!winner || !slot) {
            setStatus(!slot ? 'Map finished (not a pool map): no point given' : 'Map finished in a tie: no point given');
            return;
        }

        state.score[winner] += 1;

        let pickTeam = null;
        let pickIndex = -1;
        for (const team of TEAMS) {
            const i = state.picks[team].findIndex(p => p.id === beatmapId);
            if (i !== -1) {
                pickTeam = team;
                pickIndex = i;
                state.picks[team][i].winner = winner;
            }
        }

        saveState();
        render();
        playGameplayPointAnimation(winner);
        match.pendingReturn = { winner, pickTeam, pickIndex };
        setStatus(`${winner.toUpperCase()} won ${slotLabel(slot)} (+1)`);
    }

    // In the gameplay scene: the pip that just filled glows and the
    // team's point number pops, then both settle back to normal.
    function playGameplayPointAnimation(winner) {
        const pips = el(`gp-${winner}-pips`).children;
        restartClass(pips[state.score[winner] - 1], 'pip-gain', 1500);
        restartClass(el(`gp-${winner}-points`), 'point-gain', 1500);
    }

    // ------------------------------------------------------
    // RESULTS SCREEN CLOSED -> BACK TO MAPPOOL
    // Also called by the panel's "Finish map now" button, which
    // gives the point first if the map hasn't been scored yet.
    // ------------------------------------------------------
    function finishMap() {
        if (!match.awarded) awardPoint();
        const pending = match.pendingReturn;
        match.pendingReturn = null;
        match.finalScores = null;
        match.awaitingReturn = false;

        // Scores go away and chat comes back, then the scene flips
        setScoresVisible(false);

        // Someone reached the winning score: straight to the winner screen
        if (pool && matchWinner()) {
            state.phase = null;
            render();
            switchScene('winner');
            return;
        }

        switchScene('mappool');
        renderPanel();
        if (!pending) return;

        // Let the scene fade in before the point animation plays
        setTimeout(() => {
            const { winner, pickTeam, pickIndex } = pending;
            let next = null;
            if (isTiebreakerScore()) {
                state.phase = null;           // tiebreaker next, no more picks
            } else if (pickTeam) {
                // Picks always alternate: the other team picks next
                next = other(pickTeam);
                state.phase = state.picks[next].length < openPickCount() ? { type: 'pick', team: next } : null;
            }
            render();
            playPointAnimation(winner, pickTeam, pickIndex);
            setStatus(isTiebreakerScore()
                ? `${winner.toUpperCase()} won the point · TIEBREAKER next`
                : `${winner.toUpperCase()} won the point${next ? ` · ${next.toUpperCase()} picks next` : ''}`);
        }, 450);
    }

    // The winner's lineup card flashes and its score pops; the
    // played map's card stamps WON / LOST.
    function playPointAnimation(winner, pickTeam, pickIndex) {
        const card = document.querySelector(`.lineup-card.${winner}`);
        restartClass(card, 'point-gain', 1600);
        if (pickTeam && pickIndex !== -1) {
            restartClass(el(`${pickTeam}-picks`).children[pickIndex], 'result-stamp', 900);
        }
    }

    function restartClass(node, cls, duration) {
        if (!node) return;
        node.classList.remove(cls);
        void node.offsetWidth;
        node.classList.add(cls);
        setTimeout(() => node.classList.remove(cls), duration);
    }

    // ------------------------------------------------------
    // SCORES + BAR
    // ------------------------------------------------------
    function setScoresVisible(visible) {
        match.scoresVisible = visible;
        el('scene-gameplay').classList.toggle('scores-visible', visible);
    }

    // Runs ~30x a second: numbers ease toward tosu's values, the
    // bar grows from the center toward the leader, and the leader's
    // score rides the bar tip until it reaches the edge. A timer is
    // used instead of requestAnimationFrame, which browsers (and
    // OBS) pause for pages they consider hidden.
    function tick() {
        for (const side of TEAMS) {
            const diff = match.target[side] - match.shown[side];
            match.shown[side] = Math.abs(diff) < 1 ? match.target[side] : match.shown[side] + diff * 0.25;
        }
        if (match.scene === 'gameplay') drawScores();
    }

    function drawScores() {
        const red = Math.round(match.shown.red);
        const blue = Math.round(match.shown.blue);
        const diff = Math.abs(red - blue);
        const maxDiff = Number(config('scoreBarMaxDiff')) || 1200000;
        const barWidth = (STAGE_CENTER - STAGE_EDGE) * Math.min(1, Math.sqrt(diff / maxDiff));
        const leader = red > blue ? 'red' : blue > red ? 'blue' : null;

        el('gp-bar-red').style.width = `${leader === 'red' ? barWidth : 0}px`;
        el('gp-bar-blue').style.width = `${leader === 'blue' ? barWidth : 0}px`;

        const redEl = el('gp-score-red');
        const blueEl = el('gp-score-blue');
        redEl.textContent = red.toLocaleString('en-US');
        blueEl.textContent = blue.toLocaleString('en-US');
        redEl.classList.toggle('leading', leader === 'red');
        blueEl.classList.toggle('leading', leader === 'blue');

        // Red's right edge sits at the bar tip (or near center)
        const redOffset = leader === 'red' ? barWidth : 0;
        const redRight = Math.min(STAGE_CENTER - SCORE_GAP - redOffset, STAGE_CENTER - SCORE_GAP);
        const redLeft = Math.max(STAGE_EDGE, redRight - redEl.offsetWidth);
        redEl.style.transform = `translateX(${redLeft}px)`;

        const blueOffset = leader === 'blue' ? barWidth : 0;
        const blueLeft = Math.min(STAGE_CENTER + SCORE_GAP + blueOffset, 1920 - STAGE_EDGE - blueEl.offsetWidth);
        blueEl.style.transform = `translateX(${blueLeft}px)`;

        el('gp-diff').textContent = leader ? `+${diff.toLocaleString('en-US')}` : '';
        el('gp-diff').className = leader || '';
    }

    // ------------------------------------------------------
    // TEAMS / POINTS
    // ------------------------------------------------------
    function renderTeam(side) {
        el(`gp-${side}-name`).textContent = el(`${side}-name`).textContent;
        el(`gp-${side}-acronym`).textContent = el(`${side}-acronym`).textContent;
        el(`gp-${side}-icon`).src = teamInfo[side].icon;
    }

    function renderPoints() {
        if (!pool) return;
        const firstTo = Math.ceil(pool.rules.bestOf / 2);
        for (const side of TEAMS) {
            el(`gp-${side}-points`).textContent = state.score[side];
            const pips = el(`gp-${side}-pips`);
            pips.innerHTML = '';
            for (let i = 0; i < firstTo; i++) {
                const pip = document.createElement('span');
                pip.className = i < state.score[side] ? 'pip filled' : 'pip';
                pips.appendChild(pip);
            }
        }
        el('gp-first-to').textContent = `FIRST TO ${firstTo}`;
    }

    // ------------------------------------------------------
    // NOW PLAYING
    // ------------------------------------------------------
    // Pool maps use mappool.json (already mod-adjusted). Anything
    // else (warmups) is read live: the first client's beatmap stats
    // carry that client's mods, so SR / CS / AR / OD / BPM are the
    // mod-adjusted values; length is scaled by the mod's speed rate.
    function nowPlayingInfo(data) {
        const bm = data.beatmap || {};
        const id = Number(bm.id) || 0;
        const slot = id ? pool?.byId.get(id) : null;
        const use = slot ? usageOf(slot.id) : null;
        const tag = use?.type === 'pick'
            ? { text: `${use.team.toUpperCase()} PICK`, cls: use.team }
            : slot?.mod === 'TB' ? { text: 'TIEBREAKER', cls: 'tb' }
            : slot ? { text: 'POOL', cls: '' } : { text: 'WARMUP / NOT IN POOL', cls: '' };

        if (slot) {
            const s = FFS.modStats(slot);
            return {
                code: slot.code, mod: slot.mod, cover: slot.cover, tag,
                title: slot.map.title, artist: slot.map.artist, mapper: slot.map.mapper, diff: slot.map.difficulty,
                sr: s.sr, cs: s.cs, ar: s.ar, od: s.od, bpm: s.bpm, length: s.length, changed: s.changed,
            };
        }

        const client = (data.tourney?.clients || []).find(c => c?.beatmap?.stats?.stars?.total);
        const st = client?.beatmap?.stats || bm.stats || {};
        const modName = String(client?.play?.mods?.name || '');
        const rate = Number(client?.play?.mods?.rate)
            || (/DT|NC/.test(modName) ? 1.5 : /HT/.test(modName) ? 0.75 : 1);
        const pick = (stat) => Number(stat?.converted ?? stat?.original) || 0;
        return {
            code: '', mod: null, tag,
            cover: bm.set ? `https://assets.ppy.sh/beatmaps/${bm.set}/covers/cover.jpg` : '',
            title: bm.title || '', artist: bm.artist || '', mapper: bm.mapper || '', diff: bm.version || '',
            sr: Number(st.stars?.total) || 0,
            cs: pick(st.cs), ar: pick(st.ar), od: pick(st.od),
            bpm: Number(st.bpm?.common) || 0,
            length: ((bm.time?.lastObject || 0) - (bm.time?.firstObject || 0)) / 1000 / rate,
            changed: [],
        };
    }

    function renderNowPlaying(info) {
        const modColor = info.mod ? FFS.MOD_COLORS[info.mod] : '#ffffff';
        if (info.mod === 'TB') info.code = 'TB';
        el('gp-np-bg').style.backgroundImage = info.cover ? `url('${info.cover}')` : '';
        const code = el('gp-np-code');
        code.textContent = info.code || '—';
        code.style.color = modColor;
        el('gp-np-title').textContent = info.title || '';
        el('gp-np-sub').textContent = [info.artist, info.diff ? `[${info.diff}]` : '', info.mapper ? `mapped by ${info.mapper}` : '']
            .filter(Boolean).join('  ·  ');
        el('gp-np-sr').textContent = `${(Number(info.sr) || 0).toFixed(2)}★`;

        const values = {
            cs: FFS.formatDiffStat(info.cs), ar: FFS.formatDiffStat(info.ar), od: FFS.formatDiffStat(info.od),
            bpm: String(Math.round(info.bpm)), length: FFS.formatLength(info.length),
        };
        for (const [key, value] of Object.entries(values)) {
            const node = el(`gp-np-${key}`);
            node.textContent = value;
            node.style.color = info.changed.includes(key) ? modColor : '';
        }

        const tag = el('gp-np-tag');
        tag.className = info.tag.cls;
        tag.textContent = info.tag.text;
    }

    // ------------------------------------------------------
    // CONTROL PANEL
    // ------------------------------------------------------
    function renderPanel() {
        for (const name of ['mappool', 'gameplay', 'winner']) {
            el(`cp-scene-${name}`)?.classList.toggle('active', match.scene === name);
        }
        const parts = [`Scene: ${match.scene.toUpperCase()}`];
        if (match.ipcState !== undefined) parts.push(`Client: ${IPC_NAMES[match.ipcState] || match.ipcState}`);
        if (match.awaitingReturn) parts.push('Back to mappool when the results screen closes');
        const node = el('cp-scene');
        if (node) node.textContent = parts.join('\n');
    }

    function init() {
        const saved = FFS.storage.get(SCENE_KEY, 'mappool');
        switchScene(['gameplay', 'winner'].includes(saved) ? saved : 'mappool', { force: true });
        setScoresVisible(false);
        setInterval(tick, 33);
    }

    return {
        init,
        onTosu,
        switchScene,
        renderTeam,
        renderPoints,
        finishMap,
        get scene() { return match.scene; },
        match,
    };
})();
