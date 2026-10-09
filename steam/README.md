# Heartfall — Steam packaging

Electron shell that wraps the web game (`../index.html`) into desktop builds
suitable for Steam depots.

## Build steps

1. **Stage the web build** (copies the game into `app/`, vendors three.js
   for offline play, rewrites the import map, drops the ⌘S helper the page
   imports from jsDelivr, stamps the version badge):

   ```bash
   ./build.sh
   ```

2. **Install + run locally**:

   ```bash
   npm install
   npm start
   ```

3. **Package** per platform: `npm run package:mac` / `package:win` / `package:linux`.
   Outputs land in `dist/`, ready to upload as Steam depot content via
   `steamcmd` / SteamPipe.

## Steam integration checklist

- [ ] Steamworks app ID + depot configured in the partner portal
- [x] Achievements bridge: the game reports every unlock through
      `window.heartfallBridge.unlockAchievement(key)` (see
      `unlockAchievement()` in `js/voxel-gen.js`), which `preload.js`
      exposes. All 23 keys live in `ACHIEVEMENTS` in
      `js/heartfall-core.js` (the test suite pins the count) — mirror
      them in the partner portal, then
      swap the `console.log` in `preload.js` for
      [steamworks.js](https://github.com/ceifa/steamworks.js)'s
      `achievement.activate(key)`.
- [ ] Decide whether the desktop build pauses on blur. Today nothing
      pauses on its own: like the web game, the siege keeps running when
      the window is hidden or loses focus (Steam overlay, alt-tab), and
      the Heart keeps taking damage. Pausing by hand (P) still works.
- [ ] Store assets: capsule art, screenshots, trailer
- [ ] Steam Overlay works out of the box with Electron ≥ 28 on default flags
- [ ] Cloud saves: sync `localStorage` keys `vx-legacy`, `vx-best-score`,
      `vx-settings`, `vx-achievements`, `vx-stats`, `vx-daily`
      (Steam Auto-Cloud on the app data dir)

## What the desktop build contains

`build.sh` stages: `index.html` (the game, staged as `app/voxel.html`),
`voxel.css`, `js/noise.js`,
`js/heartfall-core.js`, `js/voxel-gen.js`, `js/voxel-textures.js`,
`js/voxel-audio.js`, a vendored `js/three.module.js`, and a stamped
`version.json`. It leaves out the page's ⌘S helper (cmd-s, imported from
jsDelivr; the desktop window has no save-page dialog for it to block), and
it fails if the staged page still references unpkg or jsDelivr, so no
network access is needed at runtime.

Game-logic changes are covered by the repo test suite — run `npm test`
from the repo root before packaging.
