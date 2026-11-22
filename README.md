<p align="center">
  <img src="../flySmart.png" alt="FlySmart" width="120" />
</p>

# FlySmart Backend

The brain of [FlySmart](../README.md) — a self-hosted flight-price intelligence system. This is the API and polling engine: it watches your trip watchlist, queries live fare data on a schedule, and remembers **every price it has ever seen**, forever.

Node.js · Express · TypeScript · Mongoose (MongoDB Atlas) · SerpApi (Google Flights) for fare data · Telegram for notifications.

## Why this backend is worth a look

- **Append-only observation store.** Every poll writes immutable price observations keyed by `routeKey`, not by trip — so history compounds across years, not just within a single trip's lifetime. Nothing is ever overwritten or silently discarded ([`models/Observation.ts`](./src/models/Observation.ts)).
- **A poller that never dies mid-run.** Per-trip try/catch isolates provider failures — one bad API call is logged and skipped, the rest of the batch completes ([`services/pollService.ts`](./src/services/pollService.ts)).
- **Explainable notification triggers, not a black box.** New low, budget crossed, route-historic low, genuine price spike, closing travel window — each with a dedupe key so you're never spammed twice for the same fact ([`services/notificationService.ts`](./src/services/notificationService.ts)).
- **Quota-aware by design.** Polling cadence throttles itself against the monthly SerpApi budget, deprioritizing low-priority trips before a run ever fails ([`config/quotas.ts`](./src/config/quotas.ts)).
- **Runs on free tiers.** MongoDB Atlas free cluster, SerpApi's free 250 searches/month, GitHub Actions cron for scheduling, Telegram for delivery — no server to keep alive, no bill that grows with usage.

See [`../MASTER_SPEC.md`](../MASTER_SPEC.md) for the complete product spec — data models (§8), polling strategy (§10), and notification rules (§11) are all documented in detail there.

## Prerequisites

- [Bun](https://bun.sh) 1.x — this project uses Bun as both package manager and dev runtime (`bun --watch`).
- A [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) cluster — the free M0 tier is enough. Create a database user and grab the connection string.
- A [SerpApi](https://serpapi.com) account for the Google Flights API — the free tier gives ~250 searches/month, which is what the polling cadence (§10.4) is budgeted against.
- A Telegram bot for notifications — message [@BotFather](https://t.me/BotFather) to create one and get a bot token, then message your new bot and hit `https://api.telegram.org/bot<token>/getUpdates` to find your chat ID. Not required to run the API itself, only for Phase 2+ (notifications).
- *(Optional)* A [Duffel](https://duffel.com) account in "Personal Use" live mode, as a fallback data source when SerpApi fails or is rate-limited (§10.2). Not required for Phase 1.

## Development

```sh
bun install
cp .env.example .env   # fill in the values below
bun run dev
```

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | Yes | Atlas connection string |
| `SERPAPI_KEY` | Yes | Primary flight data source |
| `DUFFEL_API_KEY` | No | Fallback data source (§10.2) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | No | Needed only for notifications (Phase 2+) |
| `PORT` | No | Defaults to `3001` |

Runs on `http://localhost:3001` by default.

## API surface

- `src/api/trips.ts` — trip CRUD, lifecycle transitions (active/booked/archived/expired)
- `src/api/observations.ts` — trend reads, trip- and route-scoped historical stats
- `src/api/settings.ts` — Telegram config, quiet hours, live API-usage panel

## Scripts

- `bun run build` — typecheck + compile to `dist/`
- `node dist/scripts/poll.js` — run one poll cycle against all due active trips (Section 3.3, 10.4)
- `node dist/scripts/backup.js` — export all collections to JSON (Section 13.5)

## Scheduled jobs (GitHub Actions)

- `.github/workflows/poll.yml` — daily at 03:00 UTC
- `.github/workflows/backup.yml` — weekly, Sundays 04:00 UTC. Requires `BACKUP_REPO` and `BACKUP_REPO_TOKEN` secrets pointing at a **private** repo — this repo is public, so backups must never be committed here.
