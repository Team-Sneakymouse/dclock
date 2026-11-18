const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

// Runs in the browser (its source is put into the page) and in the tests. Returns the handler for SSE event data:
// it shows an event's amount only if its version is newer than what the clock shows (the server-rendered version at
// first), so an event from an older row never replaces a newer page. After a restore (a lower version) the page shows
// the older row on its next load. Self-contained: it may use nothing from this module.
export function createClock(clock) {
	let shown = /^\d+$/.test(clock.dataset.version ?? "") ? Number(clock.dataset.version) : -1;
	return (data) => {
		let event;
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		const seconds = Math.max(0, Math.floor(Number(event?.amount)));
		const version = Number(event?.version);
		if (!Number.isFinite(seconds) || !Number.isSafeInteger(version) || version <= shown) return;
		shown = version;
		clock.textContent = seconds.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	};
}

// `seconds` is the formatted amount, e.g. "1,234,567", and `version` the row version it was read with. Both are
// escaped like any other interpolated value.
export function renderPage(seconds, version) {
	const text = escapeHtml(seconds);
	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta property="og:type" content="website" />
		<meta property="og:url" content="https://dclock.rawb.tv/" />
		<meta property="og:title" content="Monica's DClock" />
		<meta property="og:description" content="${text} seconds left~" />
		<meta property="og:image" content="https://dclock.rawb.tv/assets/robMonica.png" />
		<meta name="theme-color" content="#ED4AF3" />

		<link rel="icon" type="image/png" href="assets/robMyGoodness.png" />
		<title>DClock</title>
		<style>
			@font-face {
				font-family: "blue-highway";
				src: url("assets/blue-highway-d.ttf");
			}
			html,
			body {
				height: 100%;
				margin: 0;
				padding: 0;
				overflow: hidden;
			}
			body {
				font-family: blue-highway;
				font-size: calc(100vw / 12 * 2.2);
				color: rgb(237, 74, 243);
				text-shadow: 2px 2px 4px rgb(163, 8, 168);
				background-color: rgb(141, 218, 241);
			}
			.container {
				display: flex;
				justify-content: center;
				align-items: center;
				height: 100%;
			}
			#clock {
				width: calc(100vw / 14 * 8);
			}

			* {
				-moz-user-select: -moz-none;
				-khtml-user-select: none;
				-webkit-user-select: none;
				-ms-user-select: none;
				user-select: none;
			}
		</style>
		<script type="module">
			// The amount only changes when someone adjusts it; show the newest one the server sends.
			// The server-rendered value stays if this fails; EventSource reconnects on its own.
			const onEvent = (${createClock.toString()})(document.getElementById("clock"));
			if ("EventSource" in window) {
				const events = new EventSource("/events");
				events.onmessage = (event) => onEvent(event.data);
			}
		</script>
	</head>
	<body>
		<div class="container">
			<div id="clock" data-version="${escapeHtml(version)}">${text}</div>
		</div>
	</body>
</html>
`;
}
