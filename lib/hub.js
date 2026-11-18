// Relays the amount to Server-Sent Events clients.
//
// Ordering: every source of a value (a notification, or a database read) takes a ticket from one counter when it
// starts. A value is published only if its ticket is newer than the last published one, so a read that started
// before a notification arrived can never roll browsers back to the older value it saw.
//
// Backpressure: each client holds at most one queued chunk in its stream and one pending value (the newest).
// A client that stops reading gets no more chunks, its pending value is overwritten, and after `stallMs` it is
// disconnected. Memory per client stays constant however fast the amount changes.
const encoder = new TextEncoder();

export function createHub({ stallMs = 60_000, now = Date.now, log = console } = {}) {
	const clients = new Set();
	let tickets = 0;
	let lastPublished = 0;
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

		ticket() {
			return ++tickets;
		},

		// Returns whether the value was published (false when a newer value already was).
		publish(value, ticket) {
			if (ticket <= lastPublished) return false;
			lastPublished = ticket;
			latest = value;
			live = true;
			for (const client of clients) offer(client, value);
			return true;
		},

		// The listener lost its connection: values from reads started before now are outdated, and new clients
		// should keep their server-rendered value rather than get `latest`, which may be stale.
		invalidate() {
			lastPublished = ++tickets;
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
