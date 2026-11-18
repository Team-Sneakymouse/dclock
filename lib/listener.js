import { SQL } from "bun";
import { readSeconds, toSeconds, withTimeout } from "./amount.js";

// Keeps `hub` current from LISTEN on `channel`, using Bun's SQL listen API (Bun >= 1.4.0).
//
// Bun gives listen() its own connection and, when it drops, reconnects with backoff, re-subscribes and calls
// `onlisten` again. Notifications sent while it was down are lost, so every `onlisten` reads the amount again
// (through `db`, the query pool), with a hub ticket so a newer notification wins over that read.
//
// A half-open connection can look alive for a long time, so a watchdog sends a notification on a private
// channel through the pool now and then; if it doesn't come back on the listen connection, the listener is
// replaced.
export function createListener({
	url,
	db,
	hub,
	channel,
	queryTimeoutMs = 5_000,
	watchdogMs = 60_000,
	watchdogWaitMs = 10_000,
	retryMs = 5_000,
	log = console,
}) {
	const pingChannel = `${channel}_web_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
	let sql = null;
	let listening = false;
	let stopped = false;
	let refreshTimer = null;
	let restartTimer = null;
	const pings = new Map(); // token -> resolve
	let watchdog = null;
	let checking = false;

	function refresh(owner) {
		clearTimeout(refreshTimer);
		const ticket = hub.ticket();
		readSeconds(db, queryTimeoutMs).then(
			(seconds) => {
				if (owner === sql) hub.publish(seconds, ticket);
			},
			(error) => {
				if (stopped || owner !== sql) return;
				log.error(`Failed to read the amount after LISTEN: ${error.message}; retrying in ${retryMs} ms`);
				refreshTimer = setTimeout(() => {
					if (!hub.live && owner === sql && listening) refresh(owner);
				}, retryMs);
			},
		);
	}

	function onNotify(owner, payload) {
		if (owner !== sql) return;
		let seconds;
		try {
			seconds = toSeconds(payload);
		} catch (error) {
			log.error(`Ignoring notification: ${error.message}`);
			refresh(owner);
			return;
		}
		hub.publish(seconds, hub.ticket());
	}

	async function start() {
		if (stopped) return;
		const owner = new SQL(url, {
			max: 1,
			connectionTimeout: 10,
			connection: { idle_session_timeout: 0 },
			onclose(error) {
				if (owner !== sql || stopped) return;
				if (listening) log.error(`Database listener lost (${error?.message ?? "closed"}); Bun reconnects it`);
				listening = false;
				hub.invalidate();
			},
		});
		sql = owner;
		try {
			await owner.listen(channel, (payload) => onNotify(owner, payload), () => {
				if (owner !== sql) return;
				listening = true;
				log.log(`Listening on ${channel}`);
				refresh(owner);
			});
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
		old?.close({ timeout: 0 }).catch(() => {});
		clearTimeout(restartTimer);
		restartTimer = setTimeout(start, delayMs);
	}

	async function check() {
		const owner = sql;
		if (!owner || !listening) return;
		const token = crypto.randomUUID();
		const echoed = new Promise((resolve) => pings.set(token, resolve));
		try {
			await withTimeout(db.notify(pingChannel, token), queryTimeoutMs);
		} catch {
			pings.delete(token);
			return; // the pool can't reach the database either; nothing to learn about the listener
		}
		const arrived = await Promise.race([echoed.then(() => true), Bun.sleep(watchdogWaitMs).then(() => false)]);
		pings.delete(token);
		if (arrived || owner !== sql || stopped || !listening) return;
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
			clearInterval(watchdog);
			clearTimeout(refreshTimer);
			clearTimeout(restartTimer);
			await sql?.close({ timeout: 0 }).catch(() => {});
		},
	};
}

