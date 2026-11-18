import { SQL } from "bun";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { format, readAmount } from "./lib/amount.js";
import { createHub } from "./lib/hub.js";
import { createListener } from "./lib/listener.js";
import { renderPage } from "./lib/page.js";

// SneakyDClock owns the amount (a single row) and runs pg_notify(CHANNEL, <new version>) on every change.
// This site only reads it, so its role needs nothing beyond select on that table.
const CHANNEL = "sneakydclock";
const HEARTBEAT_MS = 25_000;
const CSP = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;";

export function startApp({
	databaseUrl,
	port = 80,
	assetsDir = join(import.meta.dir, "assets"),
	queryTimeoutMs = 5_000,
	heartbeatMs = HEARTBEAT_MS,
	stallMs = 60_000,
	watchdogMs = 60_000,
	watchdogWaitMs = 10_000,
	maxPendingReads = 32,
	log = console,
}) {
	const db = new SQL(databaseUrl, { max: 4, connectionTimeout: 5, idleTimeout: 30 });
	const hub = createHub({ stallMs, log });
	const listener = createListener({ url: databaseUrl, db, hub, channel: CHANNEL, queryTimeoutMs, watchdogMs, watchdogWaitMs, log });
	listener.start();
	const heartbeat = setInterval(() => hub.heartbeat(), heartbeatMs);

	// Only the files present at startup are served, by exact name, so no request path reaches the filesystem.
	const assets = {};
	for (const name of readdirSync(assetsDir)) {
		assets[`/assets/${name}`] = new Response(Bun.file(join(assetsDir, name)), {
			headers: { "Content-Security-Policy": CSP, "Cache-Control": "public, max-age=3600" },
		});
	}

	let pendingReads = 0;

	async function page() {
		// Read on each request so embeds always carry the current amount. While the database hangs, reads pile
		// up until they time out; past `maxPendingReads` answer 503 at once instead of queueing more.
		if (pendingReads >= maxPendingReads) return unavailable();
		pendingReads++;
		try {
			const row = await readAmount(db, queryTimeoutMs);
			const html = renderPage(format(row.seconds), row.version);
			return new Response(html, { headers: headers({ "Content-Type": "text/html; charset=utf-8" }) });
		} catch (error) {
			log.error(`Failed to load the amount: ${error.message}`);
			return unavailable();
		} finally {
			pendingReads--;
		}
	}

	function events(request, server) {
		server.timeout(request, 0); // the stream is idle between changes; heartbeats and the stall check cover it
		return new Response(hub.stream(), {
			headers: headers({
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				"X-Accel-Buffering": "no",
			}),
		});
	}

	const server = Bun.serve({
		port,
		routes: {
			...assets,
			"/": { GET: page },
			"/events": { GET: events },
		},
		fetch() {
			return new Response("Not Found", { status: 404, headers: headers({ "Content-Type": "text/plain" }) });
		},
		error(error) {
			log.error(error);
			return new Response("Internal Server Error", { status: 500, headers: headers({ "Content-Type": "text/plain" }) });
		},
	});
	log.log(`Server started on port ${server.port}`);

	let stopping = null;
	return {
		server,
		hub,
		listener,
		stop() {
			stopping ??= (async () => {
				clearInterval(heartbeat);
				hub.closeAll(); // ends each SSE response properly; browsers reconnect to the next instance
				// Let responses in flight finish, but don't wait on idle keep-alive connections for long.
				await Promise.race([server.stop(), Bun.sleep(1_000)]);
				server.stop(true);
				await listener.stop();
				await db.close({ timeout: 1 }).catch(() => {});
			})();
			return stopping;
		},
	};
}

function headers(extra) {
	return { "Content-Security-Policy": CSP, ...extra };
}

function unavailable() {
	return new Response("Countdown temporarily unavailable", {
		status: 503,
		headers: headers({ "Content-Type": "text/plain; charset=utf-8", "Retry-After": "5" }),
	});
}

if (import.meta.main) {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		console.error("DATABASE_URL is not set");
		process.exit(1);
	}
	const app = startApp({ databaseUrl, port: Number(process.env.PORT) || 80 });
	const shutdown = () => app.stop().finally(() => process.exit(0));
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
