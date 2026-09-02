/* 404Lyrics - networking + diagnostics.
 *
 * LXNet.getJson routes every outbound request through Spicetify.CosmosAsync
 * first. CosmosAsync goes through Spotify's native networking layer, which
 * sidesteps both the page CSP and browser CORS - the only reliable way to
 * reach third-party lyric and translation APIs from inside the client. Plain
 * fetch is the fallback for hosts that send permissive CORS (LRCLIB).
 *
 * LXLog is a gated logger: silent unless `localStorage["404lyrics:debug"]`
 * is "true". It exists so the translation and karaoke paths can be traced in
 * Spotify's DevTools during setup without shipping console noise. Meaningful
 * errors are still surfaced through it rather than swallowed.
 */
const LXLog = (() => {
	function on() {
		try {
			return localStorage.getItem("404lyrics:debug") === "true";
		} catch (e) {
			return false;
		}
	}
	const tag = "%c404Lyrics";
	const css = "color:#c9a6ff;font-weight:700";
	return {
		enabled: on,
		info: (...a) => on() && console.info(tag, css, ...a),
		warn: (...a) => on() && console.warn(tag, css, ...a),
		error: (...a) => on() && console.error(tag, css, ...a),
	};
})();

const LXNet = (() => {
	// Cosmos returns already-parsed JSON. Some endpoints answer with a JSON
	// string body (Google's dict endpoint does under Cosmos); handle both.
	function coerce(value) {
		if (typeof value !== "string") return value;
		try {
			return JSON.parse(value);
		} catch (e) {
			return value;
		}
	}

	async function viaCosmos(url, headers) {
		if (!(window.Spicetify && Spicetify.CosmosAsync)) throw new Error("no CosmosAsync");
		return coerce(await Spicetify.CosmosAsync.get(url, null, headers || undefined));
	}

	async function viaFetch(url, headers, signal) {
		const res = await fetch(url, { headers: headers || undefined, signal });
		if (!res.ok) throw new Error(`http ${res.status}`);
		const text = await res.text();
		return coerce(text);
	}

	/**
	 * GET a URL and return parsed JSON. Tries CosmosAsync, then fetch.
	 * `signal` only applies to the fetch fallback (CosmosAsync has no abort);
	 * callers must still drop a stale result by token.
	 * Throws if both transports fail or the body is not JSON.
	 */
	async function getJson(url, opts) {
		const o = opts || {};
		let firstError;
		try {
			const data = await viaCosmos(url, o.headers);
			if (o.signal && o.signal.aborted) throw new DOMException("aborted", "AbortError");
			if (data && typeof data === "object") return data;
			firstError = new Error("cosmos: non-JSON body");
		} catch (e) {
			if (e && e.name === "AbortError") throw e;
			firstError = e;
		}
		try {
			return await viaFetch(url, o.headers, o.signal);
		} catch (e) {
			if (e && e.name === "AbortError") throw e;
			throw firstError || e;
		}
	}

	return { getJson };
})();
