# FlySmart Backend

The API + polling engine for FlySmart — a personal flight-price monitoring app. Node.js + Express + TypeScript + Mongoose (MongoDB Atlas), SerpApi (Google Flights) for fare data, Telegram for notifications.

See [`../MASTER_SPEC.md`](../MASTER_SPEC.md) for the full product spec.

## Development

```sh
bun install
cp .env.example .env   # fill in MONGODB_URI, SERPAPI_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
bun run dev
```

Runs on `http://localhost:3001` by default.

## Scripts

- `bun run build` — typecheck + compile to `dist/`
- `node dist/scripts/poll.js` — run one poll cycle against all due active trips (Section 3.3, 10.4)
- `node dist/scripts/backup.js` — export all collections to JSON (Section 13.5)

## Scheduled jobs (GitHub Actions)

- `.github/workflows/poll.yml` — daily at 03:00 UTC
- `.github/workflows/backup.yml` — weekly, Sundays 04:00 UTC. Requires `BACKUP_REPO` and `BACKUP_REPO_TOKEN` secrets pointing at a **private** repo — this repo is public, so backups must never be committed here.
