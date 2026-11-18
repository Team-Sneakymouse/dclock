// Runs against a throwaway PostgreSQL only. Set both URLs to enable it:
//   TEST_DATABASE_URL  the site's role (select on sneakydclock.dclock only)
//   TEST_ADMIN_URL     a role that may update the table and end the site's connections (stands in for SneakyDClock:
//                      every change raises the version and notifies it, as sneakydclock.adjust does)
// The app connects through a local TCP proxy, so the tests can freeze a connection (like a paused database or a
// dead network path) without touching the database container. See README ("Tests").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { startApp } from "../app.js";

const appUrl = process.env.TEST_DATABASE_URL;
const adminUrl = process.env.TEST_ADMIN_URL;

// Forwards TCP to the database. A frozen connection holds its data in both directions until it is thawed.
function startProxy({ hostname, port }) {
	const connections = [];
	let freezeNew = false;
	const forward = (conn, to, chunk) => (conn.frozen ? conn.held.push([to, chunk]) : conn[to]?.write(chunk));
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(client) {
				const conn = { client, upstream: null, held: [], frozen: freezeNew, listen: false, closed: false };
				client.data = conn;
				connections.push(conn);
				Bun.connect({
					hostname,
					port: Number(port),
					socket: {
						open(upstream) {
							conn.upstream = upstream;
							for (const [to, chunk] of conn.held.splice(0)) {
								if (conn.frozen) conn.held.push([to, chunk]);
								else conn[to].write(chunk);
							}
						},
						data(_, chunk) {
							forward(conn, "client", chunk);
						},
						close() {
							conn.closed = true;
							client.end();
						},
						error() {},
					},
				}).catch(() => client.end());
			},
			data(client, chunk) {
				const conn = client.data;
				if (Buffer.from(chunk).includes('LISTEN "sneakydclock"')) conn.listen = true;
				if (!conn.upstream) conn.held.push(["upstream", chunk]);
				else forward(conn, "upstream", chunk);
			},
			close(client) {
				client.data.closed = true;
				client.data.upstream?.end();
			},
			error() {},
		},
	});
	const thaw = (conn) => {
		conn.frozen = false;
		for (const [to, chunk] of conn.held.splice(0)) conn[to]?.write(chunk);
	};
	return {
		port: server.port,
		listenConnection: () => connections.findLast((c) => c.listen && !c.closed),
		freeze: (conn) => (conn.frozen = true),
		freezeAll() {
			freezeNew = true;
			for (const conn of connections) conn.frozen = true;
		},
		thawAll() {
			freezeNew = false;
			for (const conn of connections) thaw(conn);
		},
		stop: () => server.stop(true),
	};
}

class Events {
	constructor(url) {
		this.values = [];
		this.versions = [];
		this.controller = new AbortController();
		this.done = fetch(url, { signal: this.controller.signal })
			.then(async (response) => {
				const decoder = new TextDecoder();
				let buffer = "";
				for await (const chunk of response.body) {
					buffer += decoder.decode(chunk);
					const end = buffer.lastIndexOf("\n\n") + 2;
					for (const match of buffer.slice(0, end).matchAll(/^data: (.*)$/gm)) {
						const event = JSON.parse(match[1]);
						this.values.push(event.amount);
						this.versions.push(event.version);
					}
					buffer = buffer.slice(end);
				}
			})
			.catch(() => {});
	}
	async until(value, timeoutMs = 10_000) {
		const end = Date.now() + timeoutMs;
		while (this.values.at(-1) !== value) {
			if (Date.now() > end) throw new Error(`timed out waiting for ${value}; got ${JSON.stringify(this.values)}`);
			await Bun.sleep(25);
		}
	}
	close() {
		this.controller.abort();
		return this.done;
	}
}

describe.skipIf(!appUrl || !adminUrl)("against PostgreSQL", () => {
	let admin, proxy, app, base;
	const logs = [];
	const log = { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };
	const role = appUrl && decodeURIComponent(new URL(appUrl).username);
	const set = (amount) =>
		admin`update sneakydclock.dclock set amount = ${amount}, version = version + 1 returning pg_notify('sneakydclock', version::text)`;

	beforeAll(async () => {
		admin = new SQL(adminUrl, { max: 1 });
		await admin`update sneakydclock.dclock set amount = 1234567.8, version = version + 1`;
		const target = new URL(appUrl);
		proxy = startProxy(target);
		target.hostname = "127.0.0.1";
		target.port = String(proxy.port);
		app = startApp({
			databaseUrl: target.href,
			port: 0,
			queryTimeoutMs: 1_000,
			watchdogMs: 1_000,
			watchdogWaitMs: 2_000,
			log,
		});
		base = `http://127.0.0.1:${app.server.port}`;
		const deadline = Date.now() + 10_000;
		while (!app.hub.live && Date.now() < deadline) await Bun.sleep(25);
	});

	afterAll(async () => {
		await app?.stop();
		proxy?.stop();
		await admin?.close();
	});

	test("the page carries the current amount", async () => {
		const response = await fetch(base);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('content="1,234,567 seconds left~"');
		expect(html).toMatch(/<div id="clock" data-version="\d+">1,234,567<\/div>/);
	});

	test("SSE sends the amount on connect and every change", async () => {
		const events = new Events(`${base}/events`);
		await events.until(1234567);
		await set(5000.5);
		await events.until(5000);
		await set(4000);
		await events.until(4000);
		expect(events.values).toEqual([1234567, 5000, 4000]);
		await events.close();
		await Bun.sleep(50);
		expect(app.hub.size).toBe(0);
	});

	test("the amount always comes from the row; a payload that is no version still means changed", async () => {
		const events = new Events(`${base}/events`);
		await events.until(4000);
		await admin`update sneakydclock.dclock set amount = 3000, version = version + 1 returning pg_notify('sneakydclock', '99.5')`;
		await events.until(3000);
		expect(events.values).not.toContain(99);
		await set(4000); // the next test starts from 4000
		await events.until(4000);
		await events.close();
	});

	test("after its connections are killed, a change made meanwhile still arrives", async () => {
		const events = new Events(`${base}/events`);
		await events.until(4000);
		// Back to back, well before Bun's first reconnect attempt (250 ms).
		await admin`select pg_terminate_backend(pid) from pg_stat_activity where usename = ${role}`;
		await admin`update sneakydclock.dclock set amount = 3333, version = version + 1`; // no notification
		await events.until(3333);
		await set(3000);
		await events.until(3000);
		await events.close();
	});

	test("a half-open listen connection is replaced by the watchdog", async () => {
		const events = new Events(`${base}/events`);
		await events.until(3000);
		const missed = () => logs.filter((m) => m.includes("missed its watchdog notification")).length;
		const before = missed();
		proxy.freeze(proxy.listenConnection());
		await set(2000); // never reaches the frozen listener
		await events.until(2000, 15_000);
		expect(missed()).toBe(before + 1);
		await set(1000);
		await events.until(1000);
		await events.close();
	});

	test("while the database hangs, the page answers 503 within the query timeout, then recovers", async () => {
		const events = new Events(`${base}/events`);
		await events.until(1000);
		proxy.freezeAll();
		const started = performance.now();
		const response = await fetch(base);
		expect(response.status).toBe(503);
		expect(performance.now() - started).toBeLessThan(2_000);
		await set(999); // while frozen: the notification is held back until the thaw
		proxy.thawAll();
		expect((await fetch(base)).status).toBe(200);
		await events.until(999);
		await events.close();
	});

	test("a restored row with a lower version is published with a warning, and the page renders it", async () => {
		const events = new Events(`${base}/events`);
		await events.until(999);
		expect(events.versions.at(-1)).toBeGreaterThan(1);
		// What a restore from an older backup leaves behind, followed by someone's adjust.
		await admin`update sneakydclock.dclock set amount = 777, version = 1 returning pg_notify('sneakydclock', version::text)`;
		await events.until(777);
		expect(events.versions.at(-1)).toBe(1);
		expect(logs.filter((m) => m.includes("version went back from")).length).toBe(1);
		expect(await (await fetch(base)).text()).toContain('<div id="clock" data-version="1">777</div>');
		await set(888);
		await events.until(888);
		expect(events.versions.at(-1)).toBe(2);
		expect(logs.filter((m) => m.includes("version went back from")).length).toBe(1);
		await events.close();
	});

});
