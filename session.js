'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// session.js — Session management, focus scoring, localStorage, chart, history
//
// Depends on tracker.js being loaded first.
// Exposes SessionManager:
//   SessionManager.init()
//   SessionManager.start()
//   SessionManager.end()
//   SessionManager.newSession()
//   SessionManager.clearHistory()
// ─────────────────────────────────────────────────────────────────────────────

const SessionManager = (() => {

  // ── Constants ──
  const STORAGE_KEY   = 'eyetrace_sessions';
  const MAX_SESSIONS  = 50;
  const SAMPLE_INTERVAL_MS = 10000; // Record a focus data point every 10s

  // Gaze heatmap resolution — points are binned into this grid during a
  // session and persisted so the report / history modal can render it.
  const HEATMAP_W = 48;
  const HEATMAP_H = 32;

  // ── Tomato-style timer presets ──────────────────────────────────────────
  // Stored as an array of integers (minutes). Capped at MAX_PRESETS.
  // The literal value 0 is reserved for "open-ended" (no countdown).
  const PRESETS_KEY = 'eyetrace_presets';
  const MAX_PRESETS = 10;
  const DEFAULT_PRESETS = [15, 25, 50]; // classic short / Pomodoro / long

  function loadPresets() {
    try {
      const raw = JSON.parse(localStorage.getItem(PRESETS_KEY) || 'null');
      if (Array.isArray(raw) && raw.length) {
        return raw.filter(n => Number.isFinite(n) && n > 0 && n <= 240).slice(0, MAX_PRESETS);
      }
    } catch {}
    return [...DEFAULT_PRESETS];
  }
  function savePresets(arr) {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(arr.slice(0, MAX_PRESETS)));
  }
  function addPreset(minutes) {
    const m = Math.round(Number(minutes));
    if (!m || m <= 0 || m > 240) return false;
    const list = loadPresets();
    if (list.includes(m)) return false;
    if (list.length >= MAX_PRESETS) return false;
    list.push(m);
    list.sort((a, b) => a - b);
    savePresets(list);
    return true;
  }
  function removePreset(minutes) {
    const list = loadPresets().filter(m => m !== minutes);
    savePresets(list);
  }

  // Selected duration for the next session, in seconds. 0 = open-ended.
  let selectedDurationSec = 0;

  // ── Personalized scoring ──────────────────────────────────────────────
  // We keep a rolling pool of per-sample measurements across all sessions
  // and use the median / MAD of that pool as each user's personal baseline.
  // Once the user has completed MIN_CALIB_SESSIONS, calcFocusScore will
  // switch from hard-coded tiers to z-score-based penalties.
  const PROFILE_KEY           = 'eyetrace_profile';
  const MIN_CALIB_SESSIONS    = 3;
  const MAX_SAMPLES_PER_SIGNAL = 600;

  // ── Session state ──
  let activeSession   = null;
  let sampleInterval  = null;
  let displayInterval = null; // fast 1s refresh for live UI
  let timerInterval   = null;
  let sessionSettings = {
    blink: true, head: true, threshold: 6,
    // Focus-nudge: when the live focus score has been below the distraction
    // cutoff continuously for `nudgeSeconds` seconds, play a soft ambient
    // tone until the user refocuses. Intended as a gentle attention cue,
    // not a medical/therapeutic claim.
    nudge: true,
    nudgeSeconds: 40,
  };

  // Distraction-tone runtime state (not persisted)
  let distractedSinceMs = null;  // timestamp when the current low-focus run began
  let nudgeMutedForRun  = false; // user tapped "silence" on the current run

  // ─────────────────────────────────────────────────────────────────────────
  // Nudge — a tiny WebAudio sub-module that generates a gentle ambient chord
  // with a slow LFO for movement. No external audio files required, so this
  // keeps working on GitHub Pages / offline. Volume ramps up and down over
  // ~0.6s to avoid jarring on/off clicks.
  // ─────────────────────────────────────────────────────────────────────────
  const Nudge = (() => {
    let ctx        = null;   // AudioContext (lazy — created on first play)
    let master     = null;   // master GainNode
    let oscs       = [];     // active oscillators
    let lfo        = null;   // slow vibrato
    let lfoGain    = null;
    let playing    = false;
    let fadeTarget = 0.08;   // peak master gain (quiet by design)

    function ensureCtx() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx    = new AC();
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
      return ctx;
    }

    function play() {
      if (playing) return;
      const c = ensureCtx();
      if (!c) return;
      // Browsers suspend AudioContext until a user gesture. Start() is only
      // ever called inside the live loop that began after the user pressed
      // START SESSION, so resume() should succeed — but guard anyway.
      if (c.state === 'suspended') c.resume().catch(() => {});

      // A soft A-minor 9 chord: A3, C4, E4, B4. Quiet, consonant, ambient.
      const FREQS = [220.00, 261.63, 329.63, 493.88];
      const PARTIAL_GAIN = 0.25; // per-voice, before master

      oscs = FREQS.map((f, i) => {
        const o = c.createOscillator();
        o.type  = i === 0 ? 'sine' : 'triangle';
        o.frequency.value = f;

        const g = c.createGain();
        g.gain.value = PARTIAL_GAIN;

        o.connect(g).connect(master);
        o.start();
        return { o, g };
      });

      // Slow LFO on master gain for gentle "breathing"
      lfo = c.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.25; // ~4s period
      lfoGain = c.createGain();
      lfoGain.gain.value = 0.015;
      lfo.connect(lfoGain).connect(master.gain);
      lfo.start();

      // Fade in
      const t = c.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(fadeTarget, t + 0.6);

      playing = true;
    }

    function stop() {
      if (!playing || !ctx) { playing = false; return; }
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(0, t + 0.5);

      // Tear down oscillators shortly after the fade completes
      const activeOscs = oscs;
      const activeLfo  = lfo;
      oscs = [];
      lfo  = null;
      lfoGain = null;
      setTimeout(() => {
        activeOscs.forEach(({ o }) => { try { o.stop(); o.disconnect(); } catch {} });
        if (activeLfo) { try { activeLfo.stop(); activeLfo.disconnect(); } catch {} }
      }, 700);

      playing = false;
    }

    return {
      play, stop,
      get isPlaying() { return playing; },
    };
  })();


  // ── Per-sample accumulators (reset every 10s) ──
  let sampleEyeMoves  = 0;
  let sampleBlinks    = 0;
  // Raw frame-level values we aggregate into window-level features.
  let sampleEarValues = [];
  let sampleGazeX     = [];
  let sampleGazeY     = [];

  // ─────────────────────────────────────────────────────────────────────────
  // User profile — rolling baseline samples for personalized scoring
  // ─────────────────────────────────────────────────────────────────────────
  function defaultProfile() {
    return {
      sessionCount:    0,
      personalized:    true, // toggled from the idle UI
      eyeMovesSamples: [],   // per-sample gaze-shifts-per-10s values
      blinkRateSamples: [],
      headScoreSamples: [],
      // Personal model (null until the user runs Calibration Mode)
      model:               null,  // { version, weights, bias, mu, sigma, featureNames, trainedAt, calibration }
      calibrationSamples:  [],    // [{ features: number[], perf: 0..1, source: 'calib'|'feedback', ts }]
    };
  }

  function loadProfile() {
    try {
      const raw = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
      if (!raw) return defaultProfile();
      return Object.assign(defaultProfile(), raw);
    } catch { return defaultProfile(); }
  }

  function saveProfile(p) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  }

  function updateProfileFromSession(session) {
    const p = loadProfile();
    p.sessionCount++;
    session.timeline.forEach(pt => {
      if (typeof pt.eyeMoves  === 'number') p.eyeMovesSamples.push(pt.eyeMoves);
      if (typeof pt.blinkRate === 'number') p.blinkRateSamples.push(pt.blinkRate);
      if (typeof pt.headScore === 'number') p.headScoreSamples.push(pt.headScore);
    });
    p.eyeMovesSamples  = p.eyeMovesSamples .slice(-MAX_SAMPLES_PER_SIGNAL);
    p.blinkRateSamples = p.blinkRateSamples.slice(-MAX_SAMPLES_PER_SIGNAL);
    p.headScoreSamples = p.headScoreSamples.slice(-MAX_SAMPLES_PER_SIGNAL);
    saveProfile(p);
    return p;
  }

  function resetProfile() {
    // Keep the personalized toggle state, but clear learned samples
    const current = loadProfile();
    const fresh   = defaultProfile();
    fresh.personalized = current.personalized;
    saveProfile(fresh);
    return fresh;
  }

  function median(arr) {
    if (!arr || arr.length === 0) return null;
    const s = [...arr].sort((a,b)=>a-b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
  }
  // Median Absolute Deviation — robust analog of std dev (× 1.4826 for normality)
  function mad(arr, med) {
    if (!arr || arr.length === 0 || med == null) return null;
    const devs = arr.map(x => Math.abs(x - med)).sort((a,b)=>a-b);
    const m = Math.floor(devs.length / 2);
    const raw = devs.length % 2 ? devs[m] : (devs[m-1] + devs[m]) / 2;
    return raw * 1.4826;
  }
  function computeBaseline(profile) {
    const eMed = median(profile.eyeMovesSamples);
    const bMed = median(profile.blinkRateSamples);
    const hMed = median(profile.headScoreSamples);
    return {
      eyeMoves:  { med: eMed, mad: mad(profile.eyeMovesSamples,  eMed) },
      blinkRate: { med: bMed, mad: mad(profile.blinkRateSamples, bMed) },
      headScore: { med: hMed, mad: mad(profile.headScoreSamples, hMed) },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Personal model — logistic regression trained in Calibration Mode.
  //
  // Features (5): eyeMoves, blinkRate, headScore, gazeDispersion, earVariance.
  // Each standardized via (x - mu) / sigma using stats captured at train time.
  // Prediction is sigmoid(w·x + b), mapped to 0–100 for display.
  // ─────────────────────────────────────────────────────────────────────────
  const FEATURE_NAMES = ['eyeMoves', 'blinkRate', 'headScore', 'gazeDispersion', 'earVariance'];

  function variance(arr) {
    if (!arr || arr.length < 2) return 0;
    let m = 0;
    for (let i = 0; i < arr.length; i++) m += arr[i];
    m /= arr.length;
    let v = 0;
    for (let i = 0; i < arr.length; i++) v += (arr[i] - m) * (arr[i] - m);
    return v / arr.length;
  }

  // Build a 5-dim feature vector from the raw window data.
  // Missing optional signals (blink/head not in use) substitute sensible defaults.
  function buildFeatureVector(eyeMoves, blinkRate, headScore, extras) {
    return [
      eyeMoves         || 0,
      blinkRate == null ? 15 : blinkRate,     // 15/min ≈ neutral resting rate
      headScore == null ? 0  : headScore,
      (extras && extras.gazeDispersion) || 0,
      (extras && extras.earVariance)    || 0,
    ];
  }

  function standardizeFeatures(samples) {
    const D = FEATURE_NAMES.length;
    const mu = new Array(D).fill(0);
    const sig = new Array(D).fill(0);
    for (const s of samples) for (let i = 0; i < D; i++) mu[i] += s.features[i];
    for (let i = 0; i < D; i++) mu[i] /= samples.length;
    for (const s of samples) for (let i = 0; i < D; i++) sig[i] += (s.features[i] - mu[i]) ** 2;
    for (let i = 0; i < D; i++) sig[i] = Math.sqrt(sig[i] / samples.length) || 1; // avoid div-by-0
    return { mu, sigma: sig };
  }

  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  function rawModelProb(model, features) {
    const D = features.length;
    let z = model.bias;
    for (let i = 0; i < D; i++) {
      const xStd = (features[i] - model.mu[i]) / (model.sigma[i] || 1);
      z += xStd * model.weights[i];
    }
    return sigmoid(z);
  }

  function percentileRank(sortedArr, v) {
    const N = sortedArr.length;
    if (N < 2) return v;
    let lo = 0, hi = N;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedArr[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo / (N - 1);
  }

  // Percentile-mapped prediction: output is the user's rank within their own
  // calibration distribution, so "top 20 %" displays as ~80 regardless of
  // absolute sigmoid value.
  function predictModel(model, features) {
    const p = rawModelProb(model, features);
    if (model.trainPredSorted && model.trainPredSorted.length > 1) {
      return Math.max(0, Math.min(1, percentileRank(model.trainPredSorted, p)));
    }
    return p;
  }

  function computeTrainPredSorted(model, samples) {
    const arr = samples.map(s => rawModelProb(model, s.features));
    arr.sort((a, b) => a - b);
    return arr;
  }

  // Train ridge-regularized logistic regression with **binary cross-entropy**
  // loss on soft labels in [0,1]. BCE gives grad = (p − y) — no sigmoid-derivative
  // factor that would stall training near p ≈ 0.5.
  // Uses an 80/20 train/validation split so the reported R² reflects
  // generalization, not training-set memorization.
  function trainPersonalModel(samples, opts = {}) {
    if (!samples || samples.length < 10) {
      return { ok: false, reason: 'Need at least 10 labeled windows to train.' };
    }
    const D  = FEATURE_NAMES.length;
    const Nt = samples.length;

    // Deterministic 80/20 shuffle (seeded) so the split is reproducible across
    // re-trains but still shuffles away any time-ordered block pattern.
    const rng = (() => { let s = 1337 + Nt; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
    const idx = samples.map((_, i) => i).sort(() => rng() - 0.5);
    const cutoff = Math.max(1, Math.floor(Nt * 0.8));
    const trainIdx = idx.slice(0, cutoff);
    const valIdx   = idx.slice(cutoff);
    // With very small datasets we may end up with 0 val samples — in that case
    // we'll still train but report r2_val = null.
    const haveVal = valIdx.length >= 3;

    // Standardize using TRAIN ONLY — otherwise val leaks into feature stats.
    const trainSamples = trainIdx.map(i => samples[i]);
    const { mu, sigma } = standardizeFeatures(trainSamples);

    const stdz = (feats) => {
      const xs = new Array(D);
      for (let i = 0; i < D; i++) xs[i] = (feats[i] - mu[i]) / (sigma[i] || 1);
      return xs;
    };
    const Xtrain = trainIdx.map(i => stdz(samples[i].features));
    const Ytrain = trainIdx.map(i => Math.max(0.01, Math.min(0.99, samples[i].perf)));
    const Xval   = valIdx  .map(i => stdz(samples[i].features));
    const Yval   = valIdx  .map(i => Math.max(0.01, Math.min(0.99, samples[i].perf)));

    const lr     = opts.lr     ?? 0.3;
    const l2     = opts.l2     ?? 0.01;
    const epochs = opts.epochs ?? 500;
    const N      = Xtrain.length;

    let w = new Array(D).fill(0);
    let b = 0;

    for (let e = 0; e < epochs; e++) {
      const gW = new Array(D).fill(0);
      let gB = 0;
      for (let n = 0; n < N; n++) {
        let z = b;
        for (let i = 0; i < D; i++) z += Xtrain[n][i] * w[i];
        const p   = sigmoid(z);
        const grad = p - Ytrain[n];
        for (let i = 0; i < D; i++) gW[i] += grad * Xtrain[n][i];
        gB += grad;
      }
      for (let i = 0; i < D; i++) w[i] -= lr * (gW[i] / N + l2 * w[i]);
      b -= lr * (gB / N);
    }

    // R² on training set (fit quality)
    const r2On = (Xs, Ys) => {
      if (Xs.length === 0) return null;
      const meanY = Ys.reduce((a, v) => a + v, 0) / Ys.length;
      let ssRes = 0, ssTot = 0;
      for (let n = 0; n < Xs.length; n++) {
        let z = b; for (let i = 0; i < D; i++) z += Xs[n][i] * w[i];
        const p = sigmoid(z);
        ssRes += (Ys[n] - p) ** 2;
        ssTot += (Ys[n] - meanY) ** 2;
      }
      return ssTot > 0 ? 1 - ssRes / ssTot : 0;
    };
    const r2_train = r2On(Xtrain, Ytrain);
    const r2_val   = haveVal ? r2On(Xval, Yval) : null;

    // Build percentile table from *all* samples so runtime predictions map
    // onto the full calibration distribution.
    const allX = samples.map(s => stdz(s.features));
    const allPreds = allX.map(xs => {
      let z = b; for (let i = 0; i < D; i++) z += xs[i] * w[i];
      return sigmoid(z);
    });
    const trainPredSorted = allPreds.slice().sort((a, b) => a - b);

    const meanPerf = samples.reduce((a, s) => a + Math.max(0.01, Math.min(0.99, s.perf)), 0) / Nt;

    return {
      ok: true,
      model: {
        version:        2,
        featureNames:   FEATURE_NAMES,
        weights:        w,
        bias:           b,
        mu,
        sigma,
        trainedAt:      new Date().toISOString(),
        trainPredSorted,
        calibration: {
          nWindows:    Nt,
          nTrain:      N,
          nVal:        valIdx.length,
          meanPerf,
          r2:          r2_val != null ? r2_val : r2_train,  // prefer held-out
          r2_train,
          r2_val,
        },
      },
    };
  }

  // Incremental SGD update: used by the post-session "that was off" feedback.
  // BCE gradient (same as main training). If opts.allSamples is given,
  // the percentile-display table is refreshed from the full calibration pool.
  function refinePersonalModel(model, newSamples, opts = {}) {
    if (!model || !newSamples || newSamples.length === 0) return model;
    const D = FEATURE_NAMES.length;
    const lr = opts.lr ?? 0.1;
    const l2 = opts.l2 ?? 0.01;
    const epochs = opts.epochs ?? 50;
    const w = model.weights.slice();
    let   b = model.bias;

    for (let e = 0; e < epochs; e++) {
      for (const s of newSamples) {
        const xs = new Array(D);
        for (let i = 0; i < D; i++) xs[i] = (s.features[i] - model.mu[i]) / (model.sigma[i] || 1);
        let z = b;
        for (let i = 0; i < D; i++) z += xs[i] * w[i];
        const p = sigmoid(z);
        const y = Math.max(0.01, Math.min(0.99, s.perf));
        const grad = p - y;  // BCE
        for (let i = 0; i < D; i++) w[i] -= lr * (grad * xs[i] + l2 * w[i]);
        b -= lr * grad;
      }
    }
    const refined = Object.assign({}, model, { weights: w, bias: b, trainedAt: new Date().toISOString() });
    if (opts.allSamples && opts.allSamples.length > 0) {
      refined.trainPredSorted = computeTrainPredSorted(refined, opts.allSamples);
    }
    return refined;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Focus scoring
  //   Returns 0–100.  Three modes:
  //     • "model"         — personal logistic-regression model trained from
  //                         Calibration Mode (preferred if available).
  //     • "classic"       — hard-coded tiers (used before calibration or when
  //                         the user has turned personalized scoring off).
  //     • "personalized"  — z-score penalties against the user's own median
  //                         and MAD from past sessions.
  // ─────────────────────────────────────────────────────────────────────────
  function calcFocusScoreClassic(eyeMoves, blinkRate, headScore) {
    let score = 100;
    const threshold = sessionSettings.threshold;

    if      (eyeMoves > threshold * 1.5) score -= 40;
    else if (eyeMoves > threshold)       score -= 20;
    else if (eyeMoves > threshold * 0.5) score -= 8;

    if (sessionSettings.blink && blinkRate !== null) {
      if      (blinkRate > 35) score -= 25;
      else if (blinkRate > 25) score -= 15;
      else if (blinkRate < 6)  score -= 10;
    }
    if (sessionSettings.head && headScore !== null) {
      if      (headScore > 3.0) score -= 30;
      else if (headScore > 1.5) score -= 15;
    }
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  function calcFocusScorePersonalized(eyeMoves, blinkRate, headScore, baseline) {
    let score = 100;
    const zEye   = (baseline.eyeMoves.mad > 0) ? (eyeMoves - baseline.eyeMoves.med) / baseline.eyeMoves.mad : 0;
    if      (zEye > 2)   score -= 40;
    else if (zEye > 1)   score -= 20;
    else if (zEye > 0.5) score -= 8;

    if (sessionSettings.blink && blinkRate !== null && baseline.blinkRate.med !== null) {
      // Penalize deviation in either direction (too slow = staring, too fast = fatigue)
      const zB = (baseline.blinkRate.mad > 0) ? Math.abs((blinkRate - baseline.blinkRate.med) / baseline.blinkRate.mad) : 0;
      if      (zB > 2)   score -= 25;
      else if (zB > 1)   score -= 15;
    }
    if (sessionSettings.head && headScore !== null && baseline.headScore.med !== null) {
      const zH = (baseline.headScore.mad > 0) ? (headScore - baseline.headScore.med) / baseline.headScore.mad : 0;
      if      (zH > 2)   score -= 30;
      else if (zH > 1)   score -= 15;
    }
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // Blend personal-model score with the classic score using held-out R² as
  // the confidence weight: final = R² × personal + (1 − R²) × classic.
  // Low-R² models (weak calibration) degrade gracefully toward classic rules
  // instead of producing low-confidence nonsense.
  function calcFocusScorePersonalModel(model, eyeMoves, blinkRate, headScore, extras) {
    const features = buildFeatureVector(eyeMoves, blinkRate, headScore, extras);
    const personal = Math.round(predictModel(model, features) * 100);
    const classic  = calcFocusScoreClassic(eyeMoves, blinkRate, headScore);
    const r2Raw = model.calibration && typeof model.calibration.r2 === 'number' ? model.calibration.r2 : 0;
    const w = Math.max(0, Math.min(1, r2Raw)); // negative R² → fully classic
    const blended = Math.round(w * personal + (1 - w) * classic);
    return Math.max(0, Math.min(100, blended));
  }

  function calcFocusScore(eyeMoves, blinkRate, headScore, extras) {
    const profile = loadProfile();
    // Preferred: trained personal model
    if (profile.personalized && profile.model && profile.model.weights) {
      return calcFocusScorePersonalModel(profile.model, eyeMoves, blinkRate, headScore, extras);
    }
    const ready = profile.personalized && profile.sessionCount >= MIN_CALIB_SESSIONS;
    if (!ready) {
      return calcFocusScoreClassic(eyeMoves, blinkRate, headScore);
    }
    const baseline = computeBaseline(profile);
    // If any critical baseline is missing, fall back to classic for safety.
    if (baseline.eyeMoves.med == null) {
      return calcFocusScoreClassic(eyeMoves, blinkRate, headScore);
    }
    return calcFocusScorePersonalized(eyeMoves, blinkRate, headScore, baseline);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chart rendering — draws focus timeline onto a canvas element
  // ─────────────────────────────────────────────────────────────────────────
  function renderChart(canvasEl, timeline, sessionDuration) {
    if (!canvasEl || !timeline || timeline.length < 1) return;

    // Set canvas resolution to match display size
    const rect = canvasEl.getBoundingClientRect();
    const W = Math.max(rect.width, 300);
    const H = 180;
    canvasEl.width  = W * window.devicePixelRatio;
    canvasEl.height = H * window.devicePixelRatio;
    canvasEl.style.width  = W + 'px';
    canvasEl.style.height = H + 'px';

    const ctx = canvasEl.getContext('2d');
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const PAD = { top:10, right:16, bottom:28, left:8 };
    const cW = W - PAD.left - PAD.right;
    const cH = H - PAD.top  - PAD.bottom;

    ctx.clearRect(0, 0, W, H);

    // ── Background zones ──
    const zones = [
      { from: 0,  to: 40,  color: 'rgba(239,68,68,0.12)'   }, // red
      { from: 40, to: 70,  color: 'rgba(251,191,36,0.12)'  }, // yellow
      { from: 70, to: 100, color: 'rgba(74,222,128,0.10)'  }, // green
    ];
    zones.forEach(z => {
      const y1 = PAD.top + cH * (1 - z.to/100);
      const y2 = PAD.top + cH * (1 - z.from/100);
      ctx.fillStyle = z.color;
      ctx.fillRect(PAD.left, y1, cW, y2-y1);
    });

    // ── Horizontal grid lines ──
    [25, 50, 75, 100].forEach(pct => {
      const y = PAD.top + cH * (1 - pct/100);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left+cW, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1; ctx.stroke();
    });

    // ── Time axis labels ──
    const totalSec = sessionDuration || (timeline[timeline.length-1].t + SAMPLE_INTERVAL_MS/1000);
    const tickCount = Math.min(6, timeline.length);
    ctx.fillStyle = 'rgba(71,85,105,0.9)';
    ctx.font = `${9 * window.devicePixelRatio / window.devicePixelRatio}px 'Space Mono', monospace`;
    ctx.textAlign = 'center';
    for (let i=0; i<=tickCount; i++) {
      const frac = i / tickCount;
      const sec  = Math.round(frac * totalSec);
      const x    = PAD.left + frac * cW;
      const label = sec >= 60 ? `${Math.floor(sec/60)}m${sec%60>0?String(sec%60).padStart(2,'0')+'s':''}` : `${sec}s`;
      ctx.fillText(label, x, H - 6);
    }

    // ── Focus line ──
    const xForPoint = (t) => PAD.left + (t / totalSec) * cW;
    const yForScore = (s) => PAD.top  + cH * (1 - s/100);

    // Filled area under line
    ctx.beginPath();
    ctx.moveTo(xForPoint(timeline[0].t), yForScore(timeline[0].score));
    timeline.forEach(p => ctx.lineTo(xForPoint(p.t), yForScore(p.score)));
    ctx.lineTo(xForPoint(timeline[timeline.length-1].t), PAD.top + cH);
    ctx.lineTo(xForPoint(timeline[0].t), PAD.top + cH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top+cH);
    grad.addColorStop(0, 'rgba(0,229,195,0.20)');
    grad.addColorStop(1, 'rgba(0,229,195,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line itself
    ctx.beginPath();
    ctx.moveTo(xForPoint(timeline[0].t), yForScore(timeline[0].score));
    timeline.forEach(p => ctx.lineTo(xForPoint(p.t), yForScore(p.score)));
    ctx.strokeStyle = '#00e5c3';
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.stroke();

    // Data points
    timeline.forEach(p => {
      const x = xForPoint(p.t);
      const y = yForScore(p.score);
      const color = p.score >= 70 ? '#4ade80' : p.score >= 40 ? '#fbbf24' : '#ef4444';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI*2);
      ctx.fillStyle   = color;
      ctx.strokeStyle = '#080b10';
      ctx.lineWidth   = 1.5;
      ctx.fill(); ctx.stroke();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Gaze heatmap rendering — classic blue → cyan → green → yellow → red
  // Takes a flat grid of counts plus its dimensions and draws a smooth
  // heatmap onto the provided canvas element.
  // ─────────────────────────────────────────────────────────────────────────
  function jetColor(v) {
    // v in [0, 1] → [r, g, b] using a standard jet-like colormap.
    const t = Math.max(0, Math.min(1, v));
    let r, g, b;
    if (t < 0.25)      { r = 0;                       g = Math.round(4 * t * 255);              b = 255; }
    else if (t < 0.5)  { r = 0;                       g = 255;                                  b = Math.round((1 - 4*(t-0.25)) * 255); }
    else if (t < 0.75) { r = Math.round(4*(t-0.5)*255); g = 255;                                b = 0; }
    else               { r = 255;                     g = Math.round((1 - 4*(t-0.75)) * 255);   b = 0; }
    return [r, g, b];
  }

  function renderHeatmap(canvasEl, grid, gridW, gridH) {
    if (!canvasEl) return;
    // Fall back gracefully when a session has no heatmap data
    const hasData = grid && grid.some(v => v > 0);
    const rect = canvasEl.getBoundingClientRect();
    const W = Math.max(rect.width || canvasEl.offsetWidth || 320, 240);
    const H = 180;
    const dpr = window.devicePixelRatio || 1;
    canvasEl.width  = Math.round(W * dpr);
    canvasEl.height = Math.round(H * dpr);
    canvasEl.style.width  = W + 'px';
    canvasEl.style.height = H + 'px';
    const ctx = canvasEl.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Dark panel background
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, W, H);

    if (!hasData) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
      ctx.font = "11px 'Space Mono', monospace";
      ctx.textAlign = 'center';
      ctx.fillText('NO GAZE DATA', W / 2, H / 2);
      return;
    }

    // Find the max cell so we can normalize to [0,1]
    let maxV = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] > maxV) maxV = grid[i];

    const cellW = W / gridW;
    const cellH = H / gridH;
    // Blob radius should overlap neighbors for a smooth look
    const radius = Math.max(cellW, cellH) * 1.8;

    // Render each non-zero cell as a radial gradient whose color comes
    // from the jet palette. Using 'lighter' composites accumulates
    // intensity where blobs overlap, producing smooth hot spots.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const v = grid[y * gridW + x];
        if (v === 0) continue;
        const t = v / maxV;
        const [r, g, b] = jetColor(t);
        const cx = (x + 0.5) * cellW;
        const cy = (y + 0.5) * cellH;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        const peak = 0.35 * t + 0.15;
        grad.addColorStop(0,    `rgba(${r},${g},${b},${peak})`);
        grad.addColorStop(0.55, `rgba(${r},${g},${b},${peak * 0.35})`);
        grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // Subtle frame so the heatmap stands apart from the card
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mini chart for history items (tiny sparkline)
  // ─────────────────────────────────────────────────────────────────────────
  function renderMiniChart(canvasEl, timeline) {
    if (!canvasEl || !timeline || timeline.length < 2) return;
    const W = canvasEl.offsetWidth || 200;
    const H = 36;
    canvasEl.width  = W * window.devicePixelRatio;
    canvasEl.height = H * window.devicePixelRatio;
    canvasEl.style.height = H + 'px';
    const ctx = canvasEl.getContext('2d');
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const last = timeline[timeline.length-1].t || 1;
    const xFn  = t => (t/last) * W;
    const yFn  = s => H - (s/100) * H;

    ctx.beginPath();
    ctx.moveTo(xFn(timeline[0].t), yFn(timeline[0].score));
    timeline.forEach(p => ctx.lineTo(xFn(p.t), yFn(p.score)));
    ctx.strokeStyle = '#00e5c3';
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = 'round';
    ctx.stroke();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // localStorage
  // ─────────────────────────────────────────────────────────────────────────
  function loadSessions() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch { return []; }
  }

  function saveSession(session) {
    const sessions = loadSessions();
    sessions.unshift(session); // newest first
    if (sessions.length > MAX_SESSIONS) sessions.splice(MAX_SESSIONS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }

  // ── Helper: set a value + color on an element by ID (safe, no-op if missing) ──
  function setEl(id, text, color) {
    const el = document.getElementById(id);
    if (!el) return;
    if (text  !== undefined) el.textContent = text;
    if (color !== undefined) el.style.color = color;
  }

  // ── Show the right screen on BOTH desktop and mobile ──
  function showScreen(id) {
    // Desktop screens
    ['screenIdle','screenActive','screenReport'].forEach(s => {
      const el = document.getElementById(s);
      if (el) el.classList.toggle('active', s === id);
    });
    // Mobile screens (prefixed with m-)
    ['m-screenIdle','m-screenActive','m-screenReport'].forEach(s => {
      const el = document.getElementById(s);
      const matches = s === 'm-' + id;
      if (el) el.classList.toggle('active', matches);
    });
  }

  function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${String(s).padStart(2,'0')}s` : `${s}s`;
  }

  function formatDate(isoString) {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', { month:'short', day:'numeric' }) +
           ' ' + d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Live UI — updates BOTH desktop and mobile elements every 0.5s
  // ─────────────────────────────────────────────────────────────────────────
  function updateLiveUI(score, dir, blinkRate, headScore) {
    const focusColor = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--yellow)' : 'var(--red)';
    const DIR_META   = { '← Left':'← L', '→ Right':'→ R', '● Center':'●', '↑ Up':'↑', '↓ Down':'↓' };
    const dirText    = DIR_META[dir] || '—';
    const blinkColor = blinkRate === null ? 'var(--teal)'
      : (blinkRate>=6 && blinkRate<=20) ? 'var(--green)' : blinkRate>25 ? 'var(--red)' : 'var(--yellow)';
    const headColor  = headScore === null ? 'var(--teal)'
      : headScore < 0.5 ? 'var(--green)' : headScore < 1.5 ? 'var(--yellow)' : 'var(--red)';

    // Desktop elements
    setEl('liveFocusScore', score + '%', focusColor);
    setEl('liveGazDir',     dirText);
    setEl('liveBlinkRate',  blinkRate !== null ? String(blinkRate) : '—', blinkColor);
    setEl('liveHeadScore',  headScore !== null ? headScore.toFixed(1) : '—', headColor);
    const bar = document.getElementById('focusBarFill');
    if (bar) { bar.style.width = score + '%'; bar.style.background = focusColor; }

    // Mobile elements
    setEl('m-liveGazDir',    dirText);
    setEl('m-liveBlinkRate', blinkRate !== null ? String(blinkRate) : '—', blinkColor);
    setEl('m-liveHeadScore', headScore !== null ? headScore.toFixed(1) : '—', headColor);
    const mBar = document.getElementById('m-focusBarFill');
    if (mBar) { mBar.style.width = score + '%'; mBar.style.background = focusColor; }

    // Mobile camera focus badge
    const badge    = document.getElementById('m-focusBadge');
    const badgeVal = document.getElementById('m-focusBadgeVal');
    if (badge && badgeVal) {
      badge.classList.add('visible');
      badgeVal.textContent  = score + '%';
      badgeVal.style.color  = focusColor;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // History list rendering
  // ─────────────────────────────────────────────────────────────────────────
  function renderHistory() {
    const sessions = loadSessions();
    const html = sessions.length === 0
      ? '<div class="history-empty">No sessions recorded yet.<br>Start your first session!</div>'
      : sessions.map((s, idx) => {
          const avg   = s.summary.avgFocus;
          const badge = avg >= 70 ? 'good' : avg >= 40 ? 'ok' : 'poor';
          return `
            <div class="history-item" onclick="SessionManager.viewSession(${idx})">
              <div class="hi-top">
                <span class="hi-date">${formatDate(s.date)}</span>
                <span class="hi-badge ${badge}">${avg}%</span>
              </div>
              <div class="hi-duration">
                <span>${formatDuration(s.duration)}</span>
                ${s.settings.blink ? ' · Blink ✓' : ''}
                ${s.settings.head  ? ' · Head ✓'  : ''}
              </div>
              <canvas class="mini-chart" id="miniChart${idx}" style="width:100%;height:36px;margin-top:7px;border-radius:4px;display:block;"></canvas>
            </div>`;
        }).join('');

    // Push to both desktop and mobile lists
    ['historyList', 'm-historyList'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });

    // Render sparklines after paint
    requestAnimationFrame(() => {
      sessions.forEach((s, idx) => {
        const mc = document.getElementById(`miniChart${idx}`);
        if (mc && s.timeline.length >= 2) renderMiniChart(mc, s.timeline);
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Preset chips — render the tomato-timer duration chooser on the idle
  // screen (both desktop and mobile). Always includes an "Open" chip that
  // means run open-ended (no countdown, end manually).
  // ─────────────────────────────────────────────────────────────────────────
  function formatPresetLabel(min) {
    if (min < 60) return min + 'm';
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? h + 'h' : h + 'h' + m + 'm';
  }

  function renderPresets() {
    const presets = loadPresets();
    const canAddMore = presets.length < MAX_PRESETS;
    const sel = selectedDurationSec;

    const chips = [];
    chips.push(`
      <button type="button" class="preset-chip ${sel === 0 ? 'active' : ''}"
              onclick="SessionManager.selectPreset(0)">
        <span class="preset-chip-label">Open</span>
        <span class="preset-chip-sub">end manually</span>
      </button>`);

    for (const m of presets) {
      const isActive = sel === m * 60;
      chips.push(`
        <button type="button" class="preset-chip ${isActive ? 'active' : ''}"
                onclick="SessionManager.selectPreset(${m * 60})">
          <span class="preset-chip-label">${formatPresetLabel(m)}</span>
          <span class="preset-chip-sub">focus</span>
          <span class="preset-chip-x" onclick="event.stopPropagation();SessionManager.removePreset(${m})" title="Remove">×</span>
        </button>`);
    }

    if (canAddMore) {
      chips.push(`
        <button type="button" class="preset-chip preset-chip-add"
                onclick="SessionManager.promptAddPreset()" title="Add a custom duration">
          <span class="preset-chip-label">+</span>
          <span class="preset-chip-sub">add</span>
        </button>`);
    }

    const html = `
      <div class="preset-card">
        <div class="preset-title">FOCUS DURATION</div>
        <div class="preset-row">${chips.join('')}</div>
        <div class="preset-hint" id="presetHint">${
          sel === 0
            ? 'No timer — the session runs until you press End.'
            : 'Session will auto-end after ' + formatPresetLabel(sel / 60) + '.'
        }</div>
      </div>`;

    ['presetContainer', 'm-presetContainer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
  }

  function selectPreset(seconds) {
    selectedDurationSec = seconds;
    renderPresets();
  }

  function promptAddPreset() {
    const raw = prompt('Add a focus duration (in minutes, 1–240):');
    if (raw === null) return;
    const n = parseInt(raw.trim(), 10);
    if (!Number.isFinite(n) || n < 1 || n > 240) {
      alert('Please enter a whole number of minutes between 1 and 240.');
      return;
    }
    if (!addPreset(n)) {
      alert('Could not add — you might already have that duration, or you\'ve hit the 10-preset limit.');
      return;
    }
    renderPresets();
  }

  function deletePreset(minutes) {
    if (!confirm('Remove the ' + formatPresetLabel(minutes) + ' preset?')) return;
    // If the user is removing the currently selected preset, fall back to Open.
    if (selectedDurationSec === minutes * 60) selectedDurationSec = 0;
    removePreset(minutes);
    renderPresets();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Score breakdown — explain *why* the session got the score it did.
  //
  // Walks every 10s sample, recomputes how many points each signal
  // (eye / blink / head) deducted, and accumulates totals. Then turns
  // those totals into a short attention-style narrative + concrete tips.
  // ─────────────────────────────────────────────────────────────────────────
  function analyzeSession(session) {
    const samples = session.timeline || [];
    if (samples.length === 0) {
      return {
        breakdown: [],
        narrative: 'Session was too short to analyze.',
        tips:      [],
        formula:   '',
      };
    }

    // Profile state at the time the session was scored. We re-derive this
    // for the explanation so the report's deductions match the score the
    // user actually saw.
    const profile      = loadProfile();
    const baseline     = computeBaseline(profile);
    const modelActive  = !!(profile.personalized && profile.model && profile.model.weights);
    const personalized = !modelActive && profile.personalized && profile.sessionCount >= MIN_CALIB_SESSIONS && baseline.eyeMoves.med != null;

    let totalEyePenalty   = 0;
    let totalBlinkPenalty = 0;
    let totalHeadPenalty  = 0;
    let blinkSamples = 0, headSamples = 0;
    let avgBlink = 0, avgHead = 0, avgEye = 0;

    for (const pt of samples) {
      avgEye += pt.eyeMoves || 0;
      // Eye penalty
      if (personalized) {
        const z = (baseline.eyeMoves.mad > 0) ? (pt.eyeMoves - baseline.eyeMoves.med) / baseline.eyeMoves.mad : 0;
        if      (z > 2)   totalEyePenalty += 40;
        else if (z > 1)   totalEyePenalty += 20;
        else if (z > 0.5) totalEyePenalty += 8;
      } else {
        const T = session.settings.threshold || 6;
        if      (pt.eyeMoves > T * 1.5) totalEyePenalty += 40;
        else if (pt.eyeMoves > T)       totalEyePenalty += 20;
        else if (pt.eyeMoves > T * 0.5) totalEyePenalty += 8;
      }
      // Blink penalty
      if (session.settings.blink && pt.blinkRate != null) {
        avgBlink += pt.blinkRate; blinkSamples++;
        if (personalized && baseline.blinkRate.med != null) {
          const zB = (baseline.blinkRate.mad > 0) ? Math.abs((pt.blinkRate - baseline.blinkRate.med) / baseline.blinkRate.mad) : 0;
          if      (zB > 2) totalBlinkPenalty += 25;
          else if (zB > 1) totalBlinkPenalty += 15;
        } else {
          if      (pt.blinkRate > 35) totalBlinkPenalty += 25;
          else if (pt.blinkRate > 25) totalBlinkPenalty += 15;
          else if (pt.blinkRate < 6)  totalBlinkPenalty += 10;
        }
      }
      // Head penalty
      if (session.settings.head && pt.headScore != null) {
        avgHead += pt.headScore; headSamples++;
        if (personalized && baseline.headScore.med != null) {
          const zH = (baseline.headScore.mad > 0) ? (pt.headScore - baseline.headScore.med) / baseline.headScore.mad : 0;
          if      (zH > 2) totalHeadPenalty += 30;
          else if (zH > 1) totalHeadPenalty += 15;
        } else {
          if      (pt.headScore > 3.0) totalHeadPenalty += 30;
          else if (pt.headScore > 1.5) totalHeadPenalty += 15;
        }
      }
    }

    avgEye   = avgEye   / samples.length;
    avgBlink = blinkSamples ? avgBlink / blinkSamples : null;
    avgHead  = headSamples  ? avgHead  / headSamples  : null;

    // Per-sample average penalty (so totals are comparable regardless of length)
    const eyePerSample   = totalEyePenalty   / samples.length;
    const blinkPerSample = totalBlinkPenalty / samples.length;
    const headPerSample  = totalHeadPenalty  / samples.length;

    const breakdown = [
      { label: 'Eye movement', perSample: eyePerSample,   total: totalEyePenalty,   color: '#7c3aed', avg: avgEye.toFixed(1)  + ' shifts/10s' },
    ];
    if (session.settings.blink) breakdown.push({ label: 'Blink rate', perSample: blinkPerSample, total: totalBlinkPenalty, color: '#00e5c3', avg: avgBlink != null ? Math.round(avgBlink) + ' /min' : '—' });
    if (session.settings.head)  breakdown.push({ label: 'Head movement', perSample: headPerSample,  total: totalHeadPenalty,  color: '#fb923c', avg: avgHead  != null ? avgHead.toFixed(2) : '—' });
    breakdown.sort((a, b) => b.perSample - a.perSample);

    const avg = session.summary.avgFocus;

    // ── Narrative — what does the score say about your attention? ──
    let narrative;
    if (avg >= 85) {
      narrative = 'Your attention held remarkably steady. Eye movement, blink rate, and head position all stayed near baseline — this is the kind of profile associated with absorbed, flow-state work.';
    } else if (avg >= 70) {
      narrative = 'Solid focused work. Most of the session was spent on-task, with only brief windows where your attention drifted. The dips in the chart show when you broke from concentration.';
    } else if (avg >= 50) {
      narrative = 'Mixed focus — you had real periods of concentration interspersed with distraction. The score reflects an attention pattern that was repeatedly interrupted rather than sustained.';
    } else if (avg >= 30) {
      narrative = 'Attention was scattered for most of the session. Frequent gaze shifts and movement suggest you were dividing focus between the task and other things in your environment.';
    } else {
      narrative = 'Your attention rarely settled. This kind of profile usually means the conditions weren\'t right for focus — too many interruptions, fatigue, or a task that wasn\'t engaging enough to anchor on.';
    }

    // ── Tips — driven by which signal hurt most ──
    const tips = [];
    const top = breakdown[0];
    if (top && top.perSample >= 15) {
      if (top.label === 'Eye movement') {
        tips.push('Your eyes wandered a lot. Try moving phones, second monitors, or visual clutter out of your direct line of sight.');
        tips.push('If you were reading or watching something, use a single window in full screen to give your eyes fewer places to drift.');
      } else if (top.label === 'Blink rate') {
        if (avgBlink != null && avgBlink > 25) {
          tips.push('Your blink rate was elevated — usually a sign of eye strain or fatigue. Take a 20-second break every 20 minutes and look at something ~20 feet away (the 20-20-20 rule).');
          tips.push('Check your screen brightness and ambient lighting — high contrast between them increases blink rate.');
        } else if (avgBlink != null && avgBlink < 8) {
          tips.push('You blinked very little — common when staring intensely at a screen. Consciously blink a few times per minute to keep your eyes lubricated.');
        }
      } else if (top.label === 'Head movement') {
        tips.push('You shifted position often. A more supportive chair or adjusting your monitor height to eye level reduces the urge to reposition.');
        tips.push('Frequent head turns sometimes signal you\'re reacting to something outside your field of view — noise-canceling headphones or facing away from doorways helps.');
      }
    }
    if (avg < 50 && session.duration < 600) {
      tips.push('This session was under 10 minutes. Short sessions get penalized harder by brief distractions — try a longer block (20–25 min) so good stretches can outweigh interruptions.');
    }
    if (avg >= 70 && tips.length === 0) {
      tips.push('You\'re doing well — try extending your session length to build endurance, or remove one focus aid (e.g., move to a slightly noisier room) to challenge yourself.');
    }
    if (tips.length === 0) {
      tips.push('Keep your environment consistent across sessions — that\'s what lets the personalized scoring distinguish a real focus dip from a normal day.');
    }

    // ── Formula description ──
    let formula;
    if (modelActive) {
      formula = 'Personal model: each 10-second window is scored by a logistic-regression model trained on your calibration session. Features (gaze shifts, blink rate, head movement, gaze dispersion, eyelid variance) are standardized and combined via learned weights — see the Attention Fingerprint below. Breakdown below is classic-rule approximation; the Fingerprint shows the actual model.';
    } else if (personalized) {
      formula = 'Personalized scoring: each 10s sample starts at 100 and loses points when your eye movement, blink rate, or head movement deviates more than ~1 MAD (median absolute deviation) from your personal baseline. Final score is the average across all samples.';
    } else {
      formula = 'Classic scoring: each 10s sample starts at 100 and loses points when eye shifts exceed your threshold, when blink rate falls outside 6–25/min, or when head movement exceeds 1.5. Final score is the average across all samples. After 3 completed sessions, scoring switches to your personal baseline.';
    }

    return { breakdown, narrative, tips, formula, personalized, modelActive };
  }

  function renderBreakdownHTML(analysis) {
    if (!analysis.breakdown.length) return '';
    const maxPer = Math.max(1, ...analysis.breakdown.map(b => b.perSample));
    const bars = analysis.breakdown.map(b => {
      const pct = Math.min(100, Math.round((b.perSample / Math.max(maxPer, 20)) * 100));
      return `
        <div class="breakdown-row">
          <div class="breakdown-row-top">
            <span class="breakdown-label">${b.label}</span>
            <span class="breakdown-meta">avg ${b.avg} · −${Math.round(b.total)} pts total</span>
          </div>
          <div class="breakdown-bar">
            <div class="breakdown-bar-fill" style="width:${pct}%;background:${b.color}"></div>
          </div>
        </div>`;
    }).join('');
    const modeLabel = analysis.modelActive ? 'PERSONAL MODEL' : (analysis.personalized ? 'PERSONALIZED' : 'CLASSIC');
    return `
      <div class="analysis-card">
        <div class="analysis-title">SCORE BREAKDOWN <span class="analysis-mode">${modeLabel}</span></div>
        <p class="analysis-formula">${analysis.formula}</p>
        ${bars}
      </div>`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Attention Fingerprint — visualizes the personal model's learned weights
  // so the user can see which signals predict *their* focus.
  //
  // Positive weight on a (standardized) feature means "more of this = more
  // focus for you." Negative weight means "more of this = less focus."
  // ─────────────────────────────────────────────────────────────────────────
  const FEATURE_PRETTY = {
    eyeMoves:       'Gaze shifts',
    blinkRate:      'Blink rate',
    headScore:      'Head movement',
    gazeDispersion: 'Gaze dispersion',
    earVariance:    'Eyelid variance',
  };
  const FEATURE_FOCUS_PHRASE = {
    // Phrasing depends on direction: + = this predicts focus, − = this anti-predicts focus
    eyeMoves:       { pos: 'active scanning',       neg: 'stable gaze' },
    blinkRate:      { pos: 'higher blink rate',     neg: 'lower blink rate' },
    headScore:      { pos: 'active head movement',  neg: 'still head' },
    gazeDispersion: { pos: 'wide gaze coverage',    neg: 'tight gaze focus' },
    earVariance:    { pos: 'active eyelid activity',neg: 'steady eyelids' },
  };

  function renderFingerprintHTML(model) {
    if (!model || !model.weights) return '';
    const feats = model.featureNames || FEATURE_NAMES;
    // Sort by absolute magnitude
    const ranked = feats.map((name, i) => ({ name, weight: model.weights[i] }))
                        .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    const maxW = Math.max(0.001, ...ranked.map(r => Math.abs(r.weight)));

    const rows = ranked.map(r => {
      const pretty = FEATURE_PRETTY[r.name] || r.name;
      const pct = Math.round((Math.abs(r.weight) / maxW) * 48); // max 48% (half-bar width)
      const cls = r.weight >= 0 ? 'pos' : 'neg';
      const style = r.weight >= 0
        ? `width:${pct}%`
        : `width:${pct}%`;
      return `
        <div class="fp-row">
          <span class="fp-label">${pretty}</span>
          <div class="fp-bar-wrap">
            <div class="fp-bar-mid"></div>
            <div class="fp-bar-fill ${cls}" style="${style}"></div>
          </div>
          <span class="fp-weight">${r.weight >= 0 ? '+' : ''}${r.weight.toFixed(2)}</span>
        </div>`;
    }).join('');

    // Callout — strongest signal
    const top = ranked[0];
    const topPretty = FEATURE_PRETTY[top.name] || top.name;
    const phrase = (FEATURE_FOCUS_PHRASE[top.name] || {})[top.weight >= 0 ? 'pos' : 'neg']
                   || topPretty.toLowerCase();
    const callout = `Your strongest focus signal is <b>${phrase}</b> (${topPretty}, weight ${top.weight >= 0 ? '+' : ''}${top.weight.toFixed(2)}).`;

    const cal = model.calibration || {};
    const r2  = typeof cal.r2 === 'number' ? cal.r2.toFixed(2) : '—';
    const n   = cal.nWindows || 0;
    const trainedAt = model.trainedAt ? new Date(model.trainedAt).toLocaleDateString() : '—';

    return `
      <div class="fingerprint-card">
        <div class="fingerprint-title">ATTENTION FINGERPRINT</div>
        <p class="fingerprint-callout">${callout}</p>
        ${rows}
        <div class="fp-footer">MODEL · LOGISTIC REGRESSION · R² ${r2} · ${n} CALIBRATION WINDOWS · TRAINED ${trainedAt}</div>
      </div>`;
  }

  // Feedback buttons: "That felt accurate" / "That was off".
  // Clicking "off" opens a prompt that lets the user flag a time range as
  // having been focused (or distracted) — each window in that range becomes
  // a new labeled sample appended to the profile's calibration pool, and
  // the model is refined via a few epochs of SGD.
  function renderFeedbackHTML(sessionId) {
    return `
      <div class="feedback-row" id="feedbackRow-${sessionId}">
        <span style="font-family:var(--mono);font-size:0.68rem;color:var(--muted);letter-spacing:0.08em;align-self:center;margin-right:6px;">DID THIS MATCH YOUR EXPERIENCE?</span>
        <button class="btn-feedback ok"  onclick="SessionManager.feedbackOk('${sessionId}')">✓ ACCURATE</button>
        <button class="btn-feedback bad" onclick="SessionManager.feedbackOff('${sessionId}')">✕ WAS OFF</button>
      </div>`;
  }

  function feedbackOk(sessionId) {
    ['feedbackRow-' + sessionId].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = `<span style="font-family:var(--mono);font-size:0.7rem;color:var(--green);letter-spacing:0.08em;">✓ THANKS — LOGGED AS CONFIRMATION</span>`;
    });
  }

  function feedbackOff(sessionId) {
    const sessions = loadSessions();
    const session  = sessions.find(s => s.id === sessionId);
    if (!session || !session.timeline || session.timeline.length === 0) return;

    const raw = prompt(
      'Tell us what was wrong.\n\n' +
      'Enter  F<seconds>-<seconds>  to flag a range you were actually FOCUSED,\n' +
      '   or  D<seconds>-<seconds>  to flag a range you were actually DISTRACTED.\n' +
      'Multiple ranges allowed, separated by commas.\n\n' +
      'Example:  F30-90, D120-180'
    );
    if (!raw) return;

    const ranges = raw.split(',').map(s => s.trim()).map(s => {
      const m = s.match(/^([FDfd])(\d+)\s*-\s*(\d+)$/);
      if (!m) return null;
      const tag = m[1].toUpperCase();
      const a = parseInt(m[2], 10), b = parseInt(m[3], 10);
      return { tag, t0: Math.min(a, b), t1: Math.max(a, b) };
    }).filter(Boolean);

    if (ranges.length === 0) {
      alert('Could not parse — try something like: F30-90, D120-180');
      return;
    }

    // Build feedback samples: every timeline point inside a flagged range
    // becomes a new label (perf=1.0 for focused, 0.0 for distracted).
    const newSamples = [];
    for (const pt of session.timeline) {
      for (const r of ranges) {
        if (pt.t >= r.t0 && pt.t <= r.t1) {
          const extras = {
            gazeDispersion: pt.gazeDispersion || 0,
            earVariance:    pt.earVariance    || 0,
          };
          const features = buildFeatureVector(pt.eyeMoves, pt.blinkRate, pt.headScore, extras);
          newSamples.push({
            features,
            perf: r.tag === 'F' ? 1.0 : 0.0,
            source: 'feedback',
            ts: Date.now(),
          });
          break;
        }
      }
    }

    if (newSamples.length === 0) {
      alert('No samples fell inside those ranges — check your seconds and try again.');
      return;
    }

    const p = loadProfile();
    const combined = (p.calibrationSamples || []).concat(newSamples);
    if (p.model && p.model.weights) {
      p.model = refinePersonalModel(p.model, newSamples, { allSamples: combined });
    }
    p.calibrationSamples = combined;
    saveProfile(p);
    renderCalibStatus();

    alert(`Thanks — ${newSamples.length} labeled window${newSamples.length === 1 ? '' : 's'} added and the model was refined. It will apply to your next session.`);

    // Mark the feedback area as done
    ['feedbackRow-' + sessionId].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = `<span style="font-family:var(--mono);font-size:0.7rem;color:var(--purple);letter-spacing:0.08em;">✓ MODEL REFINED WITH ${newSamples.length} NEW LABEL${newSamples.length === 1 ? '' : 'S'}</span>`;
    });
  }

  function renderNarrativeHTML(analysis) {
    const tipsHTML = analysis.tips.map(t => `<li>${t}</li>`).join('');
    return `
      <div class="analysis-card">
        <div class="analysis-title">WHAT THIS SAYS</div>
        <p class="analysis-narrative">${analysis.narrative}</p>
        <div class="analysis-title" style="margin-top:14px">HOW TO IMPROVE</div>
        <ul class="analysis-tips">${tipsHTML}</ul>
      </div>`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Progress analysis — look at the most recent (up to 10) sessions and
  // tell the user whether their focus is trending up, down, or flat.
  // Uses simple linear regression slope on the avgFocus values.
  // ─────────────────────────────────────────────────────────────────────────
  function analyzeProgress() {
    const all = loadSessions(); // newest first
    if (all.length < 2) return null;

    // Take up to 10 most recent, then put them in chronological order
    const recent = all.slice(0, 10).reverse();
    const scores = recent.map(s => s.summary.avgFocus);
    const n = scores.length;

    // Linear regression: y = mx + b, fit on (index, score)
    const sumX  = (n - 1) * n / 2;
    const sumY  = scores.reduce((a, b) => a + b, 0);
    const sumXY = scores.reduce((acc, y, x) => acc + x * y, 0);
    const sumXX = (n - 1) * n * (2 * n - 1) / 6;
    const slope = n > 1 ? (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) : 0;
    const meanScore = sumY / n;

    // Compare the first half vs second half for a more intuitive number
    const half  = Math.floor(n / 2);
    const early = scores.slice(0, half);
    const late  = scores.slice(n - half);
    const earlyAvg = early.length ? early.reduce((a,b)=>a+b,0) / early.length : meanScore;
    const lateAvg  = late.length  ? late.reduce((a,b)=>a+b,0)  / late.length  : meanScore;
    const delta    = Math.round(lateAvg - earlyAvg);

    let direction, headline, color, advice;
    if (slope > 1.5) {
      direction = 'up';
      headline  = `Trending up — ${delta >= 0 ? '+' + delta : delta} points over your last ${n} sessions`;
      color     = 'var(--green)';
      advice    = 'Whatever you\'ve been doing is working. Keep your environment and routine consistent so the gains compound.';
    } else if (slope < -1.5) {
      direction = 'down';
      headline  = `Trending down — ${delta} points over your last ${n} sessions`;
      color     = 'var(--red)';
      advice    = 'Your focus has been dropping. Look at what changed recently — sleep, schedule, workspace — and consider shorter sessions to rebuild the habit.';
    } else {
      direction = 'flat';
      headline  = `Holding steady — averaging ${Math.round(meanScore)}% across your last ${n} sessions`;
      color     = 'var(--teal)';
      advice    = meanScore >= 70
        ? 'Consistent focus is more valuable than peak focus. You have a stable baseline — try extending session length to build endurance.'
        : 'You\'re plateauing. To break out, change one variable: time of day, environment, or task type, and see if any one shift moves the needle.';
    }

    return {
      n,
      sessions: recent,
      scores,
      meanScore: Math.round(meanScore),
      bestScore: Math.max(...scores),
      worstScore: Math.min(...scores),
      slope,
      delta,
      direction,
      headline,
      color,
      advice,
    };
  }

  function renderProgressHTML(p) {
    if (!p) {
      return `
        <div class="analysis-card">
          <div class="analysis-title">PROGRESS</div>
          <p class="analysis-narrative">Complete at least 2 sessions to see your trend over time.</p>
        </div>`;
    }
    // Tiny inline sparkline: scores plotted as SVG path
    const W = 240, H = 50, pad = 4;
    const xStep = p.scores.length > 1 ? (W - pad * 2) / (p.scores.length - 1) : 0;
    const yFor  = s => H - pad - (s / 100) * (H - pad * 2);
    const pts   = p.scores.map((s, i) => `${pad + i * xStep},${yFor(s)}`).join(' ');
    const dots  = p.scores.map((s, i) => {
      const c = s >= 70 ? '#4ade80' : s >= 40 ? '#fbbf24' : '#ef4444';
      return `<circle cx="${pad + i * xStep}" cy="${yFor(s)}" r="2.5" fill="${c}" />`;
    }).join('');

    return `
      <div class="analysis-card">
        <div class="analysis-title">PROGRESS <span class="analysis-mode">LAST ${p.n}</span></div>
        <div class="progress-headline" style="color:${p.color}">${p.headline}</div>
        <svg class="progress-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <polyline points="${pts}" fill="none" stroke="${p.color}" stroke-width="1.5" stroke-linejoin="round" />
          ${dots}
        </svg>
        <div class="progress-stats">
          <div><span class="ps-label">AVG</span><span class="ps-val">${p.meanScore}%</span></div>
          <div><span class="ps-label">BEST</span><span class="ps-val" style="color:var(--green)">${p.bestScore}%</span></div>
          <div><span class="ps-label">WORST</span><span class="ps-val" style="color:var(--red)">${p.worstScore}%</span></div>
        </div>
        <p class="analysis-narrative" style="margin-top:10px">${p.advice}</p>
      </div>`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Report screen
  // ─────────────────────────────────────────────────────────────────────────
  function showReport(session) {
    showScreen('screenReport');

    const scoreColor = session.summary.avgFocus >= 70 ? 'var(--green)'
      : session.summary.avgFocus >= 40 ? 'var(--yellow)' : 'var(--red)';
    const metaHTML = `
      Duration: <span>${formatDuration(session.duration)}</span><br>
      Date: <span>${formatDate(session.date)}</span><br>
      Samples: <span>${session.timeline.length}</span>`;

    const cards = [
      { val: session.summary.minFocus + '%', label: 'MIN FOCUS' },
      { val: session.summary.distractionEvents, label: 'DISTRACTIONS' },
      { val: session.summary.eyeMoveTotal,      label: 'EYE MOVEMENTS' },
    ];
    if (session.settings.blink) cards.push({ val: session.summary.totalBlinks, label: 'TOTAL BLINKS' });
    if (session.settings.head)  cards.push({ val: session.summary.headEvents,  label: 'HEAD EVENTS' });
    const statsHTML = cards.map(c => `
      <div class="report-stat-card">
        <span class="rs-val">${c.val}</span>
        <span class="rs-label">${c.label}</span>
      </div>`).join('');

    // Desktop
    setEl('reportAvgScore', session.summary.avgFocus + '%', scoreColor);
    const metaEl = document.getElementById('reportMeta');
    if (metaEl) metaEl.innerHTML = metaHTML;
    const statsEl = document.getElementById('reportStatsRow');
    if (statsEl) statsEl.innerHTML = statsHTML;

    // Mobile
    setEl('m-reportAvgScore', session.summary.avgFocus + '%', scoreColor);
    const mMetaEl  = document.getElementById('m-reportMeta');
    if (mMetaEl)  mMetaEl.innerHTML  = metaHTML;
    const mStatsEl = document.getElementById('m-reportStatsRow');
    if (mStatsEl) mStatsEl.innerHTML = statsHTML;

    // Score-breakdown / advice / progress blocks (all four containers,
    // desktop + mobile, get the same content)
    const analysis = analyzeSession(session);
    const progress = analyzeProgress();
    const profile  = loadProfile();
    const breakdownHTML   = renderBreakdownHTML(analysis);
    const narrativeHTML   = renderNarrativeHTML(analysis);
    const progressHTML    = renderProgressHTML(progress);
    const fingerprintHTML = renderFingerprintHTML(profile.model);
    const feedbackHTML    = (profile.model && profile.model.weights) ? renderFeedbackHTML(session.id) : '';

    ['reportFingerprint', 'm-reportFingerprint'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = fingerprintHTML;
    });
    ['reportFeedback', 'm-reportFeedback'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = feedbackHTML;
    });
    ['reportBreakdown', 'm-reportBreakdown'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = breakdownHTML;
    });
    ['reportNarrative', 'm-reportNarrative'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = narrativeHTML;
    });
    ['reportProgress', 'm-reportProgress'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = progressHTML;
    });

    // Render charts + heatmap after DOM paint
    setTimeout(() => {
      const d = document.getElementById('focusChart');
      const m = document.getElementById('m-focusChart');
      if (d) renderChart(d, session.timeline, session.duration);
      if (m) renderChart(m, session.timeline, session.duration);

      const gW = session.heatmapW || HEATMAP_W;
      const gH = session.heatmapH || HEATMAP_H;
      const heat = session.heatmap || [];
      const dh = document.getElementById('reportHeatmap');
      const mh = document.getElementById('m-reportHeatmap');
      if (dh) renderHeatmap(dh, heat, gW, gH);
      if (mh) renderHeatmap(mh, heat, gW, gH);
    }, 80);

    // Timer displays
    setEl('timerDisplay',   formatDuration(session.duration));
    setEl('m-timerDisplay', formatDuration(session.duration));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session start
  // ─────────────────────────────────────────────────────────────────────────
  function start() {
    // Read settings — prefer the active layout's controls
    const mobile = isMobile();
    const blinkToggle = document.getElementById(mobile ? 'm-toggleBlink' : 'toggleBlink');
    const headToggle  = document.getElementById(mobile ? 'm-toggleHead'  : 'toggleHead');
    const thresh      = document.getElementById(mobile ? 'm-threshSlider': 'threshSlider');
    const nudgeToggle = document.getElementById(mobile ? 'm-toggleNudge' : 'toggleNudge');
    const nudgeSlide  = document.getElementById(mobile ? 'm-nudgeSlider' : 'nudgeSlider');
    sessionSettings = {
      blink:        blinkToggle ? blinkToggle.checked : true,
      head:         headToggle  ? headToggle.checked  : true,
      threshold:    thresh      ? +thresh.value       : 6,
      nudge:        nudgeToggle ? nudgeToggle.checked : true,
      nudgeSeconds: nudgeSlide  ? +nudgeSlide.value   : 40,
    };

    // Reset per-session nudge state
    distractedSinceMs = null;
    nudgeMutedForRun  = false;
    _hideNudgeIndicator();

    // Configure tracker
    Tracker.setOptions({ blink: sessionSettings.blink, head: sessionSettings.head });
    Tracker.resetSession();

    // Initialize the live gaze map overlay (shown in place of the camera
    // during active sessions). The webcam keeps streaming into MediaPipe
    // for tracking, but the user sees the abstract gaze-map view instead.
    const gazeCanvasId = isMobile() ? 'm-gazeMapCanvas' : 'gazeMapCanvas';
    const gazeCanvas = document.getElementById(gazeCanvasId);
    if (gazeCanvas && typeof GazeMap !== 'undefined') {
      GazeMap.init(gazeCanvas);
      GazeMap.clear();
      // Resize after the next paint, once the canvas is laid out
      setTimeout(() => GazeMap.resize(), 50);
    }

    // Wire tracker events
    let eyeMoveCount = 0;
    Tracker.onGazeChange = (dir) => {
      eyeMoveCount++;
      sampleEyeMoves++;
    };
    Tracker.onBlink = () => { sampleBlinks++; };

    // Each frame: (a) push a point into the live gaze map for the active
    // screen, (b) bin it into the session's full-session heatmap grid, and
    // (c) accumulate raw values into the per-window feature pools used by
    // the personal model (gaze dispersion, EAR variance).
    Tracker.onFrame = (frame) => {
      if (!frame) return;
      if (frame.gazePoint) {
        if (typeof GazeMap !== 'undefined') GazeMap.addPoint(frame.gazePoint);
        sampleGazeX.push(frame.gazePoint.nx);
        sampleGazeY.push(frame.gazePoint.ny);
      }
      if (typeof frame.ear === 'number' && !Number.isNaN(frame.ear)) {
        sampleEarValues.push(frame.ear);
      }
      if (!activeSession || !activeSession.heatmap || !frame.gazePoint) return;
      const gx = Math.floor(frame.gazePoint.nx * HEATMAP_W);
      const gy = Math.floor(frame.gazePoint.ny * HEATMAP_H);
      if (gx >= 0 && gx < HEATMAP_W && gy >= 0 && gy < HEATMAP_H) {
        activeSession.heatmap[gy * HEATMAP_W + gx]++;
      }
    };

    // Switch the body into "session active" mode so CSS can hide the
    // webcam preview and reveal the gaze-map stage in its place.
    document.body.classList.add('session-active');

    // Hide live cards based on settings
    const blinkCard = document.getElementById('liveBlinkCard');
    const headCard  = document.getElementById('liveHeadCard');
    if (blinkCard) blinkCard.style.display = sessionSettings.blink ? '' : 'none';
    if (headCard)  headCard.style.display  = sessionSettings.head  ? '' : 'none';

    // Init session object
    activeSession = {
      id:       Date.now().toString(),
      date:     new Date().toISOString(),
      duration: 0,
      settings: { ...sessionSettings },
      timeline: [],
      heatmap:  new Array(HEATMAP_W * HEATMAP_H).fill(0),
      heatmapW: HEATMAP_W,
      heatmapH: HEATMAP_H,
      summary:  {
        avgFocus:         0,
        minFocus:         100,
        distractionEvents:0,
        eyeMoveTotal:     0,
        totalBlinks:      0,
        headEvents:       0,
      },
    };

    sampleEyeMoves  = 0;
    sampleBlinks    = 0;
    sampleEarValues = [];
    sampleGazeX     = [];
    sampleGazeY     = [];

    // Switch to active screen
    showScreen('screenActive');

    // Show timers in both layouts
    ['sessionTimer','m-sessionTimer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('visible');
    });
    ['camTimer','m-camTimer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('visible');
    });

    // Show/hide optional cards in both layouts
    ['liveBlinkCard','m-liveBlinkCard'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = sessionSettings.blink ? '' : 'none';
    });
    ['liveHeadCard','m-liveHeadCard'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = sessionSettings.head ? '' : 'none';
    });

    // Snapshot the duration choice at the moment the session starts so
    // changes on the idle screen during a session can't affect a running one.
    activeSession.targetDurationSec = selectedDurationSec; // 0 = open-ended

    let elapsedSeconds = 0;
    timerInterval = setInterval(() => {
      elapsedSeconds++;
      activeSession.duration = elapsedSeconds;
      const target = activeSession.targetDurationSec;

      // Open-ended: count up. Preset: count down toward 0 then auto-end.
      const display = target > 0
        ? formatDuration(Math.max(0, target - elapsedSeconds))
        : formatDuration(elapsedSeconds);
      setEl('timerDisplay',   display);
      setEl('m-timerDisplay', display);
      setEl('camTimer',   display);
      setEl('m-camTimer', display);

      if (target > 0 && elapsedSeconds >= target) {
        // Time's up — auto-finalize the session.
        end();
      }
    }, 1000);

    // ── Fast display refresh (every 0.5s) ──
    displayInterval = setInterval(() => {
      if (!activeSession) return;
      const blinkRate = Tracker.getBlinkRate();
      const headScore = Tracker.getHeadScore();
      // Live preview uses the running accumulators for a smooth-ish live score
      const extras = computeWindowExtras();
      const liveScore = calcFocusScore(sampleEyeMoves, blinkRate, headScore, extras);
      updateLiveUI(liveScore, Tracker.currentDir, blinkRate, headScore);
      evaluateNudge(liveScore);
    }, 500);

    // Focus sampling — every 10s record a data point to the timeline
    sampleInterval = setInterval(() => {
      if (!activeSession) return;
      const t          = activeSession.duration;
      const blinkRate  = Tracker.getBlinkRate();
      const headScore  = Tracker.getHeadScore();
      const extras     = computeWindowExtras();
      const score      = calcFocusScore(sampleEyeMoves, blinkRate, headScore, extras);

      activeSession.timeline.push({
        t,
        score,
        eyeMoves:       sampleEyeMoves,
        blinkRate:      blinkRate,
        headScore:      headScore,
        gazeDispersion: extras.gazeDispersion,
        earVariance:    extras.earVariance,
      });

      // Update summary stats
      activeSession.summary.eyeMoveTotal  += sampleEyeMoves;
      activeSession.summary.totalBlinks   += sampleBlinks;
      if (score < 70) activeSession.summary.distractionEvents++;
      if (score < activeSession.summary.minFocus) activeSession.summary.minFocus = score;
      if (headScore !== null && headScore > 3.0) activeSession.summary.headEvents++;

      // Reset per-sample accumulators
      sampleEyeMoves  = 0;
      sampleBlinks    = 0;
      sampleEarValues = [];
      sampleGazeX     = [];
      sampleGazeY     = [];

    }, SAMPLE_INTERVAL_MS);
  }

  // Aggregate the current per-frame accumulators into window-level features.
  // Called both from the 10s sampler and from the 0.5s live refresh.
  function computeWindowExtras() {
    const gazeVar = variance(sampleGazeX) + variance(sampleGazeY);
    return {
      gazeDispersion: Math.sqrt(gazeVar),
      earVariance:    variance(sampleEarValues),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Nudge evaluator — called every 500ms from the live loop.
  //
  // Logic:
  //   - "Distracted" means liveScore is below DISTRACT_CUTOFF (matches the
  //     same cutoff the session summary uses for "distractionEvents").
  //   - Record the timestamp at which the current distracted run began.
  //     As soon as the user refocuses, reset the timestamp AND stop the
  //     tone if it was playing.
  //   - When the distracted run exceeds the user's `nudgeSeconds` threshold,
  //     play the tone — unless the user has already tapped "silence" on this
  //     run, in which case the tone stays off until they refocus again.
  // ─────────────────────────────────────────────────────────────────────────
  const DISTRACT_CUTOFF = 70;
  function evaluateNudge(liveScore) {
    if (!sessionSettings.nudge) {
      // Feature disabled — make sure nothing is playing or showing
      if (Nudge.isPlaying) Nudge.stop();
      _hideNudgeIndicator();
      distractedSinceMs = null;
      nudgeMutedForRun  = false;
      return;
    }

    const now = Date.now();
    const distracted = typeof liveScore === 'number' && liveScore < DISTRACT_CUTOFF;

    if (!distracted) {
      // Refocused — reset the run, stop the tone, hide indicator
      distractedSinceMs = null;
      nudgeMutedForRun  = false;
      if (Nudge.isPlaying) Nudge.stop();
      _hideNudgeIndicator();
      return;
    }

    // Distracted — start the run clock if it hasn't been started
    if (distractedSinceMs === null) distractedSinceMs = now;

    const elapsedMs = now - distractedSinceMs;
    const thresholdMs = (sessionSettings.nudgeSeconds || 40) * 1000;

    if (elapsedMs >= thresholdMs && !nudgeMutedForRun) {
      if (!Nudge.isPlaying) Nudge.play();
      _showNudgeIndicator(false);
    } else if (nudgeMutedForRun) {
      // User silenced this run — still show the muted indicator as feedback
      _showNudgeIndicator(true);
    }
  }

  function _showNudgeIndicator(muted) {
    ['nudgeIndicator', 'm-nudgeIndicator'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.add('visible');
      el.classList.toggle('muted', !!muted);
      const label = el.querySelector('span:last-child');
      if (label) {
        label.textContent = muted
          ? 'Silenced — will return when you refocus'
          : 'Nudging — tap to silence';
      }
    });
  }

  function _hideNudgeIndicator() {
    ['nudgeIndicator', 'm-nudgeIndicator'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('visible');
      el.classList.remove('muted');
    });
  }

  // Public — wired to the indicator's click handler
  function muteNudge() {
    nudgeMutedForRun = true;
    if (Nudge.isPlaying) Nudge.stop();
    _showNudgeIndicator(true);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session end
  // ─────────────────────────────────────────────────────────────────────────
  function end() {
    if (!activeSession) return;

    // Stop any active focus-nudge tone and hide its indicator
    if (Nudge.isPlaying) Nudge.stop();
    _hideNudgeIndicator();
    distractedSinceMs = null;
    nudgeMutedForRun  = false;

    // Stop timers
    clearInterval(sampleInterval);
    clearInterval(displayInterval);
    clearInterval(timerInterval);
    sampleInterval  = null;
    displayInterval = null;
    timerInterval   = null;

    // Clear the live gaze map and put the camera preview back
    if (typeof GazeMap !== 'undefined') GazeMap.clear();
    document.body.classList.remove('session-active');

    // Hide timers in both layouts
    ['sessionTimer','m-sessionTimer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('visible');
    });
    ['camTimer','m-camTimer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.classList.remove('visible'); el.textContent = ''; }
    });
    // Hide mobile focus badge
    const badge = document.getElementById('m-focusBadge');
    if (badge) badge.classList.remove('visible');

    // Capture final partial sample if there's been any data
    if (sampleEyeMoves > 0 || activeSession.timeline.length === 0) {
      const blinkRate = Tracker.getBlinkRate();
      const headScore = Tracker.getHeadScore();
      const extras    = computeWindowExtras();
      const score     = calcFocusScore(sampleEyeMoves, blinkRate, headScore, extras);
      activeSession.timeline.push({
        t:              activeSession.duration,
        score,
        eyeMoves:       sampleEyeMoves,
        blinkRate:      blinkRate,
        headScore:      headScore,
        gazeDispersion: extras.gazeDispersion,
        earVariance:    extras.earVariance,
      });
      activeSession.summary.eyeMoveTotal += sampleEyeMoves;
      activeSession.summary.totalBlinks  += sampleBlinks;
      if (score < 70) activeSession.summary.distractionEvents++;
      if (score < activeSession.summary.minFocus) activeSession.summary.minFocus = score;
    }

    // Calculate average focus
    if (activeSession.timeline.length > 0) {
      const total = activeSession.timeline.reduce((s,p) => s+p.score, 0);
      activeSession.summary.avgFocus = Math.round(total / activeSession.timeline.length);
    }

    // Handle case where session was too short for any sample
    if (activeSession.timeline.length === 0) {
      activeSession.timeline.push({ t:0, score:100, eyeMoves:0, blinkRate:null, headScore:null });
      activeSession.summary.avgFocus = 100;
      activeSession.summary.minFocus = 100;
    }

    // Save to localStorage
    const completed = { ...activeSession };
    saveSession(completed);
    activeSession = null;

    // Update history sidebar
    renderHistory();

    // Show report
    showReport(completed);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public utility methods
  // ─────────────────────────────────────────────────────────────────────────
  function newSession() {
    showScreen('screenIdle');
    const timerEl = document.getElementById('timerDisplay');
    if (timerEl) timerEl.textContent = '00:00';
    renderPresets();
    renderCalibStatus();
  }

  function clearHistory() {
    if (!confirm('Clear all session history? This cannot be undone.')) return;
    localStorage.removeItem(STORAGE_KEY);
    renderHistory();
  }

  function viewSession(index) {
    const sessions = loadSessions();
    const session  = sessions[index];
    if (!session) return;

    // Build a modal with the session report
    const existing = document.getElementById('historyModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id        = 'historyModal';
    modal.innerHTML = `
      <div class="modal-box">
        <div class="modal-header">
          <span class="modal-title">SESSION — ${formatDate(session.date)}</span>
          <button class="modal-close" onclick="document.getElementById('historyModal').remove()">✕</button>
        </div>
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;">
          <div>
            <div style="font-family:var(--mono);font-size:0.6rem;color:var(--muted);margin-bottom:2px;">AVG FOCUS</div>
            <div style="font-family:var(--mono);font-size:2.2rem;font-weight:700;color:${session.summary.avgFocus>=70?'var(--green)':session.summary.avgFocus>=40?'var(--yellow)':'var(--red)'}">
              ${session.summary.avgFocus}%
            </div>
          </div>
          <div style="font-family:var(--mono);font-size:0.75rem;color:var(--muted);text-align:right;line-height:1.8;">
            Duration: <span style="color:var(--text)">${formatDuration(session.duration)}</span><br>
            Eye moves: <span style="color:var(--text)">${session.summary.eyeMoveTotal}</span><br>
            Distractions: <span style="color:var(--text)">${session.summary.distractionEvents}</span>
            ${session.settings.blink ? `<br>Blinks: <span style="color:var(--text)">${session.summary.totalBlinks}</span>` : ''}
          </div>
        </div>
        <div class="chart-wrap" style="margin-bottom:10px;">
          <div class="chart-y-labels"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
          <canvas id="modalChart" style="flex:1;height:160px;border-radius:8px;border:1px solid var(--border);display:block;"></canvas>
        </div>
        <div class="heatmap-wrap">
          <div class="heatmap-title">GAZE HEATMAP</div>
          <canvas id="modalHeatmap" class="heatmap-canvas"></canvas>
          <div class="heatmap-legend">
            <span class="heatmap-legend-label">rarely viewed</span>
            <span class="heatmap-legend-bar"></span>
            <span class="heatmap-legend-label">frequently viewed</span>
          </div>
        </div>
      </div>`;

    document.body.appendChild(modal);

    // Render chart + heatmap inside modal
    setTimeout(() => {
      const c = document.getElementById('modalChart');
      if (c) renderChart(c, session.timeline, session.duration);

      const h = document.getElementById('modalHeatmap');
      if (h) {
        const gW = session.heatmapW || HEATMAP_W;
        const gH = session.heatmapH || HEATMAP_H;
        renderHeatmap(h, session.heatmap || [], gW, gH);
      }
    }, 60);

    // Close on backdrop click
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Calibration Mode — trains the personal logistic-regression model against
  // objective cognitive performance (typing speed+accuracy, mental-arithmetic
  // speed+accuracy) captured in parallel with webcam behavior.
  // ─────────────────────────────────────────────────────────────────────────
  const CALIB_PARAGRAPHS = [
    "The moon rose slowly over the silent fields, painting the landscape in silver and shadow. A single owl called from the distant trees, its voice carrying on the cool night air. I stood at the window for a long time, watching the light shift across the grass as clouds drifted past.",
    "Attention is not a single thing. It is a cluster of overlapping capacities, the ability to notice, to hold, to resist distraction, and to return when the mind wanders. Each has its own neural signature, and each can be trained, though not always in the ways we expect.",
    "She opened the notebook to a blank page and sat looking at it. For a long moment nothing came. Then, slowly, a sentence formed, and another, and the words began to fill the page on their own, as if they had been waiting patiently in the back of her mind.",
    "Deep learning models are trained by example. Given enough labeled data they can recognize patterns that no human explicitly programmed. But the examples must be good, and the questions we ask of them must be the right questions, framed carefully and asked with care.",
    "The lighthouse keeper had walked the same circular stairs every evening for thirty years. He knew the exact number of steps, the worn spots on each, and the way the wind sounded differently on each landing. Habit had become a kind of meditation for him.",
    "On quiet mornings the harbor looks like a painting that has not yet dried, with boats held suspended in a milky gray light and gulls tracing slow circles above. Nothing seems to move, and yet everything is moving, imperceptibly, toward noon.",
  ];

  const BLOCK_DURATION_SEC = 300; // 5 min per block → ~30 windows × 2 blocks = 60 labels
  // "probe" is a PVT-style attention task: random flash, press space ASAP.
  // Reaction time directly measures attention lapses (gold-standard lab method),
  // so it gives far cleaner labels than task-performance alone.
  const CALIB_BLOCKS       = ['typing', 'probe'];
  const PVT_MIN_ISI_MS     = 2000; // inter-stimulus interval: 2 – 7 s, uniform
  const PVT_MAX_ISI_MS     = 7000;
  const PVT_TIMEOUT_MS     = 1500; // no response within 1.5 s → lapse

  // Typing keystroke-dynamics thresholds (HCI literature: pauses >2 s index
  // thought interruption; gaps >15 s are usually leaving the keyboard).
  const TYPING_PAUSE_THRESHOLD_MS = 2000;
  const TYPING_IKI_MAX_MS         = 15000;

  let calibState = null;
  let calibInterval = null;
  let calibTimer    = null;
  let calibProbeTimer = null; // fine-grained timer for PVT stimulus scheduling

  function makeArithProblem() {
    const r = Math.random();
    if (r < 0.55) {
      const a = 10 + Math.floor(Math.random() * 90);
      const b = 10 + Math.floor(Math.random() * 90);
      return { text: `${a} + ${b}`, answer: a + b };
    } else if (r < 0.9) {
      let a = 10 + Math.floor(Math.random() * 90);
      let b = 10 + Math.floor(Math.random() * 90);
      if (b > a) [a, b] = [b, a];
      return { text: `${a} − ${b}`, answer: a - b };
    } else {
      const a = 2 + Math.floor(Math.random() * 8);
      const b = 10 + Math.floor(Math.random() * 90);
      return { text: `${a} × ${b}`, answer: a * b };
    }
  }

  function startCalibration() {
    if (activeSession) { alert('End your current session before calibrating.'); return; }
    if (calibState)    { return; } // already running

    calibState = {
      phase:    'intro',              // 'intro' | 'typing' | 'arith' | 'training' | 'done'
      blockIdx: -1,
      blocks:   CALIB_BLOCKS.slice(),
      allSamples: [],                 // accumulated across blocks
      blockSamples: [],               // raw per-window samples for current block
      // Current-window accumulators (diffed at window boundaries)
      typing: {
        paragraphIdx: 0,
        target:       '',
        typed:        '',
        committedTotal: 0, // chars matching target prefix, cumulative
        errorTotal:     0, // mismatches counted cumulatively (position-based)
        lastWindowCommitted: 0,
        lastWindowError:     0,
        // Keystroke-dynamics tracking. Per-window accumulators are reset
        // at every calibWindowTick. Pauses are IKIs > PAUSE_THRESHOLD_MS;
        // IKIs above IKI_MAX_MS are treated as "not really typing" and
        // excluded from the mean/variance (they contaminate signal).
        lastKeystrokeAt:       null,
        windowIkiSum:          0,
        windowIkiSumSq:        0,
        windowIkiCount:        0,
        windowPauseCount:      0,
        windowBackspaceCount:  0,
      },
      arith: {
        problem:         null,
        solvedTotal:     0,
        correctTotal:    0,
        lastWindowSolved:  0,
        lastWindowCorrect: 0,
      },
      // PVT-style probe: a dot flashes at a random interval; user presses
      // SPACE as fast as possible. Reaction time + lapse rate give the
      // cleanest possible attention label (this is the lab standard).
      probe: {
        nextStimulusAt:    0,     // epoch ms when the next dot should appear
        stimulusShownAt:   null,  // epoch ms when the current dot appeared, or null
        responded:         false, // set when user reacts to the current dot
        feedback:          '',    // transient UI text ("213 ms", "LAPSE")
        rtSum:             0,     // cumulative across the whole block
        rtCount:           0,
        hitCount:          0,
        missCount:         0,
        falseStartCount:   0,     // presses while no stimulus is up
        lastWindowRtSum:   0,
        lastWindowRtCount: 0,
        lastWindowHit:     0,
        lastWindowMiss:    0,
      },
      blockStartedAt: null,
      windowStartedAt: null,
    };

    // Take over tracker handlers for the duration of calibration
    let eyeMoveCount = 0;
    Tracker.onGazeChange = () => { sampleEyeMoves++; };
    Tracker.onBlink      = () => { sampleBlinks++; };
    Tracker.onFrame = (frame) => {
      if (!frame) return;
      if (frame.gazePoint) { sampleGazeX.push(frame.gazePoint.nx); sampleGazeY.push(frame.gazePoint.ny); }
      if (typeof frame.ear === 'number' && !Number.isNaN(frame.ear)) sampleEarValues.push(frame.ear);
    };

    renderCalibOverlay();
  }

  function cancelCalibration() {
    if (!calibState) return;
    if (calibState.phase !== 'done' && calibState.phase !== 'training') {
      if (!confirm('Cancel calibration? Progress will be discarded.')) return;
    }
    if (calibInterval)   { clearInterval(calibInterval);   calibInterval   = null; }
    if (calibTimer)      { clearInterval(calibTimer);      calibTimer      = null; }
    if (calibProbeTimer) { clearInterval(calibProbeTimer); calibProbeTimer = null; }
    document.removeEventListener('keydown', onCalibProbeKey, true);
    calibState = null;
    const overlay = document.getElementById('calibOverlay');
    if (overlay) overlay.remove();
    // Clear tracker handlers we took over
    Tracker.onGazeChange = null;
    Tracker.onBlink      = null;
    Tracker.onFrame      = null;
    // Reset per-window accumulators
    sampleEyeMoves = 0; sampleBlinks = 0;
    sampleEarValues = []; sampleGazeX = []; sampleGazeY = [];
    renderCalibStatus();
  }

  function renderCalibOverlay() {
    let overlay = document.getElementById('calibOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'calibOverlay';
      overlay.className = 'calib-overlay';
      overlay.innerHTML = `
        <div class="calib-box">
          <div class="calib-header">
            <span class="calib-title" id="calibTitle">CALIBRATION</span>
            <button class="calib-cancel" onclick="SessionManager.cancelCalibration()">✕</button>
          </div>
          <div class="calib-progress">
            <div class="calib-progress-bar"><div id="calibProgressFill" class="calib-progress-fill"></div></div>
            <div class="calib-progress-meta">
              <span id="calibBlockLabel">—</span>
              <span id="calibTimeLabel">—</span>
            </div>
          </div>
          <div class="calib-body" id="calibBody"></div>
        </div>`;
      document.body.appendChild(overlay);
    }
    renderCalibBody();
  }

  function renderCalibBody() {
    const body = document.getElementById('calibBody');
    if (!body) return;
    const phase = calibState.phase;

    if (phase === 'intro') {
      body.innerHTML = `
        <div class="calib-card">
          <h3>BUILD YOUR ATTENTION FINGERPRINT</h3>
          <p>We'll learn what <span class="calib-emph">your</span> focused behavior looks like on camera by measuring it while you do real cognitive work — not by guessing from generic rules.</p>
          <p><b>How it works:</b></p>
          <ul>
            <li><b>Block 1 · Typing (5 min)</b> — transcribe short paragraphs.</li>
            <li><b>Block 2 · Attention probe (5 min)</b> — a dot flashes at random intervals; press <b>SPACE</b> as fast as you can.</li>
          </ul>
          <p>Reaction time on the probe directly measures attention lapses (this is the lab-standard PVT task). Combined with your typing speed + accuracy, it gives us <span class="calib-emph">objective labels</span> that we correlate with your webcam signals (gaze, blink, head) to train a personal logistic-regression model in your browser.</p>
          <p style="color:var(--muted);font-size:0.8rem;">Nothing leaves your device. Webcam stays on.</p>
          <div style="margin-top:16px">
            <button class="calib-primary" onclick="SessionManager.calibNext()">START BLOCK 1 &rarr;</button>
            <button class="calib-secondary" onclick="SessionManager.cancelCalibration()">CANCEL</button>
          </div>
        </div>`;
      setEl('calibBlockLabel', 'READY');
      setEl('calibTimeLabel',  '0 / 2 BLOCKS');
      const fill = document.getElementById('calibProgressFill');
      if (fill) fill.style.width = '0%';
    }
    else if (phase === 'typing') {
      body.innerHTML = `
        <div class="calib-card">
          <h3>BLOCK 1 · TYPING</h3>
          <p style="font-size:0.82rem;color:var(--muted);margin-bottom:8px">Type the paragraph exactly as shown. Move on naturally when finished — the block continues until the timer ends.</p>
          <div class="calib-target" id="calibTarget"></div>
          <textarea class="calib-input" id="calibTypingInput" placeholder="Start typing…" spellcheck="false" autocomplete="off"></textarea>
          <div style="margin-top:6px;font-family:var(--mono);font-size:0.68rem;color:var(--muted);letter-spacing:0.08em">
            <span id="calibTypingStats">0 chars · 0 errors</span>
            <span style="float:right" id="calibTypingPar">Paragraph 1 / ${CALIB_PARAGRAPHS.length}</span>
          </div>
        </div>`;
      calibTypingShowParagraph();
      const inp = document.getElementById('calibTypingInput');
      if (inp) {
        inp.addEventListener('input', onCalibTypingInput);
        setTimeout(() => inp.focus(), 60);
      }
    }
    else if (phase === 'arith') {
      body.innerHTML = `
        <div class="calib-card">
          <h3>BLOCK 2 · ARITHMETIC</h3>
          <p style="font-size:0.82rem;color:var(--muted);margin-bottom:8px">Solve mentally. Press Enter to submit. Skip by pressing Enter with no input — you'll get a new problem.</p>
          <div class="calib-arith-wrap">
            <div class="calib-arith-prompt" id="calibArithPrompt">—</div>
            <input type="text" inputmode="numeric" class="calib-arith-input" id="calibArithInput" autocomplete="off" />
            <div class="calib-arith-feedback" id="calibArithFeedback"></div>
            <div class="calib-arith-stats" id="calibArithStats">Solved: <b>0</b> · Correct: <b>0</b></div>
          </div>
        </div>`;
      calibArithShowProblem();
      const inp = document.getElementById('calibArithInput');
      if (inp) {
        inp.addEventListener('keydown', onCalibArithKey);
        setTimeout(() => inp.focus(), 60);
      }
    }
    else if (phase === 'probe') {
      body.innerHTML = `
        <div class="calib-card">
          <h3>BLOCK 2 · ATTENTION PROBE</h3>
          <p style="font-size:0.82rem;color:var(--muted);margin-bottom:8px">A dot will flash at random intervals (2 – 7&nbsp;s). Press <b>SPACE</b> as fast as you can when you see it. Keep your eyes on the target area — don't look away.</p>
          <div class="calib-probe-wrap" id="calibProbeWrap" tabindex="0">
            <div class="calib-probe-target" id="calibProbeTarget"></div>
            <div class="calib-probe-hint" id="calibProbeHint">WAIT FOR THE DOT…</div>
            <div class="calib-probe-feedback" id="calibProbeFeedback">&nbsp;</div>
            <div class="calib-probe-stats" id="calibProbeStats">Mean RT: <b>—</b> · Hits: <b>0</b> · Lapses: <b>0</b></div>
          </div>
        </div>`;
      // Schedule the first stimulus 1–2 s after block start so user can settle
      calibState.probe.nextStimulusAt = Date.now() + 1200 + Math.floor(Math.random() * 800);
      calibState.probe.stimulusShownAt = null;
      calibState.probe.responded = false;
      if (calibProbeTimer) clearInterval(calibProbeTimer);
      calibProbeTimer = setInterval(calibProbeTick, 50);
      document.addEventListener('keydown', onCalibProbeKey, true);
      setTimeout(() => {
        const wrap = document.getElementById('calibProbeWrap');
        if (wrap) wrap.focus();
      }, 60);
    }
    else if (phase === 'training') {
      body.innerHTML = `
        <div class="calib-training-wrap">
          <div class="calib-spinner"></div>
          <h3 style="font-family:var(--mono);letter-spacing:0.1em;color:var(--purple);font-size:0.95rem">TRAINING YOUR PERSONAL MODEL…</h3>
          <p style="color:var(--muted);font-size:0.85rem;margin-top:8px">Fitting logistic regression on <b id="calibTrainN">—</b> labeled windows.</p>
        </div>`;
      setEl('calibBlockLabel', 'TRAINING');
      setEl('calibTimeLabel',  '');
      setTimeout(finalizeCalibration, 200); // allow paint
    }
    else if (phase === 'done') {
      const m = calibState.trainResult && calibState.trainResult.model;
      const cal = m ? m.calibration : null;
      const r2Held = cal && typeof cal.r2_val === 'number' ? cal.r2_val
                   : cal && typeof cal.r2 === 'number' ? cal.r2 : null;
      const weak = r2Held == null || r2Held < 0.1;
      const blendPct = Math.round(Math.max(0, Math.min(1, r2Held || 0)) * 100);
      const headline = weak
        ? `<h3 style="color:var(--yellow, #e0b84a)">CALIBRATION SAVED — WEAK SIGNAL</h3>`
        : `<h3 style="color:var(--green)">CALIBRATION COMPLETE</h3>`;
      const intro = weak
        ? `<p>Your personal model is installed as a <b>weak prior</b>: it didn't find a strong webcam↔performance link in this session (R² ${r2Held != null ? r2Held.toFixed(2) : '—'}). We'll mostly use the classic score for now (${100 - blendPct}%), and refine your model online from the <b>"focused / distracted"</b> buttons you tap after each session.</p>`
        : `<p>Your personal attention model is live. Every future session will be scored against your own fingerprint — ${blendPct}% personal + ${100 - blendPct}% classic (confidence-blended).</p>`;
      body.innerHTML = `
        <div class="calib-card" style="text-align:center">
          ${headline}
          ${intro}
          <div class="calib-done-stats">
            <div class="calib-done-stat">
              <span class="calib-done-stat-val">${cal ? cal.nWindows : 0}</span>
              <span class="calib-done-stat-label">WINDOWS</span>
            </div>
            <div class="calib-done-stat">
              <span class="calib-done-stat-val">${r2Held != null ? r2Held.toFixed(2) : '—'}</span>
              <span class="calib-done-stat-label">R²${cal && typeof cal.r2_val === 'number' ? ' (HELD-OUT)' : ''}</span>
            </div>
            <div class="calib-done-stat">
              <span class="calib-done-stat-val">${cal ? Math.round(cal.meanPerf * 100) + '%' : '—'}</span>
              <span class="calib-done-stat-label">MEAN PERF</span>
            </div>
          </div>
          <p style="color:var(--muted);font-size:0.8rem">${weak
            ? 'Tip: after each real session, use the ✓ focused / ✗ distracted buttons on the report. Every tap refines your model.'
            : 'R² measures how well your webcam behavior explains your task performance on <b>held-out</b> windows. Even 0.2–0.4 is meaningful with this little data.'}</p>
          <div style="margin-top:16px">
            <button class="calib-primary" onclick="SessionManager.cancelCalibration()">CLOSE</button>
          </div>
        </div>`;
      setEl('calibBlockLabel', 'DONE');
      setEl('calibTimeLabel',  '2 / 2 BLOCKS');
      const fill = document.getElementById('calibProgressFill');
      if (fill) fill.style.width = '100%';
    }
  }

  function calibNext() {
    if (!calibState) return;
    calibState.blockIdx++;
    if (calibState.blockIdx >= calibState.blocks.length) {
      calibState.phase = 'training';
      renderCalibBody();
      return;
    }
    const block = calibState.blocks[calibState.blockIdx];
    calibState.phase = block;
    calibState.blockSamples = [];
    calibState.blockStartedAt  = Date.now();
    calibState.windowStartedAt = Date.now();
    // Fresh per-window accumulators
    sampleEyeMoves  = 0;
    sampleBlinks    = 0;
    sampleEarValues = [];
    sampleGazeX     = [];
    sampleGazeY     = [];
    if (block === 'typing') {
      const t = calibState.typing;
      t.paragraphIdx        = 0;
      t.target              = CALIB_PARAGRAPHS[0];
      t.typed               = '';
      t.committedTotal      = 0;
      t.errorTotal          = 0;
      t.lastWindowCommitted = 0;
      t.lastWindowError     = 0;
      t.lastKeystrokeAt     = null;
      t.windowIkiSum        = 0;
      t.windowIkiSumSq      = 0;
      t.windowIkiCount      = 0;
      t.windowPauseCount    = 0;
      t.windowBackspaceCount = 0;
    }
    if (block === 'arith') {
      calibState.arith.problem        = null;
      calibState.arith.solvedTotal    = 0;
      calibState.arith.correctTotal   = 0;
      calibState.arith.lastWindowSolved  = 0;
      calibState.arith.lastWindowCorrect = 0;
    }
    if (block === 'probe') {
      const pr = calibState.probe;
      pr.nextStimulusAt    = Date.now() + 1200 + Math.floor(Math.random() * 800);
      pr.stimulusShownAt   = null;
      pr.responded         = false;
      pr.feedback          = '';
      pr.rtSum             = 0;
      pr.rtCount           = 0;
      pr.hitCount          = 0;
      pr.missCount         = 0;
      pr.falseStartCount   = 0;
      pr.lastWindowRtSum   = 0;
      pr.lastWindowRtCount = 0;
      pr.lastWindowHit     = 0;
      pr.lastWindowMiss    = 0;
    }
    renderCalibBody();
    updateCalibProgress();

    // 10s window sampler for this block
    if (calibInterval) clearInterval(calibInterval);
    calibInterval = setInterval(calibWindowTick, SAMPLE_INTERVAL_MS);
    // 1s UI timer
    if (calibTimer) clearInterval(calibTimer);
    calibTimer = setInterval(updateCalibProgress, 1000);
  }

  function updateCalibProgress() {
    if (!calibState || !calibState.blockStartedAt) return;
    const elapsed = Math.floor((Date.now() - calibState.blockStartedAt) / 1000);
    const remaining = Math.max(0, BLOCK_DURATION_SEC - elapsed);
    // Overall progress across all blocks
    const blocksDone = calibState.blockIdx;
    const blockFrac  = Math.min(1, elapsed / BLOCK_DURATION_SEC);
    const overall    = (blocksDone + blockFrac) / calibState.blocks.length;
    const fill = document.getElementById('calibProgressFill');
    if (fill) fill.style.width = Math.round(overall * 100) + '%';
    setEl('calibBlockLabel',
      `BLOCK ${calibState.blockIdx + 1} / ${calibState.blocks.length} · ${calibState.phase.toUpperCase()}`);
    setEl('calibTimeLabel', formatDuration(remaining) + ' LEFT');

    if (elapsed >= BLOCK_DURATION_SEC) {
      // Block is up — finalize this block and advance
      clearInterval(calibInterval); calibInterval = null;
      clearInterval(calibTimer);    calibTimer    = null;
      if (calibProbeTimer) { clearInterval(calibProbeTimer); calibProbeTimer = null; }
      document.removeEventListener('keydown', onCalibProbeKey, true);
      // Capture any remaining partial window
      if (Date.now() - calibState.windowStartedAt > 1500) calibWindowTick(true);
      finalizeBlockLabels();
      // Flush block samples into accumulator
      calibState.allSamples = calibState.allSamples.concat(calibState.blockSamples);
      calibState.blockSamples = [];
      calibNext();
    }
  }

  // Called every 10s during a calibration block to record a feature vector
  // plus raw per-window performance. Labels are computed later per-block.
  function calibWindowTick(isFinal) {
    if (!calibState) return;
    const extras = computeWindowExtras();
    const blinkRate = Tracker.getBlinkRate();
    const headScore = Tracker.getHeadScore();
    const features = buildFeatureVector(sampleEyeMoves, blinkRate, headScore, extras);

    // Per-window raw perf inputs (block-specific)
    let speedRaw = 0, accuracyRaw = 0, engaged = 1;
    let typingMetrics = null;
    if (calibState.phase === 'typing') {
      const t = calibState.typing;
      const dCommitted = t.committedTotal - t.lastWindowCommitted;
      const dError     = t.errorTotal     - t.lastWindowError;
      t.lastWindowCommitted = t.committedTotal;
      t.lastWindowError     = t.errorTotal;
      speedRaw    = dCommitted;                                 // chars committed
      accuracyRaw = dCommitted > 0 ? dCommitted / (dCommitted + dError) : 0;

      // Keystroke-dynamics features for this window
      const n = t.windowIkiCount;
      const ikiMean = n > 0 ? (t.windowIkiSum / n) : null;
      let ikiCV = null;
      if (n >= 2 && ikiMean && ikiMean > 0) {
        const variance = (t.windowIkiSumSq / n) - (ikiMean * ikiMean);
        ikiCV = Math.sqrt(Math.max(0, variance)) / ikiMean;
      }
      const secs = SAMPLE_INTERVAL_MS / 1000;
      typingMetrics = {
        ikiMean,
        ikiCV,
        pauseRate:     t.windowPauseCount     / secs,
        backspaceRate: t.windowBackspaceCount / secs,
      };
      // Reset per-window keystroke accumulators
      t.windowIkiSum         = 0;
      t.windowIkiSumSq       = 0;
      t.windowIkiCount       = 0;
      t.windowPauseCount     = 0;
      t.windowBackspaceCount = 0;

      if (dCommitted < 5) engaged = 0; // not really typing — low engagement
    } else if (calibState.phase === 'arith') {
      const a = calibState.arith;
      const dSolved  = a.solvedTotal  - a.lastWindowSolved;
      const dCorrect = a.correctTotal - a.lastWindowCorrect;
      a.lastWindowSolved  = a.solvedTotal;
      a.lastWindowCorrect = a.correctTotal;
      speedRaw    = dSolved;
      accuracyRaw = dSolved > 0 ? dCorrect / dSolved : 0;
      if (dSolved < 1) engaged = 0;
    } else if (calibState.phase === 'probe') {
      // PVT window label: speed ∝ (PVT_TIMEOUT − meanRT)  (higher = faster),
      // accuracy = hits / (hits + lapses).
      const pr = calibState.probe;
      const dRtSum  = pr.rtSum    - pr.lastWindowRtSum;
      const dRtN    = pr.rtCount  - pr.lastWindowRtCount;
      const dHit    = pr.hitCount - pr.lastWindowHit;
      const dMiss   = pr.missCount - pr.lastWindowMiss;
      pr.lastWindowRtSum   = pr.rtSum;
      pr.lastWindowRtCount = pr.rtCount;
      pr.lastWindowHit     = pr.hitCount;
      pr.lastWindowMiss    = pr.missCount;
      const meanRt = dRtN > 0 ? dRtSum / dRtN : PVT_TIMEOUT_MS;
      speedRaw    = Math.max(0, PVT_TIMEOUT_MS - meanRt); // ms saved under timeout
      accuracyRaw = (dHit + dMiss) > 0 ? dHit / (dHit + dMiss) : 0;
      // No stimulus presented in this window → treat as unengaged (rare; 10s ≥ max ISI)
      if ((dHit + dMiss) === 0) engaged = 0;
    }

    calibState.blockSamples.push({
      block:       calibState.phase,
      features,
      speedRaw,
      accuracyRaw,
      engaged,
      typingMetrics, // null for non-typing blocks
      perf:        null, // filled at block-end by finalizeBlockLabels
    });

    // Reset per-window accumulators
    sampleEyeMoves  = 0;
    sampleBlinks    = 0;
    sampleEarValues = [];
    sampleGazeX     = [];
    sampleGazeY     = [];
    calibState.windowStartedAt = Date.now();
  }

  // Turn per-window raw signals into a soft [0,1] label per window.
  //
  // Method: for each block, build a list of focus-correlated signals with a
  // sign (+1 = higher is better, −1 = lower is better). Z-score each within
  // the block, weight, sum → composite. Percentile-rank the composite to
  // spread labels uniformly across [0.05, 0.95] — this is the fix that
  // rescued the logistic regression from collapsing near 0.5.
  //
  // Typing uses 5 signals (speed, accuracy, IKI mean, IKI CV, pause rate)
  // so the webcam model has a richer focus target than speed+accuracy alone.
  // Keystroke-dynamics features capture the difference between a fast-but-
  // autopilot typist and a slow-but-engaged one — a dimension the raw
  // char-count completely misses.
  function finalizeBlockLabels() {
    const engaged = calibState.blockSamples.filter(s => s.engaged === 1);
    if (engaged.length === 0) {
      calibState.blockSamples.forEach(s => { s.perf = 0.1; });
      return;
    }

    // Signal definitions per block. Each entry: get(sample) → number|null,
    // sign ∈ {+1, −1}, optional weight (default 1).
    let signalDefs;
    if (calibState.phase === 'typing') {
      signalDefs = [
        { get: s => s.speedRaw,                                                sign: +1 },
        { get: s => s.accuracyRaw,                                             sign: +1 },
        { get: s => s.typingMetrics ? s.typingMetrics.ikiMean   : null,        sign: -1 },
        { get: s => s.typingMetrics ? s.typingMetrics.ikiCV     : null,        sign: -1 },
        { get: s => s.typingMetrics ? s.typingMetrics.pauseRate : null,        sign: -1 },
      ];
    } else if (calibState.phase === 'probe') {
      signalDefs = [
        { get: s => s.speedRaw,    sign: +1, weight: 0.7 }, // PVT RT (already encoded as timeout−RT)
        { get: s => s.accuracyRaw, sign: +1, weight: 0.3 }, // hit rate
      ];
    } else {
      signalDefs = [
        { get: s => s.speedRaw,    sign: +1 },
        { get: s => s.accuracyRaw, sign: +1 },
      ];
    }

    // Accumulate z-scored composite per engaged sample. Missing values
    // (e.g. a typing window with fewer than 2 keystrokes → no IKI) are
    // treated as a zero contribution from that signal, so the sample is
    // ranked against the others using its available signals.
    const composite = new Array(engaged.length).fill(0);
    for (const sig of signalDefs) {
      const raw = engaged.map(sig.get);
      const valid = raw.filter(v => typeof v === 'number' && !Number.isNaN(v));
      if (valid.length < 3) continue; // not enough data to z-score meaningfully
      const m = valid.reduce((a, b) => a + b, 0) / valid.length;
      const sd = Math.sqrt(valid.reduce((a, b) => a + (b - m) ** 2, 0) / valid.length) || 1;
      const w = typeof sig.weight === 'number' ? sig.weight : 1;
      for (let i = 0; i < engaged.length; i++) {
        const v = raw[i];
        if (typeof v !== 'number' || Number.isNaN(v)) continue;
        composite[i] += sig.sign * w * ((v - m) / sd);
      }
    }

    // Percentile-rank the composite → uniform labels in [0.05, 0.95]
    const paired = engaged.map((s, i) => ({ s, c: composite[i] }));
    paired.sort((a, b) => a.c - b.c);
    const denom = Math.max(1, paired.length - 1);
    paired.forEach((item, i) => {
      item.s.perf = 0.05 + 0.9 * (i / denom);
    });

    // Idle windows stay at the low end, clearly below any engaged window
    for (const s of calibState.blockSamples) {
      if (s.engaged === 0) s.perf = 0.02;
    }
  }

  // ── Typing block interactions ──
  function calibTypingShowParagraph() {
    if (!calibState) return;
    const t = calibState.typing;
    t.target = CALIB_PARAGRAPHS[t.paragraphIdx % CALIB_PARAGRAPHS.length];
    t.typed  = '';
    const inp = document.getElementById('calibTypingInput');
    if (inp) inp.value = '';
    updateCalibTypingDisplay();
    const par = document.getElementById('calibTypingPar');
    if (par) par.textContent = `Paragraph ${t.paragraphIdx + 1} / ${CALIB_PARAGRAPHS.length}`;
  }

  function onCalibTypingInput(e) {
    if (!calibState) return;
    const t = calibState.typing;
    const v = e.target.value;
    const now = Date.now();

    // ── Keystroke dynamics (per input event ≈ one keystroke) ──
    // Inter-keystroke interval: skip the first keystroke of the block and
    // any gap that looks like "left the keyboard" (> TYPING_IKI_MAX_MS).
    if (t.lastKeystrokeAt != null) {
      const iki = now - t.lastKeystrokeAt;
      if (iki > 0 && iki < TYPING_IKI_MAX_MS) {
        t.windowIkiSum   += iki;
        t.windowIkiSumSq += iki * iki;
        t.windowIkiCount += 1;
        if (iki > TYPING_PAUSE_THRESHOLD_MS) t.windowPauseCount += 1;
      }
    }
    t.lastKeystrokeAt = now;

    // Backspace detection: buffer shrunk relative to last seen value within
    // the *same* paragraph. calibTypingShowParagraph resets t.typed='' on
    // advance, so paragraph transitions don't leak into this count.
    if (v.length < t.typed.length) {
      t.windowBackspaceCount += (t.typed.length - v.length);
    }

    // Recompute committed/error counts for this paragraph from scratch,
    // then offset by what was committed in previous paragraphs.
    const prevCommitted = t.committedTotal - countParagraphCommitted(t.typed, t.target);
    const prevErrors    = t.errorTotal     - countParagraphErrors   (t.typed, t.target);
    t.typed = v;
    const newCommitted = countParagraphCommitted(v, t.target);
    const newErrors    = countParagraphErrors   (v, t.target);
    t.committedTotal = prevCommitted + newCommitted;
    t.errorTotal     = prevErrors    + newErrors;
    updateCalibTypingDisplay();
    // Advance paragraph if (a) we've hit the end with full match, or
    // (b) the user typed past the length (they moved on)
    if (v.length >= t.target.length) {
      t.paragraphIdx++;
      calibTypingShowParagraph();
    }
  }
  function countParagraphCommitted(typed, target) {
    let n = 0;
    const len = Math.min(typed.length, target.length);
    for (let i = 0; i < len; i++) if (typed[i] === target[i]) n++;
    return n;
  }
  function countParagraphErrors(typed, target) {
    let n = 0;
    const len = Math.min(typed.length, target.length);
    for (let i = 0; i < len; i++) if (typed[i] !== target[i]) n++;
    // Extra chars beyond target count as errors too
    if (typed.length > target.length) n += typed.length - target.length;
    return n;
  }

  function updateCalibTypingDisplay() {
    const t = calibState && calibState.typing;
    if (!t) return;
    const tgt = document.getElementById('calibTarget');
    if (tgt) {
      const typed = t.typed;
      const target = t.target;
      const len = Math.min(typed.length, target.length);
      let html = '';
      for (let i = 0; i < len; i++) {
        const ch = target[i];
        const safe = ch.replace(/</g,'&lt;').replace(/>/g,'&gt;');
        if (ch === ' ') {
          // Correct typed space → bare ` ` (no span) so the browser can break
          // a line here. Incorrect space → visible middle-dot marker in red.
          html += typed[i] === ch
            ? ' '
            : `<span class="typed-bad">&middot;</span>`;
        } else {
          html += typed[i] === ch
            ? `<span class="typed-ok">${safe}</span>`
            : `<span class="typed-bad">${safe}</span>`;
        }
      }
      if (target.length > typed.length) {
        const cursorCh = target[typed.length];
        const cursorSafe = cursorCh === ' '
          ? '&nbsp;'
          : cursorCh.replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html += `<span class="typed-cursor">${cursorSafe}</span>`;
        // Remaining un-typed text: plain text so it wraps at real word boundaries.
        html += target.slice(typed.length + 1)
          .replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }
      tgt.innerHTML = html;
    }
    const stats = document.getElementById('calibTypingStats');
    if (stats) stats.textContent = `${t.committedTotal} chars · ${t.errorTotal} errors`;
  }

  // ── Arithmetic block interactions ──
  function calibArithShowProblem() {
    if (!calibState) return;
    calibState.arith.problem = makeArithProblem();
    const p = document.getElementById('calibArithPrompt');
    if (p) p.textContent = calibState.arith.problem.text + ' = ?';
    const inp = document.getElementById('calibArithInput');
    if (inp) { inp.value = ''; inp.focus(); }
    const fb = document.getElementById('calibArithFeedback');
    if (fb) { fb.textContent = ''; fb.className = 'calib-arith-feedback'; }
  }

  function onCalibArithKey(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inp = e.target;
    const raw = inp.value.trim();
    if (raw === '') {
      // Skip — new problem without counting as solved
      calibArithShowProblem();
      return;
    }
    const answer = parseInt(raw, 10);
    const ok = Number.isFinite(answer) && answer === calibState.arith.problem.answer;
    calibState.arith.solvedTotal++;
    if (ok) calibState.arith.correctTotal++;
    const fb = document.getElementById('calibArithFeedback');
    if (fb) {
      fb.textContent = ok ? '✓ CORRECT' : `✗ WAS ${calibState.arith.problem.answer}`;
      fb.className = 'calib-arith-feedback ' + (ok ? 'ok' : 'bad');
    }
    const stats = document.getElementById('calibArithStats');
    if (stats) {
      stats.innerHTML = `Solved: <b>${calibState.arith.solvedTotal}</b> · Correct: <b>${calibState.arith.correctTotal}</b>`;
    }
    // Auto-advance after a short beat so the user sees feedback
    setTimeout(() => { if (calibState && calibState.phase === 'arith') calibArithShowProblem(); }, 500);
  }

  // ── PVT attention-probe block interactions ──
  // The probe runs on a 50 ms interval (calibProbeTimer) that handles both
  // "time to show a new dot" and "time since current dot was shown".
  function calibProbeTick() {
    if (!calibState || calibState.phase !== 'probe') return;
    const pr = calibState.probe;
    const now = Date.now();
    const target = document.getElementById('calibProbeTarget');
    const hint   = document.getElementById('calibProbeHint');

    if (pr.stimulusShownAt == null) {
      // Waiting for next stimulus
      if (target) target.classList.remove('on');
      if (hint) hint.textContent = 'WAIT FOR THE DOT…';
      if (now >= pr.nextStimulusAt) {
        pr.stimulusShownAt = now;
        pr.responded = false;
        if (target) target.classList.add('on');
        if (hint) hint.textContent = 'PRESS SPACE!';
      }
    } else {
      // Stimulus is up
      const dt = now - pr.stimulusShownAt;
      if (!pr.responded && dt >= PVT_TIMEOUT_MS) {
        // Lapse
        pr.missCount++;
        pr.responded = true;
        pr.feedback = 'LAPSE';
        if (target) target.classList.remove('on');
        if (hint) hint.textContent = 'MISSED — keep going…';
        const fb = document.getElementById('calibProbeFeedback');
        if (fb) { fb.textContent = 'LAPSE'; fb.className = 'calib-probe-feedback bad'; }
        pr.stimulusShownAt = null;
        pr.nextStimulusAt = now + PVT_MIN_ISI_MS + Math.floor(Math.random() * (PVT_MAX_ISI_MS - PVT_MIN_ISI_MS));
        updateProbeStats();
      }
    }
  }

  function onCalibProbeKey(e) {
    if (!calibState || calibState.phase !== 'probe') return;
    // Ignore keys originating from text inputs (none in this phase, but safe)
    if (e.key !== ' ' && e.code !== 'Space') return;
    e.preventDefault();
    const pr = calibState.probe;
    const now = Date.now();
    if (pr.stimulusShownAt == null || pr.responded) {
      // False start — count lightly, don't derail stats
      pr.falseStartCount++;
      const fb = document.getElementById('calibProbeFeedback');
      if (fb) { fb.textContent = 'TOO EARLY'; fb.className = 'calib-probe-feedback warn'; }
      return;
    }
    const rt = now - pr.stimulusShownAt;
    pr.rtSum += rt;
    pr.rtCount++;
    pr.hitCount++;
    pr.responded = true;
    const target = document.getElementById('calibProbeTarget');
    const hint   = document.getElementById('calibProbeHint');
    if (target) target.classList.remove('on');
    if (hint) hint.textContent = 'NICE — wait for the next one…';
    const fb = document.getElementById('calibProbeFeedback');
    if (fb) {
      fb.textContent = rt + ' ms';
      fb.className = 'calib-probe-feedback ' + (rt < 400 ? 'ok' : rt < 800 ? '' : 'warn');
    }
    pr.stimulusShownAt = null;
    pr.nextStimulusAt = now + PVT_MIN_ISI_MS + Math.floor(Math.random() * (PVT_MAX_ISI_MS - PVT_MIN_ISI_MS));
    updateProbeStats();
  }

  function updateProbeStats() {
    const pr = calibState && calibState.probe;
    if (!pr) return;
    const el = document.getElementById('calibProbeStats');
    if (!el) return;
    const meanRt = pr.rtCount > 0 ? Math.round(pr.rtSum / pr.rtCount) : null;
    el.innerHTML = `Mean RT: <b>${meanRt != null ? meanRt + ' ms' : '—'}</b> · Hits: <b>${pr.hitCount}</b> · Lapses: <b>${pr.missCount}</b>`;
  }

  // ── Final: train model, save to profile, show done screen ──
  function finalizeCalibration() {
    if (!calibState) return;
    const samples = calibState.allSamples.filter(s => typeof s.perf === 'number');
    setEl('calibTrainN', String(samples.length));

    const result = trainPersonalModel(samples);
    calibState.trainResult = result;

    if (result.ok) {
      const p = loadProfile();
      p.model = result.model;
      // Store calibration samples for later online refinement
      p.calibrationSamples = samples.map(s => ({
        features: s.features.slice(),
        perf:     s.perf,
        source:   'calib',
        ts:       Date.now(),
      }));
      p.personalized = true; // make sure it's on
      saveProfile(p);
    } else {
      // Training failed — stay in whichever mode was active
      console.warn('[Calibration] training failed:', result.reason);
    }

    calibState.phase = 'done';
    renderCalibBody();
    renderCalibStatus();
  }

  // ── Idle-screen status chip: shows whether the user has a trained model ──
  function renderCalibStatus() {
    const p = loadProfile();
    let html = '';
    if (p.model && p.model.weights) {
      const cal = p.model.calibration || {};
      const r2Held = (typeof cal.r2_val === 'number') ? cal.r2_val : null;
      const r2Train = (typeof cal.r2_train === 'number') ? cal.r2_train : null;
      const r2Primary = r2Held != null ? r2Held : (typeof cal.r2 === 'number' ? cal.r2 : null);
      const r2Label = r2Held != null
        ? `R² ${r2Held.toFixed(2)} <span style="opacity:0.6">(held-out, train ${r2Train != null ? r2Train.toFixed(2) : '—'})</span>`
        : `R² ${(typeof cal.r2 === 'number' ? cal.r2.toFixed(2) : '—')}`;
      const when = p.model.trainedAt ? new Date(p.model.trainedAt).toLocaleDateString() : '';
      const blend = r2Primary != null ? Math.max(0, Math.min(1, r2Primary)) : 0;
      const blendPct = Math.round(blend * 100);
      const weak = r2Primary == null || r2Primary < 0.1;
      const headline = weak
        ? `<b style="color:var(--yellow,#e0b84a)">Personal model · weak prior</b>`
        : `<b>Personal model active</b>`;
      const weakNote = weak
        ? `<br><span style="opacity:0.8">Low calibration signal — model is a weak prior. Use the ✓ focused / ✗ distracted feedback buttons on each report to refine it online.</span>`
        : '';
      html = `
        <div class="calib-status">
          ${headline}<br>
          ${r2Label} · ${cal.nWindows || 0} windows · ${when}
          <br><span style="opacity:0.7">Live score = ${blendPct}% personal + ${100 - blendPct}% classic (confidence-blended)</span>
          ${weakNote}
          <br><span class="calib-reset" onclick="SessionManager.resetModel()">Reset model</span>
        </div>`;
    } else if (p.sessionCount >= MIN_CALIB_SESSIONS && p.personalized) {
      html = `<div class="calib-status">Using <b>unsupervised personalized</b> mode (median/MAD from past sessions). Run calibration for an objective-performance model.</div>`;
    } else {
      html = `<div class="calib-status">Using <b>classic scoring</b>. Calibrate to unlock a personal model trained from your task performance.</div>`;
    }
    ['calibStatusContainer', 'm-calibStatusContainer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
  }

  function resetModel() {
    if (!confirm('Reset your personal model? You will need to calibrate again.')) return;
    const p = loadProfile();
    p.model = null;
    p.calibrationSamples = [];
    saveProfile(p);
    renderCalibStatus();
  }

  // ── Export / Import: no backend, so users back up their fingerprint locally ──
  function exportModel() {
    const p = loadProfile();
    if (!p.model || !p.model.weights) {
      alert('No trained model to export yet. Run calibration first.');
      return;
    }
    const payload = {
      app:        'eyetrace',
      kind:       'personal-model',
      version:    1,
      exportedAt: new Date().toISOString(),
      model:      p.model,
      calibrationSamples: p.calibrationSamples || [],
      profileStats: {
        sessionCount:     p.sessionCount     || 0,
        eyeMovesSamples:  p.eyeMovesSamples  || [],
        blinkRateSamples: p.blinkRateSamples || [],
        headScoreSamples: p.headScoreSamples || [],
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href     = url;
    a.download = `ifocus-fingerprint-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function importModel() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = 'application/json,.json';
    input.onchange = (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        let data;
        try { data = JSON.parse(e.target.result); }
        catch (err) { alert('Import failed: not a valid JSON file.'); return; }

        if (!data || data.app !== 'eyetrace' || data.kind !== 'personal-model') {
          alert('Import failed: file does not look like an iFocus fingerprint export.');
          return;
        }
        const m = data.model;
        if (!m || !Array.isArray(m.weights) || !Array.isArray(m.mu) || !Array.isArray(m.sigma)
            || m.weights.length !== m.mu.length || m.weights.length !== m.sigma.length) {
          alert('Import failed: model payload is malformed.');
          return;
        }
        // Accept version 1 (pre-held-out) and 2 (current). Newer majors → refuse.
        if (m.version !== 1 && m.version !== 2) {
          alert('Import failed: unsupported model version (' + m.version + ').');
          return;
        }

        const p = loadProfile();
        const hadModel = !!(p.model && p.model.weights);
        if (hadModel && !confirm('You already have a trained model. Replace it with the imported one?')) return;

        p.model = m;
        p.calibrationSamples = Array.isArray(data.calibrationSamples) ? data.calibrationSamples : [];
        if (data.profileStats) {
          if (Array.isArray(data.profileStats.eyeMovesSamples))  p.eyeMovesSamples  = data.profileStats.eyeMovesSamples;
          if (Array.isArray(data.profileStats.blinkRateSamples)) p.blinkRateSamples = data.profileStats.blinkRateSamples;
          if (Array.isArray(data.profileStats.headScoreSamples)) p.headScoreSamples = data.profileStats.headScoreSamples;
        }
        saveProfile(p);
        renderCalibStatus();
        const cal = m.calibration || {};
        const r2Show = typeof cal.r2_val === 'number' ? cal.r2_val
                    : typeof cal.r2 === 'number' ? cal.r2 : null;
        alert('Personal model imported. R² ' +
          (r2Show != null ? r2Show.toFixed(2) : '—') +
          ' across ' + (cal.nWindows || 0) + ' windows.');
      };
      reader.readAsText(file);
    };
    input.click();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Init — wire up MediaPipe, load history
  // ─────────────────────────────────────────────────────────────────────────
  function init() {
    const mobile   = isMobile();
    const videoEl  = document.getElementById(mobile ? 'm-video'   : 'video');
    const canvasEl = document.getElementById(mobile ? 'm-overlay' : 'overlay');
    if (!videoEl || !canvasEl) return;

    Tracker.start(videoEl, canvasEl);
    renderHistory();
    renderPresets();
    renderCalibStatus();
    showScreen('screenIdle');
  }

  // ── Auto-init when DOM is ready ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small delay to ensure MediaPipe scripts have executed
    setTimeout(init, 100);
  }

  // ── Public API ──
  return {
    start, end, newSession, clearHistory, viewSession,
    selectPreset, promptAddPreset,
    removePreset: deletePreset,
    // Calibration
    startCalibration, cancelCalibration,
    calibNext, resetModel, exportModel, importModel,
    // Post-session feedback
    feedbackOk, feedbackOff,
    // Focus-nudge — silence the current distraction-run tone
    muteNudge,
    // Full-report preview (used for re-viewing a historical session)
    previewReport: (sessionId) => {
      const sessions = loadSessions();
      const s = sessions.find(x => x.id === sessionId) || sessions[0];
      if (s) showReport(s);
    },
  };

})();
