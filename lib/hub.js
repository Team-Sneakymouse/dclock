// Relays the amount to Server-Sent Events clients.
//
// Ordering: every read returns the amount with the row's version, which every change raises. A value is published
// only if its version is greater than the last published one, so reads may complete in any order: one that saw an
// older row never rolls browsers back.
//
// Backpressure: each client holds at most one queued chunk in its stream and one pending value (the newest).
// A client that stops reading gets no more chunks, its pending value is overwritten, and after `stallMs` it is
// disconnected. Memory per client stays constant however fast the amount changes.
const encoder = new TextEncoder();

export function createHub({ stallMs = 60_000, now = Date.now, log = console } = {}) {
	const clients = new Set();
	let version = -1; // of `latest`
	let latest = null;
	let live = false; // whether `latest` is known to be current (the listener is connected)

	function enqueue(client, text) {
		try {
			client.controller.enqueue(encoder.encode(text));
			return true;
		} catch {
			drop(client); // the stream is already closed
			return false;
		}
	}

	function flush(client) {
		if (client.pending === null || !(client.controller.desiredSize > 0)) return;
		// Update the state first: enqueue() can call pull() synchronously, which flushes again.
		const value = client.pending;
		client.sent = value;
		client.pending = null;
		enqueue(client, `data: ${value}\n\n`);
	}

	function offer(client, value) {
		// Compare against what this client was last sent, never a global value, so no client is left behind.
		client.pending = value === client.sent ? null : value;
		flush(client);
	}

	function drop(client, reason) {
		if (!clients.delete(client)) return;
		if (reason) {
			log.log(`Dropped an SSE client: ${reason}`);
			try {
				client.controller.error(new Error(reason));
			} catch {}
		}
	}

	return {
		get size() {
			return clients.size;
		},
		get latest() {
			return latest;
		},
		get live() {
			return live;
		},

		get version() {
			return version;
		},

		// Returns whether the value was published (false when its version is not newer than the last published one).
		publish(value, rowVersion) {
			if (rowVersion <= version) return false;
			version = rowVersion;
			latest = value;
			for (const client of clients) offer(client, value);
			return true;
		},

		// The listener is connected and a read made since has completed: `latest` is current, so new clients get it.
		markLive() {
			live = true;
		},

		// The listener lost its connection: new clients should keep their server-rendered value rather than get
		// `latest`, which may be stale. Existing clients still get newer values as reads complete.
		invalidate() {
			live = false;
		},

		heartbeat() {
			const time = now();
			for (const client of clients) {
				if (client.controller.desiredSize > 0) {
					client.stalledSince = null;
					if (client.pending !== null) flush(client);
					else enqueue(client, ": heartbeat\n\n");
				} else if (client.stalledSince === null) {
					client.stalledSince = time;
				} else if (time - client.stalledSince >= stallMs) {
					drop(client, "client stopped reading");
				}
			}
		},

		// A ReadableStream for one SSE response.
		stream() {
			let client;
			return new ReadableStream(
				{
					start(controller) {
						client = { controller, sent: null, pending: null, stalledSince: null };
						clients.add(client);
						enqueue(client, "retry: 5000\n\n");
						if (live && latest !== null) client.pending = latest; // sent on the first pull
					},
					pull() {
						if (client) flush(client);
					},
					cancel() {
						if (client) clients.delete(client);
					},
				},
				{ highWaterMark: 1 },
			);
		},

		closeAll() {
			for (const client of clients) {
				clients.delete(client);
				try {
					client.controller.close();
				} catch {}
			}
		},
	};
}
