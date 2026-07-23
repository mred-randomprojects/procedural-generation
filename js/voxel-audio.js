// Small synthesized SFX kit (no audio files) built on the Web Audio API.
// Browsers block audio until a user gesture; ctx starts "suspended" and is
// resumed lazily the first time a sound is actually requested.

let ctx = null;

function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function noiseBuffer(c, duration) {
  const n = Math.max(1, Math.floor(c.sampleRate * duration));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function envGain(c, out, t0, attack, decay, peak) {
  const g = c.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  g.connect(out);
  return g;
}

// Two lowpass filters in series = a steep ~-24dB/octave rolloff, so almost no
// high-frequency energy survives — this is what keeps the noise layers from
// ever reading as bright/metallic ("cymbal") instead of a dull boom.
function darkNoise(c, out, duration, startFreq, endFreq, rampTime, t0, attack, decay, peak) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, duration);
  const f1 = c.createBiquadFilter();
  f1.type = "lowpass";
  f1.Q.value = 0.5;
  f1.frequency.setValueAtTime(startFreq, t0);
  f1.frequency.exponentialRampToValueAtTime(endFreq, t0 + rampTime);
  const f2 = c.createBiquadFilter();
  f2.type = "lowpass";
  f2.Q.value = 0.5;
  f2.frequency.setValueAtTime(startFreq, t0);
  f2.frequency.exponentialRampToValueAtTime(endFreq, t0 + rampTime);
  const g = envGain(c, out, t0, attack, decay, peak);
  src.connect(f1);
  f1.connect(f2);
  f2.connect(g);
  src.start(t0);
  return src;
}

// Harsh soft-clip curve — deliberately used only by the glitch layer below.
// (The base boom avoids this on purpose; driven/clipped sines read as bright
// and metallic, which is exactly the "glitchy and crazy" character we want
// once the blast radius goes past the old cap.)
function crushCurve(amount) {
  const n = 44100;
  const curve = new Float32Array(n);
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

// Bolted onto the base boom once the blast radius exceeds 8: a stuttering
// burst of short filtered noise blips, a square-wave siren that jumps
// randomly between dissonant pitches, and a crackly bitcrushed undertone.
// Intensity (and how unhinged it sounds) scales with how far past 8 you are.
function playGlitchLayer(c, master, t0, radius) {
  const intensity = Math.min(1.6, (radius - 8) * 0.22);

  const stutterCount = 5 + Math.floor(intensity * 7);
  for (let i = 0; i < stutterCount; i++) {
    const st = t0 + Math.random() * (0.15 + intensity * 0.4);
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 0.02 + Math.random() * 0.05);
    const filt = c.createBiquadFilter();
    filt.type = Math.random() < 0.5 ? "bandpass" : "highpass";
    filt.frequency.value = 300 + Math.random() * 4500;
    filt.Q.value = 4 + Math.random() * 10;
    const g = envGain(c, master, st, 0.001, 0.02 + Math.random() * 0.06, (0.4 + Math.random() * 0.6) * intensity);
    src.connect(filt);
    filt.connect(g);
    src.start(st);
  }

  // dissonant pitch-jumping siren — a classic "circuit bent" glitch sound
  const wob = c.createOscillator();
  wob.type = "square";
  const wobGain = envGain(c, master, t0, 0.01, 0.5 + intensity * 0.3, 0.3 * intensity);
  wob.connect(wobGain);
  let tt = t0;
  const steps = 8 + Math.floor(intensity * 6);
  for (let i = 0; i < steps; i++) {
    wob.frequency.setValueAtTime(180 + Math.random() * 2200, tt);
    tt += 0.025 + Math.random() * 0.05;
  }
  wob.start(t0);
  wob.stop(tt);

  // bitcrushed crackle undertone
  const crackle = c.createBufferSource();
  crackle.buffer = noiseBuffer(c, 0.35 + intensity * 0.2);
  const shaper = c.createWaveShaper();
  shaper.curve = crushCurve(60 + intensity * 40);
  const crackleGain = envGain(c, master, t0, 0.005, 0.3 + intensity * 0.2, 0.35 * intensity);
  crackle.connect(shaper);
  shaper.connect(crackleGain);
  crackle.start(t0);
}

// A big, dark, real-explosion boom: a fat sub-bass thump (two detuned low
// sines, no distortion/waveshaping — that's what was reading as a cymbal)
// plus a heavily double-filtered noise "whump" body and rumble tail.
// Scales louder and longer with blast radius; past radius 8 it also gets an
// increasingly glitchy/chaotic layer bolted on top (see playGlitchLayer).
export function playExplosion(radius = 3) {
  const c = getCtx();
  const t0 = c.currentTime;
  const scale = Math.min(4.0, 0.9 + radius * 0.16);
  const master = c.createGain();
  master.gain.value = Math.min(2.6, 1.05 * scale);
  master.connect(c.destination);

  // fat sub-bass thump: two detuned sines for body, no distortion (clean = no shimmer)
  for (const detune of [0, -6]) {
    const sub = c.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(110 * Math.pow(2, detune / 1200), t0);
    sub.frequency.exponentialRampToValueAtTime(26, t0 + 0.32 * scale);
    const subGain = envGain(c, master, t0, 0.006, 1.0 * scale, 0.9);
    sub.connect(subGain);
    sub.start(t0);
    sub.stop(t0 + 1.2 * scale);
  }

  // muffled noise "whump" — the body of the blast, dark from the very first sample
  darkNoise(c, master, 0.9 * scale, 700, 70, 0.45 * scale, t0, 0.006, 0.7 * scale, 1.0);

  // low rolling distant rumble tail for the "massive" feel
  darkNoise(c, master, 1.8 * scale, 220, 60, 0.6 * scale, t0 + 0.06, 0.3, 1.6 * scale, 0.6);

  if (radius > 8) playGlitchLayer(c, master, t0, radius);
}

// A loud, satisfying pop/splat + descending groan + low impact thud for a
// zombie kill. Gets a little louder/beefier for multi-kills (count > 1).
export function playZombieKill(count = 1) {
  const c = getCtx();
  const t0 = c.currentTime;
  const boost = Math.min(1.5, 1 + (count - 1) * 0.14);
  const master = c.createGain();
  master.gain.value = Math.min(2.2, 1.5 * boost);
  master.connect(c.destination);

  // low impact thud so the kill has real weight, not just a splat
  const thud = c.createOscillator();
  thud.type = "sine";
  thud.frequency.setValueAtTime(150, t0);
  thud.frequency.exponentialRampToValueAtTime(45, t0 + 0.16);
  const thudGain = envGain(c, master, t0, 0.004, 0.22, 1.0 * boost);
  thud.connect(thudGain);
  thud.start(t0);
  thud.stop(t0 + 0.3);

  // wet splat: bandpassed noise burst
  const splat = c.createBufferSource();
  splat.buffer = noiseBuffer(c, 0.18);
  const splatFilter = c.createBiquadFilter();
  splatFilter.type = "bandpass";
  splatFilter.frequency.setValueAtTime(1400, t0);
  splatFilter.frequency.exponentialRampToValueAtTime(220, t0 + 0.14);
  splatFilter.Q.value = 1.4;
  const splatGain = envGain(c, master, t0, 0.003, 0.18, 1.2);
  splat.connect(splatFilter);
  splatFilter.connect(splatGain);
  splat.start(t0);

  // descending groan
  const groan = c.createOscillator();
  groan.type = "sawtooth";
  groan.frequency.setValueAtTime(240, t0);
  groan.frequency.exponentialRampToValueAtTime(60, t0 + 0.28);
  const groanFilter = c.createBiquadFilter();
  groanFilter.type = "lowpass";
  groanFilter.frequency.value = 900;
  const groanGain = envGain(c, master, t0 + 0.02, 0.02, 0.3, 0.5);
  groan.connect(groanFilter);
  groanFilter.connect(groanGain);
  groan.start(t0 + 0.02);
  groan.stop(t0 + 0.4);

  // little reward "ding" so a kill feels good
  const ding = c.createOscillator();
  ding.type = "triangle";
  ding.frequency.setValueAtTime(900, t0 + 0.1);
  ding.frequency.exponentialRampToValueAtTime(1500, t0 + 0.22);
  const dingGain = envGain(c, master, t0 + 0.1, 0.01, 0.22, 0.35);
  ding.connect(dingGain);
  ding.start(t0 + 0.1);
  ding.stop(t0 + 0.34);
}
