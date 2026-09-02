/* 404Lyrics - lyrics retrieval.
 *
 * Two providers, tried in order:
 *
 *   1. Spotify's own colour-lyrics endpoint (via Spicetify.CosmosAsync, which
 *      carries the WebPlayer auth for us). This is the same source the native
 *      Lyrics view uses, so line timing matches Spotify exactly.
 *   2. LRCLIB (https://lrclib.net) - a free, key-less community LRC database,
 *      reached with a plain fetch. Covers a lot of tracks Spotify has no
 *      synced lyrics for.
 *
 * Both are normalised to one shape so the view never branches on provider:
 *
 *   { kind, lines: [{ time, text }], language, provider, copyright, uri }
 *
 * kind: "synced" | "unsynced" | "instrumental" | "none"
 * `time` is milliseconds; it is 0 for every line when kind is "unsynced".
 */
const LXProviders = (() => {
	const INSTRUMENTAL_MARKS = new Set(["", "♪", "♫", "🎵", "🎶", "···", "…"]);

	function isInstrumentalOnly(lines) {
		return lines.length > 0 && lines.every((l) => INSTRUMENTAL_MARKS.has(l.text.trim()));
	}

	/* ------------------------------------------------------------ LRC parsing */

	function timestampToMs(stamp) {
		// [mm:ss.xx] or [mm:ss:xx] or [h:mm:ss.xx]
		const parts = stamp.split(":");
		let seconds = Number(parts.pop());
		let minutes = Number(parts.pop() || 0);
		let hours = Number(parts.pop() || 0);
		if (!Number.isFinite(seconds)) seconds = 0;
		if (!Number.isFinite(minutes)) minutes = 0;
		if (!Number.isFinite(hours)) hours = 0;
		return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
	}

	function parseLrc(text) {
		const stampRe = /\[(\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?)\]/g;
		const out = [];
		for (const rawLine of text.split(/\r?\n/)) {
			// Skip metadata tags like [ar:...] [length:...]
			if (/^\[[a-z]+:/i.test(rawLine.trim())) continue;
			const stamps = [];
			let m;
			stampRe.lastIndex = 0;
			while ((m = stampRe.exec(rawLine))) stamps.push(m[1]);
			if (!stamps.length) continue;
			const words = rawLine.replace(stampRe, "").trim();
			for (const stamp of stamps) out.push({ time: timestampToMs(stamp), text: words || "♪" });
		}
		out.sort((a, b) => a.time - b.time);
		return out;
	}

	function parsePlain(text) {
		// Blank lines are dropped rather than kept as spacers - the view gives
		// every line its own vertical rhythm, and an empty line rendered as a
		// lyric would just look like a gap with a stray "♪".
		return text
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l) => ({ time: 0, text: l }));
	}

	/* ------------------------------------------------------------- providers  */

	async function spotify(info) {
		if (info.kind !== "track" || !info.id) return null;

		const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${info.id}?format=json&vocalRemoval=false&market=from_token`;
		const body = await Spicetify.CosmosAsync.get(url);
		const lyrics = body && body.lyrics;
		if (!lyrics || !Array.isArray(lyrics.lines) || !lyrics.lines.length) return null;

		const synced = lyrics.syncType === "LINE_SYNCED";
		let lines = lyrics.lines.map((line) => ({
			time: synced ? Number(line.startTimeMs) || 0 : 0,
			text: (line.words || "").trim(),
		}));
		// Synced: an empty line is a timed instrumental gap, keep it as "♪".
		// Unsynced: an empty line is just noise, drop it.
		if (synced) lines = lines.map((l) => (l.text ? l : { ...l, text: "♪" }));
		else lines = lines.filter((l) => l.text);

		return {
			kind: isInstrumentalOnly(lines) ? "instrumental" : synced ? "synced" : "unsynced",
			lines,
			language: lyrics.language || "",
			provider: "Spotify",
			copyright: (body.colors && body.provider) || lyrics.providerDisplayName || "Musixmatch",
		};
	}

	async function lrclib(info) {
		const params = new URLSearchParams({
			track_name: info.title,
			artist_name: info.artist,
			album_name: info.album,
			duration: String(Math.round(info.durationMs / 1000)),
		});

		let res;
		try {
			res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
				headers: { "x-user-agent": "404Lyrics (https://github.com/Chrisss666/404Lyrics)" },
			});
		} catch (e) {
			return null; // network blocked or offline - not fatal
		}
		if (!res.ok) return null;
		const body = await res.json();

		if (body.instrumental) {
			return { kind: "instrumental", lines: [{ time: 0, text: "♪" }], language: "", provider: "LRCLIB", copyright: "LRCLIB" };
		}
		if (body.syncedLyrics) {
			const lines = parseLrc(body.syncedLyrics);
			if (lines.length) return { kind: "synced", lines, language: "", provider: "LRCLIB", copyright: "LRCLIB" };
		}
		if (body.plainLyrics) {
			const lines = parsePlain(body.plainLyrics);
			if (lines.length) return { kind: "unsynced", lines, language: "", provider: "LRCLIB", copyright: "LRCLIB" };
		}
		return null;
	}

	const CHAIN = [spotify, lrclib];

	/* Resolve lyrics for a track. `signal` aborts the surrounding request; we
	 * check it between providers and after each await so a fast track switch
	 * cannot leave a slow lookup running against a stale token. The caller is
	 * still responsible for ignoring a result whose token no longer matches. */
	async function fetchLyrics(info, signal) {
		const base = { uri: info.uri, lines: [], language: "", provider: "", copyright: "" };

		if (!info || (info.kind !== "track")) {
			return { ...base, kind: "unsupported" };
		}

		for (const provider of CHAIN) {
			if (signal && signal.aborted) return { ...base, kind: "none" };
			try {
				const result = await provider(info, signal);
				if (signal && signal.aborted) return { ...base, kind: "none" };
				if (result && result.lines.length) return { ...base, ...result };
			} catch (e) {
				/* provider failed - fall through to the next one */
			}
		}
		return { ...base, kind: "none" };
	}

	return { fetchLyrics, parseLrc, parsePlain };
})();
