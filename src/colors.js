/* 404Lyrics - artwork colour extraction.
 *
 * Produces the palette the immersive background and the active-line glow are
 * built from. Every source Spotify exposes for this is version-fragile, so the
 * three of them are tried in order and a neutral palette is always returned -
 * a colour failure must never stop lyrics from rendering.
 */
const LXColors = (() => {
	const FALLBACK = { accent: "#8b5cf6", base: "#161821" };

	/* ------------------------------------------------------------ colour math */

	function hexToRgb(hex) {
		const h = String(hex).replace("#", "").trim();
		const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
		const int = Number.parseInt(n, 16);
		if (!Number.isFinite(int)) return null;
		return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
	}

	function intToRgb(int) {
		return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
	}

	function rgbToHex({ r, g, b }) {
		const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
		return "#" + c(r) + c(g) + c(b);
	}

	function rgbToHsl({ r, g, b }) {
		r /= 255;
		g /= 255;
		b /= 255;
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const l = (max + min) / 2;
		let h = 0;
		let s = 0;
		if (max !== min) {
			const d = max - min;
			s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
			if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
			else if (max === g) h = (b - r) / d + 2;
			else h = (r - g) / d + 4;
			h /= 6;
		}
		return { h, s, l };
	}

	function hslToRgb({ h, s, l }) {
		if (s === 0) {
			const v = l * 255;
			return { r: v, g: v, b: v };
		}
		const hue2rgb = (p, q, t) => {
			if (t < 0) t += 1;
			if (t > 1) t -= 1;
			if (t < 1 / 6) return p + (q - p) * 6 * t;
			if (t < 1 / 2) return q;
			if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
			return p;
		};
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		return { r: hue2rgb(p, q, h + 1 / 3) * 255, g: hue2rgb(p, q, h) * 255, b: hue2rgb(p, q, h - 1 / 3) * 255 };
	}

	/* The raw swatch is whatever the artwork happens to be - too dark, too
	 * washed out or neon. Pin it to a band that reads as a glow on a dark
	 * scrim without ever fighting the white lyric text for attention. */
	function tuneAccent(rgb) {
		const hsl = rgbToHsl(rgb);
		// Only pull saturation up when the swatch already has a hue to work
		// with - forcing saturation onto a near-grey swatch would invent a
		// (usually red) colour that is nowhere in the artwork.
		if (hsl.s >= 0.12) hsl.s = Math.max(0.5, Math.min(0.92, hsl.s));
		hsl.l = Math.max(0.6, Math.min(0.74, hsl.l));
		return rgbToHex(hslToRgb(hsl));
	}

	// Deep, slightly desaturated version of the artwork used for the ambient
	// gradient. Kept dark on purpose: the scrim above it does the readability
	// work, this only tints it.
	function tuneBase(rgb) {
		const hsl = rgbToHsl(rgb);
		hsl.s = Math.min(0.5, hsl.s);
		hsl.l = 0.14;
		return rgbToHex(hslToRgb(hsl));
	}

	/* --------------------------------------------------------------- sources */

	async function fromColorExtractor(uri) {
		if (!Spicetify.colorExtractor) return null;
		const map = await Spicetify.colorExtractor(uri);
		if (!map) return null;
		const accent = map.VIBRANT || map.LIGHT_VIBRANT || map.PROMINENT || map.VIBRANT_NON_ALARMING || map.DESATURATED;
		const base = map.DESATURATED || map.PROMINENT || accent;
		if (!accent) return null;
		return { accentRgb: hexToRgb(accent), baseRgb: hexToRgb(base) || hexToRgb(accent) };
	}

	async function fromGraphQL(uri) {
		const defs = Spicetify.GraphQL && Spicetify.GraphQL.Definitions;
		if (!defs || !defs.fetchExtractedColorForTrackEntity) return null;
		const { data } = await Spicetify.GraphQL.Request(defs.fetchExtractedColorForTrackEntity, { uri });
		const colors = data && data.trackUnion && data.trackUnion.albumOfTrack && data.trackUnion.albumOfTrack.coverArt.extractedColors;
		const hex = colors && (colors.colorDark || colors.colorRaw || colors.colorLight);
		if (!hex || !hex.hex) return null;
		const rgb = hexToRgb(hex.hex);
		return rgb ? { accentRgb: rgb, baseRgb: rgb } : null;
	}

	async function fromCosmos(uri, signal) {
		const res = await Spicetify.CosmosAsync.get(
			`https://spclient.wg.spotify.com/colorextractor/v1/extract-presets?uri=${encodeURIComponent(uri)}&format=json`
		);
		if (signal && signal.aborted) return null;
		const swatches = res && res.entries && res.entries[0] && res.entries[0].color_swatches;
		if (!swatches || !swatches.length) return null;
		const pick = (preset) => swatches.find((s) => s.preset === preset);
		const accent = pick("VIBRANT") || pick("VIBRANT_NON_ALARMING") || pick("LIGHT_VIBRANT") || swatches[0];
		const base = pick("DESATURATED") || pick("DARK_VIBRANT") || accent;
		return { accentRgb: intToRgb(accent.color), baseRgb: intToRgb(base.color) };
	}

	async function extract(uri, signal) {
		if (!uri || !uri.startsWith("spotify:track:")) return FALLBACK;

		for (const source of [fromColorExtractor, fromGraphQL, fromCosmos]) {
			if (signal && signal.aborted) return FALLBACK;
			try {
				const raw = await source(uri, signal);
				if (raw && raw.accentRgb) {
					return {
						accent: tuneAccent(raw.accentRgb),
						base: tuneBase(raw.baseRgb || raw.accentRgb),
					};
				}
			} catch (e) {
				/* try the next source */
			}
		}
		return FALLBACK;
	}

	return { extract, FALLBACK };
})();
