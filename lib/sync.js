import { toVersion } from "./amount.js";

// Decides when to read the row: when a notification names a version newer than the held one (a payload that is no
// version still counts as "changed"), and on request (after the listener (re)connects).
//
// At most one read runs at a time. Requests that arrive while one runs get one follow-up read once it is done (none
// if they only named versions that read already returned), so a burst of notifications costs at most two reads.
// Versions make the order of reads irrelevant: the hub publishes only a newer one. A read satisfies every request
// made before it started: PostgreSQL delivers a notification only after its transaction committed, so a read started
// after the notification arrived sees that version or a newer one. A failed read is retried after `minBackoffMs`,
// doubling up to `maxBackoffMs`, until one succeeds; a success resets the delay. There is one retry timer.
export function createSync({
	read, // () => Promise<{ version, ... }>
	held, // () => the version currently held
	apply, // (row) => void, called with every successful read
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
	let target = -1; // the newest version a notification named
	let lastUnversioned = 0; // the last request that named no version (a reconnect, an unparsable payload)
	let reading = false;
	let cancelRetry = null;
	let backoffMs = minBackoffMs;
	let stopped = false;

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
				backoffMs = minBackoffMs;
				apply(row);
				satisfied = Math.max(satisfied, startedAt);
				// Requests made while it ran only named versions, and it saw them all: no follow-up needed.
				if (lastUnversioned <= satisfied && held() >= target) satisfied = requested;
				if (satisfied === requested && held() < target) {
					// Only a notification that didn't come from adjust() (or a recreated row) gets here; reading again
					// would not help.
					log.error(`A notification named version ${target}, but the row has version ${held()}`);
					target = held();
				}
				pump();
			},
			(error) => {
				reading = false;
				if (stopped) return;
				const delayMs = backoffMs;
				backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
				log.error(`Failed to read the amount: ${error.message}; retrying in ${delayMs} ms`);
				cancelRetry = schedule(delayMs, () => {
					cancelRetry = null;
					pump();
				});
			},
		);
	}

	return {
		notified(payload) {
			const version = toVersion(payload);
			if (version !== null) {
				if (version <= held()) return;
				target = Math.max(target, version);
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
