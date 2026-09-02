/* 404Lyrics - Spotify player integration.
 *
 * The single place that touches `Spicetify.Player`. Everything the rest of the
 * app needs about "what is playing and where" comes through here, normalised
 * into a plain object so a Spotify metadata reshuffle only has to be handled
 * once.
 */
const LXPlayer = (() => {
	// Spotify hands artwork either as a CDN URL already or as a `spotify:image:`
	// URI that has to be rewritten to be usable in CSS.
	function imageUrl(raw) {
		if (!raw || typeof raw !== "string") return "";
		if (raw.startsWith("spotify:image:")) return "https://i.scdn.co/image/" + raw.slice("spotify:image:".length);
		return raw;
	}

	// track / episode / local / ad / ""  -> drives which experience we show.
	function kindOf(uri) {
		if (typeof uri !== "string") return "";
		const parts = uri.split(":");
		return parts.length > 1 ? parts[1] : "";
	}

	function currentItem() {
		try {
			const data = Spicetify.Player && Spicetify.Player.data;
			return (data && (data.item || data.track)) || null;
		} catch (e) {
			return null;
		}
	}

	function infoFromItem(item) {
		if (!item) return null;
		const meta = item.metadata || {};
		const uri = item.uri || meta.uri || "";
		if (!uri) return null;

		let durationMs = Number(item.duration && item.duration.milliseconds);
		if (!Number.isFinite(durationMs) || durationMs <= 0) durationMs = Number(meta.duration) || 0;

		const artist = meta.artist_name || (item.artists && item.artists[0] && item.artists[0].name) || "";

		return {
			uri,
			id: uri.split(":")[2] || "",
			kind: kindOf(uri),
			title: item.name || meta.title || "Unknown",
			artist,
			album: (item.album && item.album.name) || meta.album_title || "",
			durationMs,
			image: imageUrl(meta.image_xlarge_url || meta.image_url || meta.image_large_url || ""),
		};
	}

	function info() {
		return infoFromItem(currentItem());
	}

	function progress() {
		try {
			const p = Number(Spicetify.Player.getProgress());
			return Number.isFinite(p) && p > 0 ? p : 0;
		} catch (e) {
			return 0;
		}
	}

	function playing() {
		try {
			return !!Spicetify.Player.isPlaying();
		} catch (e) {
			return false;
		}
	}

	function seek(ms) {
		try {
			Spicetify.Player.seek(Math.max(0, Math.round(ms)));
			return true;
		} catch (e) {
			return false;
		}
	}

	/* One subscription helper so callers never juggle raw add/removeEventListener
	 * pairs. Returns an unsubscribe function that detaches every listener it
	 * attached, which is what keeps the view leak-free across remounts. */
	function subscribe(handlers) {
		const bound = [];
		const add = (name, fn) => {
			if (typeof fn !== "function") return;
			const wrapped = (e) => {
				try {
					fn(e);
				} catch (err) {
					/* a throwing handler must not corrupt Spotify's listener list */
				}
			};
			try {
				Spicetify.Player.addEventListener(name, wrapped);
				bound.push([name, wrapped]);
			} catch (e) {
				/* event unsupported on this client - skip it */
			}
		};

		add("songchange", handlers.onSong);
		add("onprogress", handlers.onProgress);
		add("onplaypause", handlers.onPlayPause);

		return () => {
			for (const [name, wrapped] of bound) {
				try {
					Spicetify.Player.removeEventListener(name, wrapped);
				} catch (e) {
					/* ignore */
				}
			}
			bound.length = 0;
		};
	}

	return { info, infoFromItem, currentItem, progress, playing, seek, subscribe, imageUrl };
})();
