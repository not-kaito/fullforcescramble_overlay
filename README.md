# Full Force Scramble – stream overlay

```
data/         players_teams.csv, teams.csv, mappool.json, config.json   <- edit these
icons/        team icons, named <ACRONYM>.png/.jpg/.jpeg/.webp/.gif (placeholder.png = fallback)
flags/        country flags for the lineups (<COUNTRY_CODE>.png)
fonts/        shared fonts
shared/       common.css + core.js (used by every scene)
mappool/      the match overlay page: mappool scene (style.css, mappool.js)
              + gameplay scene and match flow (gameplay.css, gameplay.js)
main.mp4      looping background behind the mappool scene
```

## Requirements
Run **tosu** next to the osu! tournament client. tosu reads everything below straight from the
client's memory, so no folder paths need setting up, whatever each streamer's install looks like:
- team names (from the lobby title `FFS: (team A) vs. (team B)`)
- live team scores while a map is played
- the client state (Idle / Playing / Ranking), which drives the scene switching
- lobby chat
- the currently loaded beatmap

## OBS setup
Browser source → **URL** (leave *Local file* unchecked): `http://127.0.0.1:24050/fullforcescramble_overlay/mappool/index.html`
- If *Local file* is checked, the page sends itself to the URL above. This only works when tosu is running and the folder
  sits inside tosu's `static` folder.
- Width **2400**, height **1080**. Crop **480 px off the right** (Alt+drag or a Crop filter):
  the control panel sits there, so you only see it in **Interact**.
- Put this source **above** the spectator clients. The mappool scene covers them with `main.mp4`.
  The gameplay scene is see-through except for a 240 px panel flush with the bottom of the frame (y 840–1080),
  with the score bar along its top edge. Panel size: `--gp-height` in gameplay.css.

## Data
**players_teams.csv** – one row per player: `user_id, team name, username, country_code`.
Players who share a team name form that team (5 max). The lineup shows their usernames and flags.

**teams.csv** – `acronym, team name`. Only used to find each team's icon (`icons/<ACRONYM>.png`).
It's pre-filled with every team name from players_teams.csv, so you only need to type in the acronyms.

**mappool.json**
- `round`: lowercase, e.g. `"group stage"`, `"round of 32"`, `"round of 16"`, `"quarterfinals"`, `"semifinals"`, `"finals"`.
  The last two pick boxes in each row are the lockable ones:
  - group stage / round of 32 / round of 16 → Bo9, both locked, 1 ban per team (2nd ban box shown locked)
  - quarterfinals / semifinals → Bo11, last one locked, 2 bans per team
  - anything else → Bo13, all open, 2 bans per team
  - Override with `"lockedSlots": n` / `"bans": 1|2`.
- `pool`: one `{ "mod": "NM", "maps": [ids…] }` per modpool, maps in order.
- `beatmaps`: stats per beatmap id: `artist, title, difficulty, mapper, setId, cover, sr, cs, ar, od, bpm, length` (seconds).
- `statsIncludeMods`: `false` = stats are nomod, and the overlay applies HR/DT itself. `true` = stats are already modded.

## Match flow
1. When the map starts (client goes to *Playing*), the overlay switches to the **gameplay** scene and shows the live scores.
   The bar along the top of the bottom panel grows toward the leading team, and the leader's score rides its tip.
2. When the map ends (*Ranking*), the winner gets +1 straight away, and the map's card is marked **WON** / **LOST**
   for the team that picked it. Each map can give only one point: the next point becomes possible only when a new map starts.
3. When the results screen closes (*Ranking* → *Idle*), the scores hide, the chat returns, and it switches back to the
   **mappool** scene. There the point animation plays (the lineup card flashes, the WON/LOST stamp lands), and the *other* team's
   pick phase starts automatically. At match point for both teams, no pick phase starts: the tiebreaker is next.
4. After a pick card (or the tiebreaker card) finishes, the overlay switches to the **gameplay** scene by itself.
5. When a team reaches the winning score (first to `ceil(bestOf / 2)`: 5 in a Bo9) and the results screen closes,
   the overlay goes to the **winner** scene instead of the mappool. It stays blank for 2 s, then shows "WINNER", the team's icon,
   name and final score in their team color. `W` opens it manually. If no team has the winning score yet, it stays blank,
   and the panel status says why.

**EZ:** team totals are summed from every client, and any player with EZ in their mods (EZ, EZHD, EZFL, …) counts
`ezMultiplier` × their score (2×, on top of the game's own 0.5×). The adjusted totals drive the score bar and decide who wins the point.
The clients themselves still show the game's own scores.

A map that isn't in the pool (e.g. a warmup), or a tie, gives no point.
The match score belongs to the overlay (the tournament client's stars are ignored), so fix it by clicking the lineup cards.

Settings in `config.json`: `ezMultiplier` (2), `pickBannerSeconds` (how long a pick card shows, 8), `switchToGameplayAfterPick`,
`autoSwitchToGameplay` (switch when a map starts), `scoreBarMaxDiff`
(the score difference at which the bar reaches the screen edge; it is halfway at a quarter of this, e.g. 300k for 1,200,000).

## Controls
Only one phase can be active at a time. Press **Esc** to cancel it before starting another.

| Action | How |
|---|---|
| Mappool / gameplay / winner scene | `M` / `G` / `W` (nothing happens if already there) |
| Fix the match score | Left click a lineup card (mappool) or team block (gameplay): +1 · right click: −1 (never below 0) |
| Go back to the mappool without waiting for Idle | **Finish map now** in the panel (gives the point if the map hasn't been scored yet) |
| Red / blue is picking | `1` / `2` |
| A team is banning | `Q` red / `E` blue, or click its name in the header |
| Pick / ban the map | Left click it in the pool (or change the song in the lobby during a pick phase) |
| Undo any pick or ban | Right click the map in the pool |
| Cancel the current phase | `Esc` |

**Tiebreaker:** it is outside the pick/ban phases. It can only be loaded when both teams are one point from winning
(Bo9 4–4, Bo11 5–5, Bo13 6–6), either by the referee loading it in the lobby or by left clicking **TB** in the pool.
It cancels any open phase and plays the tiebreaker card across both rows: a yellow intro, then the map.
Right click TB to undo. **Test tiebreaker** in the panel previews the card.

**Team names**: they come from the lobby automatically. If they're wrong or missing, type them in the
control panel (autocompletes from players_teams.csv) and press **Apply**. **Use lobby names** switches back.

**Manual rosters (improv teams)**: open the *Manual rosters* drop-down under the team name buttons and type up to
8 osu! user ids per side, then press **Apply rosters** (or Enter). A side with ids uses them for its lineup and winner-screen
roster instead of the CSV roster. Team names still come from the lobby. **Clear** goes back to the CSV rosters.
Usernames and flags come from players_teams.csv (any registered player, whatever their team) or, for anyone else,
from the lobby: tosu reports every client's id, name and country, so they fill in as soon as the player joins.
Until then the lineup shows `#id`, and the panel lists who it's still waiting for. Lobby-learned players are remembered
across refreshes. The osu! API itself can't be used here: it doesn't allow calls from browser pages.

Picks and bans are saved per round, so they survive a browser source refresh. Use **Reset match** between matches
(click it twice: OBS can't show confirmation pop-ups).

## Troubleshooting
- **Overlay looks outdated or shows no data in OBS:** OBS caches browser sources. Open the source's properties and press
  **Refresh cache of current page**. The page also loads every file with a fresh version tag, so after one cache refresh,
  later updates show up with a normal refresh.
- **Check what tosu is reading:** open `http://127.0.0.1:24050/json/v2` while the tournament client is open.
  `beatmap`, `tourney.team`, `tourney.clients` and `tourney.chat` are what the overlay uses.
- **Open the overlay in a normal browser** at the same URL to see whether a problem is in the overlay or in OBS.
