# Heartfall — Steam packaging

Electron shell that wraps the web game (`../voxel.html`) into desktop builds
suitable for Steam depots.

## Build steps

1. **Stage the web build** (copies the game into `app/`, vendors three.js
   for offline play, rewrites the import map, stamps the version badge):

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
      exposes. All 16 keys live in `ACHIEVEMENTS` in
      `js/heartfall-core.js` — mirror them in the partner portal, then
      swap the `console.log` in `preload.js` for
      [steamworks.js](https://github.com/ceifa/steamworks.js)'s
      `achievement.activate(key)`.
- [x] Auto-pause when the window loses visibility (Steam overlay, alt-tab)
- [ ] Store assets: capsule art, screenshots, trailer
- [ ] Steam Overlay works out of the box with Electron ≥ 28 on default flags
- [ ] Cloud saves: sync `localStorage` keys `vx-legacy`, `vx-best-score`,
      `vx-settings`, `vx-achievements`, `vx-stats`, `vx-daily`
      (Steam Auto-Cloud on the app data dir)

## What the desktop build contains

`build.sh` stages: `voxel.html`, `voxel.css`, `js/noise.js`,
`js/heartfall-core.js`, `js/voxel-gen.js`, `js/voxel-textures.js`,
`js/voxel-audio.js`, a vendored `js/three.module.js`, and a stamped
`version.json`. No network access is needed at runtime.

Game-logic changes are covered by the repo test suite — run `npm test`
from the repo root before packaging.
