# Heartfall — Steam packaging

Electron shell that wraps the web game (`../voxel.html`) into desktop builds
suitable for Steam depots.

## Build steps

1. **Stage the web build** — copy the game into `app/`:

   ```bash
   mkdir -p app/js
   cp ../voxel.html ../voxel.css app/
   cp ../js/noise.js ../js/voxel-gen.js ../js/voxel-textures.js ../js/voxel-audio.js app/js/
   ```

2. **Vendor three.js** (the page currently loads it from unpkg via an import
   map; Steam builds must work offline):

   ```bash
   curl -o app/js/three.module.js https://unpkg.com/three@0.160.0/build/three.module.js
   ```

   Then edit `app/voxel.html`'s import map to
   `{ "imports": { "three": "./js/three.module.js" } }`.

3. **Install + run locally**:

   ```bash
   npm install
   npm start
   ```

4. **Package** per platform: `npm run package:mac` / `package:win` / `package:linux`.
   Outputs land in `dist/`, ready to upload as Steam depot content via
   `steamcmd` / SteamPipe.

## Steam integration checklist

- [ ] Steamworks app ID + depot configured in the partner portal
- [ ] Wrap achievements: the game already tracks 8 achievements in
      `localStorage` (`vx-achievements` — see `ACHIEVEMENTS` in
      `voxel-gen.js`); bridge them to the Steamworks API with
      [steamworks.js](https://github.com/ceifa/steamworks.js) by calling
      `achievement.activate()` inside `unlockAchievement()` via a preload.
- [ ] Store assets: capsule art, screenshots, trailer
- [ ] Steam Overlay works out of the box with Electron ≥ 28 on default flags
- [ ] Cloud saves: sync `localStorage` keys `vx-legacy`, `vx-best-score`,
      `vx-settings`, `vx-achievements` (Steam Auto-Cloud on the app data dir)
