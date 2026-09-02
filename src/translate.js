/* 404Lyrics - translation.
 *
 * Design notes
 * ------------
 * A Spicetify extension runs as untrusted frontend JavaScript, so a paid
 * translation API is out: its key would be sitting in plain text in everyone's
 * Spotify install. What is actually reachable without credentials is Google's
 * public `translate_a` endpoint (the one the Google Translate website itself
 * calls). Spicetify relaxes Spotify's connect-src CSP, so a plain `fetch` to
 * it works. That is the default and only bundled provider.
 *
 * Everything is written against a tiny provider interface so a self-hosted
 * LibreTranslate instance, DeepL-through-a-proxy, etc. can be added later
 * without touching the view. Register one with `LXTranslate.useProvider(p)`:
 *
 *   p.id
 *   p.translateOne(text, target, sourceHint, signal) ->
 *       Promise<{ translated: string, detected?: string }>
 *
 * Guarantees
 * ----------
 * - A translation failure never throws into the lyrics view. Lines that could
 *   not be translated simply keep showing the original only.
 * - Results are cached in localStorage, keyed per track + source + target +
 *   line text, so reopening Spotify or re-rendering the page costs no requests.
 * - Every batch is cancellable; a stale batch stops mid-flight on track change.
 */
const LXTranslate = (() => {
	const CACHE_KEY = "404lyrics:tcache";
	const CACHE_LIMIT = 4000; // entries; oldest are evicted first
	const CONCURRENCY = 6;
	const MAX_CONSECUTIVE_FAILURES = 4; // treat as rate-limited, stop the batch

	/* ------------------------------------------------------------------ cache */

	let cache = null;
	let flushTimer = null;

	function loadCache() {
		if (cache) return cache;
		try {
			cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
		} catch (e) {
			cache = {};
		}
		return cache;
	}

	function scheduleFlush() {
		if (flushTimer) return;
		flushTimer = setTimeout(() => {
			flushTimer = null;
			try {
				const entries = Object.entries(cache);
				if (entries.length > CACHE_LIMIT) {
					entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
					cache = Object.fromEntries(entries.slice(entries.length - CACHE_LIMIT));
				}
				localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
			} catch (e) {
				/* quota or disabled storage - the in-memory cache still helps */
			}
		}, 600);
	}

	// Short, stable hash so cache keys stay small (cyrb53).
	function hash(str) {
		let h1 = 0xdeadbeef;
		let h2 = 0x41c6ce57;
		for (let i = 0; i < str.length; i++) {
			const ch = str.charCodeAt(i);
			h1 = Math.imul(h1 ^ ch, 2654435761);
			h2 = Math.imul(h2 ^ ch, 1597334677);
		}
		h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
		h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
		return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
	}

	function cacheKey(trackId, source, target, text) {
		return `${trackId || "?"}|${source || "auto"}|${target}|${hash(text)}`;
	}

	function readCached(trackId, source, target, text) {
		const entry = loadCache()[cacheKey(trackId, source, target, text)];
		return entry ? entry.t : undefined;
	}

	function writeCached(trackId, source, target, text, translated) {
		loadCache()[cacheKey(trackId, source, target, text)] = { t: translated, ts: Date.now() };
		scheduleFlush();
	}

	/* --------------------------------------------------------- Google provider */

	const googleProvider = {
		id: "google",
		async translateOne(text, target, sourceHint, signal) {
			const url =
				"https://translate.googleapis.com/translate_a/single?client=gtx&dt=t" +
				`&sl=${encodeURIComponent(sourceHint || "auto")}` +
				`&tl=${encodeURIComponent(target)}` +
				`&q=${encodeURIComponent(text)}`;

			const res = await fetch(url, { signal });
			if (!res.ok) throw new Error(`google ${res.status}`);
			const data = await res.json();

			// data[0] -> array of [translatedChunk, originalChunk, ...]
			const chunks = Array.isArray(data && data[0]) ? data[0] : [];
			const translated = chunks.map((c) => (c && c[0]) || "").join("");
			const detected = (data && data[2]) || (data && data[8] && data[8][0] && data[8][0][0]) || "";
			return { translated: translated.trim(), detected };
		},
	};

	let activeProvider = googleProvider;

	function useProvider(provider) {
		if (provider && typeof provider.translateOne === "function") activeProvider = provider;
	}

	/* -------------------------------------------------------------- the batch */

	// Normalise so "same line" survives punctuation width and casing quirks;
	// used only for the "source already equals target" short-circuit.
	function looksSame(a, b) {
		const strip = (s) => s.toLowerCase().replace(/[\s\p{P}]/gu, "");
		return strip(a) === strip(b);
	}

	/**
	 * Translate every distinct non-empty line.
	 *
	 * @param {{time:number,text:string}[]} lines
	 * @param {object} opts { trackId, target, sourceHint, signal, onProgress }
	 * @returns {Promise<{ map: Record<string,string>, detected: string, status: string }>}
	 *   `map` is keyed by original line text -> translated text.
	 *   status: "ok" | "partial" | "cancelled" | "unavailable" | "not-needed"
	 */
	async function translateLines(lines, opts) {
		const { trackId, target, sourceHint, signal, onProgress } = opts;
		const map = {};
		let detected = sourceHint || "";

		// Cache-key source component is fixed for the whole run (and every future
		// run for this track): `detected` may change as Google reports a
		// language mid-batch, but the key must stay stable or nothing is ever a
		// cache hit on reopen.
		const srcKey = sourceHint || "auto";

		if (!target) return { map, detected, status: "not-needed" };

		// Distinct texts, skipping instrumental marks and blanks.
		const unique = [];
		const seen = new Set();
		for (const line of lines) {
			const t = (line.text || "").trim();
			if (!t || t === "♪" || seen.has(t)) continue;
			seen.add(t);
			unique.push(t);
		}
		if (!unique.length) return { map, detected, status: "not-needed" };

		// Serve from cache first; only the misses hit the network.
		const misses = [];
		for (const text of unique) {
			const hit = readCached(trackId, srcKey, target, text);
			if (hit !== undefined) {
				if (hit) map[text] = hit;
			} else {
				misses.push(text);
			}
		}
		if (onProgress) onProgress({ ...map });

		if (!misses.length) return { map, detected, status: "ok" };
		if (signal && signal.aborted) return { map, detected, status: "cancelled" };

		let consecutiveFailures = 0;
		let anySuccess = Object.keys(map).length > 0;
		let cancelled = false;
		let cursor = 0;

		async function worker() {
			while (cursor < misses.length) {
				if (signal && signal.aborted) {
					cancelled = true;
					return;
				}
				if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;

				const text = misses[cursor++];
				try {
					const { translated, detected: det } = await activeProvider.translateOne(text, target, detected || sourceHint, signal);
					consecutiveFailures = 0;
					if (det && !detected) detected = det;

					// If the line is already in the target language, storing an
					// empty translation keeps the cache from re-trying it and
					// tells the view to show the original only.
					const finalValue = !translated || looksSame(translated, text) ? "" : translated;
					writeCached(trackId, srcKey, target, text, finalValue);
					if (finalValue) {
						map[text] = finalValue;
						anySuccess = true;
						if (onProgress) onProgress({ ...map });
					}
				} catch (err) {
					if (err && err.name === "AbortError") {
						cancelled = true;
						return;
					}
					consecutiveFailures++;
				}
			}
		}

		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, misses.length) }, worker));

		if (cancelled || (signal && signal.aborted)) return { map, detected, status: "cancelled" };
		if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			return { map, detected, status: anySuccess ? "partial" : "unavailable" };
		}
		const complete = unique.every((t) => t in map || readCached(trackId, srcKey, target, t) !== undefined);
		return { map, detected, status: complete ? "ok" : "partial" };
	}

	function clearCache() {
		cache = {};
		try {
			localStorage.removeItem(CACHE_KEY);
		} catch (e) {
			/* ignore */
		}
	}

	return { translateLines, useProvider, clearCache, googleProvider };
})();
