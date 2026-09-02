/* 404Lyrics - Spotify integration shim.
 *
 * Registered as `subfiles_extension`, so it runs on every Spotify start,
 * independent of whether the app page is open. Two jobs:
 *
 *   1. Add a Lyrics button to the playbar that opens the 404Lyrics page.
 *   2. Make Spotify's own Lyrics button open 404Lyrics instead of the native
 *      panel, so the enhanced view becomes the default lyrics experience.
 *
 * Both are best-effort and isolated. If Spotify renames the native button,
 * (2) quietly stops working and the native panel comes back - nothing breaks,
 * and the playbar button in (1) still gets the user there.
 *
 * This runs in its own scope; it shares nothing with the app but the route
 * name and the `404lyrics:` storage prefix.
 */
(function LyricsExtension() {
	const APP_PATH = "/404Lyrics";
	const SETTING_HIJACK = "404lyrics:setting:hijack-native"; // default on

	if (!(window.Spicetify && Spicetify.Platform && Spicetify.Platform.History && Spicetify.Playbar && Spicetify.URI)) {
		setTimeout(LyricsExtension, 300);
		return;
	}

	const History = Spicetify.Platform.History;

	function isOpen() {
		return History.location && History.location.pathname === APP_PATH;
	}

	function toggle() {
		if (isOpen()) History.goBack();
		else History.push(APP_PATH);
	}

	/* ----------------------------------------------------- playbar button */

	const button = new Spicetify.Playbar.Button(
		"404Lyrics",
		`<svg role="img" height="16" width="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h9a1 1 0 0 1 0 2H4a1 1 0 0 1 0-2Zm0 4.5h7a1 1 0 0 1 0 2H4a1 1 0 0 1 0-2ZM4 15h10a1 1 0 0 1 0 2H4a1 1 0 0 1 0-2Z"/><circle cx="19" cy="8.5" r="2.4"/></svg>`,
		toggle,
		false,
		isOpen()
	);

	History.listen(() => {
		button.active = isOpen();
	});

	/* ------------------------------------------- hijack the native button */

	// One delegated capture-phase listener rather than a MutationObserver:
	// cheap, and it keeps working as rows re-render. The selector is the only
	// Spotify internal we touch, and missing it just means the native panel
	// opens as usual.
	const NATIVE_SELECTOR = '[data-testid="lyrics-button"], .main-nowPlayingBar-lyricsButton';

	function onDocumentClick(event) {
		if (localStorage.getItem(SETTING_HIJACK) === "false") return;
		const hit = event.target.closest && event.target.closest(NATIVE_SELECTOR);
		if (!hit) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		if (!isOpen()) History.push(APP_PATH);
	}

	document.addEventListener("click", onDocumentClick, true);

	// Also expose a config toggle in the Spotify profile menu so the hijack can
	// be turned off without editing storage by hand.
	if (Spicetify.Menu) {
		const item = new Spicetify.Menu.Item(
			"404Lyrics replaces native lyrics",
			localStorage.getItem(SETTING_HIJACK) !== "false",
			(self) => {
				const next = !self.isEnabled;
				localStorage.setItem(SETTING_HIJACK, String(next));
				self.setState(next);
				Spicetify.showNotification(next ? "Spotify's Lyrics button now opens 404Lyrics" : "Spotify's Lyrics button restored");
			},
			"lyrics"
		);
		item.register();
	}
})();
