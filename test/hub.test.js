import { describe, expect, test } from "bun:test";
import { createHub } from "../lib/hub.js";

const decoder = new TextDecoder();

// Reads what a client has received so far, without waiting for more. A read that is still waiting when it
// returns stays pending (and takes the next chunk), so a "stalled" client must not have been drained.
const pendingReads = new WeakMap();
async function drain(reader) {
	let text = "";
	for (;;) {
		if (!pendingReads.has(reader)) pendingReads.set(reader, reader.read());
		const result = await Promise.race([pendingReads.get(reader), Bun.sleep(20).then(() => null)]);
		if (!result) return text;
		pendingReads.delete(reader);
		if (result.done) return text;
		text += decoder.decode(result.value);
	}
}

const events = (text) => [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]));
const data = (text) => events(text).map((event) => event.amount);

describe("publication", () => {
	test("every value goes out with its version, a lower one too", async () => {
		const hub = createHub();
		const reader = hub.stream().getReader();
		await drain(reader);
		hub.publish(30, 3);
		expect(await drain(reader)).toBe('data: {"amount":30,"version":3}\n\n');
		hub.publish(10, 1); // the database went backwards; browsers decide what to show
		expect(events(await drain(reader))).toEqual([{ amount: 10, version: 1 }]);
		expect(hub.latest).toBe(10);
		expect(hub.version).toBe(1);
	});

	test("nothing is published before the first value", () => {
		const hub = createHub();
		expect(hub.latest).toBe(null);
		expect(hub.version).toBe(-1);
	});

	test("live only between markLive and invalidate; values still go out while not live", async () => {
		const hub = createHub();
		const reader = hub.stream().getReader();
		hub.publish(1, 1);
		expect(hub.live).toBe(false);
		expect(data(await drain(reader))).toEqual([1]);
		hub.markLive();
		expect(hub.live).toBe(true);
		hub.invalidate();
		expect(hub.live).toBe(false);
		hub.publish(3, 2);
		expect(data(await drain(reader))).toEqual([3]);
	});
});

describe("clients", () => {
	test("get the latest value on connect only while it is current", async () => {
		const hub = createHub();
		hub.publish(42, 1);
		hub.markLive();
		const live = hub.stream().getReader();
		expect(await drain(live)).toBe('retry: 5000\n\ndata: {"amount":42,"version":1}\n\n');

		hub.invalidate();
		const stale = hub.stream().getReader();
		expect(data(await drain(stale))).toEqual([]); // keeps its server-rendered value

		hub.publish(43, 2);
		expect(data(await drain(stale))).toEqual([43]);
		expect(data(await drain(live))).toEqual([43]);
	});

	test("each version is sent once, and a repeated version isn't sent again", async () => {
		const hub = createHub();
		const reader = hub.stream().getReader();
		let version = 0;
		let received = "";
		for (const value of [1, 2, 2, 3]) {
			hub.publish(value, ++version);
			received += await drain(reader);
		}
		expect(events(received)).toEqual([1, 2, 2, 3].map((amount, i) => ({ amount, version: i + 1 })));
		hub.publish(3, version);
		expect(data(await drain(reader))).toEqual([]);
	});

	test("a client that stops reading holds one chunk and the newest value, then catches up", async () => {
		const hub = createHub();
		const stream = hub.stream(); // holds "retry: 5000", the one chunk it may queue, unread
		for (let value = 1; value <= 10_000; value++) hub.publish(value, value);
		hub.heartbeat();
		expect(await drain(stream.getReader())).toBe('retry: 5000\n\ndata: {"amount":10000,"version":10000}\n\n');
	});

	test("a version equal to what the client last got cancels its pending one", async () => {
		const hub = createHub();
		const stream = hub.stream(); // "retry" fills the queue; the client isn't reading
		hub.publish(5, 1); // pending
		hub.publish(7, 2); // replaces it
		const reader = stream.getReader();
		expect(decoder.decode((await reader.read()).value)).toBe("retry: 5000\n\n");
		expect(decoder.decode((await reader.read()).value)).toBe('data: {"amount":7,"version":2}\n\n'); // the client has 2
		hub.publish(9, 3); // queued
		hub.publish(8, 4); // pending
		hub.publish(9, 3); // read again: the client will have 3, which is current, so nothing is pending
		expect(data(await drain(reader))).toEqual([9]);
	});

	test("a stalled client is disconnected after stallMs", async () => {
		let time = 0;
		const hub = createHub({ stallMs: 60_000, now: () => time, log: { log() {} } });
		const reader = hub.stream().getReader(); // never read
		hub.heartbeat();
		time = 59_999;
		hub.heartbeat();
		expect(hub.size).toBe(1);
		time = 60_000;
		hub.heartbeat();
		expect(hub.size).toBe(0);
		expect(reader.read()).rejects.toThrow("client stopped reading");
	});

	test("a client that disconnects is removed", async () => {
		const hub = createHub();
		const reader = hub.stream().getReader();
		await reader.cancel();
		expect(hub.size).toBe(0);
	});

	test("closeAll ends every stream", async () => {
		const hub = createHub();
		const reader = hub.stream().getReader();
		await drain(reader);
		hub.closeAll();
		expect(hub.size).toBe(0);
		expect((await reader.read()).done).toBe(true);
	});
});
