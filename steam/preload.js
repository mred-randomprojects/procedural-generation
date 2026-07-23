// Preload bridge between the sandboxed game page and Electron/Steamworks.
//
// The game calls `window.heartfallBridge?.unlockAchievement(key)` from
// unlockAchievement() in voxel-gen.js every time a local achievement pops
// (keys are the ACHIEVEMENTS table in js/heartfall-core.js). To ship real
// Steam achievements, install steamworks.js and replace the body below:
//
//   const steamworks = require("steamworks.js");
//   const client = steamworks.init(APP_ID);
//   ... client.achievement.activate(key) ...
//
// Until then this logs, so the wiring is verifiable end-to-end in dev.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("heartfallBridge", {
  unlockAchievement(key) {
    console.log(`[heartfall] achievement unlocked: ${key}`);
  },
});
