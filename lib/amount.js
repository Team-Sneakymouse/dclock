// The amount is a resource, not a clock: it only changes when someone adjusts it, so show it as it is.
export function toSeconds(value) {
	const amount = Number(value);
	if (value === null || value === "" || !Number.isFinite(amount)) throw new Error(`Invalid amount: ${value}`);
	return Math.max(0, Math.floor(amount));
}

export function format(seconds) {
	return seconds.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Bun's SQL client has no per-query timeout, so race the query against a timer and cancel it on expiry.
// The caller gets its answer on time even if the connection hangs (a paused or unreachable database).
export async function withTimeout(query, timeoutMs) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			try {
				query.cancel?.();
			} catch {}
			reject(new Error(`Query timed out after ${timeoutMs} ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([query, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export async function readSeconds(sql, timeoutMs) {
	const rows = await withTimeout(sql`select amount from sneakydclock.dclock`, timeoutMs);
	if (rows.length !== 1) throw new Error(`sneakydclock.dclock has ${rows.length} rows, expected 1`);
	return toSeconds(rows[0].amount);
}
