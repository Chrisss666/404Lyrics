# 404Lyrics

A [Spicetify](https://spicetify.app) custom app that replaces Spotify's Lyrics
view with a premium, fullscreen lyrics experience — synced line by line,
translated underneath, on a background painted from the album art.

> **[Portfolio](https://404brainnotfound.at)** ·
> [Other projects](https://404brainnotfound.at/en/projects/)

It keeps the one thing Spotify's lyrics get right — accurate synced timing,
pulled from the same source Spotify itself uses — and rebuilds everything
around it: the active line is the focus of the screen, the rest recede into a
shallow depth of field, and the whole column glides so the current line always
sits on the same reading line.

## Features

- **Synchronised lyrics** straight from Spotify's own lyric provider, with
  LRCLIB as a fallback for tracks Spotify has nothing for. Click any line to
  seek playback there.
- **A redesigned view, not a reskin.** One large active line, distance-based
  opacity and blur falloff for everything else, and a hair-thin underline that
  fills as playback moves toward the next line.
- **Smooth, GPU-friendly transitions.** The column is moved with a single
  eased `transform`; lines animate only `opacity`, `filter` and `transform`.
  No per-frame layout, no scroll jank.
- **Dynamic artwork background.** Blurred cover art, an album-derived accent
  and gradient, and a fixed dark scrim so the lyrics stay readable no matter
  what the cover looks like. Optional slow ambient drift.
- **Translation underneath each line.** The original text is never replaced —
  the translation sits below it in smaller, dimmer type and moves with its
  line. Korean, Japanese and Chinese lyrics keep their original script.
- **Translation language selection**, remembered locally, defaulting to your
  Spotify client language.
- **Theme compatibility.** Chrome (controls, now-playing) uses Spotify's
  semantic variables, so it follows the active theme — default Spotify,
  third-party themes and [kpop-theme](https://github.com/Chrisss666/kpop-theme).
- **`prefers-reduced-motion` support** — decorative animation, ambient drift
  and the progress underline all switch off, and the column jumps instead of
  gliding.
- **Graceful states** for loading, missing lyrics, instrumentals, podcasts /
  local files, network failure and translation errors. A translation or
  artwork failure never stops the lyrics.
- **Native integration.** Spotify's own Lyrics button opens 404Lyrics, and a
  Lyrics button is added to the playbar.

## Installation

You need [Spicetify](https://spicetify.app/docs/getting-started) installed
first.

1. Put this repo in your Spicetify `CustomApps` folder as `404Lyrics`:

   ```sh
   git clone https://github.com/Chrisss666/404Lyrics.git "$(dirname "$(spicetify -c)")/CustomApps/404Lyrics"
   ```

   Or copy the folder there manually — the folder name must be `404Lyrics`.

2. Register the app and apply:

   ```sh
   spicetify config custom_apps 404Lyrics
   spicetify apply
   ```

Restart Spotify afterwards. Open it from the playbar Lyrics button, from
Spotify's own Lyrics button, or from the `404Lyrics` entry in the sidebar.

### Uninstall

```sh
spicetify config custom_apps 404Lyrics-
spicetify apply
```

Then delete the `CustomApps/404Lyrics` folder. To also drop the cached
translations, clear the `404lyrics:*` keys in Spotify's DevTools
`localStorage`.

## Translation

**How it works.** When translation is on, each distinct lyric line is
translated once and shown under the original. Lines already in your target
language are left as-is.

**Provider.** A Spicetify custom app is plain frontend JavaScript, so a paid
API is not an option — its key would ship in everyone's install. 404Lyrics
uses Google's public `translate_a` endpoint (the same one the Google Translate
site calls), reached with a plain `fetch`. No key, no account, no setup.

Translation is written against a small provider interface
(`src/translate.js`), so a self-hosted [LibreTranslate](https://libretranslate.com)
instance or a DeepL proxy can be added later without touching the view.

**Internet access** is required for translation (and for the LRCLIB lyrics
fallback). Everything else works offline once lyrics are loaded.

**Caching.** Every translated line is stored in `localStorage` under
`404lyrics:tcache`, keyed by track + source language + target language + a
hash of the line. Reopening Spotify, switching back to a track or re-rendering
the page costs zero requests. The cache holds up to 4000 lines; the oldest are
dropped first.

**Known limitations.**

- Machine translation of song lyrics is rough — idiom, wordplay and line
  breaks that only make sense sung will not survive.
- The public endpoint is unofficial and rate-limited. On a burst of failures
  404Lyrics stops the batch and shows "translation unavailable"; the lines it
  already has stay. It retries on the next track or when you toggle
  translation off and on.
- No romanization. Non-Latin scripts are translated, not transliterated. The
  provider layer is where that would be added.

## Development

No build step, by design — Spicetify loads the files directly. No npm, no
bundler, no TypeScript, no JSX (custom apps can't use it, so React elements
are built with `Spicetify.React.createElement` through a short `h()` helper).

```
manifest.json      app metadata, icons, subfile order
index.js           app shell: state, the playback clock, which screen is on,
                   the error boundary, global render()
extension.js       runs on Spotify start: playbar button + redirect of the
                   native Lyrics button to 404Lyrics
style.css          all styles
src/settings.js    namespaced preference storage, client-locale detection
src/player.js      the only file that touches Spicetify.Player - track info,
                   position, seek, one subscribe/unsubscribe helper
src/providers.js   lyrics retrieval: Spotify colour-lyrics, then LRCLIB;
                   LRC parsing; one normalised shape
src/translate.js   provider interface, Google provider, the localStorage
                   cache, the cancellable concurrency-limited batch
src/colors.js      artwork colour extraction (3 fallbacks) + palette tuning
src/sync.js        pure math: active line index, per-line progress
src/ui.js          view builders - controls, now-playing, state screens
```

`subfiles` share one scope with `index.js`; each wraps itself in an IIFE and
exposes one `LX*` object. `extension.js` runs in its own scope — the route
name and the `404lyrics:` storage prefix are the only things it shares.

**Race safety.** Every track load takes a monotonic token and its own
`AbortController`. Lyrics, colour and translation results are dropped unless
their token still matches, so a slow response for a track you already skipped
past can never overwrite what is playing. Translation batches are aborted on
track change and on any language/toggle change.

Changes take effect after `spicetify apply`, which copies the files into the
Spotify install. Debug through Spotify's DevTools.

## Limitations

- **Lyrics coverage** is whatever Spotify's provider (Musixmatch) and LRCLIB
  have. Some tracks have unsynced lyrics only; some have none. 404Lyrics shows
  a clean fallback for each.
- **Line-level sync only.** Word-by-word ("karaoke") timing is not exposed
  consistently by Spotify, so it is not used.
- **Spotify internals.** Colour extraction and the native-button redirect
  touch Spotify internals that can change without notice. Each is isolated and
  fails quietly — the redirect stops working and the native panel comes back,
  colours fall back to a neutral palette. Lyrics keep working.
- **Per machine.** Preferences and the translation cache are local. There is
  no sync.
- A major Spotify client update can move things 404Lyrics relies on. If the
  view breaks, check for an update here before anything else.

## License

[MIT](LICENSE) © Chrisss666

---

Part of my portfolio at **[404brainnotfound.at](https://404brainnotfound.at)**.
Other projects: [spicetify-stats](https://github.com/Chrisss666/spicetify-stats) ·
[kpop-theme](https://github.com/Chrisss666/kpop-theme)
