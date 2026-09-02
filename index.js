/* 404Lyrics - app entry point.
 *
 * Spicetify concatenates the manifest's subfiles ahead of this file into one
 * shared scope and calls the global render(). The subfiles own the hard parts
 * (player, providers, translation, colours, sync, view builders); this file is
 * the shell that holds state, drives the playback clock and decides which
 * screen is on.
 *
 * Race safety: every track load takes a monotonic token and its own
 * AbortController. Lyrics, colour and translation results are dropped unless
 * their token still matches the current one, so a slow response for a track
 * the user already skipped away from can never overwrite what is playing.
 */

const react = Spicetify.React;

/* ------------------------------------------------------------- background */

function BgLayer(props) {
	const { info, palette, ambient, reduceMotion, artKey } = props;
	return react.createElement(
		"div",
		{
			className: "lx-bg" + (ambient && !reduceMotion ? " lx-bg--ambient" : ""),
			style: { "--lx-base": palette.base, "--lx-accent": palette.accent },
		},
		info && info.image
			? react.createElement("div", {
					key: artKey,
					className: "lx-bg__art",
					style: { backgroundImage: `url("${info.image}")` },
				})
			: null,
		react.createElement("div", { className: "lx-bg__grad" }),
		react.createElement("div", { className: "lx-bg__scrim" })
	);
}

/* ------------------------------------------------------------- lyric list */

function Lines(props) {
	const { data, translations, activeIndex, showTranslations, onSeek, reduceMotion, wordsRef } = props;
	const linesRef = react.useRef(null);
	const karaoke = data.kind === "richsync";
	const synced = data.kind === "synced" || karaoke;
	const anchor = activeIndex < 0 ? 0 : activeIndex;

	// Keep the active line on a fixed reading line (~42% down the stage) by
	// sliding the whole column with one transform. The CSS transition on that
	// transform is what makes the scroll smooth; we only ever set a target.
	react.useLayoutEffect(() => {
		const el = linesRef.current;
		if (!el || !synced) return;
		const active = el.children[anchor];
		const stage = el.parentElement;
		if (!active || !stage) return;
		const target = stage.clientHeight * 0.42;
		const lineCenter = active.offsetTop + active.offsetHeight / 2;
		el.style.transform = `translate3d(0, ${Math.round(target - lineCenter)}px, 0)`;
	}, [anchor, synced, showTranslations, translations, data]);

	const children = data.lines.map((line, i) => {
		const text = (line.text || "").trim();
		const dist = synced ? i - anchor : 0;
		const ad = Math.abs(dist);
		const isActive = synced && i === activeIndex;
		const seekable = synced && Number.isFinite(line.time) && line.time > 0;
		const tr = showTranslations ? translations[text] : null;
		const showWords = karaoke && isActive && Array.isArray(line.words) && line.words.length > 0;

		// The active karaoke line renders one span per word (base + fill
		// overlay); every other line stays a single plain span so only ~1 line
		// ever holds the extra DOM.
		const textNode = showWords
			? react.createElement(
					"span",
					{ className: "lx-line__text lx-line__text--kara", ref: wordsRef },
					line.words.map((w, wi) =>
						react.createElement(
							"span",
							{ key: wi, className: "lx-word" },
							react.createElement("span", { className: "lx-word__base" }, w.text),
							react.createElement("span", { className: "lx-word__fill", "aria-hidden": "true" }, w.text)
						)
					)
				)
			: react.createElement("span", { className: "lx-line__text" }, text || "♪");

		const handlers = seekable
			? {
					onClick: () => onSeek(line.time),
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onSeek(line.time);
						}
					},
				}
			: {};

		return react.createElement(
			"div",
			Object.assign(
				{
					key: i,
					className:
						"lx-line" +
						(isActive ? " lx-line--active" : "") +
						(synced && dist < 0 ? " lx-line--past" : ""),
					style: synced ? { "--ad": ad, opacity: ad > 14 ? 0 : undefined } : undefined,
					role: seekable ? "button" : undefined,
					tabIndex: seekable ? 0 : undefined,
					"aria-label": seekable ? `Play from “${text || "instrumental break"}”` : undefined,
					"aria-current": isActive ? "true" : undefined,
				},
				handlers
			),
			textNode,
			tr ? react.createElement("span", { className: "lx-line__tr", lang: props.targetLang }, tr) : null,
			isActive && seekable ? react.createElement("span", { className: "lx-line__bar", "aria-hidden": "true" }) : null
		);
	});

	return react.createElement(
		"div",
		{
			ref: linesRef,
			className: "lx-lines" + (synced ? "" : " lx-lines--flow") + (reduceMotion ? " lx-lines--still" : ""),
		},
		children
	);
}

/* --------------------------------------------------------------- the app */

const EMPTY_TRANSLATIONS = { map: {}, status: "idle", detected: "" };

class LyricsApp extends react.Component {
	constructor(props) {
		super(props);
		this.state = {
			phase: "loading", // loading | lyrics | none | instrumental | unsupported
			info: null,
			data: null,
			palette: LXColors.FALLBACK,
			activeIndex: -1,
			translations: EMPTY_TRANSLATIONS,
			immersive: false,
			menuOpen: false,
			controlsVisible: true,
			reduceMotion: false,
			translationProvider: "",
			settings: {
				"translate-enabled": LXSettings.get("translate-enabled"),
				"translate-lang": LXSettings.get("translate-lang"),
				karaoke: LXSettings.get("karaoke"),
				ambient: LXSettings.get("ambient"),
				autohide: LXSettings.get("autohide"),
			},
		};

		this.token = 0; // track identity - bumped on every song change / re-fetch
		this.tToken = 0; // translation-batch identity - bumped on every (re)translate
		this.lyricsAbort = null;
		this.translateAbort = null;
		this._mounted = false;
		this._clockIdle = false;
		this._oneMoreTick = false;
		this._wi = -2; // last rendered active-word index (karaoke)
		this._wc = null; // word container the classes were last written to
		this.raf = 0;
		this.hideTimer = 0;
		this._translatedThisEnable = false;
		this._safeTopTimers = [];
		this._safeTop = -1; // sentinel: first measurement always applies

		this.rootRef = react.createRef();
		this.stageRef = react.createRef();
		this.wordsRef = react.createRef();

		this.onSong = this.onSong.bind(this);
		this.onProgress = this.onProgress.bind(this);
		this.onPlayPause = this.onPlayPause.bind(this);
		this.onPointerActivity = this.onPointerActivity.bind(this);
		this.onKeyActivity = this.onKeyActivity.bind(this);
		this.onFullscreenChange = this.onFullscreenChange.bind(this);
		this.onDocumentClick = this.onDocumentClick.bind(this);
		this.onReduceMotionChange = this.onReduceMotionChange.bind(this);
		this.measureSafeTop = this.measureSafeTop.bind(this);
		this.seek = this.seek.bind(this);
	}

	/* ---------------------------------------------------------- top safe area
	 * The custom app mounts inside Spotify's main-view scroll node, and Spotify
	 * floats a translucent top bar over the first stretch of that node. Nothing
	 * we set on z-index can lift our controls above it - it lives in a separate
	 * stacking context that is Spotify's, not ours - so instead we measure how
	 * far that chrome overlaps our top edge and inset the controls / lyric
	 * column past it via the --lx-safe-top custom property. */
	measureSafeTop() {
		const app = this.rootRef.current;
		if (!app) return;

		// In immersive (browser fullscreen) our element fills the screen and
		// Spotify's chrome isn't shown - no inset needed.
		if (document.fullscreenElement === app) {
			if (this._safeTop !== 0) {
				this._safeTop = 0;
				app.style.setProperty("--lx-safe-top", "0px");
			}
			return;
		}

		const TOP_CHROME = [
			".main-topBar-container",
			'[data-testid="topbar"]',
			".Root__globalNav",
			".main-globalNav-searchContainer",
		];
		const appTop = app.getBoundingClientRect().top;
		let overlap = 0;
		let sawChrome = false;

		for (const selector of TOP_CHROME) {
			for (const el of document.querySelectorAll(selector)) {
				const r = el.getBoundingClientRect();
				if (r.height === 0) continue;
				sawChrome = true;
				// Only bars that actually start at or above our top edge overlap us.
				if (r.top <= appTop + 4 && r.bottom > appTop) overlap = Math.max(overlap, r.bottom - appTop);
			}
		}

		// Grounded fallback: 64px is Spotify's standard top-bar height, used
		// only when none of the selectors matched (chrome renamed / not ready).
		const inset = overlap > 4 ? Math.round(overlap) + 8 : sawChrome ? 0 : 64;
		if (inset === this._safeTop) return;
		this._safeTop = inset;
		app.style.setProperty("--lx-safe-top", inset + "px");
	}

	// Spotify's chrome settles asynchronously after the route mounts, and the
	// top bar can resize on scroll, so re-measure a few times and on the
	// signals that move it.
	watchSafeTop() {
		const run = () => this._mounted && this.measureSafeTop();
		run();
		this._safeTopTimers = [80, 300, 800, 2000].map((ms) => setTimeout(run, ms));

		window.addEventListener("resize", this.measureSafeTop);

		this._scrollNode =
			document.querySelector(".Root__main-view .os-viewport") ||
			document.querySelector(".Root__main-view .main-view-container__scroll-node") ||
			document.querySelector(".Root__main-view");
		if (this._scrollNode) this._scrollNode.addEventListener("scroll", this.measureSafeTop, { passive: true });

		if (typeof ResizeObserver === "function") {
			this._topObserver = new ResizeObserver(run);
			const bar = document.querySelector(".main-topBar-container") || document.querySelector(".Root__globalNav");
			if (bar) this._topObserver.observe(bar);
		}
	}

	unwatchSafeTop() {
		this._safeTopTimers.forEach(clearTimeout);
		this._safeTopTimers = [];
		window.removeEventListener("resize", this.measureSafeTop);
		if (this._scrollNode) this._scrollNode.removeEventListener("scroll", this.measureSafeTop);
		if (this._topObserver) this._topObserver.disconnect();
	}

	/* ------------------------------------------------------------ lifecycle */

	componentDidMount() {
		this._mounted = true;

		this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
		this.setState({ reduceMotion: this.motionQuery.matches });
		this.motionQuery.addEventListener("change", this.onReduceMotionChange);

		this.unsubscribe = LXPlayer.subscribe({
			onSong: this.onSong,
			onProgress: this.onProgress,
			onPlayPause: this.onPlayPause,
		});

		document.addEventListener("fullscreenchange", this.onFullscreenChange);
		document.addEventListener("pointerdown", this.onDocumentClick, true);

		this.startClock();
		this.loadTrack();
		this.armAutoHide();
		this.watchSafeTop();
	}

	componentWillUnmount() {
		this._mounted = false;
		cancelAnimationFrame(this.raf);
		clearTimeout(this.hideTimer);
		if (this.unsubscribe) this.unsubscribe();
		if (this.lyricsAbort) this.lyricsAbort.abort();
		if (this.translateAbort) this.translateAbort.abort();
		if (this.motionQuery) this.motionQuery.removeEventListener("change", this.onReduceMotionChange);
		document.removeEventListener("fullscreenchange", this.onFullscreenChange);
		document.removeEventListener("pointerdown", this.onDocumentClick, true);
		this.unwatchSafeTop();
		if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
	}

	safeSetState(patch) {
		if (this._mounted) this.setState(patch);
	}

	/* -------------------------------------------------------- playback clock */

	startClock() {
		cancelAnimationFrame(this.raf);
		this._clockIdle = false;
		const step = () => {
			this.tickClock();
			if (LXPlayer.playing() || this._oneMoreTick) {
				this._oneMoreTick = false;
				this.raf = requestAnimationFrame(step);
			} else {
				this._clockIdle = true;
			}
		};
		this.raf = requestAnimationFrame(step);
	}

	// Restart the loop after a pause, or run a single frame after a seek so the
	// active line and column position catch up without spinning rAF forever.
	pokeClock() {
		if (this._clockIdle) this.startClock();
		else this._oneMoreTick = true;
	}

	tickClock() {
		const { data } = this.state;
		if (!data || !data.lines.length || (data.kind !== "synced" && data.kind !== "richsync")) return;

		const pos = LXPlayer.progress();
		const idx = LXSync.activeIndex(data.lines, pos);

		if (this.stageRef.current) {
			this.stageRef.current.style.setProperty("--lx-prog", LXSync.lineProgress(data.lines, idx, pos).toFixed(3));
		}

		if (idx !== this.state.activeIndex) {
			// Line changed: let React move the active class / karaoke spans
			// first; word fill picks up next frame against the settled DOM.
			this.safeSetState({ activeIndex: idx });
			this._wi = -2;
		} else if (data.kind === "richsync") {
			// The only thing updated every frame - straight on the DOM, no
			// React render. Class shuffling happens only when the word changes.
			this.tickWords(data.lines[idx], pos);
		}
	}

	tickWords(line, pos) {
		const container = this.wordsRef.current;
		if (!line || !line.words || !line.words.length || !container) return;

		const wi = LXSync.activeWord(line.words, pos);
		if (wi !== this._wi || container !== this._wc) {
			const kids = container.children;
			for (let k = 0; k < kids.length; k++) {
				const cl = kids[k].classList;
				cl.toggle("lx-word--done", k < wi);
				cl.toggle("lx-word--active", k === wi);
				cl.toggle("lx-word--soon", k > wi);
			}
			this._wi = wi;
			this._wc = container;
		}
		container.style.setProperty("--wp", LXSync.wordProgress(line.words, wi, pos).toFixed(3));
	}

	/* ----------------------------------------------------------- player events */

	onSong() {
		this.loadTrack();
	}

	onProgress() {
		// Fires on seek and periodically during playback. A single catch-up
		// frame is enough; the rAF loop handles steady playback.
		this.pokeClock();
	}

	onPlayPause() {
		this.pokeClock();
	}

	onReduceMotionChange(e) {
		this.safeSetState({ reduceMotion: e.matches });
	}

	/* --------------------------------------------------------------- loading */

	loadTrack() {
		const info = LXPlayer.info();
		const token = ++this.token;

		if (this.lyricsAbort) this.lyricsAbort.abort();
		this.lyricsAbort = new AbortController();
		this.cancelTranslation();
		this._wi = -2;
		this._wc = null;
		const signal = this.lyricsAbort.signal;

		if (!info) {
			this.safeSetState({ phase: "none", info: null, data: null, activeIndex: -1, translations: EMPTY_TRANSLATIONS });
			return;
		}

		this.safeSetState({
			info,
			data: null,
			activeIndex: -1,
			translations: EMPTY_TRANSLATIONS,
			translationProvider: "",
			phase: info.kind === "track" ? "loading" : "unsupported",
		});

		// Colour extraction is decorative and independent: its failure or its
		// lateness must never hold up or break the lyrics.
		LXColors.extract(info.uri, signal)
			.then((palette) => {
				if (token === this.token) this.safeSetState({ palette });
			})
			.catch(() => {});

		if (info.kind !== "track") return;
		this.applyLyrics(info, token, signal);
	}

	// Re-fetch lyrics for the current track without the loading flash - used
	// when the karaoke toggle changes the provider chain, or "Re-fetch lyrics".
	refetchLyrics() {
		const info = this.state.info;
		if (!info || info.kind !== "track") return;
		const token = ++this.token;
		if (this.lyricsAbort) this.lyricsAbort.abort();
		this.lyricsAbort = new AbortController();
		this.cancelTranslation();
		this._wi = -2;
		this._wc = null;
		this.applyLyrics(info, token, this.lyricsAbort.signal);
	}

	applyLyrics(info, token, signal) {
		const karaoke = !!this.state.settings.karaoke;
		LXProviders.fetchLyrics(info, signal, { karaoke })
			.then((data) => {
				if (token !== this.token) return;
				const screen = { none: "none", unsupported: "unsupported", instrumental: "instrumental" };
				if (screen[data.kind]) {
					this.safeSetState({ phase: screen[data.kind], data, activeIndex: -1 });
					return;
				}
				LXLog.info("lyrics:", data.provider, "·", data.kind, "·", data.lines.length, "lines");
				this.safeSetState({ phase: "lyrics", data, activeIndex: -1 });
				this._wi = -2;
				this.pokeClock();
				this.runTranslation(data, info);
			})
			.catch((err) => {
				if (token === this.token) {
					LXLog.warn("lyrics fetch failed:", err && err.message);
					this.safeSetState({ phase: "none", data: null });
				}
			});
	}

	/* ----------------------------------------------------------- translation */

	// Stop any running translation batch and open a fresh generation. Every
	// caller of runTranslation goes through here first, so a stale batch that
	// resolves late (slow network, aborted mid-flight) fails its `tGen` guard
	// and cannot write results for the wrong track or the wrong language.
	cancelTranslation() {
		this.tToken++;
		if (this.translateAbort) this.translateAbort.abort();
		this.translateAbort = new AbortController();
	}

	// Re-run for the current lyrics when the toggle flips or the language
	// changes - without touching the lyrics request.
	retranslate() {
		this.cancelTranslation();
		const { data, info } = this.state;
		if (data && info && (data.kind === "synced" || data.kind === "unsynced" || data.kind === "richsync")) {
			this.runTranslation(data, info);
		} else {
			this.safeSetState({ translations: EMPTY_TRANSLATIONS, translationProvider: "" });
		}
	}

	runTranslation(data, info) {
		if (!this.translateAbort) this.translateAbort = new AbortController();
		const tGen = this.tToken; // fixed for this batch; cancelTranslation() bumped it
		const alive = () => this._mounted && tGen === this.tToken;

		if (!this.state.settings["translate-enabled"]) {
			this._translatedThisEnable = false;
			this.safeSetState({ translations: { map: {}, status: "idle" } });
			return;
		}

		const target = this.state.settings["translate-lang"];
		const sourceHint = (data.language || "").toLowerCase().split(/[-_]/)[0];

		if (!this._translatedThisEnable) {
			this._translatedThisEnable = true;
			LXLog.info("translation enabled → target", target, "· provider", LXTranslate.providerId());
		}

		if (sourceHint && sourceHint === target) {
			this.safeSetState({ translations: { map: {}, status: "source-matches" } });
			return;
		}

		this.safeSetState({ translations: { map: {}, status: "loading" } });

		// Lines stream in a few at a time; coalesce the updates so a 40-line
		// song does not trigger 40 full re-renders of the lyric list.
		let lastPaint = 0;
		const paint = (partial) => {
			const now = Date.now();
			if (now - lastPaint < 300 || !alive()) return;
			lastPaint = now;
			this.safeSetState({ translations: { map: partial, status: "loading" } });
		};

		LXTranslate.translateLines(data.lines, {
			trackId: info.id,
			target,
			sourceHint,
			signal: this.translateAbort.signal,
			onProgress: paint,
		})
			.then((res) => {
				if (!alive()) return;
				const status =
					{ ok: "done", partial: "partial", "not-needed": "source-matches", cancelled: "idle", unavailable: "unavailable" }[res.status] ||
					"idle";
				this.safeSetState({
					translations: { map: res.map, status, detected: res.detected || "" },
					translationProvider: res.provider || "",
				});
			})
			.catch((err) => {
				if (!alive()) return;
				LXLog.warn("translation batch error:", err && err.message);
				this.safeSetState({ translations: { map: {}, status: "unavailable" } });
			});
	}

	/* -------------------------------------------------------------- controls */

	updateSetting(key, value) {
		LXSettings.set(key, value);
		this.setState((s) => ({ settings: Object.assign({}, s.settings, { [key]: value }) }), () => {
			if (key === "translate-enabled" || key === "translate-lang") this.retranslate();
			if (key === "karaoke") this.refetchLyrics();
			if (key === "autohide") this.armAutoHide();
		});
	}

	toggleTranslate() {
		this.updateSetting("translate-enabled", !this.state.settings["translate-enabled"]);
	}

	toggleImmersive() {
		const el = this.rootRef.current;
		if (!el) return;
		if (!document.fullscreenElement) {
			(el.requestFullscreen ? el.requestFullscreen() : Promise.reject()).catch(() => {});
		} else {
			document.exitFullscreen().catch(() => {});
		}
	}

	onFullscreenChange() {
		this.safeSetState({ immersive: document.fullscreenElement === this.rootRef.current });
		this.measureSafeTop();
	}

	onDocumentClick(e) {
		if (!this.state.menuOpen) return;
		if (this.rootRef.current && !e.target.closest(".lx-controls__menu")) {
			this.safeSetState({ menuOpen: false });
		}
	}

	/* ------------------------------------------------------------- auto-hide */

	armAutoHide() {
		clearTimeout(this.hideTimer);
		if (!this.state.settings.autohide) {
			this.safeSetState({ controlsVisible: true });
			return;
		}
		this.hideTimer = setTimeout(() => {
			if (this._mounted && !this.state.menuOpen && !this.rootRef.current?.querySelector(".lx-controls:focus-within")) {
				this.safeSetState({ controlsVisible: false });
			}
		}, 2600);
	}

	onPointerActivity() {
		if (!this.state.controlsVisible) this.safeSetState({ controlsVisible: true });
		this.armAutoHide();
	}

	onKeyActivity(e) {
		if (e.key === "Escape" && this.state.menuOpen) this.safeSetState({ menuOpen: false });
		this.onPointerActivity();
	}

	seek(ms) {
		LXPlayer.seek(ms);
		this.pokeClock();
	}

	/* ---------------------------------------------------------------- render */

	// Provider label + one-line status for the settings popover.
	translationStatus() {
		const t = this.state.translations;
		const s = this.state.settings;
		const prov = { google: "Google", "google-dict": "Google", mymemory: "MyMemory" }[this.state.translationProvider] || "";
		if (!s["translate-enabled"]) return { text: "Off", tone: "muted" };
		switch (t.status) {
			case "loading":
				return { text: (prov ? "via " + prov + " · " : "") + "translating…", tone: "busy" };
			case "done":
				return { text: prov ? "via " + prov : "ready", tone: "ok" };
			case "partial":
				return { text: (prov ? "via " + prov + " · " : "") + "some lines missing", tone: "warn" };
			case "unavailable":
				return { text: "unavailable — try again shortly", tone: "warn" };
			case "source-matches":
				return { text: "already in " + LXSettings.languageLabel(s["translate-lang"]), tone: "muted" };
			default:
				return { text: "ready", tone: "muted" };
		}
	}

	renderStage() {
		const { phase, data, translations, activeIndex, settings, reduceMotion } = this.state;

		if (phase === "lyrics" && data) {
			const showTranslations = settings["translate-enabled"] && Object.keys(translations.map).length > 0;
			return react.createElement(Lines, {
				key: this.state.info.uri + "|" + data.provider + "|" + data.kind,
				data,
				translations: translations.map,
				activeIndex,
				showTranslations,
				targetLang: settings["translate-lang"],
				onSeek: this.seek,
				reduceMotion,
				wordsRef: this.wordsRef,
			});
		}

		const detail =
			phase === "unsupported" && this.state.info ? `“${this.state.info.title}” doesn’t carry lyric data.` : null;
		return LXUi.stateScreen(phase === "loading" ? "loading" : phase, detail);
	}

	render() {
		const { info, palette, settings, immersive, menuOpen, controlsVisible, reduceMotion, data, translations } = this.state;

		return react.createElement(
			"div",
			{
				className:
					"lx-app" +
					(immersive ? " lx-app--immersive" : "") +
					(reduceMotion ? " lx-app--still" : ""),
				ref: this.rootRef,
				onMouseMove: this.onPointerActivity,
				onKeyDown: this.onKeyActivity,
			},
			react.createElement(BgLayer, {
				info,
				palette,
				ambient: settings.ambient,
				reduceMotion,
				artKey: info ? info.image : "none",
			}),
			react.createElement("div", { className: "lx-stage", ref: this.stageRef }, this.renderStage()),
			LXUi.controls({
				settings,
				visible: controlsVisible || menuOpen,
				immersive,
				menuOpen,
				busy: settings["translate-enabled"] && translations.status === "loading",
				diagnostics: {
					source: data ? data.provider : "",
					sync: data ? data.kind : "",
					translation: this.translationStatus(),
					detected: translations.detected || "",
					cacheCount: LXTranslate.cacheCount(),
					wordSyncPossible: !!data && data.kind === "richsync",
				},
				onInteract: this.onPointerActivity,
				onToggleTranslate: () => this.toggleTranslate(),
				onLang: (code) => this.updateSetting("translate-lang", code),
				onImmersive: () => this.toggleImmersive(),
				onToggleMenu: () => this.setState((s) => ({ menuOpen: !s.menuOpen })),
				onSetting: (key, value) => this.updateSetting(key, value),
				onClearCache: () => {
					LXTranslate.clearCache();
					this.retranslate();
					this.forceUpdate();
				},
				onReload: () => {
					this.refetchLyrics();
					this.setState({ menuOpen: false });
				},
			}),
			LXUi.nowPlaying(info)
		);
	}
}

/* A throw in render blanks Spotify's whole main view, so the tree is wrapped
 * in a boundary that shows a recoverable message instead. */
let boundaryClass = null;

function getBoundary() {
	if (boundaryClass) return boundaryClass;

	class LyricsBoundary extends react.Component {
		constructor(props) {
			super(props);
			this.state = { error: null };
		}

		static getDerivedStateFromError(error) {
			return { error };
		}

		render() {
			if (!this.state.error) return this.props.children;
			return react.createElement(
				"div",
				{ className: "lx-app lx-app--errored" },
				react.createElement("div", { className: "lx-bg" }, react.createElement("div", { className: "lx-bg__grad" })),
				react.createElement(
					"div",
					{ className: "lx-stage" },
					LXUi.stateScreen("error", (this.state.error && this.state.error.message) || String(this.state.error))
				)
			);
		}
	}

	boundaryClass = LyricsBoundary;
	return boundaryClass;
}

function render() {
	return react.createElement(getBoundary(), null, react.createElement(LyricsApp, null));
}
