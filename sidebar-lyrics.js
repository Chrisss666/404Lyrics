/* 404Lyrics - right sidebar mini lyrics box.
 *
 * Registered as `subfiles_extension`. Shows the current lyric line (with the
 * word-by-word karaoke fill) and the upcoming line in a small box under the
 * cover / title / artist in the Now Playing (right sidebar) view, plus the next
 * three lines. Word-timed Netease lyrics get the karaoke fill; otherwise
 * line-synced Spotify / LRCLIB lyrics are shown line by line. The box only
 * exists while synced lyrics exist for the current track; with word-by-word
 * (karaoke) mode off it shows line-synced lyrics only. Otherwise it is removed
 * from the DOM.
 *
 * Self-contained: runs in its own scope and shares only the `404lyrics:`
 * storage prefix with the app. The Netease lookup mirrors neteaseKaraoke() in
 * src/providers.js.
 */
(function SidebarLyrics() {
	if (!(window.Spicetify && Spicetify.Player && Spicetify.Player.addEventListener && Spicetify.Platform && Spicetify.CosmosAsync)) {
		setTimeout(SidebarLyrics, 300);
		return;
	}

	const SETTING_KARAOKE = "404lyrics:setting:karaoke"; // default on
	const SETTING_BOX = "404lyrics:setting:sidebar-lyrics"; // default on
	const BOX_ID = "lx-sb-box";
	const STYLE_ID = "lx-sb-style";
	const NE_HEADERS = { "User-Agent": "Mozilla/5.0", Referer: "https://music.163.com" };
	const CREDIT_RE = /^\s*(作词|作曲|编曲|制作|监制|混音|母带|吉他|贝斯|鼓|和声|录音|策划|统筹|出品|发行|词|曲|producer|writ|compos|arrang|mix|master|guitar|bass|drums|vocal|lyric)s?\b.*(:|：)/i;
	const MAX_ATTEMPTS = 4;
	const RETRY_MS = 8000;
	const UPCOMING = 3; // current line + 3 upcoming = 4 lines shown

	const log = (...a) => {
		try {
			if (localStorage.getItem("404lyrics:debug") === "true") console.info("[404Lyrics sidebar]", ...a);
		} catch (e) {}
	};

	const cache = new Map(); // uri -> lines[] | null (null = confirmed: no karaoke lyrics)
	let token = 0;
	let loadedMode = karaokeOn(); // word-by-word mode the current lyrics were loaded for
	let trackUri = ""; // track the current load/state belongs to
	let loading = false;
	let attempts = 0;
	let lastAttempt = 0;
	let lines = null; // active lyrics for the current track, or null
	let activeIndex = -2;
	let box = null;
	let curEl = null;
	let nextEls = [];
	let wordEls = [];
	let wordShown = [];

	/* ------------------------------------------------------------- settings */

	function boxOn() {
		try {
			const raw = localStorage.getItem(SETTING_BOX);
			return raw == null ? true : raw === "true";
		} catch (e) {
			return true;
		}
	}

	function karaokeOn() {
		try {
			const raw = localStorage.getItem(SETTING_KARAOKE);
			return raw == null ? true : raw === "true";
		} catch (e) {
			return true;
		}
	}

	// Word-timed and line-only lookups give different results for a track.
	const cacheKey = (info) => info.uri + (loadedMode ? "|w" : "|l");

	/* -------------------------------------------------------------- parsing */

	function joinWords(words) {
		return words
			.map((w) => w.text)
			.join("")
			.replace(/\s+/g, " ")
			.trim();
	}

	function parseYrc(text) {
		const lineRe = /^\[(\d+),(\d+)\](.*)$/;
		const wordRe = /\((\d+),(\d+),\d+\)([^(]*)/g;
		const out = [];
		for (const raw of text.split(/\r?\n/)) {
			const m = raw.trim().match(lineRe);
			if (!m) continue;
			const words = [];
			let wm;
			wordRe.lastIndex = 0;
			while ((wm = wordRe.exec(m[3]))) {
				if (wm[3] === "") continue;
				const t = Number(wm[1]);
				words.push({ time: t, endTime: t + Math.max(Number(wm[2]), 1), text: wm[3] });
			}
			if (!words.length) continue;
			const t = joinWords(words);
			if (!t || CREDIT_RE.test(t)) continue;
			out.push({ time: Number(m[1]), text: t, words });
		}
		return out.sort((a, b) => a.time - b.time);
	}

	function parseKlyric(text) {
		const lineRe = /^\[(\d+),(\d+)\](.*)$/;
		const out = [];
		for (const raw of text.split(/\r?\n/)) {
			const m = raw.trim().match(lineRe);
			if (!m) continue;
			const seg = m[3].split(/\((\d+),(\d+)\)/);
			const words = [];
			let cursor = Number(m[1]);
			for (let i = 1; i < seg.length; i += 3) {
				const dur = Number(seg[i + 1]);
				const w = seg[i + 2];
				if (w == null || w === "" || w === " ") {
					cursor += Number.isFinite(dur) ? dur : 0;
					continue;
				}
				const d = Number.isFinite(dur) && dur > 0 ? dur : 200;
				words.push({ time: cursor, endTime: cursor + d, text: w });
				cursor += d;
			}
			if (!words.length) continue;
			const t = joinWords(words);
			if (!t || CREDIT_RE.test(t)) continue;
			out.push({ time: Number(m[1]), text: t, words });
		}
		return out.sort((a, b) => a.time - b.time);
	}

	/* --------------------------------------------------------------- lookup */

	// Same transport order as LXNet.getJson: CosmosAsync goes through Spotify's
	// native networking (no CORS/CSP), plain fetch is only a fallback.
	function coerce(v) {
		if (typeof v !== "string") return v;
		try {
			return JSON.parse(v);
		} catch (e) {
			return v;
		}
	}

	async function getJson(url) {
		let first;
		try {
			const data = coerce(await Spicetify.CosmosAsync.get(url, null, NE_HEADERS));
			if (data && typeof data === "object") return data;
			first = new Error("cosmos: non-JSON body");
		} catch (e) {
			first = e;
		}
		try {
			const res = await fetch(url, { headers: NE_HEADERS });
			if (!res.ok) throw new Error("HTTP " + res.status);
			return coerce(await res.text());
		} catch (e) {
			throw first || e;
		}
	}

	/* Line-synced fallbacks (same sources/order as the app: Spotify, LRCLIB). */

	function parseLrc(text) {
		const stampRe = /\[(\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?)\]/g;
		const out = [];
		for (const rawLine of text.split(/\r?\n/)) {
			if (/^\[[a-z]+:/i.test(rawLine.trim())) continue; // [ar:...] metadata
			const stamps = [];
			let m;
			stampRe.lastIndex = 0;
			while ((m = stampRe.exec(rawLine))) stamps.push(m[1]);
			if (!stamps.length) continue;
			const t = rawLine.replace(stampRe, "").trim();
			for (const stamp of stamps) {
				const parts = stamp.split(":");
				let sec = Number(parts.pop());
				const min = Number(parts.pop() || 0);
				if (!Number.isFinite(sec)) sec = 0;
				out.push({ time: Math.round(((Number.isFinite(min) ? min : 0) * 60 + sec) * 1000), text: t || "♪" });
			}
		}
		return out.sort((a, b) => a.time - b.time);
	}

	async function fetchSpotifyLines(info) {
		const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${info.uri.split(":")[2]}?format=json&vocalRemoval=false&market=from_token`;
		const body = await Spicetify.CosmosAsync.get(url);
		const ly = body && body.lyrics;
		if (!ly || !Array.isArray(ly.lines) || !ly.lines.length) return null;
		if (ly.syncType !== "LINE_SYNCED" && ly.syncType !== "SYLLABLE_SYNCED") return null;
		const out = ly.lines.map((l) => ({ time: Number(l.startTimeMs) || 0, text: (l.words || "").trim() || "♪" }));
		return out.length ? out.sort((a, b) => a.time - b.time) : null;
	}

	async function fetchLrclibLines(info) {
		const params = new URLSearchParams({
			track_name: info.title,
			artist_name: info.artist,
			album_name: info.album,
			duration: String(Math.round(info.durationMs / 1000)),
		});
		let res;
		try {
			res = await fetch(`https://lrclib.net/api/get?${params.toString()}`);
		} catch (e) {
			return null;
		}
		if (!res.ok) return null;
		const body = await res.json();
		if (body.instrumental || !body.syncedLyrics) return null;
		const out = parseLrc(body.syncedLyrics);
		return out.length ? out : null;
	}

	// Word-timed Netease first, then line-synced Spotify / LRCLIB. Throws only
	// when nothing was found AND a provider errored (so it is worth retrying).
	async function fetchLines(info, wordMode) {
		let failure = null;
		const providers = wordMode ? [fetchKaraoke, fetchSpotifyLines, fetchLrclibLines] : [fetchSpotifyLines, fetchLrclibLines];
		for (const provider of providers) {
			try {
				const res = await provider(info);
				if (res && res.length) return res;
			} catch (e) {
				failure = failure || e;
			}
		}
		if (failure) throw failure;
		return null;
	}

	async function fetchKaraoke(info) {
		const search = await getJson(
			`https://music.163.com/api/search/get?type=1&limit=10&s=${encodeURIComponent(`${info.title} ${info.artist}`.trim())}`
		);
		const songs = (search && search.result && search.result.songs) || [];
		const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
		const close = songs.filter((s) => Math.abs((s.duration || 0) - info.durationMs) < 4000);
		const match = close.find((s) => norm(s.name) === norm(info.title)) || close[0];
		if (!match) return null;

		const lyric = await getJson(`https://music.163.com/api/song/lyric?id=${match.id}&lv=1&kv=1&tv=1&yv=1`);
		let out = null;
		if (lyric && lyric.yrc && lyric.yrc.lyric) out = parseYrc(lyric.yrc.lyric);
		if ((!out || !out.length) && lyric && lyric.klyric && lyric.klyric.lyric) out = parseKlyric(lyric.klyric.lyric);
		return out && out.length ? out : null;
	}

	function trackInfo() {
		const item = Spicetify.Player.data && Spicetify.Player.data.item;
		if (!item || item.type !== "track" || !item.uri || item.uri.indexOf("spotify:track:") !== 0) return null;
		const md = item.metadata || {};
		return {
			uri: item.uri,
			title: item.name || md.title || "",
			artist: (item.artists && item.artists[0] && item.artists[0].name) || md.artist_name || "",
			album: (item.album && item.album.name) || md.album_title || "",
			durationMs: (item.duration && item.duration.milliseconds) || Number(md.duration) || 0,
		};
	}

	/* ----------------------------------------------------------- current line */

	function indexAt(list, pos) {
		let lo = 0;
		let hi = list.length - 1;
		let res = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (list[mid].time <= pos) {
				res = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		return res;
	}

	/* ------------------------------------------------------------------ DOM */

	function injectStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const s = document.createElement("style");
		s.id = STYLE_ID;
		s.textContent = `
#${BOX_ID}{grid-column:1/-1;grid-row:auto;justify-self:stretch;width:auto;max-width:100%;margin:8px 0 4px;position:relative;z-index:10;pointer-events:none;
	padding:10px 14px;border-radius:10px;background:rgba(255,255,255,.07);box-sizing:border-box;
	text-align:left;overflow:hidden}
#${BOX_ID} .lx-sb-cur{font-size:15px;font-weight:700;line-height:1.35;white-space:pre-wrap;
	display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:1.35em}
#${BOX_ID} .lx-sb-w{color:transparent;-webkit-background-clip:text;background-clip:text;
	background-image:linear-gradient(90deg,#fff calc(var(--p,0)*100%),rgba(255,255,255,.4) calc(var(--p,0)*100%))}
#${BOX_ID} .lx-sb-next{margin-top:4px;font-size:12px;font-weight:600;line-height:1.35;color:rgba(255,255,255,.45);
	white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${BOX_ID} .lx-sb-next:nth-of-type(3){color:rgba(255,255,255,.34)}
#${BOX_ID} .lx-sb-next:nth-of-type(4){color:rgba(255,255,255,.24)}
#${BOX_ID} .lx-sb-next:empty{display:none}`;
		document.head.appendChild(s);
	}

	// The element after which the box goes: the title/artist block of the
	// Now Playing view. Several selectors, since Spotify renames classes.
	function findAnchor() {
		const info = document.querySelector(".main-nowPlayingView-contextItemInfo");
		if (info) return info;
		const title = document.querySelector('[data-testid="context-item-info-title"], [data-testid="context-item-link"]');
		if (!title || !title.closest('.Root__right-sidebar, #Desktop_PanelContainer_Id, aside, [class*="nowPlayingView"]')) return null;
		const artist = document.querySelector('[data-testid="context-item-info-artist"], [data-testid="context-item-info-subtitles"]');
		let el = title;
		if (artist) {
			while (el.parentElement && !el.contains(artist)) el = el.parentElement;
		} else if (el.parentElement) {
			el = el.parentElement;
		}
		return el;
	}

	function removeBox() {
		if (box && box.parentNode) box.parentNode.removeChild(box);
		const stray = document.getElementById(BOX_ID);
		if (stray && stray.parentNode) stray.parentNode.removeChild(stray);
		box = curEl = null;
		nextEls = [];
		wordEls = [];
		wordShown = [];
	}

	function ensureBox() {
		const anchor = findAnchor();
		if (!anchor || !anchor.parentNode) {
			if (box && !box.isConnected) removeBox();
			return false;
		}
		if (box && box.isConnected && box.previousElementSibling === anchor) return true;
		removeBox();
		injectStyle();
		box = document.createElement("div");
		box.id = BOX_ID;
		curEl = document.createElement("div");
		curEl.className = "lx-sb-cur";
		box.appendChild(curEl);
		nextEls = [];
		for (let i = 0; i < UPCOMING; i++) {
			const el = document.createElement("div");
			el.className = "lx-sb-next";
			box.appendChild(el);
			nextEls.push(el);
		}
		anchor.parentNode.insertBefore(box, anchor.nextSibling);
		activeIndex = -2; // force text rebuild
		return true;
	}

	/* --------------------------------------------------------------- update */

	function shouldShow() {
		return !!(lines && boxOn());
	}

	function buildLine(line) {
		curEl.textContent = "";
		wordEls = [];
		wordShown = [];
		if (!line) return;
		// Line-synced lyrics carry no word timing: one solid, fully lit span.
		const parts = line.words || [{ text: line.text }];
		for (const w of parts) {
			const span = document.createElement("span");
			span.className = "lx-sb-w";
			span.textContent = w.text;
			if (!line.words) span.style.setProperty("--p", "1");
			curEl.appendChild(span);
			wordEls.push(span);
			wordShown.push(-1);
		}
	}

	// Soft line change: the new current line rises in while the upcoming line
	// fades up behind it, instead of both text nodes snapping.
	const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)");
	function transition(hasCurrent) {
		if (!curEl.animate || (reduceMotion && reduceMotion.matches)) return;
		const ease = "cubic-bezier(.22,.8,.24,1)";
		if (hasCurrent) {
			curEl.animate(
				[
					{ opacity: 0, transform: "translateY(8px)" },
					{ opacity: 1, transform: "translateY(0)" },
				],
				{ duration: 420, easing: ease }
			);
		}
		nextEls.forEach((el, i) => {
			if (!el.textContent) return;
			el.animate(
				[
					{ opacity: 0, transform: "translateY(6px)" },
					{ opacity: 1, transform: "translateY(0)" },
				],
				{ duration: 520, easing: ease, delay: 60 + i * 50, fill: "backwards" }
			);
		});
	}

	// Cheap per-frame work: only touches the DOM when something changed.
	function update() {
		if (!box || !box.isConnected || !lines) return;
		const pos = Spicetify.Player.getProgress() || 0;
		const idx = indexAt(lines, pos);
		if (idx !== activeIndex) {
			activeIndex = idx;
			buildLine(idx >= 0 ? lines[idx] : null);
			for (let i = 0; i < nextEls.length; i++) {
				const upcoming = lines[idx + 1 + i]; // idx -1 => starts at the first line
				nextEls[i].textContent = upcoming ? upcoming.text : "";
			}
			transition(idx >= 0);
		}
		if (idx < 0) {
			// Intro: nothing is being sung yet; the first line shows as "upcoming".
			return;
		}
		const words = lines[idx].words;
		if (!words) return; // line-synced: nothing to fill
		for (let i = 0; i < wordEls.length; i++) {
			const w = words[i];
			const end = w.endTime > w.time ? w.endTime : w.time + 200;
			let p = (pos - w.time) / (end - w.time);
			p = p < 0 ? 0 : p > 1 ? 1 : Math.round(p * 50) / 50;
			if (p !== wordShown[i]) {
				wordShown[i] = p;
				wordEls[i].style.setProperty("--p", String(p));
			}
		}
	}

	function tick() {
		if (!shouldShow()) {
			removeBox();
			return;
		}
		if (ensureBox()) update();
	}

	/* ----------------------------------------------------------------- load */

	async function load() {
		const my = ++token;
		lines = null;
		activeIndex = -2;
		loading = false;
		removeBox();

		const info = trackInfo();
		trackUri = info ? info.uri : "";
		loadedMode = karaokeOn();
		attempts = 0;
		if (!info || !boxOn()) return;

		const key = cacheKey(info);
		if (cache.has(key)) {
			lines = cache.get(key);
			tick();
			return;
		}
		await attempt(info, my);
	}

	async function attempt(info, my) {
		loading = true;
		attempts++;
		lastAttempt = Date.now();
		try {
			const res = await fetchLines(info, loadedMode);
			if (my !== token) return; // stale
			cache.set(cacheKey(info), res);
			lines = res;
			attempts = MAX_ATTEMPTS; // definitive answer, stop retrying
			log("karaoke lines:", res ? res.length : 0, "anchor found:", !!findAnchor());
		} catch (e) {
			if (my !== token) return;
			log("lookup failed:", e && e.message);
		} finally {
			if (my === token) loading = false;
		}
		if (my === token) tick();
	}

	// Housekeeping: startup races (Player data / network not ready yet), a
	// track that was already playing before this extension loaded, transient
	// lookup failures, and the karaoke setting flipping (same-window
	// localStorage writes fire no `storage` event).
	function housekeeping() {
		const info = trackInfo();
		if (karaokeOn() !== loadedMode) {
			load(); // word-by-word toggled: reload with the matching providers
			return;
		}
		if (info && !loading && !lines && boxOn()) {
			if (info.uri !== trackUri) {
				load();
				return;
			}
			const key = cacheKey(info);
			if (cache.has(key)) {
				lines = cache.get(key);
			} else if (attempts < MAX_ATTEMPTS && Date.now() - lastAttempt > RETRY_MS) {
				attempt(info, token);
				return;
			}
		}
		tick();
	}

	/* ----------------------------------------------------------------- init */

	Spicetify.Player.addEventListener("songchange", load);
	setInterval(housekeeping, 400);

	// Smooth word fill while playing.
	(function frame() {
		try {
			if (box && lines && Spicetify.Player.isPlaying()) update();
		} catch (e) {}
		requestAnimationFrame(frame);
	})();

	load();
})();
