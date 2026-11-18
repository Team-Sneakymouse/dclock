import { expect, test } from "bun:test";
import { format, toSeconds } from "../lib/amount.js";
import { escapeHtml, renderPage } from "../lib/page.js";

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

test("the amount is rendered into the embed description and the clock", () => {
	const html = renderPage("1,234,567");
	expect(html).toContain('<meta property="og:description" content="1,234,567 seconds left~" />');
	expect(html).toContain('<div id="clock">1,234,567</div>');
	// The client-side formatter survives the template literal with its backslashes.
	expect(html).toContain(".replace(/\\B(?=(\\d{3})+(?!\\d))/g, \",\")");
});

test("interpolated values are HTML-escaped", () => {
	expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
	const html = renderPage(`"/><script>alert(1)</script>`);
	expect(html).not.toContain("<script>alert(1)");
	expect(html).toContain('content="&quot;/&gt;&lt;script&gt;alert(1)&lt;/script&gt; seconds left~"');
});
