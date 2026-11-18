import { afterEach, describe, expect, test } from "bun:test";
import { createHub } from "../lib/hub.js";
import { createListener } from "../lib/listener.js";

const CHANNEL = "sneakydclock";

// Stand-ins for Bun's SQL: `connect` makes listen connections the test can drop and resubscribe by hand, `db` is the
// query pool (reads the row, sends watchdog pings to the newest listen connection).
function setup({ ack = true, failReads = 0, echo = () => true, ...options } = {}) {
	const state = { amount: 100, version: 1, reads: 0, failReads, connections: [], logs: [] };
	const connect = (connectOptions) => {
		const conn = {
			closed: false,
			subscriptions: new Map(),
			onlisten: null,
			listen(channel, onNotify, onlisten) {
				conn.subscriptions.set(channel, onNotify);
				if (channel === CHANNEL) conn.onlisten = onlisten;
				if (!ack) return new Promise(() => {}); // the subscription is never acknowledged
				queueMicrotask(() => onlisten?.());
				return Promise.resolve();
			},
			close() {
				conn.closed = true;
				return Promise.resolve();
			},
			drop: (error) => connectOptions.onclose(error), // Bun lost the connection and reconnects
			resubscribed: () => conn.onlisten(),
			notify: (payload) => conn.subscriptions.get(CHANNEL)(payload),
		};
		state.connections.push(conn);
		return conn;
	};
	const db = () => {
		state.reads++;
		if (state.failReads > 0) {
			state.failReads--;
			return Promise.reject(new Error("connection refused"));
		}
		return Promise.resolve([{ amount: state.amount, version: String(state.version) }]);
	};
	db.notify = (channel, token) => {
		const conn = state.connections.at(-1);
		if (echo(conn)) queueMicrotask(() => conn.subscriptions.get(channel)?.(token));
		return Promise.resolve();
	};
	const log = { log: (m) => state.logs.push(String(m)), error: (m) => state.logs.push(String(m)) };
	state.hub = createHub({ log });
	state.listener = createListener({ url: "postgres://test", db, hub: state.hub, channel: CHANNEL, connect, log, ...options });
	state.listener.start();
	return state;
}

async function until(condition, timeoutMs = 2_000) {
	const end = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(5);
	}
}

let s;
afterEach(async () => {
	await s?.listener.stop();
	s = null;
});

describe("listener", () => {
	test("a LISTEN that is never acknowledged is replaced after listenTimeoutMs", async () => {
		s = setup({ ack: false, listenTimeoutMs: 50 });
		await until(() => s.connections.length >= 2);
		expect(s.connections[0].closed).toBe(true);
		expect(s.logs).toContain("Database listener has not been listening for 50 ms; replacing it");
	});

	test("a resubscribe after a disconnect that never completes is replaced too", async () => {
		s = setup({ listenTimeoutMs: 50 });
		await until(() => s.listener.listening);
		s.connections[0].drop(new Error("reset"));
		expect(s.listener.listening).toBe(false);
		await until(() => s.connections.length === 2 && s.listener.listening);
		expect(s.connections[0].closed).toBe(true);
	});

	test("a listener that resubscribes in time is kept", async () => {
		s = setup({ listenTimeoutMs: 50 });
		await until(() => s.listener.listening);
		s.connections[0].drop(new Error("reset"));
		s.connections[0].resubscribed();
		await Bun.sleep(100);
		expect(s.connections.length).toBe(1);
	});

	test("the watchdog doesn't replace a listener that reconnected while it waited for its ping", async () => {
		let pings = 0;
		s = setup({
			watchdogMs: 20,
			watchdogWaitMs: 60,
			echo(conn) {
				if (++pings > 1) return true;
				// The first ping is lost with the old connection; Bun reconnects before the check ends.
				queueMicrotask(() => {
					conn.drop(new Error("reset"));
					conn.resubscribed();
				});
				return false;
			},
		});
		await until(() => pings >= 3);
		expect(s.connections.length).toBe(1);
		expect(s.logs.some((m) => m.includes("missed its watchdog notification"))).toBe(false);
	});

	test("the watchdog replaces a listener whose ping never arrives", async () => {
		s = setup({ watchdogMs: 20, watchdogWaitMs: 30, echo: () => false });
		await until(() => s.connections.length >= 2);
		expect(s.logs.some((m) => m.includes("missed its watchdog notification"))).toBe(true);
	});

	test("a failed read after a notification is retried until it succeeds", async () => {
		s = setup({ minBackoffMs: 10 });
		await until(() => s.hub.live);
		expect(s.hub.latest).toBe(100);
		s.amount = 50;
		s.version = 2;
		s.failReads = 3;
		s.connections[0].notify("2");
		await until(() => s.hub.latest === 50);
		expect(s.logs.filter((m) => m.startsWith("Failed to read the amount")).length).toBe(3);
	});

	test("stop leaves no retry timer that reads", async () => {
		s = setup({ minBackoffMs: 10, failReads: 1_000 });
		await until(() => s.reads >= 2);
		await s.listener.stop();
		expect(s.listener.listening).toBe(false);
		const reads = s.reads;
		await Bun.sleep(100);
		expect(s.reads).toBe(reads);
	});
});
