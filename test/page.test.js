import { expect, test } from "bun:test";
import { format, toSeconds } from "../lib/amount.js";
import { createClock, escapeHtml, renderPage } from "../lib/page.js";

test("amounts are floored, never negative, and formatted with thousands separators", () => {
	expect(format(toSeconds(1234567.8))).toBe("1,234,567");
	expect(format(toSeconds("999.99"))).toBe("999");
	expect(format(toSeconds(-5))).toBe("0");
	expect(format(toSeconds(0))).toBe("0");
});

test("invalid amounts are rejected", () => {
	for (const value of ["garbage", "", null, undefined, "Infinity", Number.NaN]) {
		expect(() => toSeconds(value)).toThrow("Invalid amount");
	}
});

test("the amount is rendered into the embed description and the clock, with its version", () => {
	const html = renderPage("1,234,567", 7);
	expect(html).toContain('<meta property="og:description" content="1,234,567 seconds left~" />');
	expect(html).toContain('<div id="clock" data-version="7">1,234,567</div>');
});

test("interpolated values are HTML-escaped", () => {
	expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
	const html = renderPage(`"/><script>alert(1)</script>`, `"><b>`);
	expect(html).not.toContain("<script>alert(1)");
	expect(html).not.toContain("<b>");
	expect(html).toContain('content="&quot;/&gt;&lt;script&gt;alert(1)&lt;/script&gt; seconds left~"');
});

const clockElement = (version, text = "") => ({ dataset: version === undefined ? {} : { version }, textContent: text });
const event = (amount, version) => JSON.stringify({ amount, version });

test("the browser shows an SSE event only if its version is newer than what it shows", () => {
	const clock = clockElement("3", "3,000");
	const onEvent = createClock(clock);
	onEvent(event(2000, 2)); // a read that started before the page was rendered
	onEvent(event(3000, 3));
	expect(clock.textContent).toBe("3,000");
	onEvent(event(1234567.8, 4));
	expect(clock.textContent).toBe("1,234,567");
	onEvent(event(5, 4));
	onEvent(event(9, 1)); // a restore: shown after the next page load
	expect(clock.textContent).toBe("1,234,567");
});

test("the browser ignores malformed events and starts from version -1 without a rendered version", () => {
	const clock = clockElement(undefined, "?");
	const onEvent = createClock(clock);
	for (const data of ["garbage", "42", "null", event("x", 1), event(1, "x"), event(1, 1.5)]) onEvent(data);
	expect(clock.textContent).toBe("?");
	onEvent(event(-5, 0));
	expect(clock.textContent).toBe("0");
});

test("the page's own script follows SSE events by version", () => {
	const html = renderPage("3,000", 3);
	const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
	const clock = clockElement("3", "3,000");
	let source;
	class FakeEventSource {
		constructor(url) {
			expect(url).toBe("/events");
			source = this;
		}
	}
	new Function("document", "window", "EventSource", script)({ getElementById: () => clock }, { EventSource: FakeEventSource }, FakeEventSource);
	source.onmessage({ data: event(2000, 2) });
	expect(clock.textContent).toBe("3,000");
	source.onmessage({ data: event(4000, 4) });
	expect(clock.textContent).toBe("4,000");
});
