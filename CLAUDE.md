# Ps99clanbattle

PS99 game event leaderboard tracker deployed via GitHub Pages.

## Architecture

- **Default branch**: `claude/ps99-clan-battle-tracker-5N9NW`
- **Deployment**: Feature branch → `deploy.yml` syncs to `gh-pages` → GitHub Pages serves at `https://jojoonline83.github.io/Ps99clanbattle/`
- **Subdirectories on gh-pages**: Each event gets its own subdirectory (e.g. `luckyblox/`, `luckyblox2/`)

## New Event URL Setup Pattern

When creating a new event tracker page:

1. **Create page files** in the repo root: `<page>.html`, `<page>.js`, `style.css`
2. **Create snapshot script** at `.github/scripts/snapshot-<name>.mjs` — fetches data from PS99 API, writes history JSON to the event's subdirectory
3. **Create workflow** at `.github/workflows/snapshot-taphero.yml` with `workflow_dispatch` only (NO cron schedule) — checks out `gh-pages`, runs the snapshot script, commits and pushes
4. **Update `deploy.yml`** to sync new page files to the event's subdirectory on gh-pages, and add the snapshot script + workflow to the KEEP list
5. **Push workflow + snapshot script to the default branch** so GitHub recognizes it for `workflow_dispatch`
6. **Add relay step** in the `ps99taphero` repo's `snapshot-taphero.yml` workflow to dispatch the Ps99clanbattle workflow using `github.token` (no PAT needed)

## Scheduler

- The external scheduler is a **Google Apps Script** ("Ps99taphero" project) that triggers `snapshot-taphero.yml` on the `ps99taphero` repo every 10 minutes via `workflow_dispatch`
- The ps99taphero workflow relays the dispatch to Ps99clanbattle — do NOT add cron to workflows, do NOT modify the Google Apps Script
- The relay step uses `github.token` and `gh workflow run`

## Current Events

### Lucky Blox (Clan Battle) — `luckyblox/`
- Pages: `index.html`, `players.html`, `stages.html`
- Scripts: `app.js`, `players.js`, `stages.js`
- Snapshot: `.github/scripts/snapshot.mjs` via `.github/workflows/snapshot.yml`

### Lucky Block Part 2 (League) — `luckyblox2/`
- Pages: `league.html`
- Scripts: `league.js`
- Snapshot: `.github/scripts/snapshot-league.mjs` via `.github/workflows/snapshot-taphero.yml`
- API: `/v1/leagues` endpoints (not clan battle API)
- History: `league_history.json`, `resolved_names.json` (95-minute retention)
- Discord alert: 20-minute zero-gain window for player "jojo8", uses `DISCORD_WEBHOOK` secret

### Pinata Party (Clan Battle) — `pinata/`
- Pages: `pinata.html` (tabbed: Clans + Players)
- Scripts: `pinata.js`
- Snapshot: `.github/scripts/snapshot-pinata.mjs` via `.github/workflows/snapshot-pinata.yml`
- API: `/api/` clan battle endpoints (same as Lucky Blox)
- History: `pinata/history.json`, `pinata/resolved_names.json` (95-minute retention)
- No Discord alerts configured yet

### Cyberpunk Battle (Clan Battle) — `cyberpunk/`
- Pages: `cyberpunk.html` (tabbed: Clans + Players)
- Scripts: `cyberpunk.js`
- Snapshot: `.github/scripts/snapshot-cyberpunk.mjs` via `.github/workflows/snapshot-cyberpunk.yml`
- API: `/api/` clan battle endpoints (same as Lucky Blox)
- History: `cyberpunk/history.json`, `cyberpunk/resolved_names.json` (95-minute retention)
- No Discord alerts configured yet
