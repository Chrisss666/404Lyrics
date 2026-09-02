/* 404Lyrics - lyrics retrieval.
 *
 * Providers, tried in order (see fetchLyrics for the full rationale):
 *
 *   1. Netease Cloud Music - the only keyless source of real word-by-word
 *      timing ("yrc" / "klyric"). Only consulted when karaoke is enabled, and
 *      only accepted when it actually has word timing.
 *   2. Spotify colour-lyrics (via Spicetify.CosmosAsync) - the same source the
 *      native Lyrics view uses, so line timing matches playback exactly.
 *   3. LRCLIB (https://lrclib.net) - free community LRC database.
 *
 * Everything is normalised to one shape so the view never branches on
 * provider:
 *
 *   { kind, lines, language, provider, copyright, uri }
 *
 * kind:  "richsync" | "synced" | "unsynced" | "instrumental" | "none" | "unsupported"
 * lines: [{ time, text, endTime?, words? }]
 *   - time is milliseconds (0 for every line when kind is "unsynced")
 *   - words (kind "richsync" only): [{ time, endTime, text }] with the
 *     trailing space kept on each token
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

	/* ---------------------------------------------------- word-level parsing */

	// Netease credit lines ("作词 : ...", "Producer: ...") are timed like
	// lyrics but are not lyrics. Filtered out of every Netease parse.
	const CREDIT_RE = /^\s*(作词|作曲|编曲|制作|监制|混音|母带|吉他|贝斯|鼓|和声|录音|策划|统筹|出品|发行|词|曲|producer|writ|compos|arrang|mix|master|guitar|bass|drums|vocal|lyric)s?\b.*(:|：)/i;

	function joinWords(words) {
		return words
			.map((w) => w.text)
			.join("")
			.replace(/\s+/g, " ")
			.trim();
	}

	/* Netease "yrc" - the newer word-level format with absolute timestamps:
	 *   [lineStartMs,lineDurationMs](wordStartMs,wordDurationMs,0)word(...)word
	 * A leading JSON metadata line and credit lines are skipped. */
	function parseYrc(text) {
		const lineRe = /^\[(\d+),(\d+)\](.*)$/;
		const wordRe = /\((\d+),(\d+),\d+\)([^(]*)/g;
		const out = [];

		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			const m = line.match(lineRe);
			if (!m) continue; // metadata / blank

			const lineStart = Number(m[1]);
			const lineDur = Number(m[2]);
			const words = [];
			let wm;
			wordRe.lastIndex = 0;
			while ((wm = wordRe.exec(m[3]))) {
				const wStart = Number(wm[1]);
				const wDur = Number(wm[2]);
				const wText = wm[3];
				if (wText === "") continue;
				words.push({ time: wStart, endTime: wStart + Math.max(wDur, 1), text: wText });
			}
			if (!words.length) continue;

			const text2 = joinWords(words);
			if (!text2 || CREDIT_RE.test(text2)) continue;

			out.push({
				time: lineStart,
				endTime: lineStart + (lineDur || 0),
				text: text2,
				words,
			});
		}
		out.sort((a, b) => a.time - b.time);
		return out;
	}

	/* Netease "klyric" - the older karaoke format, word *durations* relative to
	 * the line start rather than absolute times:
	 *   [lineStartMs,lineDurationMs](0,dur)word(0,dur)word ... */
	function parseKlyric(text) {
		const lineRe = /^\[(\d+),(\d+)\](.*)$/;
		const out = [];

		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			const m = line.match(lineRe);
			if (!m) continue;

			const lineStart = Number(m[1]);
			const segments = m[3].split(/\((\d+),(\d+)\)/); // ["", off, dur, word, off, dur, word, ...]
			const words = [];
			let cursor = lineStart;
			for (let i = 1; i < segments.length; i += 3) {
				const dur = Number(segments[i + 1]);
				const wText = segments[i + 2];
				if (wText == null || wText === "" || wText === " ") {
					cursor += Number.isFinite(dur) ? dur : 0;
					continue;
				}
				const d = Number.isFinite(dur) && dur > 0 ? dur : 200;
				words.push({ time: cursor, endTime: cursor + d, text: wText });
				cursor += d;
			}
			if (!words.length) continue;

			const text2 = joinWords(words);
			if (!text2 || CREDIT_RE.test(text2)) continue;
			out.push({ time: lineStart, endTime: lineStart + (Number(m[2]) || 0), text: text2, words });
		}
		out.sort((a, b) => a.time - b.time);
		return out;
	}

	/* ------------------------------------------------------------- providers  */

	// Build word objects from a Spotify SYLLABLE_SYNCED line, if the client
	// ever returns one. `syllables` carry { startTimeMs, endTimeMs?, numChars };
	// the line's `words` string is sliced by numChars. Defensive - most
	// responses are LINE_SYNCED and this branch never runs.
	function spotifySyllables(line) {
		const syl = line.syllables;
		if (!Array.isArray(syl) || !syl.length) return null;
		const full = line.words || "";
		const words = [];
		let cursor = 0;
		for (const s of syl) {
			const n = Number(s.numChars) || 0;
			const chunk = full.slice(cursor, cursor + n);
			cursor += n;
			if (!chunk.trim()) continue;
			const start = Number(s.startTimeMs) || 0;
			words.push({ time: start, endTime: Number(s.endTimeMs) || start + 200, text: chunk });
		}
		return words.length ? words : null;
	}

	async function spotify(info) {
		if (info.kind !== "track" || !info.id) return null;

		const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${info.id}?format=json&vocalRemoval=false&market=from_token`;
		const body = await Spicetify.CosmosAsync.get(url);
		const lyrics = body && body.lyrics;
		if (!lyrics || !Array.isArray(lyrics.lines) || !lyrics.lines.length) return null;

		const meta = {
			language: lyrics.language || "",
			provider: "Spotify",
			copyright: (body.colors && body.provider) || lyrics.providerDisplayName || "Musixmatch",
		};

		if (lyrics.syncType === "SYLLABLE_SYNCED") {
			const rich = [];
			for (const line of lyrics.lines) {
				const words = spotifySyllables(line);
				const start = Number(line.startTimeMs) || 0;
				if (words) rich.push({ time: start, endTime: Number(line.endTimeMs) || 0, text: (line.words || joinWords(words)).trim(), words });
				else rich.push({ time: start, endTime: Number(line.endTimeMs) || 0, text: (line.words || "").trim() || "♪" });
			}
			if (rich.some((l) => l.words)) return { ...meta, kind: "richsync", lines: rich };
		}

		const synced = lyrics.syncType === "LINE_SYNCED";
		let lines = lyrics.lines.map((line) => ({
			time: synced ? Number(line.startTimeMs) || 0 : 0,
			text: (line.words || "").trim(),
		}));
		// Synced: an empty line is a timed instrumental gap, keep it as "♪".
		// Unsynced: an empty line is just noise, drop it.
		if (synced) lines = lines.map((l) => (l.text ? l : { ...l, text: "♪" }));
		else lines = lines.filter((l) => l.text);

		return { ...meta, kind: isInstrumentalOnly(lines) ? "instrumental" : synced ? "synced" : "unsynced", lines };
	}

	/* Netease Cloud Music - the one keyless source of real word timing. Its
	 * "yrc" (and older "klyric") fields carry per-word timestamps. Only used
	 * when it actually has word timing; its line-level "lrc" is ignored so a
	 * possible timing offset never displaces Spotify's exact line sync. */
	async function neteaseKaraoke(info, signal) {
		const NE_HEADERS = { "User-Agent": "Mozilla/5.0", Referer: "https://music.163.com" };
		const query = `${info.title} ${info.artist}`.trim();
		const search = await LXNet.getJson(
			`https://music.163.com/api/search/get?type=1&limit=10&s=${encodeURIComponent(query)}`,
			{ headers: NE_HEADERS, signal }
		);
		const songs = (search && search.result && search.result.songs) || [];
		if (!songs.length) {
			LXLog.info("netease: no search results for", query);
			return null;
		}

		// Require a plausible match: duration within 4s. Wrong-track word timing
		// would be worse than none, so a bad match returns null (-> Spotify).
		// A wrong-track match would give wrong word timing, which is worse than
		// no karaoke. Require the duration to line up (within 4s); within that
		// set, prefer an exact title match.
		const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
		const byDuration = songs.filter((s) => Math.abs((s.duration || 0) - info.durationMs) < 4000);
		const match = byDuration.find((s) => norm(s.name) === norm(info.title)) || byDuration[0];
		if (!match) {
			LXLog.info("netease: no duration-confident match for", info.title, "-", info.artist);
			return null;
		}

		const lyric = await LXNet.getJson(
			`https://music.163.com/api/song/lyric?id=${match.id}&lv=1&kv=1&tv=1&yv=1`,
			{ headers: NE_HEADERS, signal }
		);

		let lines = null;
		let format = "";
		if (lyric && lyric.yrc && lyric.yrc.lyric) {
			lines = parseYrc(lyric.yrc.lyric);
			format = "yrc";
		}
		if ((!lines || !lines.length) && lyric && lyric.klyric && lyric.klyric.lyric) {
			lines = parseKlyric(lyric.klyric.lyric);
			format = "klyric";
		}
		if (!lines || !lines.length || !lines.some((l) => l.words && l.words.length)) {
			LXLog.info("netease: matched track has no word-level lyrics");
			return null;
		}

		LXLog.info("netease karaoke:", format, lines.length, "lines, track id", match.id);
		return {
			kind: isInstrumentalOnly(lines) ? "instrumental" : "richsync",
			lines,
			language: "",
			provider: "Netease",
			copyright: "Netease Cloud Music",
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

	/* Resolve lyrics for a track. Provider order:
	 *
	 *   1. Netease  - only when karaoke is on AND it has real word timing
	 *   2. Spotify  - line-synced, timing matches playback exactly
	 *   3. LRCLIB   - line-synced community lyrics
	 *   4. (Spotify / LRCLIB unsynced fallthrough)
	 *
	 * Netease is skipped entirely unless `opts.karaoke` is true, and its
	 * result is only accepted when it carries word timing - line-level Netease
	 * never displaces Spotify. `signal` is checked between providers and after
	 * every await; the caller still drops a result whose token no longer
	 * matches.
	 */
	async function fetchLyrics(info, signal, opts) {
		const base = { uri: info.uri, lines: [], language: "", provider: "", copyright: "" };
		if (!info || info.kind !== "track") return { ...base, kind: "unsupported" };

		const chain = [];
		if (opts && opts.karaoke) chain.push(neteaseKaraoke);
		chain.push(spotify, lrclib);

		for (const provider of chain) {
			if (signal && signal.aborted) return { ...base, kind: "none" };
			try {
				const result = await provider(info, signal);
				if (signal && signal.aborted) return { ...base, kind: "none" };
				if (result && result.lines.length) return { ...base, ...result };
			} catch (e) {
				if (e && e.name === "AbortError") return { ...base, kind: "none" };
				LXLog.warn("lyrics provider failed:", provider.name, e && e.message);
			}
		}
		return { ...base, kind: "none" };
	}

	return { fetchLyrics, parseLrc, parsePlain, parseYrc, parseKlyric };
})();
