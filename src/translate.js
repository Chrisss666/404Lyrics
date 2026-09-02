/* 404Lyrics - translation.
 *
 * Design notes
 * ------------
 * A Spicetify extension runs as untrusted frontend JavaScript, so a paid /
 * keyed translation API is out - the key would sit in plain text in everyone's
 * install. What is reachable without credentials are the same public endpoints
 * browser translation extensions use. Three are bundled and tried in order,
 * because each is unofficial and independently rate-limited:
 *
 *   1. translate.googleapis.com/translate_a/single   (client=gtx)
 *   2. clients5.google.com/translate_a/t             (client=dict-chrome-ex)
 *   3. api.mymemory.translated.net/get               (community memory)
 *
 * All requests go through LXNet (CosmosAsync, so no CSP/CORS wall).
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
	const CONCURRENCY = 5;
	const MAX_CONSECUTIVE_FAILURES = 5; // treat as rate-limited, stop the batch

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

	/* ------------------------------------------------------------- providers */

	function enc(s) {
		return encodeURIComponent(s);
	}

	// translate.googleapis.com - nested-array response, also reports source.
	const googleGtx = {
		id: "google",
		async translateOne(text, target, sourceHint, signal) {
			const url =
				`https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${enc(sourceHint || "auto")}` +
				`&tl=${enc(target)}&q=${enc(text)}`;
			const data = await LXNet.getJson(url, { signal });
			if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("gtx: unexpected shape");
			const translated = data[0].map((c) => (c && c[0]) || "").join("");
			return { translated: translated.trim(), detected: (data[2] || "").toString() };
		},
	};

	// clients5.google.com - flat response: ["translated"] or [["translated","src"]].
	const googleDict = {
		id: "google-dict",
		async translateOne(text, target, sourceHint, signal) {
			const url =
				`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${enc(sourceHint || "auto")}` +
				`&tl=${enc(target)}&q=${enc(text)}`;
			const data = await LXNet.getJson(url, { signal });
			let translated = "";
			let detected = "";
			if (Array.isArray(data) && typeof data[0] === "string") translated = data[0];
			else if (Array.isArray(data) && Array.isArray(data[0])) {
				translated = data[0][0] || "";
				detected = data[0][1] || data[1] || "";
			} else throw new Error("dict: unexpected shape");
			return { translated: translated.trim(), detected: detected.toString() };
		},
	};

	// MyMemory - keyless community translation memory, generous anon quota.
	const myMemory = {
		id: "mymemory",
		async translateOne(text, target, sourceHint, signal) {
			const pair = `${(sourceHint && sourceHint !== "auto" ? sourceHint : "en")}|${target}`;
			const url = `https://api.mymemory.translated.net/get?q=${enc(text)}&langpair=${enc(pair)}`;
			const data = await LXNet.getJson(url, { signal });
			const t = data && data.responseData && data.responseData.translatedText;
			if (!t || (data.responseStatus && data.responseStatus !== 200)) throw new Error(`mymemory ${data && data.responseStatus}`);
			return { translated: String(t).trim(), detected: "" };
		},
	};

	/* Meta-provider: walk the list, stick to whichever answered last so a
	 * healthy provider is not re-probed for every line. A provider is retried
	 * from the top only after the current one fails. */
	const chain = (() => {
		const list = [googleGtx, googleDict, myMemory];
		let idx = 0;
		return {
			get id() {
				return list[idx].id;
			},
			async translateOne(text, target, sourceHint, signal) {
				let lastErr;
				for (let step = 0; step < list.length; step++) {
					const p = list[(idx + step) % list.length];
					try {
						const out = await p.translateOne(text, target, sourceHint, signal);
						if (!out || typeof out.translated !== "string") throw new Error("empty result");
						if (step > 0) {
							idx = (idx + step) % list.length;
							LXLog.info("translation provider →", p.id);
						}
						return out;
					} catch (err) {
						if (err && err.name === "AbortError") throw err;
						lastErr = err;
						LXLog.warn("translation provider failed:", p.id, err && err.message);
					}
				}
				throw lastErr || new Error("all translation providers failed");
			},
		};
	})();

	let activeProvider = chain;

	function useProvider(provider) {
		if (provider && typeof provider.translateOne === "function") activeProvider = provider;
	}

	function providerId() {
		return (activeProvider && activeProvider.id) || "unknown";
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
	 * @param {{time:number,text:string,words?:object[]}[]} lines
	 * @param {object} opts { trackId, target, sourceHint, signal, onProgress }
	 * @returns {Promise<{ map, detected, status, provider }>}
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

		if (!target) return { map, detected, status: "not-needed", provider: providerId() };
		if (sourceHint && sourceHint === target) return { map, detected, status: "not-needed", provider: providerId() };

		LXLog.info("translate batch:", (lines && lines.length) || 0, "lines ->", target, "(source hint:", sourceHint || "auto", ")");

		// Distinct texts, skipping instrumental marks and blanks.
		const unique = [];
		const seen = new Set();
		for (const line of lines) {
			const t = (line.text || "").trim();
			if (!t || t === "♪" || seen.has(t)) continue;
			seen.add(t);
			unique.push(t);
		}
		if (!unique.length) return { map, detected, status: "not-needed", provider: providerId() };

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

		if (!misses.length) return { map, detected, status: "ok", provider: providerId() };
		if (signal && signal.aborted) return { map, detected, status: "cancelled", provider: providerId() };

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

		if (cancelled || (signal && signal.aborted)) return { map, detected, status: "cancelled", provider: providerId() };
		if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			LXLog.warn("translation stopped after repeated failures - likely rate-limited");
			return { map, detected, status: anySuccess ? "partial" : "unavailable", provider: providerId() };
		}
		const complete = unique.every((t) => t in map || readCached(trackId, srcKey, target, t) !== undefined);
		LXLog.info("translate batch done:", Object.keys(map).length, "/", unique.length, "via", providerId());
		return { map, detected, status: complete ? "ok" : "partial", provider: providerId() };
	}

	function clearCache() {
		const n = cacheCount();
		cache = {};
		try {
			localStorage.removeItem(CACHE_KEY);
		} catch (e) {
			/* ignore */
		}
		LXLog.info("translation cache cleared (" + n + " entries)");
	}

	function cacheCount() {
		try {
			return Object.keys(loadCache()).length;
		} catch (e) {
			return 0;
		}
	}

	return { translateLines, useProvider, clearCache, cacheCount, providerId };
})();
