'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// tracker.js — Pure measurement layer
//
// Handles all MediaPipe setup, iris/blink/head detection algorithms.
// Exposes a Tracker object with:
//   Tracker.start(videoEl, canvasEl)
//   Tracker.stop()
//   Tracker.setOptions({ blink, head })
//   Tracker.onGazeChange   — callback(dir)
//   Tracker.onBlink        — callback()
//   Tracker.onFrame        — callback({ ear, vertRatio, horizRatio, dir, headScore, blinkRate })
// ─────────────────────────────────────────────────────────────────────────────

const Tracker = (() => {

  // ── Public callbacks ──
  let onGazeChange = null;
  let onBlink      = null;
  let onFrame      = null;

  // ── Options ──
  let opts = { blink: true, head: true };

  // ── Landmark indices ──
  const LEFT_IRIS  = [468,469,470,471,472];
  const RIGHT_IRIS = [473,474,475,476,477];
  const LEFT_EYE   = [33,246,161,160,159,158,157,173,133,155,154,153,145,144,163,7];
  const RIGHT_EYE  = [362,398,384,385,386,387,388,466,263,249,390,373,374,380,381,382];

  // ── Canvas refs ──
  let video  = null;
  let canvas = null;
  let ctx    = null;

  // ── Gaze state ──
  let lastDir    = null;
  let currentDir = null;

  // ── Blink detector state ──
  const EAR_PARTIAL_THRESHOLD = 0.20;
  const BLINK_FAST_DROP       = 0.04;
  const BLINK_MAX_DURATION    = 450;
  const BLINK_SUPPRESS_MS     = 120;
  const IRIS_DOWN_THRESHOLD   = 0.04;

  let earBuffer     = [];
  let irisYBuffer   = [];
  let blinkState    = 'OPEN';
  let blinkStart    = 0;
  let suppressUntil = 0;

  // Blink rate (60s rolling window)
  const BLINK_WINDOW_MS = 60000;
  let blinkTimestamps   = [];

  // ── Head movement state ──
  const HEAD_WINDOW_MS = 5000;
  const HEAD_NOISE_FLOOR = 0.002;
  let headDisplacements = [];
  let lastNosePos       = null;

  // ── Helpers ──
  function lm(landmarks, i) {
    const p = landmarks[i];
    return { x: p.x * canvas.width, y: p.y * canvas.height };
  }

  // ── EAR computation ──
  function computeEAR(lms) {
    function ear(top, bot, left, right) {
      return Math.hypot(top.x-bot.x, top.y-bot.y) /
             Math.hypot(left.x-right.x, left.y-right.y);
    }
    const L = ear(lm(lms,159), lm(lms,145), lm(lms,33),  lm(lms,133));
    const R = ear(lm(lms,386), lm(lms,374), lm(lms,362), lm(lms,263));
    return (L + R) / 2;
  }

  // ── Vertical gaze ratio (stable eye-corner reference) ──
  function getVertGazeRatio(lms) {
    const lCL = lm(lms,33),  lCR = lm(lms,133);
    const rCL = lm(lms,362), rCR = lm(lms,263);
    const li  = lm(lms,468), ri  = lm(lms,473);

    const lW = Math.hypot(lCR.x-lCL.x, lCR.y-lCL.y);
    const rW = Math.hypot(rCR.x-rCL.x, rCR.y-rCL.y);
    const lCY = (lCL.y+lCR.y)/2, rCY = (rCL.y+rCR.y)/2;

    return ((li.y-lCY)/lW + (ri.y-rCY)/rW) / 2;
  }

  // ── Horizontal gaze ──
  function getHorizGaze(lms, leftCenter, rightCenter) {
    const lEL = lm(lms,33),  lER = lm(lms,133);
    const rEL = lm(lms,362), rER = lm(lms,263);
    const lw  = Math.hypot(lER.x-lEL.x, lER.y-lEL.y);
    const rw  = Math.hypot(rER.x-rEL.x, rER.y-rEL.y);
    const avg = ((leftCenter.x-lEL.x)/lw + (rightCenter.x-rEL.x)/rw) / 2;
    return { ratio: avg, dir: avg < 0.38 ? '→ Right' : avg > 0.62 ? '← Left' : '● Center' };
  }

  // ── Dual-signal blink classifier ──
  function classifyBlink(avgEAR, irisVertRatio) {
    const now = Date.now();
    earBuffer.push({ ear: avgEAR, time: now });
    if (earBuffer.length > 8) earBuffer.shift();
    irisYBuffer.push(irisVertRatio);
    if (irisYBuffer.length > 6) irisYBuffer.shift();

    if (now < suppressUntil) return true;

    const prevEAR  = earBuffer.length >= 4 ? earBuffer[earBuffer.length-4].ear : avgEAR;
    const dropRate = prevEAR - avgEAR;
    const avgIrisY = irisYBuffer.reduce((a,b)=>a+b,0) / irisYBuffer.length;

    if (blinkState === 'OPEN') {
      if (avgEAR < EAR_PARTIAL_THRESHOLD && dropRate > BLINK_FAST_DROP) {
        // Iris already shifted down = downward gaze, not a blink
        if (avgIrisY > IRIS_DOWN_THRESHOLD) return false;
        blinkState = 'CLOSING';
        blinkStart = now;
        return true;
      }
      return false;
    }
    if (blinkState === 'CLOSING') {
      if (now - blinkStart > BLINK_MAX_DURATION) { blinkState = 'OPEN'; return false; }
      if (avgIrisY > IRIS_DOWN_THRESHOLD * 2)    { blinkState = 'OPEN'; return false; }
      if (avgEAR > EAR_PARTIAL_THRESHOLD && dropRate < 0) {
        blinkState    = 'REOPENING';
        suppressUntil = now + BLINK_SUPPRESS_MS;
        _recordBlink();
        return true;
      }
      return true;
    }
    if (blinkState === 'REOPENING') {
      if (avgEAR > EAR_PARTIAL_THRESHOLD) blinkState = 'OPEN';
      return now < suppressUntil;
    }
    return false;
  }

  function _recordBlink() {
    const now = Date.now();
    blinkTimestamps.push(now);
    blinkTimestamps = blinkTimestamps.filter(t => now - t <= BLINK_WINDOW_MS);
    if (onBlink) onBlink();
  }

  function getBlinkRate() {
    const now     = Date.now();
    const elapsed = Math.min((now - _sessionStart) / 1000, 60);
    blinkTimestamps = blinkTimestamps.filter(t => now - t <= BLINK_WINDOW_MS);
    if (elapsed < 8) return null;
    return Math.round((blinkTimestamps.length / elapsed) * 60);
  }

  // ── Head movement ──
  function trackHead(lms) {
    const nose  = lms[4];
    const lEye  = lms[33], rEye = lms[263];
    const scale = Math.hypot(lEye.x-rEye.x, lEye.y-rEye.y);
    if (scale < 0.01) return;

    if (lastNosePos) {
      const dx    = (nose.x - lastNosePos.x) / scale;
      const dy    = (nose.y - lastNosePos.y) / scale;
      const delta = Math.hypot(dx, dy);
      if (delta > HEAD_NOISE_FLOOR) {
        const now = Date.now();
        headDisplacements.push({ delta, time: now });
        headDisplacements = headDisplacements.filter(d => now-d.time <= HEAD_WINDOW_MS);
      }
    }
    lastNosePos = { x: nose.x, y: nose.y };
  }

  function getHeadScore() {
    const now = Date.now();
    headDisplacements = headDisplacements.filter(d => now-d.time <= HEAD_WINDOW_MS);
    return headDisplacements.reduce((s,d) => s+d.delta, 0);
  }

  // ── Drawing ──
  function drawEyeOutline(lms, indices) {
    ctx.beginPath();
    const f = lm(lms, indices[0]);
    ctx.moveTo(f.x, f.y);
    for (let i=1; i<indices.length; i++) { const p=lm(lms,indices[i]); ctx.lineTo(p.x,p.y); }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawIris(lms, indices, color) {
    const center = lm(lms, indices[0]);
    const edge   = lm(lms, indices[1]);
    const radius = Math.hypot(center.x-edge.x, center.y-edge.y);

    ctx.beginPath();
    ctx.arc(center.x, center.y, radius+5, 0, Math.PI*2);
    ctx.strokeStyle = color + '22'; ctx.lineWidth = 8; ctx.stroke();

    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI*2);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();

    ctx.beginPath();
    ctx.arc(center.x, center.y, 3, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.fill();

    const s = 8;
    ctx.strokeStyle = color + '88'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(center.x-radius-s, center.y); ctx.lineTo(center.x-radius+4, center.y);
    ctx.moveTo(center.x+radius-4, center.y); ctx.lineTo(center.x+radius+s, center.y);
    ctx.moveTo(center.x, center.y-radius-s); ctx.lineTo(center.x, center.y-radius+4);
    ctx.moveTo(center.x, center.y+radius-4); ctx.lineTo(center.x, center.y+radius+s);
    ctx.stroke();

    return { center, radius };
  }

  // ── Session start time (for blink rate normalization) ──
  let _sessionStart = Date.now();

  // ── MediaPipe ──
  let faceMesh = null;
  let camera   = null;
  let running  = false;

  function onResults(results) {
    if (!canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) {
      _setStatus('NO FACE', false);
      return;
    }

    const lms       = results.multiFaceLandmarks[0];
    const avgEAR    = computeEAR(lms);
    const vertRatio = getVertGazeRatio(lms);

    // Debug strip — update desktop and mobile elements
    function dbg(id, text, color) {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      if (color) el.style.color = color;
    }
    const ratioColor = vertRatio > 0.08 ? '#fb923c' : vertRatio < -0.08 ? '#f472b6' : '#00e5c3';
    dbg('dbgRatio', vertRatio.toFixed(3), ratioColor);
    dbg('dbgEar',   avgEAR.toFixed(3));

    // Blink classification
    const isBlink = opts.blink ? classifyBlink(avgEAR, vertRatio) : false;
    const blinkText = isBlink ? blinkState : 'none';
    dbg('dbgBlock', blinkText);

    if (isBlink) {
      _setStatus('BLINK', true);
      drawEyeOutline(lms, LEFT_EYE);
      drawEyeOutline(lms, RIGHT_EYE);
      return;
    }

    _setStatus('TRACKING', true);
    drawEyeOutline(lms, LEFT_EYE);
    drawEyeOutline(lms, RIGHT_EYE);

    const left  = drawIris(lms, LEFT_IRIS,  '#00e5c3');
    const right = drawIris(lms, RIGHT_IRIS, '#9d6ef8');

    // Gaze direction
    const { ratio: horizRatio, dir: horizDir } = getHorizGaze(lms, left.center, right.center);
    const vert = vertRatio < -0.08 ? '↑ Up' : vertRatio > 0.08 ? '↓ Down' : null;
    const dir  = vert ?? horizDir;

    const dg = document.getElementById('dbgGaze');
    if (dg) dg.textContent = dir;

    if (dir !== lastDir) {
      lastDir = dir;
      if (onGazeChange) onGazeChange(dir);
    }
    currentDir = dir;

    // Head tracking
    if (opts.head) trackHead(lms);

    // Approximate gaze point in normalized [0,1] screen coords,
    // using the average iris landmark. Horizontal is flipped because
    // MediaPipe delivers a mirrored front-camera image.
    const iL = lms[468];
    const iR = lms[473];
    const gazePoint = {
      nx: 1 - (iL.x + iR.x) / 2,
      ny: (iL.y + iR.y) / 2,
    };

    // Fire onFrame with all current measurements
    if (onFrame) {
      onFrame({
        ear:        avgEAR,
        vertRatio:  vertRatio,
        horizRatio: horizRatio,
        dir:        dir,
        gazePoint:  gazePoint,
        headScore:  opts.head  ? getHeadScore()   : null,
        blinkRate:  opts.blink ? getBlinkRate()   : null,
      });
    }
  }

  function _setStatus(text, active) {
    ['statusPill','m-statusPill'].forEach(id => {
      const pill = document.getElementById(id);
      if (pill) pill.classList.toggle('active', active);
    });
    ['statusText','m-statusText'].forEach(id => {
      const span = document.getElementById(id);
      if (span) span.textContent = text;
    });
  }

  // ── Public API ──
  return {
    start(videoEl, canvasEl) {
      video  = videoEl;
      canvas = canvasEl;
      ctx    = canvas.getContext('2d');
      _sessionStart = Date.now();
      blinkTimestamps   = [];
      headDisplacements = [];
      lastNosePos       = null;
      earBuffer         = [];
      irisYBuffer       = [];
      blinkState        = 'OPEN';
      running           = true;

      faceMesh = new FaceMesh({
        locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
      });
      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      faceMesh.onResults(onResults);

      camera = new Camera(video, {
        onFrame: async () => {
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width  = video.videoWidth  || 640;
            canvas.height = video.videoHeight || 480;
          }
          if (running) await faceMesh.send({ image: video });
        },
        width: 640, height: 480,
        facingMode: 'user',
      });

      camera.start().then(() => _setStatus('CAMERA ON', true));
    },

    stop() {
      running = false;
      if (camera) { camera.stop(); camera = null; }
      if (faceMesh) { faceMesh.close(); faceMesh = null; }
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
      _setStatus('READY', false);
    },

    resetSession() {
      _sessionStart     = Date.now();
      blinkTimestamps   = [];
      headDisplacements = [];
      lastNosePos       = null;
      earBuffer         = [];
      irisYBuffer       = [];
      blinkState        = 'OPEN';
      lastDir           = null;
    },

    setOptions(o) {
      opts = { ...opts, ...o };
    },

    getBlinkRate,
    getHeadScore,
    get currentDir() { return currentDir; },

    set onGazeChange(fn) { onGazeChange = fn; },
    set onBlink(fn)      { onBlink = fn; },
    set onFrame(fn)      { onFrame = fn; },
  };

})();
