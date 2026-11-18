# dclock
Monica's dclock countdown robMonica

Shows the Doom Clock's seconds left at dclock.rawb.tv. The amount lives in PostgreSQL, in the single-row table
`sneakydclock.dclock` owned by the SneakyDClock plugin. It is a resource, not a clock: it changes only when someone
adjusts it, and nothing counts it down. This site only reads it.

It runs on [Bun](https://bun.com) (1.4.4, pinned in the Dockerfile) with no npm dependencies: `Bun.serve` for HTTP
and Server-Sent Events, Bun's built-in SQL client for queries and `LISTEN`.

- `/` reads the amount on every request and renders it into the page (so Discord/OG embeds are current), floored
  and with thousands separators. It answers 503 if the database can't be read within 5 seconds.
- `/events` is a Server-Sent Events stream: the current amount on connect, then every change, with a heartbeat
  comment every 25 seconds. The page keeps the server-rendered value if the stream fails.
- `/assets/*` serves the files in `assets/`.

## How updates reach browsers

SneakyDClock runs `pg_notify('sneakydclock', <new amount>)` on every change. The site subscribes with `sql.listen()`
(added in Bun 1.4.0). Bun keeps that subscription on its own connection and, when it drops, reconnects with backoff
(250 ms doubling to 32 s), subscribes again and calls `onlisten`, where the site reads the amount again: notifications
sent while disconnected are lost.

- **Ordering.** A notification is only a cue to read the row: PostgreSQL delivers identical payloads of one
  transaction only once (set 10, set 20, set 10 notifies 10, 20), so the payload can be stale. Every read takes a
  ticket when it starts; a result older than the last one published is dropped, so an earlier read can't roll
  browsers back past a later one.
- **Half-open connections.** Every minute the site sends a notification on a private channel through its query
  pool. If it doesn't arrive on the listen connection within 10 seconds, the listener is replaced (and reads again).
- **Slow clients.** Each SSE client holds at most one queued chunk and the newest pending value; Bun stops pulling
  a stream whose socket is full. A client that hasn't read for 60 seconds is disconnected.
- **While the listener is down**, new SSE clients get no value until it is back, so they keep the fresh value the
  page was rendered with instead of a possibly stale one.

SIGTERM ends the streams, stops the server and closes the database connections, so `docker stop` exits 0.

## Environment

| Variable | Required | What |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string, e.g. `postgres://user:password@host:5432/database`. The role only needs `usage` on schema `sneakydclock` and `select` on `sneakydclock.dclock`; the site never writes (it does `NOTIFY` on its own watchdog channel, which needs no privilege). |
| `PORT` | no | Port to listen on (default `80`). |

The app exits at startup without `DATABASE_URL`. If the database is down, it starts anyway, answers 503 and
connects once it can.

## Development

```sh
bun install            # nothing to install today; bunfig.toml refuses versions younger than 7 days
DATABASE_URL=postgres://... PORT=8080 bun app.js
```

`bunfig.toml` sets `install.minimumReleaseAge` (7 days, supply-chain quarantine). The Dockerfile copies it before
`bun install`, so it applies to image builds too. If you add a dependency, commit `bun.lock` and copy it in the
Dockerfile next to `package.json`.

## Tests

```sh
bun test               # unit tests (page rendering and escaping, publication order, backpressure)
```

The integration tests run only when both URLs are set, and only against a throwaway database:

```sh
docker run -d --name dclock-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17-alpine
docker exec -i dclock-test-pg psql -U postgres <<'SQL'
create schema sneakydclock;
create table sneakydclock.dclock (id boolean primary key default true check (id), amount double precision not null check (amount >= 0));
insert into sneakydclock.dclock (amount) values (0);
create role dclock_web login password 'web';
grant usage on schema sneakydclock to dclock_web;
grant select on sneakydclock.dclock to dclock_web;
SQL
TEST_DATABASE_URL=postgres://dclock_web:web@127.0.0.1:55432/postgres \
TEST_ADMIN_URL=postgres://postgres:test@127.0.0.1:55432/postgres bun test
```

They connect the app through a local TCP proxy so they can freeze connections, and cover: the rendered page,
SSE updates, a change made while the site's connections were killed, the watchdog replacing a frozen listen
connection, and 503 within the timeout while the database hangs, with recovery after.
