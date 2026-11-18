// Relays the amount to Server-Sent Events clients.
//
// Every event carries the row's version with the amount (`data: {"amount":<seconds>,"version":<n>}`). The hub
// publishes what the listener hands it, a lower version too: the listener hands over only reads that started and
// finished on the current listen connection, one at a time, so a lower version means the database went backwards
// (a restore). Browsers ignore an event older than what they show, so a page rendered from a newer row is never
// rolled back by a late event; after a restore they show the older row on their next page load.
//
// Backpressure: each client holds at most one queued chunk in its stream and one pending event (the newest).
// A client that stops reading gets no more chunks, its pending event is overwritten, and after `stallMs` it is
// disconnected. Memory per client stays constant however fast the amount changes.
const encoder = new TextEncoder();

export function createHub({ stallMs = 60_000, now = Date.now, log = console } = {}) {
	const clients = new Set();
	let latest = null; // { amount, version, text }
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
		const event = client.pending;
		client.sent = event.version;
		client.pending = null;
		enqueue(client, event.text);
	}

	function offer(client, event) {
		// Compare against what this client was last sent, never a global value, so no client is left behind.
		client.pending = event.version === client.sent ? null : event;
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
		// The amount (whole seconds) last published, or null.
		get latest() {
			return latest?.amount ?? null;
		},
		get live() {
			return live;
		},

		// The version of `latest`; -1 before the first publication.
		get version() {
			return latest?.version ?? -1;
		},

		publish(amount, version) {
			latest = { amount, version, text: `data: ${JSON.stringify({ amount, version })}\n\n` };
			for (const client of clients) offer(client, latest);
		},

		// The listener is connected and a read made since has completed: `latest` is current, so new clients get it.
		markLive() {
			live = true;
		},

		// The listener lost its connection: new clients should keep their server-rendered value rather than get
		// `latest`, which may be stale.
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
