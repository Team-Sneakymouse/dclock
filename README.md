# dclock
Monica's dclock countdown robMonica

Shows the Doom Clock's seconds left at dclock.rawb.tv. The amount lives in PostgreSQL, in the single-row table
`sneakydclock.dclock` owned by the SneakyDClock plugin. It is a resource, not a clock: it changes only when someone
adjusts it, and nothing counts it down. This site only reads it:

- `/` reads the amount on every request and renders it into the page (so Discord/OG embeds are current).
  It answers 503 if the database cannot be read.
- `/events` is a Server-Sent Events stream: the current amount on connect, then every change. The server
  `LISTEN`s on the `sneakydclock` channel (SneakyDClock runs `pg_notify` on each change), reconnects with backoff,
  and reads the amount again after each reconnect. The page keeps the server-rendered value if the stream fails.

## Environment

| Variable | Required | What |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string, e.g. `postgres://user:password@host:5432/database`. The role only needs `usage` on schema `sneakydclock` and `select` on `sneakydclock.dclock`; the site never writes. |
| `PORT` | no | Port to listen on (default `80`). |

## Development

```sh
npm ci                 # .npmrc: min-release-age=7 (supply-chain quarantine)
DATABASE_URL=postgres://... PORT=8080 node app.js
```

New dependency versions published fewer than 7 days ago are refused. Emergency bypass: `npm install --min-release-age=0 <pkg>`.
