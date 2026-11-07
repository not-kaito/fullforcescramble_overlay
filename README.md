# Full Force Scramble – stream overlay

## Requirements
Run **tosu** next to the osu! tournament client. tosu reads everything below straight from the
client's memory.

## OBS setup
Browser source → **URL** (leave *Local file* unchecked): `http://127.0.0.1:24050/fullforcescramble_overlay/mappool/index.html`
- If *Local file* is checked, the page sends itself to the URL above. This only works when tosu is running and the folder
  sits inside tosu's `static` folder.
- Width **2400**, height **1080**. Crop **480 px off the right** (Alt+drag or a Crop filter), or align left side at 0px:
  the control panel sits there, so you only see it in **Interact**.
- (Do the math if you stream 720p sorry LOL)


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
`ezMultiplier` × their score (2×, on top of the game's own 0.5×).
The clients themselves still show the game's own scores.

A map that isn't in the pool (e.g. a warmup), or a tie, gives no point.
The match score belongs to the overlay (the tournament client's stars are ignored), so fix it by clicking the lineup cards.

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

**Ban order** is always A B B A, where A is whichever team you start the first ban phase for (one-ban rounds: just A B).
After each ban, the next team's ban phase starts by itself; after the last ban, the phase goes back to idle.
If you press Esc partway through, starting a ban phase again picks the order back up.

**Team names**: they come from the lobby automatically. If they're wrong or missing, type them in the
control panel (autocompletes from players_teams.csv) and press **Apply**. **Use lobby names** switches back.

Use **Reset match** between matches (click it twice).

## Troubleshooting
- **Overlay looks outdated or shows no data in OBS:** OBS caches browser sources. Open the source's properties and press
  **Refresh cache of current page**. The page also loads every file with a fresh version tag, so after one cache refresh,
  later updates show up with a normal refresh.
- **Check what tosu is reading:** open `http://127.0.0.1:24050/json/v2` while the tournament client is open.
  `beatmap`, `tourney.team`, `tourney.clients` and `tourney.chat` are what the overlay uses.
- **Open the overlay in a normal browser** at the same URL to see whether a problem is in the overlay or in OBS.
