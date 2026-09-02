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
index.js           app shell: state, playback clock, screen routing, boundary
extension.js       subfiles_extension – playbar button + native-button redirect
style.css          all styles, class prefix lx-
src/settings.js    LXSettings   – prefs + locale detection
src/player.js      LXPlayer     – the only Spicetify.Player consumer
src/colors.js      LXColors     – artwork palette (3 fallbacks)
src/sync.js        LXSync       – pure: active index, line progress
src/providers.js   LXProviders  – Spotify colour-lyrics, then LRCLIB
src/translate.js   LXTranslate  – provider interface, Google, cache, batch
src/ui.js          LXUi + h()   – controls, now-playing, state screens
```

`subfiles` share one scope with `index.js`; each is an IIFE exposing one `LX*`
object. `extension.js` has its own scope – only the route name and the
`404lyrics:` storage prefix are shared.

## Rules

- Every track load takes a monotonic token + its own `AbortController`.
  Lyrics / colour / translation results are dropped unless the token still
  matches. Never regress this – it is the whole race-safety story.
- Translation and artwork failures must never break lyrics. Swallow those,
  not everything.
- Spotify internals (colour endpoints, `[data-testid="lyrics-button"]`) are
  isolated and fail quietly. Don't scatter Spotify DOM selectors around.
- Animate `transform` / `opacity` / `filter` only. No per-frame layout.
- Respect `prefers-reduced-motion` (JS state + the CSS media block).
- Class names are `lx-` prefixed. Chrome uses `--spice-*` where sensible;
  the immersive surface uses artwork-derived colour.
- No `console.log` in committed code. Comments explain non-obvious choices.

## Workflow

- `spicetify apply` copies files into the Spotify install; changes only take
  effect then. Debug via Spotify DevTools.
- `node --check` every file; `node --check` the concatenation too.
- README is English (portfolio project), links back to 404brainnotfound.at.
