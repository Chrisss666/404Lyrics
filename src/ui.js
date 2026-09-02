/* 404Lyrics - view builders.
 *
 * No JSX (Spicetify custom apps cannot use it), so elements are built with a
 * short `h()` helper over Spicetify.React.createElement. This file owns the
 * chrome - background layers, the control cluster, the now-playing card and
 * the loading / empty / error screens. The lyric column itself lives in
 * index.js because it is tied to the player clock.
 */

function h(tag, props, ...children) {
	return Spicetify.React.createElement(tag, props, ...children.flat());
}

const LXUi = (() => {
	const svg = (paths, extra) =>
		h(
			"svg",
			Object.assign({ viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, extra || {}),
			paths.map((d, i) => h("path", { key: i, d }))
		);

	const ICONS = {
		translate: () => svg(["M4 5h7M8 3v2M10.5 5S9.5 9.5 7 12.5 3 15 3 15", "M6 12s2 2.5 4.5 2.5", "M13 20l4-9 4 9M14.6 16.5h4.8"]),
		expand: () => svg(["M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5"]),
		collapse: () => svg(["M9 4v5H4M15 20v-5h5M20 9h-5V4M4 15h5v5"]),
		gear: () => svg(["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6", "M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"]),
		music: () => svg(["M9 18V5l12-2v13", "M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0"]),
		alert: () => svg(["M12 9v4M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0"]),
	};

	function iconButton(name, label, onClick, opts) {
		const o = opts || {};
		return h(
			"button",
			{
				type: "button",
				className: "lx-ctl" + (o.active ? " lx-ctl--active" : "") + (o.busy ? " lx-ctl--busy" : ""),
				onClick,
				"aria-label": label,
				"aria-pressed": o.toggle ? !!o.active : undefined,
				title: label,
			},
			(ICONS[name] || ICONS.music)(),
			o.busy ? h("span", { className: "lx-ctl__spinner", "aria-hidden": "true" }) : null
		);
	}

	/* ------------------------------------------------------------- controls  */

	const SYNC_LABEL = { richsync: "Word-synced", synced: "Line-synced", unsynced: "Unsynced", instrumental: "Instrumental" };

	function switchRow(label, checked, onToggle, hint) {
		return h(
			"button",
			{
				type: "button",
				className: "lx-pop__row",
				role: "switch",
				"aria-checked": !!checked,
				onClick: () => onToggle(!checked),
			},
			h("span", { className: "lx-pop__label" }, label, hint ? h("span", { className: "lx-pop__hint" }, hint) : null),
			h("span", { className: "lx-pop__switch" + (checked ? " is-on" : "") })
		);
	}

	function settingsPopover(p) {
		if (!p.open) return null;
		const s = p.settings;
		const d = p.diagnostics || {};
		const ts = d.translation || { text: "", tone: "muted" };

		return h(
			"div",
			{ className: "lx-pop", role: "group", "aria-label": "404Lyrics settings" },

			h("p", { className: "lx-pop__title" }, "Translation"),
			switchRow("Enable translation", s["translate-enabled"], (v) => p.onSetting("translate-enabled", v)),
			h(
				"label",
				{ className: "lx-pop__row lx-pop__row--select" },
				h("span", { className: "lx-pop__label" }, "Language"),
				h(
					"select",
					{
						className: "lx-pop__select",
						value: s["translate-lang"],
						"aria-label": "Translation language",
						onChange: (e) => p.onLang(e.target.value),
					},
					LXSettings.LANGUAGES.map(([code, name]) => h("option", { key: code, value: code }, name))
				)
			),
			s["translate-enabled"]
				? h(
						"p",
						{ className: "lx-pop__status lx-pop__status--" + ts.tone },
						ts.tone === "busy" ? h("span", { className: "lx-pop__dot", "aria-hidden": "true" }) : null,
						ts.text
					)
				: null,
			s["translate-enabled"] && d.detected
				? h("p", { className: "lx-pop__meta" }, "Detected source: " + LXSettings.languageLabel(d.detected))
				: null,
			h(
				"button",
				{ type: "button", className: "lx-pop__action", onClick: p.onClearCache },
				"Clear translation cache" + (d.cacheCount ? " (" + d.cacheCount + ")" : "")
			),

			h("div", { className: "lx-pop__divider" }),
			h("p", { className: "lx-pop__title" }, "Karaoke"),
			switchRow(
				"Word-by-word when available",
				s.karaoke,
				(v) => p.onSetting("karaoke", v),
				d.wordSyncPossible ? "Active for this track" : "Uses Netease word timing"
			),

			h("div", { className: "lx-pop__divider" }),
			h("p", { className: "lx-pop__title" }, "Appearance"),
			switchRow("Ambient background motion", s.ambient, (v) => p.onSetting("ambient", v)),
			switchRow("Auto-hide these controls", s.autohide, (v) => p.onSetting("autohide", v)),

			h("div", { className: "lx-pop__divider" }),
			d.source
				? h("p", { className: "lx-pop__meta" }, "Lyrics: " + d.source + (SYNC_LABEL[d.sync] ? " · " + SYNC_LABEL[d.sync] : ""))
				: null,
			h("button", { type: "button", className: "lx-pop__action", onClick: p.onReload }, "Re-fetch lyrics")
		);
	}

	function controls(props) {
		const s = props.settings;
		return h(
			"div",
			{
				className: "lx-controls" + (props.visible ? "" : " lx-controls--hidden"),
				onMouseEnter: props.onInteract,
			},
			iconButton("translate", s["translate-enabled"] ? "Turn translation off" : "Turn translation on", props.onToggleTranslate, {
				toggle: true,
				active: s["translate-enabled"],
				busy: !!props.busy,
			}),
			iconButton(props.immersive ? "collapse" : "expand", props.immersive ? "Exit immersive mode" : "Immersive mode", props.onImmersive, {
				toggle: true,
				active: props.immersive,
			}),
			h(
				"div",
				{ className: "lx-controls__menu" },
				iconButton("gear", "Settings", props.onToggleMenu, { toggle: true, active: props.menuOpen }),
				settingsPopover({
					open: props.menuOpen,
					settings: s,
					diagnostics: props.diagnostics,
					onSetting: props.onSetting,
					onLang: props.onLang,
					onClearCache: props.onClearCache,
					onReload: props.onReload,
				})
			)
		);
	}

	/* ---------------------------------------------------------- now playing  */

	function nowPlaying(info) {
		if (!info) return null;
		return h(
			"div",
			{ className: "lx-now" },
			info.image
				? h("img", { className: "lx-now__art", src: info.image, alt: "", draggable: "false" })
				: h("div", { className: "lx-now__art lx-now__art--empty" }, ICONS.music()),
			h(
				"div",
				{ className: "lx-now__meta" },
				h("p", { className: "lx-now__title", title: info.title }, info.title),
				h("p", { className: "lx-now__artist", title: info.artist }, info.artist)
			)
		);
	}

	/* ------------------------------------------------------------- screens  */

	const MESSAGES = {
		loading: { title: "Finding the words…", body: "Checking the lyric providers for this track." },
		none: { title: "No lyrics for this one", body: "None of the providers have lyrics for this track yet." },
		instrumental: { title: "Instrumental", body: "This track has no words — just enjoy it." },
		unsupported: { title: "Lyrics aren’t available here", body: "Podcasts, local files and ads don’t carry lyric data." },
		error: { title: "Something went wrong", body: "The lyrics view hit an error. Switching tracks usually clears it." },
	};

	function stateScreen(kind, detail) {
		const msg = MESSAGES[kind] || MESSAGES.error;
		return h(
			"div",
			{ className: "lx-screen lx-screen--" + kind, role: kind === "error" ? "alert" : "status" },
			h(
				"div",
				{ className: "lx-screen__mark", "aria-hidden": "true" },
				kind === "loading"
					? h("span", { className: "lx-screen__pulse" })
					: kind === "instrumental"
						? ICONS.music()
						: kind === "error" || kind === "unsupported"
							? ICONS.alert()
							: ICONS.music()
			),
			h("p", { className: "lx-screen__title" }, msg.title),
			h("p", { className: "lx-screen__body" }, detail || msg.body)
		);
	}

	return { h, controls, nowPlaying, stateScreen, ICONS };
})();
