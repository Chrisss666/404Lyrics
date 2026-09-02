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
- **Word-by-word karaoke** when a provider has real per-word timing (Netease).
  The active line fills token by token in time with the vocal — completed
  words lit, the current word filling left to right, upcoming words muted.
  Falls back cleanly to line-level sync when word timing isn't available.
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
  line (karaoke line included). Korean, Japanese and Chinese lyrics keep their
  original script; no romanization.
- **In-view settings.** A gear button, top right, opens a small panel:
  translation on/off, target language, provider and status, clear cache, the
  karaoke toggle, and the lyric source / sync quality for the current track.
- **Theme compatibility.** Chrome (controls, now-playing) uses Spotify's
  semantic variables, so it follows the active theme — default Spotify,
  third-party themes and [kpop-theme](https://github.com/Chrisss666/kpop-theme).
- **`prefers-reduced-motion` support** — decorative animation, ambient drift
  and the progress underline switch off, and the column jumps instead of
  gliding. Karaoke word-fill stays (it's information, not decoration) but
  loses its glow.
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

Translation is **off by default**. Turn it on from the gear panel (top right)
and pick a target language — it defaults to your Spotify client language and
is remembered locally under `404lyrics:setting:translate-lang`. While it is
off, no translation request is ever made.

**How it works.** Each distinct lyric line is translated once and shown under
the original in smaller, secondary type. Lines already in the target language
show the original only. Failures are silent — a line that can't be translated
just keeps showing the original, and the lyrics themselves are never affected.

**Providers.** A Spicetify custom app is plain frontend JavaScript, so a paid
or keyed API is out — the key would ship in everyone's install. 404Lyrics uses
the same keyless endpoints browser translation extensions use, tried in order
because each is unofficial and independently rate-limited:

1. `translate.googleapis.com/translate_a/single`
2. `clients5.google.com/translate_a/t`
3. `api.mymemory.translated.net` (community translation memory)

All requests go through `Spicetify.CosmosAsync`, which routes them through
Spotify's native networking layer — the only reliable way past the page CSP
and browser CORS. The panel shows which provider answered.

Translation is written against a small provider interface (`src/translate.js`
— `provider.translateOne(text, target, sourceHint, signal)`), so a self-hosted
[LibreTranslate](https://libretranslate.com) instance or a DeepL proxy can be
registered later with `LXTranslate.useProvider(p)` without touching the view.

**Internet access** is required for translation (and for the LRCLIB and
Netease lyric providers). The rest works offline once lyrics are loaded.

**Caching.** Every translated line is stored in `localStorage` under
`404lyrics:tcache`, keyed by track + source language + target language + a
hash of the line. Reopening Spotify, switching back to a track, changing the
render or re-enabling translation costs zero requests. The cache holds up to
4000 lines, oldest evicted first; "Clear translation cache" in the panel wipes
it.

**Known limitations.**

- Machine translation of song lyrics is rough — idiom, wordplay and sung line
  breaks don't survive.
- The endpoints are unofficial and rate-limited. On a burst of failures the
  batch stops and the panel shows "unavailable"; lines already translated
  stay. It retries on the next track or when you toggle translation off and
  on.
- No romanization — non-Latin scripts are translated, not transliterated.

To trace the translation path in Spotify's DevTools, set
`localStorage["404lyrics:debug"] = "true"` — 404Lyrics then logs which
provider is used, provider failures with the real error, and batch results.
Unset it to silence the logging again.

## Karaoke

When "Word-by-word when available" is on (the default), 404Lyrics looks up
**Netease Cloud Music** for the current track and, if it has real per-word
timing (`yrc` / `klyric`), uses it: the active line renders one token per
word, completed words lit, the current word filling left to right in time
with the vocal, upcoming words muted. Seeking, pausing and jumping backward
all update the word state immediately.

Netease is only consulted when karaoke is on, and its result is used **only**
if it carries word timing — its line-level lyrics are ignored so a possible
timing offset never displaces Spotify's exact line sync. The Netease match is
gated on track duration (±4 s); a track it can't confidently match falls
through to Spotify. Turning karaoke off re-fetches from Spotify / LRCLIB.

No estimated / faked word timing is generated — if no provider has it, the
line-level experience is preserved exactly.

## Development

No build step, by design — Spicetify loads the files directly. No npm, no
bundler, no TypeScript, no JSX (custom apps can't use it, so React elements
are built with `Spicetify.React.createElement` through a short `h()` helper).

```
manifest.json      app metadata, icons, subfile order
index.js           app shell: state, the playback clock (incl. per-frame word
                   fill), which screen is on, the error boundary, render()
extension.js       runs on Spotify start: playbar button + redirect of the
                   native Lyrics button to 404Lyrics
style.css          all styles
src/net.js         LXNet (CosmosAsync-first GET) + LXLog (gated diagnostics)
src/settings.js    namespaced preference storage, client-locale detection
src/player.js      the only file that touches Spicetify.Player - track info,
                   position, seek, one subscribe/unsubscribe helper
src/providers.js   lyrics retrieval: Netease word timing, Spotify colour-
                   lyrics, LRCLIB; LRC / yrc / klyric parsing; one shape
src/translate.js   provider chain (3 keyless endpoints), localStorage cache,
                   the cancellable concurrency-limited batch
src/colors.js      artwork colour extraction (3 fallbacks) + palette tuning
src/sync.js        pure math: active line + active word index, progress
src/ui.js          view builders - control cluster, settings panel, screens
```

`subfiles` share one scope with `index.js`; each wraps itself in an IIFE and
exposes one `LX*` object. `extension.js` runs in its own scope — the route
name and the `404lyrics:` storage prefix are the only things it shares.

**Normalised lyric shape.** Every provider returns
`{ kind, lines, language, provider, copyright }` where `kind` is
`richsync | synced | unsynced | instrumental | none`, and a `richsync` line
carries `words: [{ time, endTime, text }]` alongside its joined `text`.

**Race safety.** Every track load takes a monotonic token (`this.token`) and
its own `AbortController`; a separate generation counter (`this.tToken`,
bumped by `cancelTranslation()`) covers translation batches. Lyrics, colour,
karaoke and translation results are all dropped unless their token still
matches, so a slow response for a track you skipped past — or a translation
for a language you switched away from — can never overwrite what's on screen.

**Karaoke rendering.** Only the active line renders word spans. The rAF loop
sets the active-word classes only when the word changes, and writes the
`--word-progress` custom property straight to the DOM every frame — no React
render per frame. `clip-path` on a stacked `.lx-word__fill` does the fill.

Changes take effect after `spicetify apply`, which copies the files into the
Spotify install. Debug through Spotify's DevTools.

## Limitations

- **Lyrics coverage** is whatever Spotify's provider (Musixmatch), LRCLIB and
  Netease have. Some tracks have unsynced lyrics only; some have none.
  404Lyrics shows a clean fallback for each.
- **Karaoke coverage** is narrower still — it depends on Netease having the
  track with `yrc`/`klyric` word timing and on the duration match being
  confident. Best for popular and K-pop / East-Asian catalogue tracks. When
  it's unavailable you get line-level sync, which is the norm.
- **Spotify internals.** Colour extraction, the syllable-lyrics branch and the
  native-button redirect touch Spotify internals that can change without
  notice. Each is isolated and fails quietly — the redirect stops working and
  the native panel comes back, colours fall back to a neutral palette. Lyrics
  keep working.
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
