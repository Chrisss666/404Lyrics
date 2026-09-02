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

	const DEFAULTS = {
		"translate-enabled": false,
		"translate-lang": "", // resolved lazily from the client locale on first read
		ambient: true, // slow background drift
		autohide: true, // fade the control cluster while the mouse is still
	};

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
		if (key === "translate-lang") {
			return raw || detectLocale();
		}
		if (typeof DEFAULTS[key] === "boolean") {
			if (raw === null) return DEFAULTS[key];
			return raw === "true";
		}
		return raw === null ? DEFAULTS[key] : raw;
	}

	function set(key, value) {
		write(key, typeof value === "boolean" ? String(value) : value);
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

	return { get, set, detectLocale, languageLabel, LANGUAGES, DEFAULTS };
})();
