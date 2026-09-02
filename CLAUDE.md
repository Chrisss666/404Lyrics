# 404Lyrics – Spicetify Custom App

A fullscreen lyrics experience that replaces Spotify's native Lyrics view:
synced lines from Spotify's own provider, translation under each line, an
album-art background. Sits alongside `kpop-theme` and `spicetify-stats`.

## Hard constraints – non-negotiable

- **No build step.** No npm, no `package.json`, no bundler, no TypeScript.
  Spicetify loads the `.js` files directly.
- **No JSX.** Custom apps can't use it. React elements are built with
  `Spicetify.React.createElement`, via the `h()` helper in `src/ui.js`.
- **No npm dependencies, no CDN scripts.** External stylesheet `@import`
  (Google Fonts) is fine and matches `kpop-theme`. Network `fetch` is used
  for LRCLIB and translation – both key-less.
- `index.js` must define a global `render()` returning a React element.
- React comes from `Spicetify.React`, not an import.

## File layout

```
manifest.json      name, icons, subfiles (order matters), subfiles_extension
index.js           app shell: state, playback clock (+ per-frame word fill),
                   screen routing, error boundary
extension.js       subfiles_extension – playbar button + native-button redirect
style.css          all styles, class prefix lx-
src/net.js         LXNet (CosmosAsync-first getJson) + LXLog (gated logger)
src/settings.js    LXSettings   – prefs + locale detection
src/player.js      LXPlayer     – the only Spicetify.Player consumer
src/colors.js      LXColors     – artwork palette (3 fallbacks)
src/sync.js        LXSync       – pure: active line + word index, progress
src/providers.js   LXProviders  – Netease (word timing), Spotify, LRCLIB
src/translate.js   LXTranslate  – 3-provider keyless chain, cache, batch
src/ui.js          LXUi + h()   – control cluster, settings panel, screens
```

`subfiles` share one scope with `index.js`; each is an IIFE exposing one `LX*`
object. `extension.js` has its own scope – only the route name and the
`404lyrics:` storage prefix are shared.

## Rules

- Race safety: `this.token` (track identity) + per-load `AbortController`, and
  `this.tToken` (translation generation, bumped by `cancelTranslation()`).
  Lyrics / colour / karaoke / translation results are dropped unless their
  token still matches. Never regress this. Every `runTranslation` caller goes
  through `cancelTranslation()` first.
- Translation, karaoke and artwork failures must never break lyrics. Swallow
  those, not everything. Provider errors go through `LXLog` (gated on
  `localStorage["404lyrics:debug"]`), never bare `console.*`.
- All outbound requests go through `LXNet.getJson` (CosmosAsync first, past
  CSP + CORS). Don't add bare `fetch` to third-party hosts.
- Karaoke: only Netease `yrc`/`klyric` (keyless — no Musixmatch, it needs a
  token). Never fake word timing; never let Netease line-level lyrics
  displace Spotify line sync. Word fill writes the DOM directly in the rAF
  loop; React re-renders only when the active line or word changes.
- Spotify internals (colour endpoints, `[data-testid="lyrics-button"]`) are
  isolated and fail quietly. Don't scatter Spotify DOM selectors around.
- Animate `transform` / `opacity` / `filter` / `clip-path` only. No per-frame
  layout, no per-frame React render.
- Respect `prefers-reduced-motion` (JS state + the CSS media block).
- Class names are `lx-` prefixed. Chrome uses `--spice-*` where sensible;
  the immersive surface uses artwork-derived colour.
- No bare `console.*` in committed code — diagnostics go through `LXLog`,
  which is silent unless the debug flag is set. Comments explain non-obvious
  choices, not obvious code.

## Workflow

- `spicetify apply` copies files into the Spotify install; changes only take
  effect then. Debug via Spotify DevTools.
- `node --check` every file; `node --check` the concatenation too.
- README is English (portfolio project), links back to 404brainnotfound.at.
