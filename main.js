/* ==========================================================================
   TURBO CRITTER GRAND PRIX
   --------------------------------------------------------------------------
   A complete browser kart racer in one file, built on three.js.
   Everything is procedural: track, karts, decorations, music and sound
   effects (Web Audio API). No external assets of any kind.

   File map (search for the ===== banners):
     1. Utilities & saved data
     2. Audio engine (synth music + SFX)
     3. Renderer / scene / lights
     4. Track building (spline, road, tunnel, ramp, mud shortcut, decor, duck)
     5. Particle system
     6. Kart factory + bot roster
     7. Racer class (player physics + bot AI)
     8. Items, rockets, puddles, coins, triggers
     9. Race manager (menu → countdown → race → results)
    10. HUD, toasts, results & menu wiring
    11. Input
    12. Debug mode (P)
    13. Main loop & boot
   ========================================================================== */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* =====================================================================
   1. UTILITIES & SAVED DATA
   ===================================================================== */

const rand    = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick    = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp   = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp    = (a, b, t) => a + (b - a) * t;
/** Wrap an angle to [-PI, PI] so steering math never spins the long way. */
const wrapPi  = (a) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };
const ordinal = (n) => n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
const fmtTime = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
};

/** Tiny localStorage wrapper — persists settings + the Duck Mode easter egg. */
const SAVE = {
  get (k, d) { try { const v = localStorage.getItem('tcgp_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set (k, v) { try { localStorage.setItem('tcgp_' + k, JSON.stringify(v)); } catch (e) { /* private mode: ignore */ } },
};

/** Difficulty presets — how fast/mean the bots are. Persisted in SAVE. */
const DIFFICULTIES = {
  easy:   { key: 'easy',   label: 'Easy 🌱',   botSpeed: 0.94, rubberMin: 0.78, rubberMax: 1.22, rubberGain: 0.6,  itemChance: 0.07, corner: 0.95, driftSkill: 0.92 },
  medium: { key: 'medium', label: 'Medium 🏁', botSpeed: 1.0,  rubberMin: 0.84, rubberMax: 1.17, rubberGain: 0.5,  itemChance: 0.15, corner: 1.0,  driftSkill: 0.84 },
  hard:   { key: 'hard',   label: 'Hard 🔥',   botSpeed: 1.05, rubberMin: 0.92, rubberMax: 1.10, rubberGain: 0.35, itemChance: 0.26, corner: 1.06, driftSkill: 0.78 },
};
let DIFF = DIFFICULTIES[SAVE.get('difficulty', 'medium')] || DIFFICULTIES.medium;

/* =====================================================================
   2. AUDIO ENGINE — everything is synthesized live with the Web Audio API
   ===================================================================== */

/** note name ("C5", "A#3") → frequency in Hz */
function noteFreq (name) {
  const SEMI = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
  const m = /^([A-G]#?)(\d)$/.exec(name);
  if (!m) return 440;
  return 440 * Math.pow(2, (SEMI[m[1]] + (parseInt(m[2], 10) - 4) * 12) / 12);
}

// 4-bar loop, 8th-note grid (32 steps), chords C → Am → F → G.
const LEAD_PAT = [
  'E5', 0, 'G5', 0, 'C6', 0, 'G5', 'A5',
  'A5', 0, 'E5', 0, 'A5', 0, 'C6', 0,
  'F5', 0, 'A5', 0, 'C6', 0, 'A5', 0,
  'B5', 0, 'G5', 'B5', 'D6', 0, 'B5', 'G5',
];
// Duck-remix lead: 'Q' = quack, 'QH' = high quack. Same chords, more nonsense.
const DUCK_PAT = [
  'Q', 0, 0, 'Q', 0, 0, 'QH', 0,
  'Q', 0, 'Q', 0, 0, 'QH', 0, 0,
  'Q', 0, 0, 'Q', 0, 'Q', 'QH', 0,
  'QH', 0, 'Q', 'Q', 0, 0, 'QH', 0,
];
const CHORD_ROOTS = ['C', 'A', 'F', 'G'];

class AudioMan {
  constructor () {
    this.ctx = null;
    this.muted  = SAVE.get('muted', false);
    this.volume = SAVE.get('volume', 0.7);
    this.duck = false;        // duck remix active?
    this.musicOn = false;
    this.step = 0; this.nextT = 0; this.timer = null;
    this.engine = null; this.skid = null;
  }

  /** Create the AudioContext lazily (must happen inside a user gesture). */
  ensure () {
    if (!this.ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        this.musicBus = this.ctx.createGain(); this.musicBus.gain.value = 0.17; this.musicBus.connect(this.master);
        this.sfxBus   = this.ctx.createGain(); this.sfxBus.gain.value = 0.6;    this.sfxBus.connect(this.master);
        // 1 second of white noise, reused by every noise-based effect
        const len = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.applyVol();
      } catch (e) { console.warn('Web Audio unavailable:', e); }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  ready () { return !!this.ctx; }
  applyVol () { if (this.master) this.master.gain.value = this.muted ? 0 : this.volume; }
  setVolume (v) { this.volume = v; SAVE.set('volume', v); this.applyVol(); }
  setMuted (m) { this.muted = m; SAVE.set('muted', m); this.applyVol(); }

  /* ---------- tiny synth helpers ---------- */

  /** One oscillator with a pitch glide and an exponential-ish decay envelope. */
  tone (o) {
    if (!this.ready()) return;
    const t0 = o.t0 !== undefined ? o.t0 : this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + o.dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.gain || 0.2, t0 + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g);
    let dest = o.music ? this.musicBus : this.sfxBus;
    if (o.filter) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = o.filter;
      g.connect(f); f.connect(dest);
    } else g.connect(dest);
    osc.start(t0); osc.stop(t0 + o.dur + 0.05);
  }

  /** Filtered noise burst (skids, whooshes, hats, crashes, fireworks). */
  noise (o) {
    if (!this.ready()) return;
    const t0 = o.t0 !== undefined ? o.t0 : this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = o.rate || 1;
    const f = this.ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.f0 || 800, t0);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.f1), t0 + o.dur);
    f.Q.value = o.q || 1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.gain || 0.2, t0 + (o.attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(f); f.connect(g); g.connect(o.music ? this.musicBus : this.sfxBus);
    src.start(t0); src.stop(t0 + o.dur + 0.05);
  }

  /** The signature quack: a pinched saw with a falling formant. */
  quack (opts) {
    if (!this.ready()) return;
    const t0 = (opts && opts.t0) !== undefined ? opts.t0 : this.ctx.currentTime;
    const hi = opts && opts.high;
    const gn = (opts && opts.gain) || 0.22;
    const music = opts && opts.music;
    const mk = (t, f0, f1) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + 0.13);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 3.5;
      bp.frequency.setValueAtTime(hi ? 1500 : 1100, t);
      bp.frequency.exponentialRampToValueAtTime(hi ? 700 : 450, t + 0.14);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gn, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(bp); bp.connect(g); g.connect(music ? this.musicBus : this.sfxBus);
      osc.start(t); osc.stop(t + 0.2);
    };
    const base = hi ? 640 : 480;
    mk(t0, base, base * 0.45);          // "qua-"
    mk(t0 + 0.085, base * 0.9, base * 0.4); // "-ack"
  }

  /* ---------- music sequencer ---------- */

  startMusic () {
    this.ensure();
    if (!this.ctx) return;
    this.stopMusic();
    this.musicOn = true;
    this.step = 0;
    this.nextT = this.ctx.currentTime + 0.08;
    this.timer = setInterval(() => this.pump(), 25);
  }
  stopMusic () {
    this.musicOn = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  setDuck (on) { this.duck = on; }

  /** Look-ahead scheduler: keeps ~120 ms of music queued at all times. */
  pump () {
    if (!this.musicOn || !this.ctx) return;
    const stepDur = 60 / (this.duck ? 140 : 132) / 2; // 8th notes
    while (this.nextT < this.ctx.currentTime + 0.12) {
      this.schedStep(this.step, this.nextT, stepDur);
      this.step = (this.step + 1) % 32;
      this.nextT += stepDur;
    }
  }

  schedStep (s, t, stepDur) {
    if (this.muted) return; // save CPU while muted
    const chord = CHORD_ROOTS[Math.floor(s / 8)];
    // Kick on every beat, snare-ish noise on backbeats, hat on off-8ths
    if (s % 2 === 0) this.tone({ t0: t, f0: 130, f1: 42, dur: 0.11, type: 'sine', gain: 0.5, music: true });
    if (s % 8 === 4) this.noise({ t0: t, f0: 1800, dur: 0.09, q: 0.8, gain: 0.16, music: true });
    if (s % 2 === 1) this.noise({ t0: t, f0: 7000, dur: 0.03, q: 1.2, gain: 0.07, type: 'highpass', music: true });
    // Bouncy bass: low root / octave-up alternating
    const bs = s % 8;
    if (bs === 0 || bs === 3 || bs === 6) {
      const oct = bs === 3 ? '3' : '2';
      this.tone({ t0: t, f0: noteFreq(chord + oct), dur: 0.16, type: 'square', gain: 0.18, filter: 500, music: true });
    }
    // Lead: either the melody or the quack remix
    const pat = this.duck ? DUCK_PAT : LEAD_PAT;
    const n = pat[s];
    if (n) {
      if (n === 'Q' || n === 'QH') this.quack({ t0: t, high: n === 'QH', gain: 0.13, music: true });
      else {
        this.tone({ t0: t, f0: noteFreq(n), dur: stepDur * 1.7, type: 'square', gain: 0.09, filter: 2600, music: true });
        this.tone({ t0: t, f0: noteFreq(n) * 1.005, dur: stepDur * 1.7, type: 'sawtooth', gain: 0.05, filter: 1800, music: true });
      }
    }
  }

  /* ---------- engine + skid loops (player kart) ---------- */

  startEngine () {
    this.ensure();
    if (!this.ctx || this.engine) return;
    const saw = this.ctx.createOscillator(); saw.type = 'sawtooth'; saw.frequency.value = 55;
    const sub = this.ctx.createOscillator(); sub.type = 'sine';     sub.frequency.value = 28;
    const lp  = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
    const g   = this.ctx.createGain(); g.gain.value = 0;
    saw.connect(lp); sub.connect(lp); lp.connect(g); g.connect(this.sfxBus);
    saw.start(); sub.start();
    this.engine = { saw, sub, lp, g };
    // Looping skid noise, gated by gain while drifting
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 950; bp.Q.value = 0.9;
    const sg = this.ctx.createGain(); sg.gain.value = 0;
    src.connect(bp); bp.connect(sg); sg.connect(this.sfxBus);
    src.start();
    this.skid = { src, sg };
  }
  stopEngine () {
    if (this.engine) { try { this.engine.saw.stop(); this.engine.sub.stop(); } catch (e) {} this.engine = null; }
    if (this.skid) { try { this.skid.src.stop(); } catch (e) {} this.skid = null; }
  }
  /** Called every frame with normalized speed + inputs. */
  updateEngine (speed01, throttle, drifting, boosting) {
    if (!this.engine || !this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 50 + speed01 * 185 + (boosting ? 30 : 0);
    this.engine.saw.frequency.setTargetAtTime(f, t, 0.05);
    this.engine.sub.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.engine.lp.frequency.setTargetAtTime(320 + speed01 * 1500, t, 0.08);
    this.engine.g.gain.setTargetAtTime(0.03 + throttle * 0.045 + speed01 * 0.02, t, 0.08);
    if (this.skid) this.skid.sg.gain.setTargetAtTime(drifting ? 0.13 : 0, t, 0.04);
  }

  /* ---------- one-shot game SFX ---------- */

  countBeep ()      { this.tone({ f0: 523, dur: 0.18, type: 'square', gain: 0.25 }); }
  goSound ()        { this.tone({ f0: 784, dur: 0.5, type: 'square', gain: 0.3 });
                      this.tone({ f0: 1046, dur: 0.5, type: 'square', gain: 0.18 });
                      this.noise({ f0: 2000, f1: 4000, dur: 0.3, gain: 0.15 }); }
  boostSfx ()       { this.noise({ f0: 300, f1: 2600, dur: 0.45, q: 2, gain: 0.3 });
                      this.tone({ f0: 180, f1: 560, dur: 0.4, type: 'sawtooth', gain: 0.12, filter: 900 }); }
  padSfx ()         { this.tone({ f0: 330, f1: 660, dur: 0.22, type: 'square', gain: 0.2 });
                      this.noise({ f0: 600, f1: 2400, dur: 0.25, gain: 0.18 }); }
  pickupSfx ()      { this.tone({ f0: 784, dur: 0.09, gain: 0.18 }); this.tone({ f0: 1046, dur: 0.14, gain: 0.18, t0: this.ctx ? this.ctx.currentTime + 0.08 : 0 }); }
  rouletteTick ()   { this.tone({ f0: 660, dur: 0.04, gain: 0.08 }); }
  coinSfx (n)       { const p = 1 + Math.min(n, 10) * 0.05;
                      this.tone({ f0: 987 * p, dur: 0.06, gain: 0.14 });
                      this.tone({ f0: 1318 * p, dur: 0.12, gain: 0.14, t0: this.ctx ? this.ctx.currentTime + 0.05 : 0 }); }
  rocketFire ()     { this.noise({ f0: 400, f1: 1800, dur: 0.5, q: 1.5, gain: 0.3 });
                      this.tone({ f0: 300, f1: 80, dur: 0.5, type: 'sawtooth', gain: 0.15, filter: 700 }); }
  rocketHit ()      { this.noise({ f0: 1500, f1: 300, dur: 0.4, gain: 0.35 });
                      this.tone({ f0: 220, f1: 55, dur: 0.35, type: 'square', gain: 0.25 }); }
  bumpSfx ()        { this.tone({ f0: 130, f1: 40, dur: 0.16, type: 'sine', gain: 0.4 });
                      this.noise({ f0: 900, f1: 250, dur: 0.12, gain: 0.2 }); }
  wallSfx ()        { this.tone({ f0: 100, f1: 35, dur: 0.2, type: 'sine', gain: 0.45 });
                      this.noise({ f0: 2500, f1: 500, dur: 0.2, gain: 0.25 }); }
  shieldUp ()       { this.tone({ f0: 300, f1: 900, dur: 0.3, type: 'sine', gain: 0.2 }); }
  shieldPopSfx ()   { this.tone({ f0: 600, f1: 150, dur: 0.12, type: 'sine', gain: 0.3 });
                      this.noise({ f0: 3000, dur: 0.06, gain: 0.2 }); }
  starSfx ()        { for (let i = 0; i < 5; i++) this.tone({ f0: 700 + i * 180, dur: 0.12, gain: 0.12, t0: this.ctx ? this.ctx.currentTime + i * 0.05 : 0 }); }
  slimeSfx ()       { this.noise({ f0: 300, f1: 90, dur: 0.35, q: 2, gain: 0.25, rate: 0.5 });
                      this.tone({ f0: 160, f1: 60, dur: 0.3, type: 'triangle', gain: 0.2 }); }
  lapChime (finalLap) {
    const notes = finalLap ? ['C5', 'E5', 'G5', 'C6'] : ['E5', 'A5'];
    notes.forEach((n, i) => this.tone({ f0: noteFreq(n), dur: 0.16, gain: 0.2, t0: this.ctx ? this.ctx.currentTime + i * 0.09 : 0 }));
  }
  hornSfx (duck) {
    if (duck) { this.quack({ gain: 0.3 }); return; }
    this.tone({ f0: 392, dur: 0.2, type: 'square', gain: 0.22 });
    this.tone({ f0: 494, dur: 0.2, type: 'square', gain: 0.22 });
  }
  chirp () { // menu birds
    const t = this.ctx ? this.ctx.currentTime : 0;
    this.tone({ f0: 2200, f1: 2700, dur: 0.05, type: 'sine', gain: 0.05, t0: t });
    this.tone({ f0: 2500, f1: 2100, dur: 0.06, type: 'sine', gain: 0.04, t0: t + 0.09 });
  }
  finishSfx ()      { this.tone({ f0: 523, dur: 0.15, gain: 0.25 });
                      this.tone({ f0: 659, dur: 0.15, gain: 0.25, t0: this.ctx ? this.ctx.currentTime + 0.12 : 0 });
                      this.tone({ f0: 784, dur: 0.3, gain: 0.25, t0: this.ctx ? this.ctx.currentTime + 0.24 : 0 }); }
  victoryFanfare () {
    const seq = [['C5', 0, 0.14], ['E5', 0.13, 0.14], ['G5', 0.26, 0.14], ['C6', 0.4, 0.3], ['G5', 0.72, 0.12], ['C6', 0.85, 0.6]];
    seq.forEach(([n, dt, dur]) => {
      this.tone({ f0: noteFreq(n), dur, type: 'square', gain: 0.22, t0: this.ctx ? this.ctx.currentTime + dt : 0 });
      this.tone({ f0: noteFreq(n) / 2, dur, type: 'triangle', gain: 0.15, t0: this.ctx ? this.ctx.currentTime + dt : 0 });
    });
  }
  loseJingle () {
    const seq = [['E4', 0], ['D4', 0.35], ['C4', 0.7]];
    seq.forEach(([n, dt]) => this.tone({ f0: noteFreq(n), f1: noteFreq(n) * 0.94, dur: 0.32, type: 'sawtooth', gain: 0.16, filter: 900, t0: this.ctx ? this.ctx.currentTime + dt : 0 }));
  }
  duckFanfare () { for (let i = 0; i < 6; i++) this.quack({ high: i % 2 === 1, gain: 0.25, t0: this.ctx ? this.ctx.currentTime + i * 0.16 : 0 }); }
  fireworkBoom () { this.noise({ f0: 250, f1: 60, dur: 0.5, gain: 0.2 }); this.tone({ f0: 90, f1: 40, dur: 0.4, type: 'sine', gain: 0.2 }); }
}

const AUDIO = new AudioMan();

/* =====================================================================
   3. RENDERER / SCENE / CAMERA / LIGHTS
   ===================================================================== */

const UI = (() => {
  const $ = (id) => document.getElementById(id);
  const ids = ['hud','pos','posSuf','lap','timer','board','itemSlot','itemIcon','itemName',
    'speedVal','boostFill','coins','toasts','countdown','wrongway','secretMsg','muteBtn',
    'menu','startBtn','menuMuteBtn','volSlider','swatches','duckToggleRow','duckToggle','bestTime',
    'results','resultsTitle','resultsSub','placeBig','winnerName','raceTimeRow','resultsBoard',
    'againBtn','menuBtn','resultsTip','pauseOverlay','resumeBtn','pauseRestartBtn','pauseMenuBtn',
    'confettiLayer','debugPanel','diffBtns','pauseBtn','minimap','nitroFx','mapBtns','fxBtn','schemeBtns','schemeRow','statsLine'];
  const o = {};
  ids.forEach((id) => { o[id] = $(id); });
  return o;
})();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;      // premium filmic response
renderer.toneMappingExposure = 1.1;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9fdcff, 220, 640);          // retinted per map

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 30, 60);

const hemiLight = new THREE.HemisphereLight(0xcfeaff, 0x5da743, 1.15);
scene.add(hemiLight);
const sun = new THREE.DirectionalLight(0xfff3d6, 1.9);
sun.position.set(140, 190, 90);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -300; sun.shadow.camera.right = 300;
sun.shadow.camera.top = 300;   sun.shadow.camera.bottom = -300;
sun.shadow.camera.far = 700;
sun.shadow.bias = -0.0004;
scene.add(sun);

// soft studio reflections so metallic paint reads "premium"
const pmrem = new THREE.PMREMGenerator(renderer);
try { scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; }
catch (e) { console.warn('env map unavailable', e); }
scene.environmentIntensity = 0.5;

// optional bloom pipeline ("Fancy FX") — desktop default on, phones default off
let composer = null, bloomPass = null;
let fancyFX = SAVE.get('fx', !(navigator.maxTouchPoints > 0 || 'ontouchstart' in window));
function setupComposer () {
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.32, 0.55, 0.82);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
}
try { setupComposer(); } catch (e) { console.warn('bloom unavailable', e); composer = null; }

/* =====================================================================
   4. TRACK SYSTEM — three maps, one config-driven builder.
   Every mesh goes into world.group so a map can be torn down and a new
   one built without reloading the page.
   ===================================================================== */

const N = 320;                 // waypoint samples around every lap
const BASE_HW = 9;             // base half-width of the road
const GRAV = 16;               // arcade gravity
const KART_R = 1.9;            // kart collision radius
const WORLD_R = 430;           // hard outer world boundary

/** The three Grand Prix venues. Coordinates are hand-placed control points;
    everything else (pads, ramps, boxes, coins, theme) is data too. */
const MAPS = [
  {
    key: 'meadows', label: 'Sunny Meadows', emoji: '🌳',
    ctrl: [
      [-160, 150], [-80, 153], [20, 153], [95, 146], [163, 122], [203, 55],
      [207, -25], [196, -95], [150, -158], [62, -184], [18, -162], [-28, -189],
      [-92, -180], [-148, -152], [-170, -95], [-128, -42], [-60, -26], [-42, 8],
      [-98, 34], [-160, 22], [-179, 88], [-168, 132],
    ],
    finish: [-40, 153],
    widths: [[-120, 152, 40, 153, 11], [190, 90, 190, -100, 13], [-70, -26, -95, 32, 10]],
    barriers: [
      [-160, 140, 60, 152], [180, 100, 175, -120], [170, -140, 40, -182],
      [-120, -175, -168, -120], [-52, -18, -80, 30], [-180, 70, -140, 148],
    ],
    tunnel: { a: [30, -168], b: [-82, -182], hill: 'cone', hillPos: [-25, -178], hillColor: 0x5cab3f, tubeColor: 0x9d8fb8, portalColor: 0x6b5a94 },
    pads: [[205, 35, 0, 9, 4], [206, 0, 0, 9, 4], [203, -40, 0, 9, 4], [-105, -172, 0, 6, 3.5], [60, 152, 3.5, 4.5, 3]],
    ramps: [[198, -78]],
    boxRows: [[180, 90], [100, -178], [-172, 55]],
    coinRuns: [[-20, 153, 55, 152, 6, 4], [206, 48, 202, -30, 7, 0], [-120, -48, -95, 30, 7, 0], [20, -164, -55, -186, 5, 2.5]],
    mud: { pts: [[-170, -88], [-186, -30], [-172, 16]], entry: [-170, -95], exit: [-160, 22], color: 0x8a6237 },
    duck: [-70, -215],
    bills: ['WORM-UP GYM  •  get ripped(ish)', 'SNAIL MAIL — overnight-ish delivery', 'EAT AT BEAKY’S  •  bread only'],
    theme: {
      skyTop: 0x3b86e8, skyBottom: 0xbfe8ff, sunPos: [140, 190, 90], sunColor: 0xfff3d6, sunIntensity: 1.9,
      hemiSky: 0xcfeaff, hemiGround: 0x5da743, hemiIntensity: 1.15,
      fog: [0x9fdcff, 220, 640], ground: 0x6cc24a, roadA: 0x3f4450, roadB: 0x474c59,
      edgeLine: 0xe8e8ee, curbA: 0xe04545, curbB: 0xf3f3f3, railA: 0xff5757, railB: 0xffffff, railGlow: false,
      flagCols: [0xffd23f, 0xff4f9a, 0x29d9e5, 0x7ee04e, 0xff7a1a],
      decor: 'forest', clouds: true, night: false, tempo: 132,
    },
  },
  {
    key: 'dunes', label: 'Sunset Dunes', emoji: '🌵',
    ctrl: [
      [170, 128], [60, 138], [-60, 136], [-150, 112], [-205, 50], [-215, -40],
      [-170, -125], [-80, -165], [-10, -152], [35, -100], [95, -82], [130, -118],
      [152, -158], [200, -95], [207, -5], [188, 70],
    ],
    finish: [40, 139],
    widths: [[140, 132, -20, 139, 11], [198, -90, 195, 55, 13], [30, -102, 100, -85, 10]],
    barriers: [
      [150, 130, -100, 137], [-190, 80, -210, 0], [20, -110, 110, -85],
      [195, -90, 190, 60], [196, 90, 175, 120],
    ],
    tunnel: { a: [-213, -55], b: [-180, -115], hill: 'cone', hillPos: [-200, -85], hillColor: 0xc98a4b, tubeColor: 0xa5793f, portalColor: 0x8a6237 },
    pads: [[203, -60, 0, 9, 4], [205, -25, 0, 9, 4], [204, 10, 0, 9, 4], [-172, -118, 0, 6, 3.5], [100, 134, -3, 4.5, 3]],
    ramps: [[196, 45]],
    boxRows: [[-100, 134], [60, -88], [203, -55]],
    coinRuns: [[130, 133, 0, 138, 6, 4], [203, -70, 200, 20, 7, 0], [30, -100, 125, -115, 7, 0], [-210, -50, -185, -110, 5, 2]],
    mud: { pts: [[-5, -148], [70, -136], [140, -150]], entry: [-10, -152], exit: [152, -158], color: 0xb78a52 },
    duck: [-238, -95],
    bills: ['CACTUS COLA — refreshingly sharp', 'DUNE TOURS — sand included, free', 'LIZARD LUBE  •  oil change while-u-bask'],
    theme: {
      skyTop: 0x5a3f8f, skyBottom: 0xffb26b, sunPos: [-220, 60, 120], sunColor: 0xffb36b, sunIntensity: 2.2,
      hemiSky: 0xffd9b0, hemiGround: 0xc98a4b, hemiIntensity: 0.9,
      fog: [0xf0b98a, 230, 700], ground: 0xd8a95e, roadA: 0x4a4148, roadB: 0x524950,
      edgeLine: 0xffe9c9, curbA: 0xd96236, curbB: 0xffe9c9, railA: 0xd96236, railB: 0xf7ead2, railGlow: false,
      flagCols: [0xffd23f, 0xff7a1a, 0xd96236, 0xf7ead2, 0xff4f9a],
      decor: 'desert', clouds: true, night: false, tempo: 126,
    },
  },
  {
    key: 'city', label: 'Neon City', emoji: '🌃',
    ctrl: [
      [-150, 110], [-40, 118], [70, 112], [150, 90], [170, 20], [158, -62],
      [172, -132], [118, -185], [30, -162], [-12, -196], [-62, -162], [-132, -186],
      [-186, -120], [-172, -48], [-118, -8], [-82, 32], [-148, 58], [-182, 86],
    ],
    finish: [-40, 117],
    widths: [[-120, 114, 30, 115, 11], [168, 0, 168, -120, 12], [-115, -10, -90, 30, 10]],
    barriers: [
      [-140, 112, 120, 100], [172, 10, 165, -140], [150, -165, 50, -165],
      [40, -158, -70, -160], [-180, -130, -175, -60], [-120, -12, -90, 28], [-178, 80, -150, 104],
    ],
    tunnel: { a: [10, -172], b: [-95, -180], hill: 'slab', hillPos: [-45, -180], hillColor: 0x171a2c, tubeColor: 0x2a2f4a, portalColor: 0x67e8f9 },
    pads: [[167, -20, 0, 8, 4], [168, -60, 0, 8, 4], [169, -100, 0, 8, 4], [-115, -182, 0, 6, 3.5], [40, 114, 3, 4.5, 3]],
    ramps: [[169, -118]],
    boxRows: [[120, 98], [-30, -178], [-176, 68]],
    coinRuns: [[-10, 116, 60, 113, 6, 4], [168, -10, 170, -95, 7, 0], [-115, -10, -95, 25, 6, 0], [15, -168, -85, -178, 5, 2]],
    mud: { pts: [[-178, -42], [-200, 15], [-186, 72]], entry: [-174, -46], exit: [-180, 82], color: 0x1e222b },
    duck: [-140, -220],
    bills: ['MEGAWATT NOODLES — open 25/7', 'HOVER-ISH TAXIS  •  mostly ground', 'BYTE BURGERS — now 01% beef'],
    theme: {
      skyTop: 0x0d1133, skyBottom: 0x3a2455, sunPos: [-100, 220, -80], sunColor: 0x9ab8ff, sunIntensity: 1.15,
      hemiSky: 0x3a4478, hemiGround: 0x181b28, hemiIntensity: 0.85,
      fog: [0x141230, 180, 560], ground: 0x23262f, roadA: 0x2e3138, roadB: 0x33363e,
      edgeLine: 0x67e8f9, curbA: 0x67e8f9, curbB: 0x1c1f2b, railA: 0x67e8f9, railB: 0xf472b6, railGlow: true,
      flagCols: [0x67e8f9, 0xf472b6, 0xfde68a, 0xa5b4fc, 0x7ee04e],
      decor: 'city', clouds: false, night: true, tempo: 138,
    },
  },
];
const MAP_BY_KEY = Object.fromEntries(MAPS.map((m) => [m.key, m]));

/** world: everything the game needs to know about the CURRENT track. */
const world = {
  group: null, mapKey: null, debugVisible: false,
  samples: [], segLen: 0, trackLen: 0, lineIdx: 0,
  pads: [], ramps: [], boxes: [], coins: [], puddles: [], rockets: [],
  mudPts: [], mudW: 5.5, shortcutEntryIdx: 0, shortcutExitIdx: 0,
  flags: [], balloons: [], clouds: [], startLights: [],
  duck: null, debugGroup: null, botTargetLines: null, finishPos: new THREE.Vector3(),
  miniPts: [], miniMud: [],
};

/** Nearest sample index to a world x/z — used to anchor every feature. */
function nearestIdx (x, z) {
  let best = 1e18, bi = 0;
  for (let i = 0; i < N; i++) {
    const s = world.samples[i];
    const dx = s.pos.x - x, dz = s.pos.z - z;
    const d = dx * dx + dz * dz;
    if (d < best) { best = d; bi = i; }
  }
  return bi;
}
/** Walk forward from a to b (wrapping) and call fn(i) on each sample. */
function forRange (ia, ib, fn) {
  let i = ia;
  for (let guard = 0; guard <= N; guard++) { fn(i); if (i === ib) break; i = (i + 1) % N; }
}
/** Place an object on the road: anchor x/z → snapped pos + yaw along travel. */
function placeOnTrack (x, z, lat = 0, y = 0) {
  const i = nearestIdx(x, z);
  const s = world.samples[i];
  return {
    idx: i,
    pos: s.pos.clone().addScaledVector(s.side, lat).setY(y),
    yaw: Math.atan2(s.tan.x, s.tan.z),
    side: s.side, tan: s.tan,
  };
}
/** Oriented-box trigger test on the XZ plane. */
function inTrigger (p, tr) {
  const dx = p.x - tr.x, dz = p.z - tr.z;
  const cos = Math.cos(-tr.yaw), sin = Math.sin(-tr.yaw);
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  return { hit: Math.abs(lx) < tr.hx && Math.abs(lz) < tr.hz, lx, lz };
}
/** true if the point is comfortably away from road + mud (for placing decor). */
function clearOfTrack (x, z, margin) {
  for (let i = 0; i < N; i += 2) {
    const s = world.samples[i];
    const dx = s.pos.x - x, dz = s.pos.z - z;
    if (dx * dx + dz * dz < (s.w + margin) * (s.w + margin)) return false;
  }
  for (const p of world.mudPts) {
    const dx = p.x - x, dz = p.z - z;
    if (dx * dx + dz * dz < (world.mudW + margin) * (world.mudW + margin)) return false;
  }
  return true;
}

/* ---------- canvas-texture helpers (banners, signs — all procedural) ---------- */
function textTexture (text, opts = {}) {
  const c = document.createElement('canvas');
  c.width = opts.w || 512; c.height = opts.h || 128;
  const x = c.getContext('2d');
  x.fillStyle = opts.bg || '#20164a';
  x.fillRect(0, 0, c.width, c.height);
  if (opts.border) { x.strokeStyle = opts.border; x.lineWidth = 10; x.strokeRect(5, 5, c.width - 10, c.height - 10); }
  x.fillStyle = opts.fg || '#ffd23f';
  x.font = `900 ${opts.size || 56}px "Arial Rounded MT Bold", "Trebuchet MS", sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, c.width / 2, c.height / 2 + 2);
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  return tx;
}
function chevronTexture (dir) { // dir: -1 left, +1 right
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#e0a814'; x.fillRect(0, 0, 256, 128);
  x.strokeStyle = '#20164a'; x.lineWidth = 14; x.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const cx = 58 + i * 70;
    x.beginPath();
    x.moveTo(cx - 18 * dir, 26); x.lineTo(cx + 18 * dir, 64); x.lineTo(cx - 18 * dir, 102);
    x.stroke();
  }
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  return tx;
}
function checkerTexture () {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const x = c.getContext('2d');
  for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) {
    x.fillStyle = (i + j) % 2 ? '#111' : '#fff';
    x.fillRect(i * 8, j * 8, 8, 8);
  }
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  return tx;
}
function padTexture () {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#0b2b46'; x.fillRect(0, 0, 128, 256);
  x.strokeStyle = '#35f0ff'; x.lineWidth = 20; x.lineCap = 'round';
  for (let i = 0; i < 2; i++) {
    const cy = 190 - i * 95;
    x.beginPath(); x.moveTo(24, cy); x.lineTo(64, cy - 55); x.lineTo(104, cy); x.stroke();
  }
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  return tx;
}
/** soft noise texture used to break up big flat ground colors */
function noiseTexture (shade = 0.1) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 1400; i++) {
    const g = 255 - Math.floor(Math.random() * 255 * shade);
    x.fillStyle = `rgb(${g},${g},${g})`;
    x.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  }
  const tx = new THREE.CanvasTexture(c);
  tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  tx.repeat.set(60, 60);
  return tx;
}
/** lit-window texture for the night-city towers */
function windowsTexture () {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#0d0f1a'; x.fillRect(0, 0, 128, 256);
  const cols = ['#67e8f9', '#f9a8d4', '#fde68a', '#a5b4fc'];
  for (let wy = 0; wy < 16; wy++) for (let wx = 0; wx < 6; wx++) {
    if (Math.random() < 0.34) {
      x.fillStyle = cols[Math.floor(Math.random() * cols.length)];
      x.globalAlpha = 0.5 + Math.random() * 0.5;
      x.fillRect(8 + wx * 20, 8 + wy * 15, 12, 8);
    }
  }
  x.globalAlpha = 1;
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  return tx;
}

/** Tear down the current map (dispose per-map geometry, keep shared assets). */
function disposeWorld () {
  if (!world.group) return;
  world.group.traverse((o) => {
    if (o.isMesh || o.isPoints || o.isLine) {
      if (o.geometry && !o.userData.sharedGeo) o.geometry.dispose();
      if (o.material && o.userData.ownMat) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    }
  });
  scene.remove(world.group);
  world.group = null;
}

/** Build a complete venue from a map config. */
function buildWorld (cfg) {
  disposeWorld();
  const T = cfg.theme;
  const G = new THREE.Group();
  world.group = G;
  scene.add(G);
  world.mapKey = cfg.key;
  world.pads = []; world.ramps = []; world.boxes = []; world.coins = [];
  world.mudPts = []; world.flags = []; world.balloons = []; world.clouds = [];
  world.startLights = []; world.duck = null; world.miniPts = []; world.miniMud = [];

  /* ---- theme: lights, fog, music tempo ---- */
  scene.fog.color.setHex(T.fog[0]);
  scene.fog.near = T.fog[1]; scene.fog.far = T.fog[2];
  hemiLight.color.setHex(T.hemiSky);
  hemiLight.groundColor.setHex(T.hemiGround);
  hemiLight.intensity = T.hemiIntensity;
  sun.color.setHex(T.sunColor);
  sun.intensity = T.sunIntensity;
  sun.position.set(...T.sunPos);
  AUDIO.baseTempo = T.tempo || 132;

  /* ---- sample the spline uniformly by arc length ---- */
  const curve = new THREE.CatmullRomCurve3(
    cfg.ctrl.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'catmullrom', 0.5);
  world.samples = [];
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const pos = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(tan).normalize();
    world.samples.push({ pos, tan, side, w: BASE_HW, cs: 99, barrier: false, tunnel: false });
  }
  world.trackLen = curve.getLength();
  world.segLen = world.trackLen / N;

  for (const [ax, az, bx, bz, w] of cfg.widths) {
    forRange(nearestIdx(ax, az), nearestIdx(bx, bz), (i) => { world.samples[i].w = w; });
  }
  for (let pass = 0; pass < 3; pass++) {
    const w2 = world.samples.map((s, i) => (world.samples[(i + N - 1) % N].w + s.w * 2 + world.samples[(i + 1) % N].w) / 4);
    w2.forEach((w, i) => { world.samples[i].w = w; });
  }
  for (let i = 0; i < N; i++) {
    const a = world.samples[(i + N - 1) % N].tan, b = world.samples[(i + 1) % N].tan;
    const ang = Math.acos(clamp(a.dot(b), -1, 1));
    const k = ang / (world.segLen * 2);
    world.samples[i].cs = clamp(Math.sqrt(30 / Math.max(k, 1e-4)), 16, 60);
  }
  world.lineIdx = nearestIdx(cfg.finish[0], cfg.finish[1]);
  for (const [ax, az, bx, bz] of cfg.barriers) {
    forRange(nearestIdx(ax, az), nearestIdx(bx, bz), (i) => { world.samples[i].barrier = true; });
  }
  const tunnelA = nearestIdx(cfg.tunnel.a[0], cfg.tunnel.a[1]);
  const tunnelB = nearestIdx(cfg.tunnel.b[0], cfg.tunnel.b[1]);
  forRange(tunnelA, tunnelB, (i) => { world.samples[i].barrier = true; world.samples[i].tunnel = true; });

  /* ---- sky dome (+ stars at night) ---- */
  const sunDir = new THREE.Vector3(...T.sunPos).normalize();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(900, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(T.skyTop) },
        bottom: { value: new THREE.Color(T.skyBottom) },
        sunDir: { value: sunDir },
        sunCol: { value: new THREE.Color(T.sunColor) },
      },
      vertexShader: 'varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `
        varying vec3 vW; uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunCol;
        void main(){
          vec3 d = normalize(vW);
          float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(bottom, top, pow(h, 0.75));
          float s = max(dot(d, sunDir), 0.0);
          col += sunCol * (pow(s, 400.0) * 2.2 + pow(s, 10.0) * 0.16);
          gl_FragColor = vec4(col, 1.0);
        }`,
    }));
  dome.userData.ownMat = true;
  G.add(dome);
  if (T.night) {
    const starPos = [];
    for (let i = 0; i < 500; i++) {
      const a = rand(0, Math.PI * 2), y = rand(0.08, 0.95), r = Math.sqrt(1 - y * y) * 870;
      starPos.push(Math.cos(a) * r, y * 870, Math.sin(a) * r);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.85, fog: false }));
    stars.userData.ownMat = true;
    G.add(stars);
  }

  /* ---- ground disc ---- */
  const gg = new THREE.CircleGeometry(WORLD_R + 60, 48);
  gg.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(gg, new THREE.MeshLambertMaterial({ color: T.ground, map: noiseTexture(0.12) }));
  ground.material.map.colorSpace = THREE.SRGBColorSpace;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  ground.userData.ownMat = true;
  G.add(ground);

  /* ---- road ribbon + edge lines + curbs + rails ---- */
  (function buildRoad () {
    const posArr = [], colArr = [], idxArr = [];
    const cA = new THREE.Color(T.roadA), cB = new THREE.Color(T.roadB);
    for (let i = 0; i <= N; i++) {
      const s = world.samples[i % N];
      const inn = s.pos.clone().addScaledVector(s.side, s.w);
      const out = s.pos.clone().addScaledVector(s.side, -s.w);
      posArr.push(inn.x, 0.02, inn.z, out.x, 0.02, out.z);
      const c = (Math.floor(i / 4) % 2 === 0) ? cA : cB;
      colArr.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (i < N) {
        const a = i * 2;
        idxArr.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
    g.setIndex(idxArr);
    g.computeVertexNormals();
    const road = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    road.receiveShadow = true;
    road.userData.ownMat = true;
    G.add(road);

    for (const latSign of [1, -1]) {
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const s = world.samples[i % N];
        pts.push(s.pos.clone().addScaledVector(s.side, latSign * (s.w - 0.35)).setY(0.06));
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: T.edgeLine }));
      line.userData.ownMat = true;
      G.add(line);
    }

    const curbG = [], railG = [];
    const mkStrip = (arr, i, latOff, w, hgt, y, col) => {
      const s = world.samples[i];
      const b = new THREE.BoxGeometry(w, hgt, world.segLen * 2.1);
      const p = s.pos.clone().addScaledVector(s.side, latOff);
      const m = new THREE.Matrix4().makeRotationY(Math.atan2(s.tan.x, s.tan.z));
      m.setPosition(p.x, y, p.z);
      b.applyMatrix4(m);
      const c = new THREE.Color(col);
      const cArr = new Float32Array(b.attributes.position.count * 3);
      for (let v = 0; v < b.attributes.position.count; v++) { cArr[v * 3] = c.r; cArr[v * 3 + 1] = c.g; cArr[v * 3 + 2] = c.b; }
      b.setAttribute('color', new THREE.BufferAttribute(cArr, 3));
      arr.push(b);
    };
    for (let i = 0; i < N; i += 2) {
      const s = world.samples[i];
      if (s.cs <= 30) {
        for (const latSign of [1, -1]) mkStrip(curbG, i, latSign * (s.w + 0.4), 1.4, 0.14, 0.07, (i % 4 === 0) ? T.curbA : T.curbB);
      }
      if (s.barrier && !s.tunnel) {
        for (const latSign of [1, -1]) mkStrip(railG, i, latSign * (s.w + 1.3), 0.6, 1.0, 0.5, (i % 4 === 0) ? T.railA : T.railB);
      }
    }
    if (curbG.length) {
      const curbs = new THREE.Mesh(mergeGeometries(curbG), new THREE.MeshLambertMaterial({ vertexColors: true }));
      curbs.receiveShadow = true; curbs.userData.ownMat = true;
      G.add(curbs);
    }
    if (railG.length) {
      const railMat = T.railGlow
        ? new THREE.MeshBasicMaterial({ vertexColors: true })   // unlit = neon glow under bloom
        : new THREE.MeshLambertMaterial({ vertexColors: true });
      const rails = new THREE.Mesh(mergeGeometries(railG), railMat);
      rails.castShadow = true; rails.receiveShadow = true; rails.userData.ownMat = true;
      G.add(rails);
    }
  })();

  /* ---- mud / shortcut ribbon ---- */
  (function buildMud () {
    const mudCurve = new THREE.CatmullRomCurve3(cfg.mud.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)));
    const M = 40;
    for (let i = 0; i <= M; i++) world.mudPts.push(mudCurve.getPointAt(i / M));
    world.shortcutEntryIdx = nearestIdx(cfg.mud.entry[0], cfg.mud.entry[1]);
    world.shortcutExitIdx = nearestIdx(cfg.mud.exit[0], cfg.mud.exit[1]);
    const posArr = [], idxArr = [];
    for (let i = 0; i <= M; i++) {
      const p = world.mudPts[i];
      const tan = mudCurve.getTangentAt(i / M);
      const side = new THREE.Vector3(0, 1, 0).cross(tan).normalize();
      const a = p.clone().addScaledVector(side, world.mudW);
      const b = p.clone().addScaledVector(side, -world.mudW);
      posArr.push(a.x, 0.03, a.z, b.x, 0.03, b.z);
      if (i < M) { const k = i * 2; idxArr.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    g.setIndex(idxArr); g.computeVertexNormals();
    const mud = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: cfg.mud.color }));
    mud.receiveShadow = true; mud.userData.ownMat = true;
    G.add(mud);
  })();

  /* ---- start line, arch, lamps, balloons ---- */
  (function buildStart () {
    const L = placeOnTrack(cfg.finish[0], cfg.finish[1], 0);
    const s = world.samples[L.idx];
    world.finishPos.copy(L.pos);

    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(s.w * 2, 3.4),
      new THREE.MeshLambertMaterial({ map: checkerTexture() }));
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = -L.yaw;
    line.position.copy(L.pos).setY(0.05);
    line.receiveShadow = true; line.userData.ownMat = true;
    G.add(line);

    const archMat = new THREE.MeshLambertMaterial({ color: 0xff4f9a });
    for (const latSign of [1, -1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 11, 10), archMat);
      p.position.copy(L.pos).addScaledVector(s.side, latSign * (s.w + 2)).setY(5.5);
      p.castShadow = true;
      G.add(p);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(s.w * 2 + 6, 2.6, 1.2), new THREE.MeshLambertMaterial({ color: 0x20164a }));
    beam.position.copy(L.pos).setY(11.4);
    beam.rotation.y = L.yaw;
    beam.castShadow = true; beam.userData.ownMat = true;
    G.add(beam);
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(s.w * 2 + 4, 2.2),
      new THREE.MeshBasicMaterial({ map: textTexture('★ TURBO CRITTER GRAND PRIX ★', { w: 1024, h: 96, size: 60, bg: '#20164a', fg: '#ffd23f' }), side: THREE.DoubleSide }));
    banner.position.copy(L.pos).setY(11.4).addScaledVector(s.tan, -0.7);
    banner.rotation.y = L.yaw + Math.PI;
    banner.userData.ownMat = true;
    G.add(banner);

    for (let i = 0; i < 3; i++) {
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 12, 10),
        new THREE.MeshLambertMaterial({ color: 0x333340, emissive: 0x000000 }));
      lamp.position.copy(L.pos).addScaledVector(s.side, (i - 1) * 2.2).setY(9.6);
      lamp.userData.ownMat = true;
      G.add(lamp);
      world.startLights.push(lamp);
    }
    // party balloons on the arch
    const cols = [0xff4f9a, 0xffd23f, 0x29d9e5, 0x7ee04e];
    for (const latSign of [1, -1]) {
      const grp = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(1.05, 12, 12), new THREE.MeshLambertMaterial({ color: cols[(i + (latSign > 0 ? 0 : 2)) % 4] }));
        b.position.set(rand(-1.2, 1.2), i * 1.5, rand(-1.2, 1.2));
        b.scale.y = 1.15;
        b.userData.ownMat = true;
        grp.add(b);
      }
      grp.position.copy(L.pos).addScaledVector(s.side, latSign * (s.w + 2)).setY(12.5);
      G.add(grp);
      world.balloons.push({ grp, baseY: 12.5, phase: rand(0, 6) });
    }
  })();

  /* ---- boost pads ---- */
  for (const [x, z, lat, hx, hz] of cfg.pads) {
    const P = placeOnTrack(x, z, lat);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(hx * 2, hz * 2),
      new THREE.MeshBasicMaterial({ map: padTexture() }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = -P.yaw;
    mesh.position.copy(P.pos).setY(0.06);
    mesh.userData.ownMat = true;
    G.add(mesh);
    world.pads.push({ x: P.pos.x, z: P.pos.z, yaw: P.yaw, hx, hz, mesh, pulse: Math.random() * 6 });
  }

  /* ---- ramps ---- */
  for (const [x, z] of cfg.ramps) {
    const R = placeOnTrack(x, z, 0);
    const hx = 7.5, hz = 6.5, H = 2.3;
    const pos = [
      -hx, 0, -hz, hx, 0, -hz, hx, 0, hz, -hx, 0, hz,
      -hx, H, hz, hx, H, hz,
    ];
    const idx = [0, 1, 5, 0, 5, 4, 3, 4, 5, 3, 5, 2, 0, 4, 3, 1, 2, 5];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const wedge = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xff8c3a, roughness: 0.5, metalness: 0.2 }));
    wedge.rotation.y = R.yaw;
    wedge.position.copy(R.pos);
    wedge.castShadow = true; wedge.receiveShadow = true; wedge.userData.ownMat = true;
    G.add(wedge);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, 0.18, 0.5), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    lip.position.set(0, H + 0.05, hz - 0.3);
    lip.userData.ownMat = true;
    wedge.add(lip);
    world.ramps.push({ x: R.pos.x, z: R.pos.z, yaw: R.yaw, hx, hz, H });
  }

  /* ---- tunnel (tube through a hill or under a city block) ---- */
  (function buildTunnel () {
    const pts = [];
    forRange(tunnelA, tunnelB, (i) => pts.push(world.samples[i].pos.clone().setY(2.2)));
    const tCurve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(tCurve, 48, 10.5, 14, false),
      new THREE.MeshLambertMaterial({ color: cfg.tunnel.tubeColor, side: THREE.DoubleSide }));
    tube.castShadow = true;
    tube.userData.ownMat = true;
    G.add(tube);

    for (const end of [0, 1]) {
      const p = tCurve.getPointAt(end);
      const tan = tCurve.getTangentAt(end);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(10.5, 1.2, 10, 24),
        cfg.theme.night
          ? new THREE.MeshLambertMaterial({ color: cfg.tunnel.portalColor, emissive: cfg.tunnel.portalColor, emissiveIntensity: 0.8 })
          : new THREE.MeshLambertMaterial({ color: cfg.tunnel.portalColor }));
      ring.position.copy(p);
      ring.lookAt(p.clone().add(tan));
      ring.castShadow = true; ring.userData.ownMat = true;
      G.add(ring);
      // collar: a short outer sleeve so you can never peek between tube and hill
      const collar = new THREE.Mesh(
        new THREE.CylinderGeometry(11.6, 11.6, 7, 16, 1, true),
        new THREE.MeshLambertMaterial({ color: cfg.tunnel.portalColor, side: THREE.DoubleSide }));
      collar.position.copy(p).addScaledVector(tan, end === 0 ? 3 : -3);
      collar.rotation.x = Math.PI / 2;
      collar.rotation.z = Math.atan2(tan.x, tan.z);
      collar.rotation.order = 'ZYX';
      collar.userData.ownMat = true;
      // orient cylinder axis along the tangent
      collar.rotation.set(0, 0, 0);
      collar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan.clone().normalize());
      G.add(collar);
    }

    for (let i = 1; i < 10; i++) {
      const p = tCurve.getPointAt(i / 10);
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 8, 8),
        new THREE.MeshBasicMaterial({ color: cfg.theme.night ? 0x9df2ff : 0xffe9a3 }));
      bulb.position.copy(p).setY(8.6);
      bulb.userData.ownMat = true;
      G.add(bulb);
      if (i % 3 === 1) {
        const glow = new THREE.PointLight(cfg.theme.night ? 0x66e0ff : 0xffdf91, 6, 26, 2);
        glow.position.copy(bulb.position);
        G.add(glow);
      }
    }

    // the cover the tunnel burrows through — DoubleSide so the camera can
    // never see "through" it from inside (the old green-hill glitch)
    const mid = tCurve.getPointAt(0.5);
    if (cfg.tunnel.hill === 'cone') {
      // slope at the tube's radius stays ABOVE the tube top, so the hill can
      // never poke into the tunnel interior (the old see-through-hill glitch)
      const hill = new THREE.Mesh(
        new THREE.ConeGeometry(34, 36, 20, 1),
        new THREE.MeshLambertMaterial({ color: cfg.tunnel.hillColor, flatShading: true }));
      hill.position.set(mid.x, -1, mid.z);
      hill.scale.y = 0.75;
      hill.castShadow = true; hill.receiveShadow = true; hill.userData.ownMat = true;
      G.add(hill);
    } else {
      // city: a lit tower block BRIDGING over the tube (bottom clears the tube)
      const wtex = windowsTexture();
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(80, 26, 55),
        new THREE.MeshLambertMaterial({ color: 0x2a2f47, map: wtex, emissive: 0xffffff, emissiveMap: wtex, emissiveIntensity: 0.85 }));
      slab.position.set(mid.x, 26, mid.z);
      slab.castShadow = true; slab.receiveShadow = true; slab.userData.ownMat = true;
      G.add(slab);
      for (const zs of [-20, 20]) {   // support piers either side of the road
        const pier = new THREE.Mesh(
          new THREE.BoxGeometry(26, 13, 8),
          new THREE.MeshLambertMaterial({ color: 0x1c2136 }));
        pier.position.set(0, -19.5, zs);
        pier.userData.ownMat = true;
        slab.add(pier);
      }
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(80, 0.6, 0.6),
        new THREE.MeshBasicMaterial({ color: 0x67e8f9 }));
      strip.position.set(0, -13.2, 27.7);
      strip.userData.ownMat = true;
      slab.add(strip);
    }
    world.tunnelMid = mid;
  })();

  /* ---- item boxes ---- */
  for (const [x, z] of cfg.boxRows) {
    const idx = nearestIdx(x, z);
    const s = world.samples[idx];
    for (const f of [-0.66, -0.22, 0.22, 0.66]) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), new THREE.MeshNormalMaterial());
      const p = s.pos.clone().addScaledVector(s.side, f * s.w).setY(1.25);
      mesh.position.copy(p);
      mesh.castShadow = true;
      mesh.userData.sharedGeo = false;
      G.add(mesh);
      world.boxes.push({ mesh, pos: p.clone(), active: true, t: 0, spin: Math.random() * 6 });
    }
  }

  /* ---- coins ---- */
  function addCoin (pos, yaw) {
    const mesh = new THREE.Mesh(coinGeo, coinMat);
    mesh.position.copy(pos).setY(1);
    mesh.rotation.y = yaw;
    mesh.castShadow = true;
    mesh.userData.sharedGeo = true;   // never dispose the shared coin assets
    G.add(mesh);
    world.coins.push({ mesh, pos: mesh.position.clone(), active: true, t: 0 });
  }
  for (const [ax, az, bx, bz, count, amp] of cfg.coinRuns) {
    const ia = nearestIdx(ax, az), ib = nearestIdx(bx, bz);
    const span = (ib - ia + N) % N;
    for (let c = 0; c < count; c++) {
      const i = (ia + Math.round(span * (c / (count - 1)))) % N;
      const s = world.samples[i];
      const lat = amp ? Math.sin(c * 1.1) * amp : 0;
      addCoin(s.pos.clone().addScaledVector(s.side, lat), Math.atan2(s.tan.x, s.tan.z));
    }
  }
  for (const f of [0.25, 0.5, 0.75]) {
    addCoin(world.mudPts[Math.round(f * (world.mudPts.length - 1))], 0);
  }

  /* ---- decor by theme ---- */
  buildDecor(cfg, G);

  /* ---- the golden duck (per-map hiding spot) ---- */
  (function buildDuck () {
    const [dx, dz] = cfg.duck;
    const gold = new THREE.MeshStandardMaterial({ color: 0xffc93a, metalness: 0.85, roughness: 0.28, emissive: 0x4a3200 });
    const grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.85, 14, 12), gold);
    body.scale.set(1, 0.85, 1.2);
    body.position.y = 0.85;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 10), gold);
    head.position.set(0, 1.75, 0.75);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 8), gold);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 1.7, 1.3);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.7, 8), gold);
    tail.rotation.x = -Math.PI / 2.4;
    tail.position.set(0, 1.1, -1.05);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.4, 0.5, 12),
      new THREE.MeshLambertMaterial({ color: 0x8d8d99 }));
    base.position.y = 0.25;
    grp.add(body, head, beak, tail, base);
    grp.position.set(dx, 0, dz);
    grp.rotation.y = rand(0, 6);
    grp.traverse((o) => { o.castShadow = true; });
    G.add(grp);
    world.duck = { grp, x: dx, z: dz, r: 3.2, cooldown: 0, quackT: rand(4, 9) };
  })();

  /* ---- debug group ---- */
  (function buildDebugGroup () {
    const grp = new THREE.Group();
    grp.visible = world.debugVisible;
    const wpPos = [], wpCol = [];
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const s = world.samples[i];
      wpPos.push(s.pos.x, 0.6, s.pos.z);
      c.setHSL(i / N, 1, 0.5);
      wpCol.push(c.r, c.g, c.b);
    }
    const wpGeo = new THREE.BufferGeometry();
    wpGeo.setAttribute('position', new THREE.Float32BufferAttribute(wpPos, 3));
    wpGeo.setAttribute('color', new THREE.Float32BufferAttribute(wpCol, 3));
    grp.add(new THREE.Points(wpGeo, new THREE.PointsMaterial({ size: 4, vertexColors: true, sizeAttenuation: false })));
    for (const latSign of [1, -1]) {
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const s = world.samples[i % N];
        pts.push(s.pos.clone().addScaledVector(s.side, latSign * s.w).setY(0.5));
      }
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x00ff88 })));
    }
    grp.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(world.mudPts.map((p) => p.clone().setY(0.5))),
      new THREE.LineBasicMaterial({ color: 0xcc8844 })));
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(8 * 2 * 3), 3));
    world.botTargetLines = new THREE.LineSegments(tGeo, new THREE.LineBasicMaterial({ color: 0xff40ff }));
    grp.add(world.botTargetLines);
    world.debugGroup = grp;
    G.add(grp);
  })();

  /* ---- minimap path cache (normalized to 0..1) ---- */
  (function cacheMinimap () {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const s of world.samples) {
      minX = Math.min(minX, s.pos.x); maxX = Math.max(maxX, s.pos.x);
      minZ = Math.min(minZ, s.pos.z); maxZ = Math.max(maxZ, s.pos.z);
    }
    const span = Math.max(maxX - minX, maxZ - minZ);
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    world.miniMap = (x, z) => [
      0.5 + (x - cx) / span * 0.86,
      0.5 + (z - cz) / span * 0.86,
    ];
    world.miniPts = world.samples.map((s) => world.miniMap(s.pos.x, s.pos.z));
    world.miniMud = world.mudPts.map((p) => world.miniMap(p.x, p.z));
  })();
}

/** Theme-specific scenery: forest / desert / neon city. */
function buildDecor (cfg, G) {
  const T = cfg.theme;
  const [duckX, duckZ] = cfg.duck;
  const rockG = [];
  function rock (x, z, s) {
    const g = new THREE.IcosahedronGeometry(s, 0);
    g.scale(1, 0.62, 1);
    g.rotateY(rand(0, 6));
    g.translate(x, s * 0.4, z);
    rockG.push(g);
  }

  if (T.decor === 'forest') {
    const trunkG = [], leafG = [];
    const leafColors = [0x2e8b3a, 0x3fa34d, 0x62c46a, 0x2f9e6e];
    function tree (x, z, s) {
      const trunk = new THREE.CylinderGeometry(0.35 * s, 0.5 * s, 2.2 * s, 6);
      trunk.translate(x, 1.1 * s, z);
      trunkG.push(trunk);
      const layers = randInt(2, 3);
      for (let l = 0; l < layers; l++) {
        const r = (2.6 - l * 0.7) * s, hgt = 2.6 * s;
        const cone = new THREE.ConeGeometry(r, hgt, 7);
        cone.translate(x, (1.8 + l * 1.7) * s + hgt * 0.3, z);
        const col = new THREE.Color(pick(leafColors));
        const cArr = new Float32Array(cone.attributes.position.count * 3);
        for (let v = 0; v < cone.attributes.position.count; v++) { cArr[v * 3] = col.r; cArr[v * 3 + 1] = col.g; cArr[v * 3 + 2] = col.b; }
        cone.setAttribute('color', new THREE.BufferAttribute(cArr, 3));
        leafG.push(cone);
      }
    }
    let placed = 0, tries = 0;
    while (placed < 70 && tries < 900) {
      tries++;
      const a = rand(0, Math.PI * 2), r = rand(30, 380);
      const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.75 - 20;
      if (!clearOfTrack(x, z, 9)) continue;
      if (Math.hypot(x - cfg.tunnel.hillPos[0], z - cfg.tunnel.hillPos[1]) < 62) continue;
      tree(x, z, rand(0.8, 1.7));
      placed++;
    }
    tree(duckX + 6, duckZ + 7, 1.5); tree(duckX - 7, duckZ + 5, 1.3);
    const trunks = new THREE.Mesh(mergeGeometries(trunkG), new THREE.MeshLambertMaterial({ color: 0x7a5230 }));
    const leaves = new THREE.Mesh(mergeGeometries(leafG), new THREE.MeshLambertMaterial({ vertexColors: true }));
    trunks.castShadow = trunks.receiveShadow = true; trunks.userData.ownMat = true;
    leaves.castShadow = leaves.receiveShadow = true; leaves.userData.ownMat = true;
    G.add(trunks, leaves);
  }

  if (T.decor === 'desert') {
    const cactusG = [];
    function cactus (x, z, s) {
      const trunk = new THREE.CylinderGeometry(0.55 * s, 0.65 * s, 6.5 * s, 8);
      trunk.translate(x, 3.2 * s, z);
      cactusG.push(trunk);
      for (const armSide of [-1, 1]) {
        if (Math.random() < 0.75) {
          const arm = new THREE.CylinderGeometry(0.32 * s, 0.36 * s, 2.6 * s, 7);
          arm.translate(x + armSide * 1.05 * s, (2.4 + Math.random() * 1.6) * s, z);
          cactusG.push(arm);
          const joint = new THREE.CylinderGeometry(0.32 * s, 0.32 * s, 1.1 * s, 7);
          joint.rotateZ(Math.PI / 2);
          joint.translate(x + armSide * 0.6 * s, (1.7 + Math.random()) * s, z);
          cactusG.push(joint);
        }
      }
    }
    let placed = 0, tries = 0;
    while (placed < 30 && tries < 500) {
      tries++;
      const a = rand(0, Math.PI * 2), r = rand(30, 380);
      const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.75 - 20;
      if (!clearOfTrack(x, z, 10)) continue;
      cactus(x, z, rand(0.8, 1.6));
      placed++;
    }
    cactus(duckX + 6, duckZ + 6, 1.4); cactus(duckX - 6, duckZ + 4, 1.1);
    const cacti = new THREE.Mesh(mergeGeometries(cactusG), new THREE.MeshLambertMaterial({ color: 0x3f9e57 }));
    cacti.castShadow = cacti.receiveShadow = true; cacti.userData.ownMat = true;
    G.add(cacti);
    // buried dunes on the horizon
    for (let i = 0; i < 10; i++) {
      const a = rand(0, Math.PI * 2), r = rand(250, 390);
      const dune = new THREE.Mesh(
        new THREE.SphereGeometry(rand(28, 60), 12, 10),
        new THREE.MeshLambertMaterial({ color: 0xe0b46c }));
      dune.position.set(Math.cos(a) * r, rand(-14, -6), Math.sin(a) * r * 0.8 - 20);
      dune.scale.y = 0.45;
      dune.receiveShadow = true; dune.userData.ownMat = true;
      G.add(dune);
    }
  }

  if (T.decor === 'city') {
    // glowing towers ringing the circuit
    const winTexes = [windowsTexture(), windowsTexture(), windowsTexture(), windowsTexture()];
    let placed = 0, tries = 0;
    while (placed < 46 && tries < 700) {
      tries++;
      const a = rand(0, Math.PI * 2), r = rand(60, 400);
      const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.8 - 20;
      if (!clearOfTrack(x, z, 22)) continue;
      if (Math.hypot(x - duckX, z - duckZ) < 16) continue;
      if (Math.hypot(x - cfg.tunnel.hillPos[0], z - cfg.tunnel.hillPos[1]) < 60) continue;
      const w = rand(12, 24), h = rand(16, 66), d = rand(12, 24);
      const tex = pick(winTexes);
      const tower = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshLambertMaterial({ color: 0x14172a, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.9, map: tex }));
      tower.position.set(x, h / 2, z);
      tower.userData.ownMat = true;
      G.add(tower);
      placed++;
    }
    // street lamps hugging the road
    for (let i = 0; i < N; i += 26) {
      const s = world.samples[i];
      if (s.tunnel) continue;
      const latSign = (i / 26) % 2 === 0 ? 1 : -1;
      const base = s.pos.clone().addScaledVector(s.side, latSign * (s.w + 2.6));
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 6, 6), new THREE.MeshLambertMaterial({ color: 0x3a3f55 }));
      pole.position.copy(base).setY(3);
      G.add(pole);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe9a3 }));
      ball.position.copy(base).setY(6.1);
      ball.userData.ownMat = true;
      G.add(ball);
    }
    // dumpster-crates hiding the duck
    for (const [ox, oz] of [[5, 6], [-6, 4], [1, 8]]) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 2.6), new THREE.MeshLambertMaterial({ color: 0x2d5a3f }));
      crate.position.set(duckX + ox, 1.5, duckZ + oz);
      crate.rotation.y = rand(0, 1.2);
      crate.castShadow = true; crate.userData.ownMat = true;
      G.add(crate);
    }
  }

  // rocks everywhere (concrete blocks in the city)
  let placedR = 0, triesR = 0;
  while (placedR < 20 && triesR < 400) {
    triesR++;
    const a = rand(0, Math.PI * 2), r = rand(40, 360);
    const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.75 - 20;
    if (!clearOfTrack(x, z, 8)) continue;
    rock(x, z, rand(1, 3));
    placedR++;
  }
  rock(duckX + 4, duckZ + 4, 2.6); rock(duckX - 4, duckZ + 3, 2.1); rock(duckX, duckZ + 6, 1.6);
  const rocks = new THREE.Mesh(mergeGeometries(rockG),
    new THREE.MeshLambertMaterial({ color: T.decor === 'city' ? 0x555a6e : 0x9a9aa8, flatShading: true }));
  rocks.castShadow = rocks.receiveShadow = true; rocks.userData.ownMat = true;
  G.add(rocks);

  /* flags along the lap */
  for (let f = 0; f < 12; f++) {
    const i = Math.floor((f / 12) * N);
    const s = world.samples[i];
    if (s.tunnel) continue;
    const latSign = f % 2 === 0 ? 1 : -1;
    const base = s.pos.clone().addScaledVector(s.side, latSign * (s.w + 3.2));
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6.4, 6), new THREE.MeshLambertMaterial({ color: 0xdddde8 }));
    pole.position.copy(base).setY(3.2);
    pole.castShadow = true;
    G.add(pole);
    const geo = new THREE.PlaneGeometry(2.6, 1.3, 6, 2);
    geo.translate(1.3, 0, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: pick(T.flagCols), side: THREE.DoubleSide }));
    mesh.position.copy(base).setY(5.6);
    mesh.rotation.y = rand(0, 6);
    mesh.userData.ownMat = true;
    G.add(mesh);
    world.flags.push({ mesh, base: geo.attributes.position.array.slice(), phase: rand(0, 6) });
  }

  /* clouds (day maps) */
  if (T.clouds) {
    for (let i = 0; i < 5; i++) {
      const grp = new THREE.Group();
      for (let b = 0; b < 3; b++) {
        const puff = new THREE.Mesh(
          new THREE.SphereGeometry(rand(7, 12), 10, 10),
          new THREE.MeshLambertMaterial({ color: 0xffffff }));
        puff.position.set(b * rand(7, 10) - 9, rand(-2, 2), rand(-3, 3));
        puff.scale.y = 0.55;
        puff.userData.ownMat = true;
        grp.add(puff);
      }
      grp.position.set(rand(-350, 350), rand(70, 120), rand(-350, 250));
      G.add(grp);
      world.clouds.push({ grp, speed: rand(1.2, 3) });
    }
  }

  /* auto chevron signs at the three sharpest corners */
  (function autoSigns () {
    const order = [...Array(N).keys()].sort((a, b) => world.samples[a].cs - world.samples[b].cs);
    const picked = [];
    for (const i of order) {
      if (picked.every((p) => Math.min((i - p + N) % N, (p - i + N) % N) > 30)) {
        picked.push(i);
        if (picked.length === 3) break;
      }
    }
    for (const i of picked) {
      const a = world.samples[(i + N - 2) % N].tan, b = world.samples[(i + 2) % N].tan;
      const turn = Math.sign(a.x * b.z - a.z * b.x) || 1;
      const j = (i - 14 + N) % N;
      const sj = world.samples[j];
      const p = sj.pos.clone().addScaledVector(sj.side, turn * (sj.w + 4));
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 3, 6), new THREE.MeshLambertMaterial({ color: 0x888899 }));
      post.position.copy(p).setY(1.5);
      G.add(post);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.1), new THREE.MeshLambertMaterial({ map: chevronTexture(turn), side: THREE.DoubleSide }));
      board.position.copy(p).setY(3.4);
      board.rotation.y = Math.atan2(sj.tan.x, sj.tan.z) + Math.PI;
      board.castShadow = true; board.userData.ownMat = true;
      G.add(board);
    }
  })();

  /* billboards + shortcut teaser */
  const billCols = T.night ? ['#67e8f9', '#f472b6', '#fde68a'] : ['#7ee04e', '#29d9e5', '#ffd23f'];
  cfg.bills.forEach((msg, bi) => {
    const a = (bi / cfg.bills.length) * Math.PI * 2 + 0.7;
    const x = Math.cos(a) * 250, z = Math.sin(a) * 200 - 20;
    const grp = new THREE.Group();
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 6.5),
      new THREE.MeshLambertMaterial({
        map: textTexture(msg, { w: 1024, h: 256, size: 58, bg: '#20164a', fg: billCols[bi % 3], border: billCols[bi % 3] }),
        side: THREE.DoubleSide,
        emissive: T.night ? 0xffffff : 0x000000,
        emissiveMap: T.night ? textTexture(msg, { w: 1024, h: 256, size: 58, bg: '#0a0c18', fg: billCols[bi % 3], border: billCols[bi % 3] }) : null,
        emissiveIntensity: T.night ? 0.8 : 0,
      }));
    board.position.y = 7;
    board.userData.ownMat = true;
    grp.add(board);
    for (const px of [-10, 10]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 7, 6), new THREE.MeshLambertMaterial({ color: 0x6b5a44 }));
      leg.position.set(px, 3.5, -0.3);
      grp.add(leg);
    }
    grp.position.set(x, 0, z);
    grp.lookAt(new THREE.Vector3(0, 7, -20));
    G.add(grp);
  });
  const sc = placeOnTrack(cfg.mud.entry[0], cfg.mud.entry[1], -(world.samples[world.shortcutEntryIdx].w + 3));
  const scSign = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 2),
    new THREE.MeshLambertMaterial({ map: textTexture('SHORTCUT?', { w: 512, h: 160, size: 84, bg: '#5c3d1e', fg: '#ffd23f', border: '#ffd23f' }), side: THREE.DoubleSide }));
  scSign.position.copy(sc.pos).setY(2.6);
  scSign.rotation.y = sc.yaw + Math.PI;
  scSign.userData.ownMat = true;
  G.add(scSign);
}

/* shared coin assets (never disposed on map change) */
const coinGeo = new THREE.CylinderGeometry(0.65, 0.65, 0.14, 14);
coinGeo.rotateX(Math.PI / 2);
const coinMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, metalness: 0.75, roughness: 0.25, emissive: 0x6b4d00 });

// build the saved (or default) venue before the racers are created
buildWorld(MAP_BY_KEY[SAVE.get('map', 'meadows')] || MAPS[0]);

/* =====================================================================
   5. PARTICLES — one shared GPU point pool for dust, sparks, flames,
      confetti, fireworks, glints… everything.
   ===================================================================== */

class Particles {
  constructor (max = 2600) {
    this.max = max; this.cursor = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: window.innerHeight * 0.7 } },
      vertexShader: `
        attribute float aSize; attribute vec3 aColor; varying vec3 vColor; uniform float uScale;
        void main () {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main () {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.1, d);
          gl_FragColor = vec4(vColor, a);
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn (x, y, z, o = {}) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = o.vx || 0; this.vel[i * 3 + 1] = o.vy || 0; this.vel[i * 3 + 2] = o.vz || 0;
    const c = o.color || 0xffffff;
    const col = c.isColor ? c : new THREE.Color(c);
    this.col[i * 3] = col.r; this.col[i * 3 + 1] = col.g; this.col[i * 3 + 2] = col.b;
    this.baseSize[i] = o.size || 0.5;
    this.life[i] = this.maxLife[i] = o.life || 0.6;
    this.grav[i] = o.grav !== undefined ? o.grav : 0;
    this.drag[i] = o.drag !== undefined ? o.drag : 1.5;
  }

  update (dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.size[i] = 0; continue; }
      this.life[i] -= dt;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= dr; this.vel[i * 3 + 2] *= dr;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dr - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.05) { this.pos[i * 3 + 1] = 0.05; this.vel[i * 3 + 1] *= -0.3; }
      this.size[i] = this.baseSize[i] * Math.max(0, this.life[i] / this.maxLife[i]);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }
  clearAll () { this.life.fill(0); }
}
const PARTICLES = new Particles();

/* ---------- effect recipes ---------- */
const fxDust = (p, n = 3, col = 0xb9a888) => {
  for (let i = 0; i < n; i++) PARTICLES.spawn(p.x + rand(-0.6, 0.6), p.y + 0.2, p.z + rand(-0.6, 0.6),
    { vx: rand(-2, 2), vy: rand(1, 3), vz: rand(-2, 2), color: col, size: rand(0.6, 1.3), life: rand(0.4, 0.9), drag: 2.5 });
};
const fxSpark = (p, n = 8, col = 0xffc23a) => {
  for (let i = 0; i < n; i++) PARTICLES.spawn(p.x, p.y + 0.3, p.z,
    { vx: rand(-7, 7), vy: rand(2, 7), vz: rand(-7, 7), color: Math.random() < 0.4 ? 0xfff3c9 : col, size: rand(0.25, 0.5), life: rand(0.2, 0.55), grav: 14, drag: 1 });
};
const fxDriftSpark = (p, tier) => {
  const col = tier >= 2 ? 0x35f0ff : 0xffb62e;
  PARTICLES.spawn(p.x, p.y + 0.15, p.z,
    { vx: rand(-3, 3), vy: rand(1.5, 4), vz: rand(-3, 3), color: col, size: rand(0.3, 0.6), life: 0.3, grav: 9, drag: 1 });
};
const fxBoostFlame = (p, back) => {
  for (let i = 0; i < 2; i++) PARTICLES.spawn(p.x + rand(-0.3, 0.3), p.y + rand(0, 0.3), p.z + rand(-0.3, 0.3),
    { vx: back.x * rand(6, 12) + rand(-1, 1), vy: rand(0.5, 2), vz: back.z * rand(6, 12) + rand(-1, 1),
      color: pick([0x35f0ff, 0xff8c3a, 0xffd23f]), size: rand(0.5, 1), life: rand(0.2, 0.4), drag: 2 });
};
const fxConfetti = (p, n = 30) => {
  const cols = [0xff4f9a, 0xffd23f, 0x29d9e5, 0x7ee04e, 0x8f6ef0, 0xffffff];
  for (let i = 0; i < n; i++) PARTICLES.spawn(p.x, p.y + 0.5, p.z,
    { vx: rand(-9, 9), vy: rand(4, 12), vz: rand(-9, 9), color: pick(cols), size: rand(0.3, 0.6), life: rand(0.7, 1.6), grav: 9, drag: 1.6 });
};
const fxFirework = (p) => {
  const col = pick([0xff4f9a, 0xffd23f, 0x29d9e5, 0x7ee04e, 0xff8c3a, 0xffffff]);
  for (let i = 0; i < 70; i++) {
    const th = rand(0, Math.PI * 2), ph = Math.acos(rand(-1, 1)), v = rand(9, 20);
    PARTICLES.spawn(p.x, p.y, p.z, {
      vx: Math.sin(ph) * Math.cos(th) * v, vy: Math.cos(ph) * v, vz: Math.sin(ph) * Math.sin(th) * v,
      color: Math.random() < 0.2 ? 0xffffff : col, size: rand(0.4, 0.8), life: rand(0.8, 1.7), grav: 6, drag: 1.1,
    });
  }
  AUDIO.fireworkBoom();
};
const fxCoinGlint = (p) => {
  for (let i = 0; i < 8; i++) PARTICLES.spawn(p.x, p.y, p.z,
    { vx: rand(-3, 3), vy: rand(2, 6), vz: rand(-3, 3), color: 0xffd23f, size: rand(0.3, 0.55), life: 0.5, grav: 8, drag: 1 });
};
const fxShieldPop = (p) => {
  for (let i = 0; i < 22; i++) {
    const th = rand(0, Math.PI * 2);
    PARTICLES.spawn(p.x, p.y + 1, p.z,
      { vx: Math.cos(th) * rand(4, 9), vy: rand(1, 5), vz: Math.sin(th) * rand(4, 9), color: 0x9ff3ff, size: rand(0.3, 0.6), life: 0.5, grav: 4, drag: 1.4 });
  }
};
const fxStarRing = (p) => {
  for (let i = 0; i < 26; i++) {
    const th = (i / 26) * Math.PI * 2;
    PARTICLES.spawn(p.x + Math.cos(th) * 2, p.y + 0.8, p.z + Math.sin(th) * 2,
      { vx: Math.cos(th) * 8, vy: 2.5, vz: Math.sin(th) * 8, color: 0xffe66d, size: 0.55, life: 0.7, grav: 2, drag: 1.2 });
  }
};
const fxMudSplat = (p) => {
  for (let i = 0; i < 5; i++) PARTICLES.spawn(p.x, p.y + 0.2, p.z,
    { vx: rand(-4, 4), vy: rand(2, 5), vz: rand(-4, 4), color: 0x7a5230, size: rand(0.4, 0.9), life: 0.6, grav: 12, drag: 1.2 });
};

/* =====================================================================
   6. KART FACTORY + BOT ROSTER
   ===================================================================== */

/** Build one kart out of primitives. Returns handles used by the Racer. */
function buildKart (bodyColor, helmetColor) {
  const root = new THREE.Group();
  const body = new THREE.Group();      // gets roll/pitch/drift lean
  root.add(body);

  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.5, roughness: 0.32 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2d38, metalness: 0.2, roughness: 0.85 });
  const helmMat = new THREE.MeshStandardMaterial({ color: helmetColor, metalness: 0.35, roughness: 0.28 });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.55, 3.6), bodyMat);
  chassis.position.y = 0.62;
  body.add(chassis);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.4, 0.8), bodyMat);
  nose.position.set(0, 0.62, 2.05);
  body.add(nose);
  for (const sx of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 1.7), darkMat);
    pod.position.set(sx * 1.25, 0.6, -0.1);
    body.add(pod);
  }

  // driver: torso + helmet + visor
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.4, 4, 10), new THREE.MeshLambertMaterial({ color: 0x30354a }));
  torso.position.set(0, 1.15, -0.5);
  body.add(torso);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.48, 14, 12), helmMat);
  helmet.position.set(0, 1.75, -0.5);
  body.add(helmet);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.36, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), new THREE.MeshLambertMaterial({ color: 0x141824 }));
  visor.rotation.x = Math.PI / 2.4;
  visor.position.set(0, 1.78, -0.14);
  body.add(visor);

  // duck beak (hidden unless Duck Mode) — clips onto the helmet
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.62, 10), new THREE.MeshLambertMaterial({ color: 0xff9a00 }));
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 1.7, 0.05);
  beak.visible = false;
  body.add(beak);

  // spoiler
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 0.14), darkMat);
    post.position.set(sx * 0.7, 1.1, -1.6);
    body.add(post);
  }
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.7), bodyMat);
  wing.position.set(0, 1.4, -1.62);
  body.add(wing);

  // exhaust pipes (flame anchors live at their tips)
  const flameAnchors = [];
  for (const sx of [-0.45, 0.45]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.5, 8), darkMat);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(sx, 0.7, -1.95);
    body.add(pipe);
    flameAnchors.push(new THREE.Vector3(sx, 0.7, -2.2));
  }

  // wheels — front pair sits in steer pivots
  const wheelGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.42, 12);
  wheelGeo.rotateZ(Math.PI / 2); // axis across the kart
  const hubGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.44, 8);
  hubGeo.rotateZ(Math.PI / 2);
  const wheels = [], frontPivots = [];
  for (const [sx, sz, front] of [[-1, 1.2, true], [1, 1.2, true], [-1, -1.25, false], [1, -1.25, false]]) {
    const wheel = new THREE.Mesh(wheelGeo, darkMat);
    wheel.add(new THREE.Mesh(hubGeo, new THREE.MeshLambertMaterial({ color: 0xcfd2dd })));
    const pivot = new THREE.Group();
    pivot.position.set(sx * 1.12, 0.44, sz);
    pivot.add(wheel);
    body.add(pivot);
    wheels.push(wheel);
    if (front) frontPivots.push(pivot);
  }

  // bubble shield (hidden unless held)
  const shield = new THREE.Mesh(new THREE.SphereGeometry(2.5, 18, 14),
    new THREE.MeshBasicMaterial({ color: 0x74e6ff, transparent: true, opacity: 0.22, depthWrite: false }));
  shield.position.y = 1.1;
  shield.visible = false;
  root.add(shield);

  root.traverse((o) => { if (o.isMesh && o !== shield) { o.castShadow = true; } });
  return { root, body, wheels, frontPivots, beak, shield, bodyMat, flameAnchors };
}

/** The seven rival critters — different skill, nerve and quirks. */
const ROSTER = [
  { name: 'Zoomie',         color: 0xffb62e, skill: 0.94, aggro: 0.85, lane: -2.5 }, // hyper hamster
  { name: 'Sir Waddles',    color: 0xf5f1e6, skill: 0.91, aggro: 0.40, lane:  2.0 }, // dignified duck
  { name: 'Nitro Newt',     color: 0x51e07c, skill: 0.86, aggro: 0.90, lane: -1.0 }, // boost addict
  { name: 'Big Tony',       color: 0x8f6ef0, skill: 0.89, aggro: 0.75, lane:  0.5, heavy: true },
  { name: 'Mabel Moss',     color: 0x7fd7c8, skill: 0.80, aggro: 0.20, lane:  2.8 }, // cautious sloth
  { name: 'Pixel Possum',   color: 0xff6fb0, skill: 0.88, aggro: 0.60, lane: -2.0, sneaky: true }, // shortcut lover
  { name: 'Captain Crumbs', color: 0xcfd6e4, skill: 0.83, aggro: 0.95, lane:  1.2, chaotic: true }, // unhinged seagull
];
const PLAYER_COLORS = [0xe23b3b, 0x2f7de1, 0xffd23f, 0x51e07c, 0xff6fb0, 0x8f6ef0, 0x29d9e5, 0x3a3f4d];
const SPARE_COLOR = 0xb45309;

/* =====================================================================
   7. RACER — shared physics for the player and every bot
   ===================================================================== */

const MAX_SPEED = 36;          // player top speed on asphalt (units/s)
const ITEMS = {
  carrot: { icon: '🥕', name: 'Turbo Carrot' },
  slime:  { icon: '🟢', name: 'Slime Spill' },
  shield: { icon: '🫧', name: 'Bubble Shield' },
  rocket: { icon: '🎉', name: 'Confetti Rocket' },
  star:   { icon: '⭐', name: 'Wobble Star' },
};
/** Item odds by current position — leaders get defence, stragglers get speed. */
function rollItem (rank) {
  const table = rank <= 2
    ? [['slime', 30], ['shield', 25], ['rocket', 25], ['star', 10], ['carrot', 10]]
    : rank <= 5
      ? [['carrot', 30], ['rocket', 25], ['shield', 20], ['slime', 15], ['star', 10]]
      : [['carrot', 45], ['star', 20], ['rocket', 15], ['shield', 15], ['slime', 5]];
  let r = Math.random() * 100;
  for (const [k, w] of table) { r -= w; if (r <= 0) return k; }
  return 'carrot';
}

let racerSeq = 0;

class Racer {
  constructor (def, isPlayer) {
    this.id = racerSeq++;
    this.def = def;
    this.isPlayer = isPlayer;
    this.name = isPlayer ? 'YOU' : def.name;
    this.color = def.color;
    this.heavy = !!def.heavy;
    const helmet = isPlayer ? 0xf7f7fb : new THREE.Color(def.color).offsetHSL(0.45, 0, 0.08).getHex();
    this.kart = buildKart(def.color, helmet);
    scene.add(this.kart.root);
    if (!isPlayer) {
      // floating name tag (billboarded sprite)
      const c = document.createElement('canvas');
      c.width = 256; c.height = 64;
      const x = c.getContext('2d');
      x.fillStyle = 'rgba(14,10,34,0.72)';
      if (x.roundRect) { x.beginPath(); x.roundRect(6, 8, 244, 48, 24); x.fill(); }
      else x.fillRect(6, 8, 244, 48);
      x.strokeStyle = '#' + def.color.toString(16).padStart(6, '0');
      x.lineWidth = 5;
      if (x.roundRect) { x.beginPath(); x.roundRect(6, 8, 244, 48, 24); x.stroke(); }
      x.fillStyle = '#fffdf5';
      x.font = '900 30px "Arial Rounded MT Bold", "Trebuchet MS", sans-serif';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(def.name, 128, 33);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.92 }));
      tag.scale.set(4.0, 1.0, 1);
      tag.position.y = 3.15;
      this.kart.root.add(tag);
      this.tag = tag;
    }
    this.pos = new THREE.Vector3();
    this.kv = new THREE.Vector3();      // knock-back velocity from collisions
    this.reset(0);
  }

  setColor (hex) {
    this.color = hex;
    this.kart.bodyMat.color.setHex(hex);
  }

  /** Put the racer on its grid slot and zero all race state. */
  reset (slot) {
    const lineI = world.lineIdx;
    const back = 14 + Math.floor(slot / 2) * 6.5;
    const i = (lineI - Math.round(back / world.segLen) + N) % N;
    const s = world.samples[i];
    const lat = (slot % 2 === 0 ? 1 : -1) * 3.1;
    this.pos.copy(s.pos).addScaledVector(s.side, lat);
    this.heading = Math.atan2(s.tan.x, s.tan.z);
    this.y = 0; this.vy = 0; this.airborne = false; this.airTime = 0; this.vyGround = 0;
    this.speed = 0; this.steer = 0; this.visDrift = 0;
    this.inThrottle = 0; this.inBrake = 0; this.inSteer = 0; this.inDrift = false; this.inBoost = false;
    this.drifting = false; this.driftDir = 0; this.driftCharge = 0;
    this.boostMeter = 0; this.boostTimer = 0;
    this.item = null; this.itemRollT = 0; this.itemHoldT = 0;
    this.shielded = false; this.kart.shield.visible = false;
    this.coins = 0;
    this.laps = 0; this.finished = false; this.finishTime = 0; this.lapTimes = []; this.lapStartT = 0;
    this.si = i; this.rel = (i - lineI + N) % N; this.prevRel = this.rel;
    this.prog = this.rel - N;   // negative until the first line-cross
    this.rank = slot + 1;
    this.slowT = 0; this.slipT = 0; this.wobbleT = 0; this.spinVis = 0; this.trickSpin = 0; this.stumbled = false;
    this.surface = 'road'; this.offroad = false;
    this.hitCd = 0; this.wallCd = 0; this.honkCd = 0; this.draftT = 0; this.draftOn = false;
    this.wrongWayT = 0;
    this.rubber = 1;
    this.shortcutMode = false; this.planShortcut = false; this.msi = 0;
    this.aiT = rand(0, 10);
    this.kv.set(0, 0, 0);
    this.kart.root.position.set(this.pos.x, 0, this.pos.z);
    this.kart.root.rotation.set(0, this.heading, 0);
    this.kart.body.rotation.set(0, 0, 0);
  }

  /* ---------------- per-frame update ---------------- */
  update (dt, time) {
    const racing = race.state === 'race';
    if (racing) {
      if (this.isPlayer && !this.finished) this.readPlayerInput();
      else this.aiDrive(dt);
    } else {
      this.inThrottle = 0; this.inBrake = 0; this.inSteer = 0; this.inDrift = false; this.inBoost = false;
    }
    this.physics(dt, time);
    this.checkTriggers(dt);
    this.trackProgress();
    this.visuals(dt, time);
  }

  readPlayerInput () {
    const autoGas = document.body.classList.contains('touch') && touchScheme === 'zones';   // Asphalt-style: gas is automatic
    this.inThrottle = (autoGas ? !input.down : input.up) ? 1 : 0;
    this.inBrake = input.down ? 1 : 0;
    this.inSteer = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    this.inDrift = input.drift;
    this.inBoost = input.boost;
    if (input.itemPressed) { input.itemPressed = false; useItem(this); }
    if (input.hornPressed) {
      input.hornPressed = false;
      if (this.honkCd <= 0) { AUDIO.hornSfx(duckState.active); this.honkCd = 0.4; }
    }
  }

  physics (dt, time) {
    const s = world.samples[this.si];

    // ---- surface under the kart ----
    const lat = (this.pos.x - s.pos.x) * s.side.x + (this.pos.z - s.pos.z) * s.side.z;
    this.lat = lat;
    if (Math.abs(lat) <= s.w + 0.4) { this.surface = 'road'; this.offroad = false; }
    else {
      // off the ribbon — mud strip or grass?
      let mud = false;
      for (const p of world.mudPts) {
        const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
        if (dx * dx + dz * dz < world.mudW * world.mudW * 1.2) { mud = true; break; }
      }
      this.surface = mud ? 'mud' : 'grass';
      this.offroad = true;
    }
    const surfF = this.airborne ? 1 : (this.surface === 'road' ? 1 : this.surface === 'mud' ? 0.62 : 0.55);

    // ---- top speed for this frame ----
    let maxV = MAX_SPEED * surfF + this.coins * 0.28;
    if (!this.isPlayer) maxV *= (0.89 + 0.09 * this.def.skill) * this.rubber * DIFF.botSpeed;
    const boosting = this.boostTimer > 0;
    if (boosting) maxV = maxV * 1.42 + 4;
    if (this.slowT > 0) maxV *= 0.45;
    if (this.wobbleT > 0) maxV *= 0.85;
    if (this.draftOn) maxV *= 1.08;

    // ---- boost meter (SHIFT) converts into boost time ----
    if (this.inBoost && this.boostMeter > 0 && !this.finished) {
      this.boostMeter = Math.max(0, this.boostMeter - 55 * dt);
      if (this.boostTimer < 0.16) this.boostTimer = 0.16;
      if (!this._boostSfx) { AUDIO.boostSfx(); this._boostSfx = true; if (this.isPlayer) race.shake = Math.max(race.shake, 0.35); }
    } else if (!this.inBoost) this._boostSfx = false;
    this.boostTimer = Math.max(0, this.boostTimer - dt);

    // ---- longitudinal speed ----
    const accelK = boosting ? 2.4 : 1.05;
    if (this.inThrottle > 0) {
      const target = maxV * this.inThrottle;
      const k = this.speed > target ? 0.7 : accelK * surfF * (this.heavy ? 0.85 : 1);
      this.speed += (target - this.speed) * (1 - Math.exp(-k * dt));
    } else if (this.inBrake > 0) {
      if (this.speed > 0.6) this.speed = Math.max(0, this.speed - 52 * dt);
      else this.speed += (-9 - this.speed) * (1 - Math.exp(-1.4 * dt)); // reverse
    } else {
      this.speed += (0 - this.speed) * (1 - Math.exp(-0.45 * dt));     // coast
    }
    if (this.slipT > 0) this.speed *= Math.exp(-0.5 * dt);

    // ---- steering / drifting ----
    let steer = clamp(this.inSteer, -1, 1);
    if (this.slipT > 0) { steer *= 0.25; this.heading += Math.sin(time * 17 + this.id * 3) * 1.5 * dt; }
    if (this.wobbleT > 0) this.heading += Math.sin(time * 13 + this.id) * 1.0 * dt;
    this.steer = steer;

    const grounded = !this.airborne;
    const spd = Math.abs(this.speed);
    let steerEff = clamp(spd / 8, 0, 1) * (1 - 0.25 * clamp((spd - 20) / 22, 0, 1));
    if (this.airborne) steerEff *= 0.35;

    const wantDrift = this.inDrift && grounded && this.speed > 15;
    if (!this.drifting && wantDrift && Math.abs(steer) > 0.25) {
      this.drifting = true;
      this.driftDir = steer > 0 ? 1 : -1;
      this.driftCharge = 0;
    }
    if (this.drifting) {
      if (!wantDrift || Math.abs(this.speed) < 12) {
        // release → mini-turbo into the boost meter
        const tier = this.driftCharge > 2 ? 2 : this.driftCharge > 0.9 ? 1 : 0;
        if (tier > 0) {
          this.boostMeter = clamp(this.boostMeter + (tier === 2 ? 80 : 38), 0, 100);
          if (this.isPlayer) toast(tier === 2 ? 'SUPER mini-turbo! ⚡' : 'Mini-turbo! ⚡');
        }
        this.drifting = false; this.driftDir = 0;
      } else {
        this.heading -= (this.driftDir * 0.95 + steer * 1.15) * steerEff * dt;
        this.driftCharge += dt * (0.5 + Math.abs(steer) * 0.8);
        this.speed *= Math.exp(-0.06 * dt); // drifting scrubs a little speed
        // sparks from the rear
        if (Math.random() < 0.75) {
          const back = new THREE.Vector3(Math.sin(this.heading + Math.PI), 0, Math.cos(this.heading + Math.PI));
          const rp = this.pos.clone().addScaledVector(back, 1.8);
          rp.y = this.y;
          fxDriftSpark(rp, this.driftCharge > 2 ? 2 : 1);
        }
      }
    } else {
      this.heading -= steer * 2.2 * steerEff * dt * Math.sign(this.speed || 1);
    }

    // ---- vertical: ramps + gravity ----
    const gInfo = groundInfoAt(this.pos);
    if (!this.airborne) {
      if (gInfo.y < this.y - 0.08) {           // drove off a ledge/ramp lip
        this.airborne = true;
        this.vy = this.vyGround;
        this.trickArmed = true;
      } else {
        this.y = gInfo.y;
        this.vyGround = this.speed * gInfo.slope;
      }
    }
    if (this.airborne) {
      this.vy -= GRAV * dt;
      this.y += this.vy * dt;
      this.airTime += dt;
      if (this.y <= gInfo.y + 0.001) {
        this.y = gInfo.y; this.vy = 0;
        const wasBig = this.airTime > 0.35;
        this.airborne = false;
        fxDust(this.pos.clone().setY(this.y), wasBig ? 10 : 4);
        // landing a full trick = small boost; landing mid-spin = stumble
        if (this.trickSpin > 0) {
          if (this.trickSpin > 5.7) {
            this.boostTimer = Math.max(this.boostTimer, 0.6);
            if (this.isPlayer) { toast('Sweet air! +boost 🌀'); AUDIO.boostSfx(); }
          } else {
            this.speed *= 0.8;
            if (this.isPlayer) toast('Wobbly landing…');
          }
          this.trickSpin = 0;
        }
      }
      this.airTime += 0;
    } else this.airTime = 0;

    // mid-air trick input (drift key while airborne)
    if (this.airborne && this.trickArmed && this.inDrift && this.airTime > 0.08 && this.trickSpin === 0) {
      this.trickSpin = 0.001; this.trickArmed = false;
    }
    if (this.trickSpin > 0 && this.trickSpin < Math.PI * 2) {
      this.trickSpin = Math.min(Math.PI * 2, this.trickSpin + dt * 13);
    }

    // ---- integrate position ----
    const moveA = this.heading + (this.drifting ? this.driftDir * 0.3 : 0);
    this.pos.x += Math.sin(moveA) * this.speed * dt + this.kv.x * dt;
    this.pos.z += Math.cos(moveA) * this.speed * dt + this.kv.z * dt;
    this.kv.multiplyScalar(Math.exp(-3.5 * dt));

    // hard world edge (nobody escapes the meadow)
    const dr = Math.hypot(this.pos.x, this.pos.z);
    if (dr > WORLD_R) { this.pos.multiplyScalar(WORLD_R / dr); this.speed *= 0.5; }

    // ---- nearest waypoint (windowed on-road, full rescan off-road) ----
    this.updateNearest();

    // ---- barrier walls ----
    const s2 = world.samples[this.si];
    const lat2 = (this.pos.x - s2.pos.x) * s2.side.x + (this.pos.z - s2.pos.z) * s2.side.z;
    const limit = s2.w - 0.5;
    if (s2.barrier && Math.abs(lat2) > limit) {
      const over = Math.abs(lat2) - limit;
      this.pos.addScaledVector(s2.side, -Math.sign(lat2) * over); // lateral push-back only
      // shepherd the heading along the wall so karts slide instead of sticking
      const ta = Math.atan2(s2.tan.x, s2.tan.z);
      const align = wrapPi(ta - this.heading);
      if (Math.abs(align) < Math.PI / 2) this.heading += align * Math.min(1, 2.2 * dt);
      else this.heading -= wrapPi(Math.PI - align) * Math.min(1, 2.2 * dt); // reversing along wall
      const hard = spd > 14 && this.wallCd <= 0;
      if (hard) {
        this.wallCd = 0.5;
        this.speed *= 0.55;
        this.kv.addScaledVector(s2.side, -Math.sign(lat2) * 7);
        const hp = this.pos.clone().setY(this.y + 0.3);
        fxSpark(hp, 12);
        if (this.isPlayer) { AUDIO.wallSfx(); race.shake = Math.max(race.shake, 0.5); buzz(35); }
        this.heading += wrapPi(ta - this.heading) * 0.4;
      } else this.speed *= 0.995;
    }

    // ---- offroad dust + mud splats ----
    if (this.offroad && grounded && spd > 8 && Math.random() < 0.5) {
      const dp = this.pos.clone().setY(this.y);
      if (this.surface === 'mud') fxMudSplat(dp); else fxDust(dp, 2, 0x9dbf6e);
    }

    // ---- slipstream (draft the kart ahead for free speed) ----
    this.draftOn = false;
    if (spd > 18 && grounded) {
      for (const other of racers) {
        if (other === this) continue;
        const dx = other.pos.x - this.pos.x, dz = other.pos.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 9 && d > 2 && other.speed > 16) {
          const ang = wrapPi(Math.atan2(dx, dz) - this.heading);
          if (Math.abs(ang) < 0.22) {
            this.draftT += dt;
            if (this.draftT > 0.7) {
              this.draftOn = true;
              if (this.isPlayer && !this._draftToast) { toast('Slipstream! 💨'); this._draftToast = true; }
            }
            break;
          }
        }
      }
    }
    if (!this.draftOn && this.draftT > 0) { this.draftT = Math.max(0, this.draftT - dt * 2); if (this.draftT === 0) this._draftToast = false; }

    // ---- timers ----
    this.slowT = Math.max(0, this.slowT - dt);
    this.slipT = Math.max(0, this.slipT - dt);
    this.wobbleT = Math.max(0, this.wobbleT - dt);
    this.hitCd = Math.max(0, this.hitCd - dt);
    this.wallCd = Math.max(0, this.wallCd - dt);
    this.honkCd = Math.max(0, this.honkCd - dt);
    if (this.spinVis > 0) this.spinVis = Math.max(0, this.spinVis - dt * 10.5);

    // ---- boost flames ----
    if (boosting && Math.random() < 0.9) {
      const back = new THREE.Vector3(Math.sin(this.heading + Math.PI), 0, Math.cos(this.heading + Math.PI));
      for (const a of this.kart.flameAnchors) {
        const wp = a.clone().applyMatrix4(this.kart.root.matrixWorld);
        fxBoostFlame(wp, back);
      }
    }

    // ---- wrong-way detector (player only) ----
    if (this.isPlayer && spd > 6) {
      const along = Math.sin(this.heading) * s2.tan.x + Math.cos(this.heading) * s2.tan.z;
      this.wrongWayT = (along < -0.25 && this.speed > 0) ? this.wrongWayT + dt : 0;
    } else this.wrongWayT = 0;
  }

  /** Windowed nearest-waypoint search; widens to a full scan when off-road
      (needed so the mud shortcut can jump ~40 indices without losing us). */
  updateNearest () {
    const R = this.offroad ? N / 2 : 10;
    let best = 1e18, bi = this.si;
    for (let d = -R; d <= R; d++) {
      const i = (this.si + d + N * 4) % N;
      const s = world.samples[i];
      const dx = s.pos.x - this.pos.x, dz = s.pos.z - this.pos.z;
      const dd = dx * dx + dz * dz;
      if (dd < best) { best = dd; bi = i; }
    }
    this.si = bi;
  }

  /** Lap counting + progress metric used for live positions. */
  trackProgress () {
    this.prevRel = this.rel;
    this.rel = (this.si - world.lineIdx + N) % N;
    if (this.prevRel > N - 30 && this.rel < 30) {           // crossed the line forward
      this.laps++;
      race.onLapCross(this);
    } else if (this.prevRel < 30 && this.rel > N - 30) {    // reversed over the line
      this.laps--;
    }
    this.prog = (this.laps - 1) * N + this.rel;
  }

  /* ---------------- bot brain (also autopilots the player after finishing) ---------------- */
  aiDrive (dt) {
    const def = this.def;
    const skill = def.chaotic ? (0.72 + 0.25 * Math.abs(Math.sin(this.aiT * 0.3 + this.id))) : def.skill;
    this.aiT += dt;

    // --- choose a target point ---
    let tx, tz;
    if (this.shortcutMode) {
      const pts = world.mudPts;
      const tgt = pts[Math.min(this.msi + 4, pts.length - 1)];
      tx = tgt.x; tz = tgt.z;
      const cur = pts[Math.min(this.msi, pts.length - 1)];
      if (Math.hypot(cur.x - this.pos.x, cur.z - this.pos.z) < 7) this.msi++;
      if (this.msi >= pts.length - 2) this.shortcutMode = false;
    } else {
      // enter the shortcut?
      const entryRel = (world.shortcutEntryIdx - world.lineIdx + N) % N;
      if (this.planShortcut && Math.abs(this.rel - entryRel) < 5) {
        this.shortcutMode = true; this.msi = 2; this.planShortcut = false;
      }
      const la = Math.round((this.offroad ? 3 : 5) + Math.abs(this.speed) * (this.offroad ? 0.1 : 0.26));
      const ts = world.samples[(this.si + la) % N];
      const laneScale = clamp((ts.w - 2.5) / BASE_HW, 0.4, 1.3);
      tx = ts.pos.x + ts.side.x * def.lane * laneScale;
      tz = ts.pos.z + ts.side.z * def.lane * laneScale;
    }
    this.aiTarget = { x: tx, z: tz };

    // --- steer toward it ---
    const desired = Math.atan2(tx - this.pos.x, tz - this.pos.z);
    let err = wrapPi(desired - this.heading);
    let steer = clamp(-err * 2.6, -1, 1);
    steer += Math.sin(this.aiT * 2.7 + this.id * 5) * 0.1 * (1 - skill);

    // --- avoid squishing into nearby karts ---
    for (const other of racers) {
      if (other === this) continue;
      const dx = other.pos.x - this.pos.x, dz = other.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 5.5) {
        const a2 = wrapPi(Math.atan2(dx, dz) - this.heading);
        if (Math.abs(a2) < 0.7) steer += (a2 > 0 ? 1 : -1) * 0.55 * (1 - d / 5.5);
      }
    }
    this.inSteer = clamp(steer, -1, 1);

    // --- corner speed management ---
    let minCs = 99;
    const look = Math.round(4 + Math.abs(this.speed) * 0.55);
    for (let d = 0; d < look; d++) {
      const cs = world.samples[(this.si + d) % N].cs;
      if (cs < minCs) minCs = cs;
    }
    const targetSpeed = this.shortcutMode ? 18 : minCs * (0.92 + 0.22 * skill) * DIFF.corner;
    if (Math.abs(this.speed) > targetSpeed * 1.12) { this.inThrottle = 0; this.inBrake = 1; }
    else if (Math.abs(this.speed) > targetSpeed) { this.inThrottle = 0; this.inBrake = 0; }
    else { this.inThrottle = 1; this.inBrake = 0; }

    // --- drift on long hard corners (good bots only) ---
    const wantDrift = skill > DIFF.driftSkill && Math.abs(this.inSteer) > 0.8 && this.speed > 20 && !this.airborne;
    this.inDrift = this.drifting ? (Math.abs(this.inSteer) > 0.25 && this.speed > 14) : wantDrift;

    // --- stuck? back out for a second and try again ---
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      this.inThrottle = 0; this.inBrake = 1; this.inSteer = -this.inSteer;
    } else if (this.inThrottle > 0 && Math.abs(this.speed) < 4) {
      this.stuckT = (this.stuckT || 0) + dt;
      if (this.stuckT > 2.2) { this.stuckT = 0; this.reverseT = 1.1; }
    } else this.stuckT = 0;

    // --- spend boost meter on straights ---
    this.inBoost = this.boostMeter > 30 && minCs > 32 && Math.random() < 0.9;

    // --- use held items after a think-delay ---
    if (this.item) {
      this.itemHoldT += dt;
      if (this.itemHoldT > rand(1.2, 3.2) && Math.random() < DIFF.itemChance) {
        const k = this.item;
        const ok =
          (k === 'carrot' && minCs > 30) ||
          (k === 'shield') ||
          (k === 'rocket' && !!findRocketTarget(this)) ||
          (k === 'slime' && racers.some((o) => o !== this && o.prog < this.prog && this.pos.distanceTo(o.pos) < 16)) ||
          (k === 'star' && racers.some((o) => o !== this && this.pos.distanceTo(o.pos) < 20));
        if (ok || this.itemHoldT > 7) useItem(this);
      }
    }
  }

  /* ---------------- pretty bits ---------------- */
  visuals (dt, time) {
    const k = this.kart;
    // drift lean-out looks: extra visual yaw beyond physics heading
    const targetVis = this.drifting ? this.driftDir * 0.4 : 0;
    this.visDrift += (targetVis - this.visDrift) * (1 - Math.exp(-8 * dt));
    k.root.position.set(this.pos.x, this.y, this.pos.z);
    k.root.rotation.y = this.heading + this.visDrift + this.spinVis * Math.PI * 2 / 3.6 + this.trickSpin;
    // body roll from steering, nose pitch in the air
    const roll = -this.steer * clamp(Math.abs(this.speed) / MAX_SPEED, 0, 1) * 0.18 - this.visDrift * 0.25;
    const pitch = this.airborne ? clamp(-this.vy * 0.03, -0.3, 0.35) : clamp(-(this.inThrottle * 0.05) + this.inBrake * 0.06, -0.2, 0.2);
    k.body.rotation.z += (roll - k.body.rotation.z) * (1 - Math.exp(-10 * dt));
    k.body.rotation.x += (pitch - k.body.rotation.x) * (1 - Math.exp(-10 * dt));
    // wobble-star silly shimmy
    if (this.wobbleT > 0) k.body.rotation.z += Math.sin(time * 15 + this.id) * 0.2;
    // wheels
    const spin = this.speed * dt / 0.44;
    for (const w of k.wheels) w.rotation.x += spin;
    for (const p of k.frontPivots) p.rotation.y = -this.steer * 0.42;
    // shield + duck beak
    k.shield.visible = this.shielded;
    if (k.shield.visible) k.shield.material.opacity = 0.16 + 0.08 * Math.sin(time * 6);
    k.beak.visible = duckState.active;
    // name tags only read at mid distance (huge up close, clutter far away)
    if (this.tag) {
      const d = camera.position.distanceTo(this.pos);
      this.tag.visible = d > 14 && d < 95;
    }
    // engine audio (player only)
    if (this.isPlayer) AUDIO.updateEngine(clamp(Math.abs(this.speed) / 50, 0, 1), this.inThrottle, this.drifting && !this.airborne, this.boostTimer > 0);
  }

  checkTriggers (dt) { checkRacerTriggers(this, dt); }
}

/* =====================================================================
   8. ITEMS, ROCKETS, PUDDLES, TRIGGERS, COLLISIONS, DUCK MODE
   ===================================================================== */

/** Ground height + slope under a point (ramps are the only slopes). */
function groundInfoAt (p) {
  for (const r of world.ramps) {
    const t = inTrigger(p, r);
    if (t.hit) return { y: ((t.lz + r.hz) / (r.hz * 2)) * r.H, slope: r.H / (r.hz * 2) };
  }
  return { y: 0, slope: 0 };
}

const duckState = {
  unlocked: SAVE.get('duckUnlocked', false),
  hits: SAVE.get('duckHits', 0),
  active: false,
};
function setDuckMode (on) {
  duckState.active = on;
  AUDIO.setDuck(on);
  UI.secretMsg.classList.toggle('hidden', !on);
  UI.duckToggle.textContent = on ? 'ON' : 'OFF';
  UI.duckToggle.classList.toggle('on', on);
}
function registerDuckHit () {
  const d = world.duck;
  if (d.cooldown > 0 || duckState.unlocked) {
    if (duckState.unlocked && d.cooldown <= 0) { d.cooldown = 2; AUDIO.quack({ gain: 0.3 }); }
    return;
  }
  d.cooldown = 3;
  buzz(40);
  duckState.hits = Math.min(3, duckState.hits + 1);
  SAVE.set('duckHits', duckState.hits);
  AUDIO.quack({ gain: 0.35 });
  fxCoinGlint(new THREE.Vector3(d.x, 1.5, d.z));
  fxConfetti(new THREE.Vector3(d.x, 1, d.z), 14);
  if (duckState.hits >= 3) {
    duckState.unlocked = true;
    SAVE.set('duckUnlocked', true);
    UI.duckToggleRow.classList.remove('hidden');
    setDuckMode(true);
    AUDIO.duckFanfare();
    toast('🦆 DUCK MODE UNLOCKED! 🦆', 'big duck', 4);
  } else {
    toast(`The golden duck wobbles… (${duckState.hits}/3) 🦆`, 'duck', 3);
  }
}

function popShield (r) {
  r.shielded = false;
  fxShieldPop(r.pos.clone().setY(r.y));
  AUDIO.shieldPopSfx();
  if (r.isPlayer) toast('Shield popped! 🫧');
}
/** Try to hurt a racer; returns true if a shield ate the hit. */
function absorbHit (r) {
  if (r.shielded) { popShield(r); return true; }
  return false;
}
function loseCoins (r, n) {
  const lost = Math.min(r.coins, n);
  if (lost <= 0) return;
  r.coins -= lost;
  for (let i = 0; i < lost; i++) fxCoinGlint(r.pos.clone().setY(r.y + 1));
}

/** Nearest racer ahead of `r` in race progress (for the confetti rocket). */
function findRocketTarget (r) {
  let best = null, bestGap = 1e9;
  for (const o of racers) {
    if (o === r || o.finished) continue;
    const gap = o.prog - r.prog;
    if (gap > 0 && gap < bestGap && r.pos.distanceTo(o.pos) < 130) { bestGap = gap; best = o; }
  }
  return best;
}

function spawnRocket (r) {
  const grp = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.5, 10), new THREE.MeshLambertMaterial({ color: 0xff4f9a }));
  cone.rotation.x = Math.PI / 2;
  grp.add(cone);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 10), new THREE.MeshLambertMaterial({ color: 0xffd23f }));
  band.rotation.x = Math.PI / 2;
  band.position.z = -0.8;
  grp.add(band);
  grp.position.copy(r.pos).setY(r.y + 1.2);
  scene.add(grp);
  world.rockets.push({
    grp,
    pos: grp.position,
    dir: new THREE.Vector3(Math.sin(r.heading), 0, Math.cos(r.heading)),
    life: 3.5, owner: r, target: findRocketTarget(r),
  });
  AUDIO.rocketFire();
  if (r.isPlayer) toast('Confetti Rocket away! 🎉');
}

function explodeRocket (rk, victim) {
  fxConfetti(rk.pos, victim ? 45 : 20);
  AUDIO.rocketHit();
  if (victim && !absorbHit(victim)) {
    victim.slowT = 1.7;
    victim.spinVis = 3.6;                 // one full visual spin
    loseCoins(victim, 3);
    if (victim.isPlayer) { race.shake = Math.max(race.shake, 0.7); toast('Confetti’d! 🎊'); buzz(70); }
    if (rk.owner && rk.owner.isPlayer) toast(`You confetti’d ${victim.name}! 🎯`);
  }
  scene.remove(rk.grp);
  rk.dead = true;
}

function updateRockets (dt) {
  for (const rk of world.rockets) {
    if (rk.dead) continue;
    rk.life -= dt;
    if (rk.target && !rk.target.finished) {
      const to = new THREE.Vector3(rk.target.pos.x - rk.pos.x, 0, rk.target.pos.z - rk.pos.z).normalize();
      rk.dir.lerp(to, clamp(3.2 * dt, 0, 1)).normalize();
    }
    rk.pos.x += rk.dir.x * 66 * dt;
    rk.pos.z += rk.dir.z * 66 * dt;
    rk.pos.y = groundInfoAt(rk.pos).y + 1.2;
    rk.grp.lookAt(rk.pos.clone().add(rk.dir));
    // sparkly trail
    PARTICLES.spawn(rk.pos.x, rk.pos.y, rk.pos.z,
      { vx: rand(-1, 1), vy: rand(0, 1.5), vz: rand(-1, 1), color: pick([0xff4f9a, 0xffd23f, 0x29d9e5]), size: 0.5, life: 0.5, drag: 1 });
    // hit anything?
    for (const o of racers) {
      if (o === rk.owner) continue;
      if (rk.pos.distanceTo(o.pos.clone().setY(rk.pos.y)) < 2.4) { explodeRocket(rk, o); break; }
    }
    if (!rk.dead && rk.life <= 0) explodeRocket(rk, null);
  }
  world.rockets = world.rockets.filter((r) => !r.dead);
}

function dropPuddle (r) {
  const back = new THREE.Vector3(Math.sin(r.heading + Math.PI), 0, Math.cos(r.heading + Math.PI));
  for (let i = 1; i <= 3; i++) {
    const p = r.pos.clone().addScaledVector(back, 2.5 + i * 2.4);
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(2.2, 14),
      new THREE.MeshLambertMaterial({ color: 0x86f76e, transparent: true, opacity: 0.85 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(p.x, 0.05 + i * 0.002, p.z);
    mesh.scale.setScalar(0.85 + i * 0.1);
    scene.add(mesh);
    world.puddles.push({ mesh, x: p.x, z: p.z, life: 15, age: 0, owner: r });
  }
  AUDIO.slimeSfx();
  if (r.isPlayer) toast('Slime spilled behind you! 🟢');
}

function updatePuddles (dt) {
  for (const p of world.puddles) {
    p.life -= dt; p.age += dt;
    if (p.life < 3) p.mesh.material.opacity = 0.85 * (p.life / 3);
    if (p.life <= 0) { scene.remove(p.mesh); p.dead = true; continue; }
    for (const r of racers) {
      if (r.airborne || r.slipT > 0) continue;
      if (r === p.owner && p.age < 1.2) continue;
      const dx = r.pos.x - p.x, dz = r.pos.z - p.z;
      if (dx * dx + dz * dz < 2.3 * 2.3) {
        if (absorbHit(r)) continue;
        r.slipT = 1.3;
        if (r.isPlayer) { AUDIO.slimeSfx(); toast('Slimed! 🫠'); race.shake = Math.max(race.shake, 0.3); }
      }
    }
  }
  world.puddles = world.puddles.filter((p) => !p.dead);
}

function useStar (r) {
  fxStarRing(r.pos.clone().setY(r.y));
  AUDIO.starSfx();
  let zapped = 0;
  for (const o of racers) {
    if (o === r) continue;
    if (r.pos.distanceTo(o.pos) < 24) {
      if (absorbHit(o)) continue;
      o.wobbleT = 2.4;
      zapped++;
      if (o.isPlayer) { toast('Wobbled! ⭐😵'); race.shake = Math.max(race.shake, 0.4); }
    }
  }
  if (r.isPlayer) toast(zapped ? `Wobble Star hit ${zapped} racer${zapped > 1 ? 's' : ''}! ⭐` : 'Wobble Star fizzled… ⭐');
}

/** Consume the held item. */
function useItem (r) {
  if (!r.item || r.itemRolling) return;
  const k = r.item;
  r.item = null; r.itemHoldT = 0;
  if (k === 'carrot') {
    r.boostTimer = Math.max(r.boostTimer, 1.6);
    AUDIO.boostSfx();
    if (r.isPlayer) { toast('Turbo Carrot! 🥕💨'); race.shake = Math.max(race.shake, 0.35); }
  } else if (k === 'shield') {
    r.shielded = true;
    AUDIO.shieldUp();
    if (r.isPlayer) toast('Bubble Shield up! 🫧');
  } else if (k === 'slime') dropPuddle(r);
  else if (k === 'rocket') spawnRocket(r);
  else if (k === 'star') useStar(r);
}

/** Pads, boxes, coins, duck statue — everything a kart can drive through. */
function checkRacerTriggers (r, dt) {
  if (race.state !== 'race' && race.state !== 'finished') return;

  // boost pads
  r.padCd = Math.max(0, (r.padCd || 0) - dt);
  for (const pad of world.pads) {
    if (r.padCd > 0) break;
    if (inTrigger(r.pos, pad).hit && !r.airborne) {
      r.padCd = 0.9;
      r.boostTimer = Math.max(r.boostTimer, 1.15);
      if (duckState.active) { r.vy = 5.5; r.airborne = true; r.trickArmed = true; }  // duck pads launch!
      if (r.isPlayer) { AUDIO.padSfx(); race.shake = Math.max(race.shake, 0.25); buzz(15); }
      break;
    }
  }

  // item boxes
  if (!r.item && !r.itemRolling) {
    for (const b of world.boxes) {
      if (!b.active) continue;
      if (r.pos.distanceTo(b.pos) < 2.2) {
        b.active = false; b.t = 3.5;
        b.mesh.visible = false;
        r.itemRolling = true; r.itemRollT = 1.0;
        r.pendingItem = rollItem(r.rank);
        fxConfetti(b.pos, 10);
        if (r.isPlayer) AUDIO.pickupSfx();
        break;
      }
    }
  }
  if (r.itemRolling) {
    r.itemRollT -= dt;
    if (r.itemRollT <= 0) {
      r.itemRolling = false;
      r.item = r.pendingItem;
      if (r.isPlayer) AUDIO.pickupSfx();
    }
  }

  // coins
  if (r.coins < 10) {
    for (const c of world.coins) {
      if (!c.active) continue;
      const dx = r.pos.x - c.pos.x, dz = r.pos.z - c.pos.z;
      if (dx * dx + dz * dz < 2.1 * 2.1) {
        c.active = false; c.t = 18;
        c.mesh.visible = false;
        r.coins = Math.min(10, r.coins + 1);
        fxCoinGlint(c.pos);
        if (r.isPlayer) AUDIO.coinSfx(r.coins);
        if (r.coins === 10 && r.isPlayer) toast('Pockets full! +max speed 🪙');
        break;
      }
    }
  }

  // the golden duck (player only — bots have no curiosity)
  if (r.isPlayer && world.duck) {
    const d = world.duck;
    const dx = r.pos.x - d.x, dz = r.pos.z - d.z;
    if (dx * dx + dz * dz < d.r * d.r && Math.abs(r.speed) > 2) registerDuckHit();
  }
}

/** Simple arcade kart-vs-kart shoving. */
function resolveKartCollisions () {
  for (let i = 0; i < racers.length; i++) {
    for (let j = i + 1; j < racers.length; j++) {
      const a = racers[i], b = racers[j];
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      const minD = KART_R * 2;
      if (d < minD && d > 0.001) {
        const nx = dx / d, nz = dz / d;
        const push = (minD - d) / 2;
        const aw = a.heavy ? 0.5 : 1, bw = b.heavy ? 0.5 : 1;
        a.pos.x -= nx * push * aw; a.pos.z -= nz * push * aw;
        b.pos.x += nx * push * bw; b.pos.z += nz * push * bw;
        if (a.hitCd <= 0 && b.hitCd <= 0) {
          a.hitCd = b.hitCd = 0.45;
          const aShield = a.shielded, bShield = b.shielded;
          if (aShield) popShield(a);
          if (bShield) popShield(b);
          a.kv.x -= nx * (bShield ? 9 : 5) / aw; a.kv.z -= nz * (bShield ? 9 : 5) / aw;
          b.kv.x += nx * (aShield ? 9 : 5) / bw; b.kv.z += nz * (aShield ? 9 : 5) / bw;
          if (!aShield) a.speed *= 0.93;
          if (!bShield) b.speed *= 0.93;
          const mid = a.pos.clone().add(b.pos).multiplyScalar(0.5).setY(Math.max(a.y, b.y) + 0.4);
          fxSpark(mid, 7);
          if (a.isPlayer || b.isPlayer) {
            AUDIO.bumpSfx();
            buzz(25);
            race.shake = Math.max(race.shake, 0.3);
            if (Math.random() < 0.2) AUDIO.hornSfx(duckState.active); // grumpy critter honk
          }
        }
      }
    }
  }
}

/* =====================================================================
   9. RACE MANAGER — menu → countdown → race → results
   ===================================================================== */

const race = {
  state: 'menu',        // menu | countdown | race | finished | results (+paused flag)
  paused: false,
  raceTime: 0, countT: 0, endT: 0,
  shake: 0, camAngle: 0, fov: 68,
  finishedOrder: [], resultsRanked: null, playerWon: false,
  rankCheckT: 0, prevPlayerRank: 8,
  fwT: 0, menuChirpT: 3, lightRevertT: 0,
};

const input = { up: false, down: false, left: false, right: false, drift: false, boost: false, itemPressed: false, hornPressed: false };

// --- build the 8 racers (player last on the grid) ---
const racers = [];
ROSTER.forEach((def) => racers.push(new Racer(def, false)));
const player = new Racer({ name: 'YOU', color: PLAYER_COLORS[SAVE.get('color', 0)], skill: 0.9, aggro: 0.5, lane: 0 }, true);
racers.push(player);

function applyPlayerColor () {
  const idx = SAVE.get('color', 0);
  const chosen = PLAYER_COLORS[idx];
  player.setColor(chosen);
  // if the player stole a bot's paint, the bot repaints
  racers.forEach((r) => {
    if (r.isPlayer) return;
    r.setColor(r.def.color === chosen ? SPARE_COLOR : r.def.color);
  });
}

function placeGrid () {
  racers.forEach((r, i) => r.reset(r.isPlayer ? 7 : i));
}

function clearTransients () {
  world.puddles.forEach((p) => scene.remove(p.mesh));
  world.puddles = [];
  world.rockets.forEach((rk) => scene.remove(rk.grp));
  world.rockets = [];
  world.boxes.forEach((b) => { b.active = true; b.t = 0; b.mesh.visible = true; });
  world.coins.forEach((c) => { c.active = true; c.t = 0; c.mesh.visible = true; });
  world.startLights.forEach((l) => { l.material.emissive.setHex(0x000000); });
  PARTICLES.clearAll();
  UI.toasts.innerHTML = '';
  UI.confettiLayer.innerHTML = '';
}

function initRace () {
  AUDIO.ensure();
  clearTransients();
  applyPlayerColor();
  placeGrid();
  race.state = 'countdown';
  race.paused = false;
  race.countT = 0; race.raceTime = 0; race.endT = 0; race.shake = 0;
  race.finishedOrder = []; race.resultsRanked = null; race.playerWon = false;
  race.prevPlayerRank = 8; race.rankCheckT = 0;
  race.countShown = { 3: false, 2: false, 1: false, go: false };
  UI.menu.classList.add('hidden');
  UI.results.classList.add('hidden');
  UI.results.classList.remove('winner');
  UI.pauseOverlay.classList.add('hidden');
  UI.hud.classList.remove('hidden');
  UI.countdown.classList.remove('hidden');
  UI.countdown.classList.remove('go');
  UI.countdown.textContent = '';
  UI.wrongway.classList.add('hidden');
  AUDIO.stopMusic();
  AUDIO.startEngine();
  updatePositions();
  updateHUD(0);
}

function updateCountdown (dt) {
  race.countT += dt;
  const t = race.countT;
  const cs = race.countShown;
  const showNum = (n) => {
    UI.countdown.textContent = String(n);
    UI.countdown.style.animation = 'none';
    void UI.countdown.offsetWidth;               // restart the pop animation
    UI.countdown.style.animation = '';
    AUDIO.countBeep();
    world.startLights[3 - n].material.emissive.setHex(0xcc2222);
  };
  if (t > 0.4 && !cs[3]) { cs[3] = true; showNum(3); }
  if (t > 1.2 && !cs[2]) { cs[2] = true; showNum(2); }
  if (t > 2.0 && !cs[1]) { cs[1] = true; showNum(1); }
  if (t > 2.8 && !cs.go) {
    cs.go = true;
    UI.countdown.textContent = 'GO!';
    UI.countdown.classList.add('go');
    AUDIO.goSound();
    AUDIO.startMusic();
    world.startLights.forEach((l) => l.material.emissive.setHex(0x2fdd55));
    race.lightRevertT = 2;
    race.state = 'race';
    setTimeout(() => UI.countdown.classList.add('hidden'), 800);
  }
}

/** Live standings + bot rubber-banding, a few times per second. */
function updatePositions () {
  const sorted = racers.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.prog - a.prog;
  });
  sorted.forEach((r, i) => { r.rank = i + 1; });

  // rubber band: bots behind the player get quicker, bots ahead ease off
  for (const r of racers) {
    if (r.isPlayer || r.finished) { r.rubber = 1; continue; }
    const gapLaps = (player.prog - r.prog) / N;
    r.rubber = clamp(1 + gapLaps * DIFF.rubberGain, DIFF.rubberMin, DIFF.rubberMax);
  }
  return sorted;
}

/** Called by a racer the moment it crosses the line going forward. */
race.onLapCross = function (r) {
  if (race.state !== 'race' && race.state !== 'finished') return;
  if (!r.isPlayer && r.laps >= 1 && r.laps <= 3) {
    r.planShortcut = r.def.sneaky ? Math.random() < 0.35 : r.def.chaotic ? Math.random() < 0.15 : false;
  }
  if (r.laps === 1) { r.lapStartT = race.raceTime; return; }   // the start-line cross
  if (r.laps >= 2 && r.laps <= 4) {
    r.lapTimes.push(race.raceTime - r.lapStartT);
    r.lapStartT = race.raceTime;
  }
  if (r.isPlayer) {
    if (r.laps === 2) { AUDIO.lapChime(false); toast('LAP 2/3'); }
    if (r.laps === 3) { AUDIO.lapChime(true); toast('FINAL LAP!', 'big', 2.6); }
  } else if (r.laps === 3 && r.rank === 1) {
    toast(`${r.name} is on the final lap!`);
  }
  if (r.laps >= 4 && !r.finished) finishRacer(r);
};

function finishRacer (r) {
  r.finished = true;
  r.finishTime = race.raceTime;
  race.finishedOrder.push(r);
  if (r.isPlayer) {
    AUDIO.finishSfx();
    buzz(90);
    fxConfetti(world.finishPos.clone().setY(2), 60);
    race.shake = Math.max(race.shake, 0.5);
    race.state = 'finished';       // player keeps rolling on autopilot briefly
    race.endT = 1.4;
    toast('FINISHED!', 'big', 2);
  } else {
    if (!player.finished) toast(`${r.name} finished! 🏁`);
  }
}

function showResults () {
  race.state = 'results';
  AUDIO.stopMusic();
  AUDIO.stopEngine();

  // rank: finishers in order, then everyone else by progress
  const ranked = updatePositions();
  race.resultsRanked = ranked;
  const place = player.rank;
  race.playerWon = place === 1;
  const winner = ranked[0];

  // persist per-map best time + lifetime stats
  if (player.finished) {
    const bkey = 'best_' + world.mapKey;
    const best = SAVE.get(bkey, null);
    if (best === null || player.finishTime < best) {
      SAVE.set(bkey, player.finishTime);
      toast('New track record! 🏅', 'big', 2.4);
    }
  }
  const stats = SAVE.get('stats', { r: 0, w: 0 });
  stats.r++; if (race.playerWon) stats.w++;
  SAVE.set('stats', stats);
  updateBestLabel(); updateStatsLine();

  UI.hud.classList.add('hidden');
  UI.results.classList.remove('hidden');
  UI.results.classList.toggle('winner', race.playerWon);

  if (race.playerWon) {
    UI.resultsTitle.textContent = duckState.active ? '🦆 Duck Mode Champion! 🦆' : '🏆 Champion of the Turbo Cup! 🏆';
    UI.resultsSub.textContent = 'Race Finished!';
    AUDIO.victoryFanfare();
    if (duckState.active) setTimeout(() => AUDIO.duckFanfare(), 900);
    domConfetti(120);
    race.fwT = 0.2;
  } else {
    UI.resultsTitle.textContent = 'Race Finished!';
    UI.resultsSub.textContent = 'Nice try! The track wants a rematch. 💪';
    AUDIO.loseJingle();
  }
  UI.placeBig.textContent = place + ordinal(place);
  UI.winnerName.innerHTML = `Winner: <b style="color:#ffd23f">${winner.name}</b>`;
  UI.raceTimeRow.textContent = (player.finished
    ? `Your race time: ${fmtTime(player.finishTime)}`
    : `Race time: ${fmtTime(race.raceTime)}`) + ` · ${DIFF.label}`;
  buildResultsBoard(ranked);

  // gentle nudge toward the easter egg after a couple of clean races
  race.racesPlayed = (race.racesPlayed || 0) + 1;
  UI.resultsTip.textContent = (!duckState.unlocked && duckState.hits === 0 && race.racesPlayed >= 2)
    ? 'Rumor: something golden hides in the grass past the tunnel…'
    : (duckState.active ? 'The ducks were racing all along.' : '');
}

function toMenu () {
  race.state = 'menu';
  race.paused = false;
  AUDIO.stopMusic();
  AUDIO.stopEngine();
  clearTransients();
  placeGrid();
  UI.results.classList.add('hidden');
  UI.pauseOverlay.classList.add('hidden');
  UI.hud.classList.add('hidden');
  UI.menu.classList.remove('hidden');
}

/* ---------- ambient world animation (always running) ---------- */
function updateWorldAnim (dt, time) {
  // spinning item boxes (+respawn)
  for (const b of world.boxes) {
    if (b.active) {
      b.mesh.rotation.y += dt * 1.6;
      b.mesh.rotation.x += dt * 0.9;
      b.mesh.position.y = b.pos.y + Math.sin(time * 2 + b.spin) * 0.18;
    } else {
      b.t -= dt;
      if (b.t <= 0) { b.active = true; b.mesh.visible = true; fxCoinGlint(b.pos); }
    }
  }
  // coins spin (+respawn)
  for (const c of world.coins) {
    if (c.active) c.mesh.rotation.y += dt * 2.4;
    else { c.t -= dt; if (c.t <= 0) { c.active = true; c.mesh.visible = true; } }
  }
  // boost pads shimmer
  for (const p of world.pads) p.mesh.position.y = 0.06 + 0.025 * (1 + Math.sin(time * 5 + p.pulse));
  // waving flags (vertex wiggle)
  for (const f of world.flags) {
    const attr = f.mesh.geometry.attributes.position;
    for (let i = 0; i < attr.count; i++) {
      const bx = f.base[i * 3];
      attr.array[i * 3 + 2] = Math.sin(bx * 1.9 + time * 7 + f.phase) * 0.24 * (bx / 2.6);
    }
    attr.needsUpdate = true;
  }
  // balloons bob
  for (const b of world.balloons) {
    b.grp.position.y = b.baseY + Math.sin(time * 1.1 + b.phase) * 0.8;
    b.grp.rotation.y = Math.sin(time * 0.5 + b.phase) * 0.3;
  }
  // clouds drift
  for (const c of world.clouds) {
    c.grp.position.x += c.speed * dt;
    if (c.grp.position.x > 420) c.grp.position.x = -420;
  }
  // start lights revert to dark after GO
  if (race.lightRevertT > 0) {
    race.lightRevertT -= dt;
    if (race.lightRevertT <= 0) world.startLights.forEach((l) => l.material.emissive.setHex(0x000000));
  }
  // the duck idles, sparkles, and softly quacks when you are close
  if (world.duck) {
    const d = world.duck;
    d.cooldown = Math.max(0, d.cooldown - dt);
    d.grp.rotation.y += dt * 0.25;
    if (Math.random() < dt * 0.7) PARTICLES.spawn(d.x + rand(-1, 1), rand(1, 2.4), d.z + rand(-1, 1),
      { vy: 1, color: 0xffd23f, size: 0.35, life: 0.8, drag: 0.5 });
    d.quackT -= dt;
    if (d.quackT <= 0) {
      d.quackT = rand(5, 10);
      if ((race.state === 'race' || race.state === 'finished') &&
          Math.hypot(player.pos.x - d.x, player.pos.z - d.z) < 22) AUDIO.quack({ gain: 0.08, high: true });
    }
  }
  // menu birdsong
  if (race.state === 'menu') {
    race.menuChirpT -= dt;
    if (race.menuChirpT <= 0) { race.menuChirpT = rand(2.5, 6); AUDIO.chirp(); }
  }
  // victory fireworks
  if (race.state === 'results' && race.playerWon) {
    race.fwT -= dt;
    if (race.fwT <= 0) {
      race.fwT = rand(0.35, 0.8);
      fxFirework(new THREE.Vector3(world.finishPos.x + rand(-40, 40), rand(18, 34), world.finishPos.z + rand(-30, 10)));
    }
  }
}

/* ---------- camera ---------- */
const camTmp = new THREE.Vector3();
function updateCamera (dt) {
  if (race.state === 'menu' || race.state === 'results') {
    race.camAngle += dt * 0.12;
    const c = world.finishPos;
    camTmp.set(c.x + Math.cos(race.camAngle) * 52, 20 + Math.sin(race.camAngle * 0.7) * 5, c.z + Math.sin(race.camAngle) * 52);
    camera.position.lerp(camTmp, 1 - Math.exp(-2.5 * dt));
    camera.lookAt(c.x, 2, c.z);
    camera.fov += (62 - camera.fov) * (1 - Math.exp(-2 * dt));
    camera.updateProjectionMatrix();
    return;
  }
  // chase cam behind the player — pulled in tight inside tunnels so the
  // camera can never poke out through the hill
  const inTun = world.samples[player.si].tunnel ? 1 : 0;
  race.tunBlend = (race.tunBlend || 0) + (inTun - (race.tunBlend || 0)) * (1 - Math.exp(-4.5 * dt));
  const tb = race.tunBlend;
  const back = (9.8 - 3.9 * tb) + Math.abs(player.speed) * 0.055 * (1 - 0.55 * tb);
  const bx = Math.sin(player.heading + Math.PI), bz = Math.cos(player.heading + Math.PI);
  camTmp.set(player.pos.x + bx * back, player.y + 4.7 - 2.1 * tb, player.pos.z + bz * back);
  const k = 1 - Math.exp(-5.5 * dt);
  camera.position.lerp(camTmp, k);
  // screen shake
  race.shake *= Math.exp(-3.2 * dt);
  if (race.shake > 0.005) {
    camera.position.x += rand(-1, 1) * race.shake;
    camera.position.y += rand(-1, 1) * race.shake * 0.6;
    camera.position.z += rand(-1, 1) * race.shake;
  }
  camera.lookAt(
    player.pos.x + Math.sin(player.heading) * 6.5,
    player.y + 1.7,
    player.pos.z + Math.cos(player.heading) * 6.5);
  const targetFov = 68 + (player.boostTimer > 0 ? 13 : 0) + clamp(Math.abs(player.speed) - 30, 0, 10) * 0.35;
  camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-4 * dt));
  camera.updateProjectionMatrix();
}

/* =====================================================================
   10. HUD, TOASTS, RESULTS BOARD, MENU WIRING
   ===================================================================== */

/** Floating announcer message. cls: '' | 'big' | 'duck' | 'big duck' */
function toast (msg, cls = '', ttl = 2) {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.style.setProperty('--ttl', ttl + 's');
  el.textContent = msg;
  UI.toasts.appendChild(el);
  while (UI.toasts.children.length > 4) UI.toasts.removeChild(UI.toasts.firstChild);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, (ttl + 0.5) * 1000);
}

/** Tiny haptic buzz on phones (no-op elsewhere). */
function buzz (ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ } }

const miniCtx = UI.minimap.getContext('2d');
/** Mini track map: outline + shortcut + live racer dots. */
function drawMinimap () {
  const W = UI.minimap.width, ctx = miniCtx;
  ctx.clearRect(0, 0, W, W);
  ctx.beginPath();
  world.miniPts.forEach(([u, v], i) => { const x = u * W, y = v * W; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 6; ctx.stroke();
  ctx.strokeStyle = 'rgba(26,22,50,0.95)'; ctx.lineWidth = 3.5; ctx.stroke();
  ctx.beginPath();
  world.miniMud.forEach(([u, v], i) => { if (i) ctx.lineTo(u * W, v * W); else ctx.moveTo(u * W, v * W); });
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(200,150,90,0.95)'; ctx.lineWidth = 3; ctx.stroke();
  ctx.setLineDash([]);
  const [fu, fv] = world.miniPts[world.lineIdx];
  ctx.fillStyle = '#fff';
  ctx.fillRect(fu * W - 3, fv * W - 3, 6, 6);
  for (const r of racers) {
    const [u, v] = world.miniMap(r.pos.x, r.pos.z);
    ctx.beginPath();
    ctx.arc(u * W, v * W, r.isPlayer ? 6 : 4, 0, 7);
    ctx.fillStyle = '#' + r.color.toString(16).padStart(6, '0');
    ctx.fill();
    if (r.isPlayer) { ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke(); }
  }
}

let hudBoardT = 0, itemIconIdx = -1;
function updateHUD (dt) {
  UI.pos.textContent = player.rank;
  UI.posSuf.textContent = ordinal(player.rank);
  UI.lap.textContent = `LAP ${clamp(player.laps, 1, 3)}/3`;
  UI.timer.textContent = fmtTime(race.raceTime);
  UI.speedVal.textContent = Math.round(Math.abs(player.speed) * 3.4);
  const bm = clamp(player.boostMeter, 0, 100);
  UI.boostFill.style.width = bm + '%';
  UI.boostFill.classList.toggle('full', bm >= 99);
  UI.coins.textContent = player.coins;

  // item slot (with roulette spin while rolling)
  if (player.itemRolling) {
    const idx = Math.floor(performance.now() / 90) % 5;
    if (idx !== itemIconIdx) { itemIconIdx = idx; AUDIO.rouletteTick(); }
    UI.itemIcon.textContent = Object.values(ITEMS)[idx].icon;
    UI.itemName.textContent = '???';
    UI.itemSlot.classList.add('has');
  } else if (player.item) {
    UI.itemIcon.textContent = ITEMS[player.item].icon;
    UI.itemName.textContent = ITEMS[player.item].name;
    UI.itemSlot.classList.add('has');
  } else {
    UI.itemIcon.textContent = '–';
    UI.itemName.textContent = 'no item';
    UI.itemSlot.classList.remove('has');
  }

  UI.wrongway.classList.toggle('hidden', player.wrongWayT < 1);

  // nitro screen glow + speed haze
  UI.nitroFx.style.opacity = player.boostTimer > 0 ? '1' : (Math.abs(player.speed) > 45 ? '0.3' : '0');
  drawMinimap();

  // mini leaderboard (rebuilt a few times per second)
  hudBoardT -= dt;
  if (hudBoardT <= 0) {
    hudBoardT = 0.3;
    const sorted = racers.slice().sort((a, b) => a.rank - b.rank);
    UI.board.innerHTML = sorted.map((r) => `
      <div class="boardRow${r.isPlayer ? ' me' : ''}">
        <span class="boardPos">${r.rank}</span>
        <span class="boardDot" style="background:#${r.color.toString(16).padStart(6, '0')}"></span>
        <span class="boardName">${r.name}</span>
        <span class="boardLap">${r.finished ? '🏁' : 'L' + clamp(r.laps, 1, 3)}</span>
      </div>`).join('');
  }
}

/** Overtake / overtaken announcements. */
function rankToastCheck (dt) {
  race.rankCheckT += dt;
  if (race.rankCheckT < 0.6 || race.raceTime < 4 || player.finished) return;
  race.rankCheckT = 0;
  const cur = player.rank;
  if (cur < race.prevPlayerRank) {
    const behind = racers.find((r) => r.rank === cur + 1 && !r.isPlayer);
    toast(behind ? `You passed ${behind.name}! 🎉` : 'Position up! 🎉');
    if (cur === 1) toast('You’re in the LEAD!', 'big', 2.2);
  } else if (cur > race.prevPlayerRank) {
    const ahead = racers.find((r) => r.rank === cur - 1 && !r.isPlayer);
    toast(ahead ? `${ahead.name} passed you! 😤` : 'Position lost…');
  }
  race.prevPlayerRank = cur;
}

function buildResultsBoard (ranked) {
  const winnerTime = ranked[0].finished ? ranked[0].finishTime : null;
  UI.resultsBoard.innerHTML = ranked.map((r, i) => {
    let t;
    if (r.finished) t = (i === 0 || winnerTime === null) ? fmtTime(r.finishTime) : `+${(r.finishTime - winnerTime).toFixed(1)}s`;
    else t = `${clamp(r.laps - 1, 0, 3)}/3 laps`;
    return `
      <div class="resRow${r.isPlayer ? ' me' : ''}">
        <span class="resPos">${i + 1}${ordinal(i + 1)}</span>
        <span class="resDot" style="background:#${r.color.toString(16).padStart(6, '0')}"></span>
        <span class="resName">${r.name}</span>
        <span class="resTime">${t}</span>
      </div>`;
  }).join('');
}

/** DOM confetti (CSS pieces; tiny ducks when Duck Mode is on). */
function domConfetti (n) {
  const cols = ['#ff4f9a', '#ffd23f', '#29d9e5', '#7ee04e', '#8f6ef0', '#ff7a1a'];
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'confettiBit';
    el.style.left = rand(0, 100) + 'vw';
    el.style.animationDuration = rand(2.6, 5.2) + 's';
    el.style.animationDelay = rand(0, 1.8) + 's';
    if (duckState.active && i % 4 === 0) { el.textContent = '🦆'; el.style.width = 'auto'; el.style.height = 'auto'; }
    else el.style.background = pick(cols);
    UI.confettiLayer.appendChild(el);
  }
}

/* ---------- menu wiring ---------- */
function syncAudioUI () {
  UI.muteBtn.textContent = AUDIO.muted ? '🔇' : '🔊';
  UI.menuMuteBtn.textContent = AUDIO.muted ? '🔇 Muted' : '🔊 Mute';
  UI.menuMuteBtn.classList.toggle('on', AUDIO.muted);
}
UI.muteBtn.addEventListener('click', () => { AUDIO.ensure(); AUDIO.setMuted(!AUDIO.muted); syncAudioUI(); });
UI.menuMuteBtn.addEventListener('click', () => { AUDIO.ensure(); AUDIO.setMuted(!AUDIO.muted); syncAudioUI(); });
UI.volSlider.value = Math.round(AUDIO.volume * 100);
UI.volSlider.addEventListener('input', () => { AUDIO.ensure(); AUDIO.setVolume(UI.volSlider.value / 100); });

// kart paint swatches
PLAYER_COLORS.forEach((hex, i) => {
  const sw = document.createElement('div');
  sw.className = 'swatch' + (SAVE.get('color', 0) === i ? ' sel' : '');
  sw.style.background = '#' + hex.toString(16).padStart(6, '0');
  sw.title = 'Kart color';
  sw.addEventListener('click', () => {
    SAVE.set('color', i);
    [...UI.swatches.children].forEach((c, ci) => c.classList.toggle('sel', ci === i));
    applyPlayerColor();
  });
  UI.swatches.appendChild(sw);
});

// map selector
function updateBestLabel () {
  const b = SAVE.get('best_' + world.mapKey, null);
  UI.bestTime.textContent = b !== null ? `★ Best on ${MAP_BY_KEY[world.mapKey].label}: ${fmtTime(b)} ★` : '';
}
function updateStatsLine () {
  const st = SAVE.get('stats', { r: 0, w: 0 });
  UI.statsLine.textContent = st.r ? `🏁 ${st.r} race${st.r === 1 ? '' : 's'} · 🏆 ${st.w} win${st.w === 1 ? '' : 's'}` : '';
}
function setMap (key) {
  if (!MAP_BY_KEY[key]) key = 'meadows';
  if (world.mapKey !== key) {
    buildWorld(MAP_BY_KEY[key]);
    placeGrid();
  }
  SAVE.set('map', key);
  [...UI.mapBtns.children].forEach((b) => b.classList.toggle('sel', b.dataset.k === key));
  updateBestLabel();
}
MAPS.forEach((mp) => {
  const b = document.createElement('button');
  b.className = 'miniBtn diffBtn';
  b.dataset.k = mp.key;
  b.textContent = `${mp.emoji} ${mp.label}`;
  b.addEventListener('click', () => setMap(mp.key));
  UI.mapBtns.appendChild(b);
});

// fancy-FX (bloom) toggle
function setFX (on) {
  fancyFX = on;
  SAVE.set('fx', on);
  UI.fxBtn.textContent = on ? '✨ Fancy FX: ON' : '✨ Fancy FX: OFF';
  UI.fxBtn.classList.toggle('on', on);
}
UI.fxBtn.addEventListener('click', () => setFX(!fancyFX));
setFX(fancyFX);

// difficulty selector
function setDifficulty (key) {
  DIFF = DIFFICULTIES[key] || DIFFICULTIES.medium;
  SAVE.set('difficulty', DIFF.key);
  [...UI.diffBtns.children].forEach((b) => b.classList.toggle('sel', b.dataset.k === DIFF.key));
}
Object.values(DIFFICULTIES).forEach((d) => {
  const b = document.createElement('button');
  b.className = 'miniBtn diffBtn';
  b.dataset.k = d.key;
  b.textContent = d.label;
  b.addEventListener('click', () => setDifficulty(d.key));
  UI.diffBtns.appendChild(b);
});
setDifficulty(SAVE.get('difficulty', 'medium'));

UI.startBtn.addEventListener('click', () => { AUDIO.ensure(); initRace(); });
UI.againBtn.addEventListener('click', () => { AUDIO.ensure(); initRace(); });
UI.menuBtn.addEventListener('click', () => toMenu());
UI.resumeBtn.addEventListener('click', () => { race.paused = false; UI.pauseOverlay.classList.add('hidden'); });
UI.pauseRestartBtn.addEventListener('click', () => initRace());
UI.pauseMenuBtn.addEventListener('click', () => toMenu());
UI.duckToggle.addEventListener('click', () => setDuckMode(!duckState.active));

setMap(SAVE.get('map', 'meadows'));
updateStatsLine();
if (duckState.unlocked) UI.duckToggleRow.classList.remove('hidden');

/* =====================================================================
   11. INPUT
   ===================================================================== */

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': input.up = true; break;
    case 'KeyS': case 'ArrowDown': input.down = true; break;
    case 'KeyA': case 'ArrowLeft': input.left = true; break;
    case 'KeyD': case 'ArrowRight': input.right = true; break;
    case 'Space': input.drift = true; break;
    case 'ShiftLeft': case 'ShiftRight': input.boost = true; break;
    case 'KeyE': case 'Enter':
      if (race.state === 'menu' && !UI.menu.classList.contains('hidden')) { UI.startBtn.click(); break; }
      if (race.state === 'results') { UI.againBtn.click(); break; }
      input.itemPressed = true;
      break;
    case 'KeyH': input.hornPressed = true; break;
    case 'KeyP': toggleDebug(); break;
    case 'Escape': togglePause(); break;
  }
});
window.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': input.up = false; break;
    case 'KeyS': case 'ArrowDown': input.down = false; break;
    case 'KeyA': case 'ArrowLeft': input.left = false; break;
    case 'KeyD': case 'ArrowRight': input.right = false; break;
    case 'Space': input.drift = false; break;
    case 'ShiftLeft': case 'ShiftRight': input.boost = false; break;
  }
});

/** Pause toggle shared by the ESC key and the on-screen ⏸ button. */
function togglePause () {
  if (race.state === 'race' || race.state === 'countdown' || race.state === 'finished') {
    race.paused = !race.paused;
    UI.pauseOverlay.classList.toggle('hidden', !race.paused);
  }
}
UI.pauseBtn.addEventListener('click', togglePause);

/* ---------- on-screen touch controls (phones/tablets) ---------- */
const isTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
/** Hold-style binding: pointer down = on, up/leave/cancel = off. */
function bindHold (id, on, off) {
  const el = document.getElementById(id);
  if (!el) return;
  const down = (e) => { e.preventDefault(); AUDIO.ensure(); on(); };
  const up = (e) => { e.preventDefault(); if (off) off(); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindHold('tGas',   () => { input.up = true; },    () => { input.up = false; });
bindHold('tBrake', () => { input.down = true; },  () => { input.down = false; });
bindHold('tLeft',  () => { input.left = true; },  () => { input.left = false; });
bindHold('tRight', () => { input.right = true; }, () => { input.right = false; });
bindHold('tDrift', () => { input.drift = true; }, () => { input.drift = false; });
bindHold('tBoost', () => { input.boost = true; }, () => { input.boost = false; });
bindHold('tItem',  () => { input.itemPressed = true; });
// Asphalt-scheme column (auto-gas, so no GAS button)
bindHold('zNitro', () => { input.boost = true; }, () => { input.boost = false; });
bindHold('zDrift', () => { input.drift = true; }, () => { input.drift = false; });
bindHold('zBrake', () => { input.down = true; },  () => { input.down = false; });
bindHold('zItem',  () => { input.itemPressed = true; });

/** Full-side steering zones — hold left/right side of the screen to steer.
    Pointer capture keeps the hold alive even when the thumb slides. */
function bindZone (id, set) {
  const el = document.getElementById(id);
  if (!el) return;
  const down = (e) => { e.preventDefault(); AUDIO.ensure(); set(true); try { el.setPointerCapture(e.pointerId); } catch (err) {} };
  const up = (e) => { e.preventDefault(); set(false); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindZone('zoneL', (v) => { input.left = v; });
bindZone('zoneR', (v) => { input.right = v; });

let touchScheme = SAVE.get('touchscheme', 'zones');
function setScheme (key) {
  touchScheme = key;
  SAVE.set('touchscheme', key);
  document.body.classList.toggle('scheme-zones', key === 'zones');
  document.body.classList.toggle('scheme-buttons', key === 'buttons');
  [...UI.schemeBtns.children].forEach((b) => b.classList.toggle('sel', b.dataset.k === key));
}
[['zones', '⚡ Zones (auto-gas)'], ['buttons', '🎮 Buttons']].forEach(([k, label]) => {
  const b = document.createElement('button');
  b.className = 'miniBtn diffBtn';
  b.dataset.k = k;
  b.textContent = label;
  b.addEventListener('click', () => setScheme(k));
  UI.schemeBtns.appendChild(b);
});
setScheme(touchScheme);

/* =====================================================================
   12. DEBUG MODE (P) — waypoints, bot targets, boundaries, live stats
   ===================================================================== */

let debugOn = false, fpsAvg = 60;
function toggleDebug () {
  debugOn = !debugOn;
  world.debugVisible = debugOn;
  world.debugGroup.visible = debugOn;
  UI.debugPanel.classList.toggle('hidden', !debugOn);
}
function updateDebug () {
  // bot → target lines
  const attr = world.botTargetLines.geometry.attributes.position;
  let li = 0;
  for (const r of racers) {
    const t = r.aiTarget;
    attr.array[li * 6 + 0] = r.pos.x; attr.array[li * 6 + 1] = 1; attr.array[li * 6 + 2] = r.pos.z;
    attr.array[li * 6 + 3] = t ? t.x : r.pos.x; attr.array[li * 6 + 4] = 1; attr.array[li * 6 + 5] = t ? t.z : r.pos.z;
    li++;
    if (li >= 8) break;
  }
  attr.needsUpdate = true;
  UI.debugPanel.textContent =
    `FPS ${fpsAvg.toFixed(0)}  state:${race.state}${race.paused ? ' (paused)' : ''}\n` +
    `player si:${player.si} rel:${player.rel} lap:${player.laps} rank:${player.rank}\n` +
    `surface:${player.surface} speed:${player.speed.toFixed(1)} boost:${player.boostMeter.toFixed(0)}\n` +
    `item:${player.item || '-'} coins:${player.coins} duckHits:${duckState.hits}${duckState.active ? ' DUCK' : ''}\n` +
    '--- bots ---\n' +
    racers.filter((r) => !r.isPlayer).map((r) =>
      `${r.rank} ${r.name.padEnd(15)} L${r.laps} rub:${r.rubber.toFixed(2)}${r.shortcutMode ? ' MUD' : ''}${r.finished ? ' FIN' : ''}`).join('\n');
}

/* =====================================================================
   13. MAIN LOOP & BOOT
   ===================================================================== */

let lastT = performance.now();
/** rAF drives the loop normally; a timer fallback keeps the simulation
    stepping if the tab is hidden (browsers stop rAF there). */
function animate (now) {
  requestAnimationFrame(animate);
  tick(now);
}
setInterval(() => { if (document.hidden) tick(performance.now()); }, 33);
function tick (now) {
  const dt = clamp((now - lastT) / 1000, 0.0001, 0.05);
  lastT = now;
  const time = now / 1000;
  fpsAvg = lerp(fpsAvg, 1 / dt, 0.04);

  if (!race.paused) {
    updateWorldAnim(dt, time);

    if (race.state === 'countdown') {
      updateCountdown(dt);
      racers.forEach((r) => r.update(dt, time));
      updateHUD(dt);
    } else if (race.state === 'race' || race.state === 'finished') {
      race.raceTime += dt;
      racers.forEach((r) => r.update(dt, time));
      resolveKartCollisions();
      updateRockets(dt);
      updatePuddles(dt);
      updatePositions();
      rankToastCheck(dt);
      if (race.state === 'finished') {
        race.endT -= dt;
        if (race.endT <= 0) showResults();
      }
      updateHUD(dt);
    }
    PARTICLES.update(dt);
    updateCamera(dt);
    if (debugOn) updateDebug();
  }
  if (!window.__TCGP_SKIP_RENDER) {
    if (fancyFX && composer) composer.render();
    else renderer.render(scene, camera);
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  PARTICLES.mat.uniforms.uScale.value = window.innerHeight * 0.7;
});

/* ---------- debug/cheat helpers (also used for automated testing) ---------- */
function debugFinish (win) {
  if (race.state !== 'race') return;
  if (!win) {
    racers.filter((r) => !r.isPlayer).slice(0, 3).forEach((b, i) => {
      b.laps = 4; b.prog = (b.laps - 1) * N + b.rel;
      b.finished = true; b.finishTime = Math.max(0.1, race.raceTime - 3 + i);
      race.finishedOrder.push(b);
    });
  }
  player.laps = 4;
  player.prog = (player.laps - 1) * N + player.rel;
  finishRacer(player);
}
window.TCGP = {
  race, player, racers, world, AUDIO, duckState, input,
  debugFinish,
  /** Deterministically fast-forward N frames (testing/automation aid). */
  step (frames = 60, dtMs = 33) { for (let i = 0; i < frames; i++) tick(lastT + dtMs); },
  unlockDuck () {
    if (duckState.unlocked) { setDuckMode(true); return; }
    duckState.hits = 2; world.duck.cooldown = 0; registerDuckHit();
  },
  setDuckMode, toggleDebug, setDifficulty, setMap, MAPS,
  get DIFF () { return DIFF; },
};

// arrange the menu diorama and go
placeGrid();
applyPlayerColor();
syncAudioUI();
requestAnimationFrame(animate);
window.__TCGP_BOOTED = true;
