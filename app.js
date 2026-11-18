import express from "express";
import pg from "pg";

// SneakyDClock owns the amount (a single row) and runs pg_notify(CHANNEL, <amount>) on every change.
// This site only reads it, so its role needs nothing beyond select on that table.
const CHANNEL = "sneakydclock";
const AMOUNT_SQL = "select amount from sneakydclock.dclock";
const HEARTBEAT_MS = 25_000;
const LISTENER_CHECK_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
	console.error("DATABASE_URL is not set");
	process.exit(1);
}

const pool = new pg.Pool({
	connectionString,
	max: 4,
	connectionTimeoutMillis: 5_000,
	query_timeout: 5_000,
	idleTimeoutMillis: 30_000,
});
pool.on("error", (error) => console.error("Idle database connection failed:", error.message));

// The amount is a resource, not a clock: it only changes when someone adjusts it, so show it as it is.
function toSeconds(value) {
	const amount = Number(value);
	if (!Number.isFinite(amount)) throw new Error(`Invalid amount: ${value}`);
	return Math.max(0, Math.floor(amount));
}

function format(seconds) {
	return seconds.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function readSeconds(client = pool) {
	const { rows } = await client.query(AMOUNT_SQL);
	if (rows.length !== 1) throw new Error("sneakydclock.dclock has no row");
	return toSeconds(rows[0].amount);
}

// Server-Sent Events clients, and the last amount sent to them.
const clients = new Set();
let latest = null;

function send(res, seconds) {
	res.write(`data: ${seconds}\n\n`);
}

function publish(seconds) {
	if (seconds === latest) return;
	latest = seconds;
	for (const res of clients) send(res, seconds);
}

setInterval(() => {
	for (const res of clients) res.write(": heartbeat\n\n");
}, HEARTBEAT_MS).unref();

// One dedicated connection LISTENs for changes. Notifications sent while it is down are lost, so every
// (re)connect reads the amount again after LISTEN is in place.
let listener = null;
let listening = false;
let reconnectDelay = RECONNECT_MIN_MS;
let stopping = false;

function dropListener(client, reason) {
	if (listener !== client || stopping) return; // already replaced, or shutting down
	listener = null;
	listening = false;
	console.error(`Database listener lost (${reason}); reconnecting in ${reconnectDelay} ms`);
	client.removeAllListeners("notification");
	client.on("error", () => {});
	client.end().catch(() => {});
	setTimeout(listen, reconnectDelay).unref();
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

async function listen() {
	if (stopping) return;
	const client = new pg.Client({
		connectionString,
		connectionTimeoutMillis: 10_000,
		query_timeout: 10_000,
		keepAlive: true,
		keepAliveInitialDelayMillis: 10_000,
	});
	listener = client;
	client.on("error", (error) => dropListener(client, error.message));
	client.on("end", () => dropListener(client, "connection ended"));
	client.on("notification", (message) => {
		if (message.channel !== CHANNEL) return;
		try {
			publish(toSeconds(message.payload));
		} catch (error) {
			console.error("Ignoring notification:", error.message);
			readSeconds(client).then(publish, (readError) => dropListener(client, readError.message));
		}
	});
	try {
		await client.connect();
		await client.query(`listen ${CHANNEL}`);
		const seconds = await readSeconds(client);
		if (listener !== client) return;
		publish(seconds);
		listening = true;
		reconnectDelay = RECONNECT_MIN_MS;
		console.log(`Listening on ${CHANNEL}`);
	} catch (error) {
		dropListener(client, error.message);
	}
}

// TCP keepalive alone can take minutes to notice a half-open connection, so ask the server now and then.
setInterval(() => {
	const client = listener;
	if (!client || !listening) return;
	client.query("select 1").catch((error) => dropListener(client, error.message));
}, LISTENER_CHECK_MS).unref();

listen();

const app = express();

app.use((req, res, next) => {
	res.setHeader(
		'Content-Security-Policy',
		"default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"
	);

	next();
});

app.use('/assets', express.static('assets'));

app.set('view engine', 'ejs');
app.set('views', ".");

app.get('/', async function (req, res) {
	try {
		// Read on each request so embeds always carry the current amount.
		res.render('./index', { seconds: format(await readSeconds()) });
	} catch (error) {
		console.error("Failed to load countdown:", error);
		res.status(503).send("Countdown temporarily unavailable");
	}
})

app.get('/events', async function (req, res) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write("retry: 5000\n\n");
	clients.add(res);
	res.on("close", () => clients.delete(res));

	if (listening && latest !== null) {
		send(res, latest);
		return;
	}
	// The listener is down: read directly so the browser still gets the current amount.
	try {
		const seconds = await readSeconds();
		if (clients.has(res)) send(res, seconds);
	} catch (error) {
		console.error("Failed to load countdown for /events:", error.message);
	}
})

const port = Number(process.env.PORT) || 80;
const server = app.listen(port, () => console.log(`Server started on port ${port}`));

function shutdown() {
	stopping = true;
	for (const res of clients) res.end();
	server.close();
	listener?.end().catch(() => {});
	pool.end().finally(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
