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
	const { data, translations, activeIndex, showTranslations, onSeek, reduceMotion } = props;
	const linesRef = react.useRef(null);
	const synced = data.kind === "synced";
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
			react.createElement("span", { className: "lx-line__text" }, text || "♪"),
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

const EMPTY_TRANSLATIONS = { map: {}, status: "idle" };

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
			settings: {
				"translate-enabled": LXSettings.get("translate-enabled"),
				"translate-lang": LXSettings.get("translate-lang"),
				ambient: LXSettings.get("ambient"),
				autohide: LXSettings.get("autohide"),
			},
		};

		this.token = 0;
		this.lyricsAbort = null;
		this.translateAbort = null;
		this._mounted = false;
		this._clockIdle = false;
		this._oneMoreTick = false;
		this.raf = 0;
		this.hideTimer = 0;

		this.rootRef = react.createRef();
		this.stageRef = react.createRef();

		this.onSong = this.onSong.bind(this);
		this.onProgress = this.onProgress.bind(this);
		this.onPlayPause = this.onPlayPause.bind(this);
		this.onPointerActivity = this.onPointerActivity.bind(this);
		this.onKeyActivity = this.onKeyActivity.bind(this);
		this.onFullscreenChange = this.onFullscreenChange.bind(this);
		this.onDocumentClick = this.onDocumentClick.bind(this);
		this.onReduceMotionChange = this.onReduceMotionChange.bind(this);
		this.seek = this.seek.bind(this);
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
		if (!data || data.kind !== "synced" || !data.lines.length) return;

		const pos = LXPlayer.progress();
		const idx = LXSync.activeIndex(data.lines, pos);
		if (idx !== this.state.activeIndex) this.safeSetState({ activeIndex: idx });

		if (this.stageRef.current) {
			const frac = LXSync.lineProgress(data.lines, idx, pos);
			this.stageRef.current.style.setProperty("--lx-prog", frac.toFixed(3));
		}
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
		if (this.translateAbort) this.translateAbort.abort();
		this.lyricsAbort = new AbortController();
		this.translateAbort = new AbortController();
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

		LXProviders.fetchLyrics(info, signal)
			.then((data) => {
				if (token !== this.token) return;
				const map = { none: "none", unsupported: "unsupported", instrumental: "instrumental" };
				if (map[data.kind]) {
					this.safeSetState({ phase: map[data.kind], data });
					return;
				}
				this.safeSetState({ phase: "lyrics", data });
				this.pokeClock();
				this.runTranslation(data, info, token);
			})
			.catch(() => {
				if (token === this.token) this.safeSetState({ phase: "none", data: null });
			});
	}

	/* ----------------------------------------------------------- translation */

	// Re-run when the toggle flips or the language changes, without touching
	// the lyrics request.
	retranslate() {
		if (this.translateAbort) this.translateAbort.abort();
		this.translateAbort = new AbortController();
		const { data, info } = this.state;
		if (data && info && (data.kind === "synced" || data.kind === "unsynced")) {
			this.runTranslation(data, info, this.token);
		} else {
			this.safeSetState({ translations: EMPTY_TRANSLATIONS });
		}
	}

	runTranslation(data, info, token) {
		if (!this.state.settings["translate-enabled"]) {
			this.safeSetState({ translations: { map: {}, status: "idle" } });
			return;
		}

		const target = this.state.settings["translate-lang"];
		const sourceHint = (data.language || "").toLowerCase().split(/[-_]/)[0];

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
			if (now - lastPaint < 280) return;
			lastPaint = now;
			if (token === this.token && this.state.settings["translate-enabled"]) {
				this.safeSetState({ translations: { map: partial, status: "loading" } });
			}
		};

		LXTranslate.translateLines(data.lines, {
			trackId: info.id,
			target,
			sourceHint,
			signal: this.translateAbort.signal,
			onProgress: paint,
		})
			.then((res) => {
				if (token !== this.token) return;
				const status =
					{ ok: "done", partial: "partial", "not-needed": "source-matches", cancelled: "idle", unavailable: "unavailable" }[res.status] ||
					"idle";
				this.safeSetState({ translations: { map: res.map, status } });
			})
			.catch(() => {
				if (token === this.token) this.safeSetState({ translations: { map: {}, status: "unavailable" } });
			});
	}

	/* -------------------------------------------------------------- controls */

	updateSetting(key, value) {
		LXSettings.set(key, value);
		this.setState((s) => ({ settings: Object.assign({}, s.settings, { [key]: value }) }), () => {
			if (key === "translate-enabled" || key === "translate-lang") this.retranslate();
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

	translationHint() {
		const t = this.state.translations;
		if (!this.state.settings["translate-enabled"]) return null;
		if (t.status === "loading") return "Translating…";
		if (t.status === "partial") return "Some lines couldn’t be translated.";
		if (t.status === "unavailable") return "Translation is unavailable right now.";
		if (t.status === "source-matches")
			return "These lyrics are already in " + LXSettings.languageLabel(this.state.settings["translate-lang"]) + ".";
		return null;
	}

	renderStage() {
		const { phase, data, translations, activeIndex, settings, reduceMotion } = this.state;

		if (phase === "lyrics" && data) {
			const showTranslations = settings["translate-enabled"] && Object.keys(translations.map).length > 0;
			return react.createElement(Lines, {
				key: this.state.info.uri + "|" + data.provider,
				data,
				translations: translations.map,
				activeIndex,
				showTranslations,
				targetLang: settings["translate-lang"],
				onSeek: this.seek,
				reduceMotion,
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
				provider: data ? data.provider : "",
				copyright: data ? data.copyright : "",
				tStatus: translations.status,
				tHint: this.translationHint(),
				onInteract: this.onPointerActivity,
				onToggleTranslate: () => this.toggleTranslate(),
				onLang: (code) => this.updateSetting("translate-lang", code),
				onImmersive: () => this.toggleImmersive(),
				onToggleMenu: () => this.setState((s) => ({ menuOpen: !s.menuOpen })),
				onSetting: (key, value) => this.updateSetting(key, value),
				onReload: () => {
					LXTranslate.clearCache();
					this.loadTrack();
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
