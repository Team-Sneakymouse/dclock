import { beforeEach, describe, expect, test } from "bun:test";
import { createSync } from "../lib/sync.js";

// A sync whose reads and retries the test completes and runs by hand.
function setup() {
	const state = { version: -1, amount: null, reads: [], retries: [], errors: [] };
	state.sync = createSync({
		read() {
			const read = Promise.withResolvers();
			state.reads.push(read);
			return read.promise;
		},
		held: () => state.version,
		apply(row) {
			if (row.version <= state.version) return;
			state.version = row.version;
			state.amount = row.seconds;
		},
		schedule(delayMs, run) {
			const retry = { delayMs, run };
			state.retries.push(retry);
			return () => state.retries.splice(state.retries.indexOf(retry), 1);
		},
		log: { error: (message) => state.errors.push(message) },
	});
	const settle = () => Bun.sleep(0);
	state.complete = async (seconds, version) => {
		state.reads.shift().resolve({ seconds, version });
		await settle();
	};
	state.fail = async () => {
		state.reads.shift().reject(new Error("connection refused"));
		await settle();
	};
	state.runRetry = () => {
		const retry = state.retries.shift();
		retry.run();
		return retry.delayMs;
	};
	return state;
}

describe("sync", () => {
	let s;
	beforeEach(() => {
		s = setup();
	});

	test("a notification for a newer version reads the row; one already held doesn't", async () => {
		s.sync.notified("1");
		expect(s.reads.length).toBe(1);
		await s.complete(5, 1);
		expect(s.amount).toBe(5);
		s.sync.notified("1");
		s.sync.notified("0");
		expect(s.reads.length).toBe(0);
	});

	test("at most one read runs, plus one follow-up for everything that arrived meanwhile", async () => {
		s.sync.notified("1");
		s.sync.notified("2");
		s.sync.notified("3");
		expect(s.reads.length).toBe(1);
		await s.complete(1, 1); // started before 2 and 3 were committed
		expect(s.reads.length).toBe(1); // the follow-up
		await s.complete(3, 3);
		expect(s.reads.length).toBe(0);
		expect(s.amount).toBe(3);
	});

	test("no follow-up when the running read already saw every notified version", async () => {
		s.sync.notified("1");
		s.sync.notified("2"); // committed before the read ran
		await s.complete(2, 2);
		expect(s.reads.length).toBe(0);
	});

	test("a payload that is no version still means changed, even while a read runs", async () => {
		s.sync.requestRead();
		s.sync.notified("changed");
		await s.complete(1, 1); // started before the notification
		expect(s.reads.length).toBe(1);
		await s.complete(2, 2);
		expect(s.amount).toBe(2);
	});

	test("a failed read after a notification is retried with backoff until one succeeds", async () => {
		s.sync.notified("1");
		await s.fail();
		expect(s.retries.length).toBe(1);
		s.sync.notified("2"); // waits for the retry instead of reading at once
		expect(s.reads.length).toBe(0);

		const delays = [];
		for (let i = 0; i < 7; i++) {
			delays.push(s.runRetry());
			await s.fail();
		}
		delays.push(s.runRetry());
		await s.complete(9, 2);
		expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
		expect(s.amount).toBe(9);
		expect(s.reads.length).toBe(0);
		expect(s.retries.length).toBe(0);

		s.sync.notified("3"); // a success resets the delay
		await s.fail();
		expect(s.retries.map((retry) => retry.delayMs)).toEqual([1_000]);
	});

	test("a failed read after a reconnect is retried too", async () => {
		s.sync.requestRead();
		await s.fail();
		s.runRetry();
		await s.complete(4, 7);
		expect(s.amount).toBe(4);
		expect(s.reads.length).toBe(0);
	});

	test("a notified version the row never reaches is logged, not polled", async () => {
		s.sync.notified("99");
		await s.complete(1, 1);
		expect(s.reads.length).toBe(0);
		expect(s.retries.length).toBe(0);
		expect(s.errors).toEqual(["A notification named version 99, but the row has version 1"]);
	});

	test("reset drops the retry, so the next request reads at once", async () => {
		s.sync.requestRead();
		await s.fail();
		s.sync.reset();
		expect(s.retries.length).toBe(0);
		s.sync.requestRead();
		expect(s.reads.length).toBe(1);
	});

	test("stop cancels the retry and drops a read still running", async () => {
		s.sync.notified("1");
		await s.fail();
		s.sync.requestRead();
		s.sync.stop();
		expect(s.retries.length).toBe(0);

		const t = setup();
		t.sync.requestRead();
		t.sync.stop();
		await t.complete(5, 1);
		expect(t.amount).toBe(null);
	});
});
