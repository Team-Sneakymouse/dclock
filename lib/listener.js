import { SQL } from "bun";
import { readAmount, withTimeout } from "./amount.js";
import { createSync } from "./sync.js";

// Keeps `hub` current from LISTEN on `channel`, using Bun's SQL listen API (Bun >= 1.4.0).
//
// Bun gives listen() its own connection and, when it drops, reconnects with backoff, re-subscribes and calls
// `onlisten` again. Notifications sent while it was down are lost, so every `onlisten` reads the amount again
// (through `db`, the query pool). A notification's payload is the row's new version; when it differs from the hub's,
// the row is read. `createSync` decides when to read, runs one read at a time and retries failed reads. A read is
// published only if it started and finished while the same connection listened: one that began before a disconnect
// may be older than a page rendered meanwhile, and the read after the reconnect takes over.
//
// A half-open connection can look alive for a long time, so a watchdog sends a notification on a private
// channel through the pool now and then; if it doesn't come back on the listen connection, the listener is
// replaced. A listener that isn't listening for `listenTimeoutMs` (the subscription was never acknowledged, or
// Bun's resubscribe after a disconnect is stuck) is replaced as well.
export function createListener({
	url,
	db,
	hub,
	channel,
	queryTimeoutMs = 5_000,
	watchdogMs = 60_000,
	watchdogWaitMs = 10_000,
	retryMs = 5_000, // before starting over after the first LISTEN failed
	listenTimeoutMs = 60_000, // Bun's own reconnect backoff is 250 ms doubling to 32 s
	minBackoffMs = 1_000,
	maxBackoffMs = 30_000,
	connect = (options) => new SQL(url, options),
	log = console,
}) {
	const pingChannel = `${channel}_web_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
	let sql = null;
	let listening = false;
	let connections = 0; // counts onlisten calls, so a check can tell that the listener reconnected meanwhile
	let stopped = false;
	let restartTimer = null;
	let listenTimer = null;
	const pings = new Map(); // token -> resolve
	let watchdog = null;
	let checking = false;
	let cancelWatchdogWait = null;

	const sync = createSync({
		read() {
			const connection = connections;
			const wasListening = listening;
			return readAmount(db, queryTimeoutMs).then((row) => ({
				...row,
				// Started and finished while the same connection listened: nothing it could have missed.
				current: wasListening && listening && connection === connections,
			}));
		},
		held: () => hub.version,
		apply(row) {
			if (!row.current) return false; // the read that onlisten starts takes over
			hub.publish(row.seconds, row.version);
			hub.markLive();
			return true;
		},
		minBackoffMs,
		maxBackoffMs,
		log,
	});

	// Replaces the listener unless it is listening within `listenTimeoutMs`.
	function expectListening() {
		if (stopped || listenTimer !== null) return;
		listenTimer = setTimeout(() => {
			listenTimer = null;
			if (stopped || listening) return;
			log.error(`Database listener has not been listening for ${listenTimeoutMs} ms; replacing it`);
			replace(0);
		}, listenTimeoutMs);
	}

	async function start() {
		if (stopped) return;
		const owner = connect({
			max: 1,
			connectionTimeout: 10,
			connection: { idle_session_timeout: 0 },
			onclose(error) {
				if (owner !== sql || stopped) return;
				if (listening) log.error(`Database listener lost (${error?.message ?? "closed"}); Bun reconnects it`);
				listening = false;
				hub.invalidate();
				expectListening();
			},
		});
		sql = owner;
		expectListening();
		try {
			await owner.listen(
				channel,
				(payload) => {
					if (owner === sql) sync.notified(payload);
				},
				() => {
					if (owner !== sql || stopped) return;
					listening = true;
					connections++;
					clearTimeout(listenTimer);
					listenTimer = null;
					log.log(`Listening on ${channel}`);
					sync.requestRead();
				},
			);
			await owner.listen(pingChannel, (token) => pings.get(token)?.());
		} catch (error) {
			// The first subscription failed (e.g. the database is down at startup): start over.
			if (owner !== sql || stopped) return;
			log.error(`LISTEN failed (${error.message}); retrying in ${retryMs} ms`);
			replace(retryMs);
		}
	}

	function replace(delayMs) {
		const old = sql;
		sql = null;
		listening = false;
		hub.invalidate();
		clearTimeout(listenTimer);
		listenTimer = null;
		sync.reset(); // the new listener reads once it listens
		old?.close({ timeout: 0 }).catch(() => {});
		clearTimeout(restartTimer);
		restartTimer = setTimeout(start, delayMs);
	}

	async function check() {
		const owner = sql;
		const connection = connections;
		if (!owner || !listening) return;
		const token = crypto.randomUUID();
		const echoed = new Promise((resolve) => pings.set(token, resolve));
		try {
			await withTimeout(db.notify(pingChannel, token), queryTimeoutMs);
		} catch {
			pings.delete(token);
			return; // the pool can't reach the database either; nothing to learn about the listener
		}
		// A timer stop() can clear, so a pending check doesn't keep the process alive after shutdown.
		const waited = new Promise((resolve) => {
			const timer = setTimeout(resolve, watchdogWaitMs, false);
			cancelWatchdogWait = () => {
				clearTimeout(timer);
				resolve(false);
			};
		});
		const arrived = await Promise.race([echoed.then(() => true), waited]);
		cancelWatchdogWait?.();
		cancelWatchdogWait = null;
		pings.delete(token);
		// A reconnect meanwhile (the ping was lost with the old connection) is no reason to replace the new one.
		if (arrived || owner !== sql || stopped || !listening || connection !== connections) return;
		log.error(`Database listener missed its watchdog notification; replacing it`);
		replace(0);
	}

	return {
		get listening() {
			return listening;
		},
		start() {
			start();
			watchdog = setInterval(() => {
				if (checking) return;
				checking = true;
				check().finally(() => (checking = false));
			}, watchdogMs);
		},
		async stop() {
			stopped = true;
			listening = false;
			clearInterval(watchdog);
			clearTimeout(restartTimer);
			clearTimeout(listenTimer);
			cancelWatchdogWait?.();
			sync.stop();
			const old = sql;
			sql = null;
			await old?.close({ timeout: 0 }).catch(() => {});
		},
	};
}
