/* 404Lyrics - preferences.
 *
 * Every user-facing toggle lives here behind namespaced localStorage keys
 * (`404lyrics:setting:*`). Nothing is uploaded; this is the only place the
 * app writes persistent state. Reads are cheap and tolerate storage that is
 * disabled or throws (private windows, locked-down clients).
 */
const LXSettings = (() => {
	const PREFIX = "404lyrics:setting:";

	// A small, deliberately short list: the languages people actually pick for
	// lyric translation, plus whatever the client locale resolves to. Kept as
	// [code, label] so the label survives even when Intl.DisplayNames does not.
	const LANGUAGES = [
		["en", "English"],
		["es", "Spanish"],
		["pt", "Portuguese"],
		["fr", "French"],
		["de", "German"],
		["it", "Italian"],
		["nl", "Dutch"],
		["pl", "Polish"],
		["ru", "Russian"],
		["uk", "Ukrainian"],
		["tr", "Turkish"],
		["ar", "Arabic"],
		["hi", "Hindi"],
		["id", "Indonesian"],
		["vi", "Vietnamese"],
		["th", "Thai"],
		["ja", "Japanese"],
		["ko", "Korean"],
		["zh", "Chinese"],
		["sv", "Swedish"],
		["fi", "Finnish"],
		["el", "Greek"],
	];

	// Background style + animation-intensity option lists, shared with the UI.
	const BG_STYLES = [
		["artwork", "Artwork blur"],
		["gradient", "Dynamic gradient"],
		["solid", "Solid"],
	];
	const ANIM_LEVELS = [
		["off", "Off"],
		["low", "Low"],
		["normal", "Normal"],
		["high", "High"],
	];
	// Drift speed / amplitude multiplier per level. 0 = decorative motion off.
	const ANIM_MULT = { off: 0, low: 0.5, normal: 1, high: 1.7 };

	const DEFAULTS = {
		"translate-enabled": false,
		"translate-lang": "", // resolved lazily from the client locale on first read
		karaoke: true, // use word-by-word timing when a provider has it
		"focus-mode": false, // minimal, immersive single-line emphasis
		"bg-style": "artwork", // artwork | gradient | solid
		"bg-blur": 70, // 0..100 slider -> ~0..72px (default maps to the current 50px)
		"bg-dim": 50, // 0..100 slider -> scrim darkness (default maps to the current look)
		"bg-anim": "normal", // off | low | normal | high
		autohide: true, // fade the control cluster while the mouse is still
	};

	/* Slider-value -> CSS mappings. Kept here so the meaning of a stored number
	 * lives in one place. Ranges are deliberately modest - 100 does not mean
	 * 100px of blur, and dim has a hard floor so lyrics stay readable. */
	function bgBlurPx(v) {
		const n = Number(v);
		return Math.round((Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : DEFAULTS["bg-blur"]) * 0.72);
	}
	function bgDim(v) {
		const n = Number(v);
		const pct = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : DEFAULTS["bg-dim"];
		// 0.33 floor keeps near-white text readable over the brightest artwork;
		// 0.83 ceiling stops the background disappearing entirely.
		return 0.33 + (pct / 100) * 0.5;
	}

	function read(key) {
		try {
			return localStorage.getItem(PREFIX + key);
		} catch (e) {
			return null;
		}
	}

	function write(key, value) {
		try {
			localStorage.setItem(PREFIX + key, value);
		} catch (e) {
			/* storage is best-effort; the UI still works for this session */
		}
	}

	// Best guess at the language the user reads Spotify in. Spicetify.Locale is
	// the supported surface; the rest are fallbacks for older clients.
	function detectLocale() {
		let tag = "";
		try {
			tag =
				(Spicetify.Locale && Spicetify.Locale.getLocale && Spicetify.Locale.getLocale()) ||
				(Spicetify.Platform && Spicetify.Platform.PlatformData && Spicetify.Platform.PlatformData.locale) ||
				navigator.language ||
				"";
		} catch (e) {
			tag = navigator.language || "";
		}
		const primary = String(tag).toLowerCase().split(/[-_]/)[0];
		return LANGUAGES.some(([code]) => code === primary) ? primary : "en";
	}

	function get(key) {
		const raw = read(key);

		if (key === "translate-lang") return raw || detectLocale();

		if (key === "bg-style") return BG_STYLES.some(([v]) => v === raw) ? raw : DEFAULTS[key];

		if (key === "bg-anim") {
			if (ANIM_LEVELS.some(([v]) => v === raw)) return raw;
			// Migrate the old boolean "ambient" toggle: ambient:false -> Off.
			try {
				if (localStorage.getItem(PREFIX + "ambient") === "false") return "off";
			} catch (e) {
				/* ignore */
			}
			return DEFAULTS[key];
		}

		if (key === "bg-blur" || key === "bg-dim") {
			const n = Number(raw);
			return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : DEFAULTS[key];
		}

		if (typeof DEFAULTS[key] === "boolean") {
			if (raw === null) return DEFAULTS[key];
			return raw === "true";
		}
		return raw === null ? DEFAULTS[key] : raw;
	}

	function set(key, value) {
		write(key, String(value));
	}

	function languageLabel(code) {
		const known = LANGUAGES.find(([c]) => c === code);
		if (known) return known[1];
		try {
			const dn = new Intl.DisplayNames([code, "en"], { type: "language" });
			return dn.of(code) || code;
		} catch (e) {
			return code;
		}
	}

	return {
		get,
		set,
		detectLocale,
		languageLabel,
		bgBlurPx,
		bgDim,
		ANIM_MULT,
		LANGUAGES,
		BG_STYLES,
		ANIM_LEVELS,
		DEFAULTS,
	};
})();
