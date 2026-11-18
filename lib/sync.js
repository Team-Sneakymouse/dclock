import { toVersion } from "./amount.js";

// Decides when to read the row: when a notification names a version other than the held one (a payload that is no
// version still counts as "changed"), and on request (after the listener (re)connects).
//
// At most one read runs at a time. Requests that arrive while one runs get one follow-up read once it is done (none
// if they only named the version that read returned), so a burst of notifications costs at most two reads. A read
// satisfies every request made before it started: PostgreSQL delivers a notification only after its transaction
// committed, so a read started after the notification arrived sees that commit.
//
// A read starts only after the previous one finished, so each read sees a row at least as new as the one before it,
// and every successful read goes to `apply`. A version lower than the held one therefore means the database's row
// went backwards (a restore, or Staging refreshed from a copy of Live); it is logged once, when `apply` takes it.
//
// A failed read is retried after `minBackoffMs`, doubling up to `maxBackoffMs`, until one succeeds; a success resets
// the delay. The first failure of a run and the recovery are logged, the retries in between are not. There is one
// retry timer.
export function createSync({
	read, // () => Promise<{ version, ... }>
	held, // () => the version currently held
	apply, // (row) => false if the row was not taken (it may be stale); called with every successful read
	minBackoffMs = 1_000,
	maxBackoffMs = 30_000,
	schedule = (delayMs, run) => {
		const timer = setTimeout(run, delayMs);
		return () => clearTimeout(timer);
	},
	log = console,
}) {
	let requested = 0; // requests made so far
	let satisfied = 0; // requests made before the last successful read started
	let target = -1; // the version the latest notification named; -1 when none is outstanding
	let lastUnversioned = 0; // the last request that named no version (a reconnect, an unparsable payload)
	let reading = false;
	let cancelRetry = null;
	let backoffMs = minBackoffMs;
	let failures = 0; // failed reads since the last success
	let stopped = false;

	function succeeded(startedAt, row) {
		backoffMs = minBackoffMs;
		if (failures > 0) log.log(`Read the amount again after ${failures} failed attempt${failures === 1 ? "" : "s"}`);
		failures = 0;
		const previous = held();
		const wentBack = row.version < previous;
		if (apply(row) !== false && wentBack) {
			log.error(`The row's version went back from ${previous} to ${row.version} (database restored or copied?); publishing its amount`);
		}
		satisfied = Math.max(satisfied, startedAt);
		// Requests made while it ran only named versions, and it returned the latest of them: no follow-up needed.
		// Equality, not "at least": after the row went backwards, a higher version can be the older row.
		if (lastUnversioned <= satisfied && (target < 0 || row.version === target)) satisfied = requested;
		if (satisfied === requested) {
			// Only a notification that didn't come from adjust() gets here; reading again would not help.
			if (target > row.version && !wentBack) log.error(`A notification named version ${target}, but the row has version ${row.version}`);
			target = -1;
		}
	}

	function failed(error) {
		const delayMs = backoffMs;
		backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
		if (failures++ === 0) {
			log.error(`Failed to read the amount: ${error.message}; retrying from ${delayMs} ms up to every ${maxBackoffMs} ms until it works`);
		}
		cancelRetry = schedule(delayMs, () => {
			cancelRetry = null;
			pump();
		});
	}

	function pump() {
		if (stopped || reading || cancelRetry || requested <= satisfied) return;
		reading = true;
		const startedAt = requested;
		let result;
		try {
			result = Promise.resolve(read());
		} catch (error) {
			result = Promise.reject(error);
		}
		result.then(
			(row) => {
				reading = false;
				if (stopped) return;
				succeeded(startedAt, row);
				pump();
			},
			(error) => {
				reading = false;
				if (stopped) return;
				failed(error);
			},
		);
	}

	return {
		notified(payload) {
			const version = toVersion(payload);
			if (version !== null) {
				if (version === held()) return; // a lower one means the row went backwards
				target = version; // notifications arrive in commit order, so the latest is the newest
			}
			requested++;
			if (version === null) lastUnversioned = requested;
			pump();
		},

		// Reads the row (again), e.g. after the listener (re)connected and notifications may have been missed.
		requestRead() {
			lastUnversioned = ++requested;
			pump();
		},

		// Drops a pending retry and its backoff; the next request reads at once.
		reset() {
			cancelRetry?.();
			cancelRetry = null;
			backoffMs = minBackoffMs;
		},

		// No more reads or retries; the result of a read still running is dropped.
		stop() {
			stopped = true;
			cancelRetry?.();
			cancelRetry = null;
		},
	};
}
