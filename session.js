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

  // ── Session state ──
  let activeSession   = null;
  let sampleInterval  = null;
  let displayInterval = null; // fast 1s refresh for live UI
  let timerInterval   = null;
  let sessionSettings = { blink: true, head: true, threshold: 6 };

  // ── Per-sample accumulators (reset every 10s) ──
  let sampleEyeMoves  = 0;
  let sampleBlinks    = 0;

  // ─────────────────────────────────────────────────────────────────────────
  // Focus scoring
  // Returns 0–100 based on current measurements
  // ─────────────────────────────────────────────────────────────────────────
  function calcFocusScore(eyeMoves, blinkRate, headScore) {
    let score = 100;
    const threshold = sessionSettings.threshold;

    // Eye movement penalty — relative to user's threshold
    if (eyeMoves > threshold * 1.5) score -= 40;
    else if (eyeMoves > threshold)   score -= 20;
    else if (eyeMoves > threshold * 0.5) score -= 8;

    // Blink rate penalty (only if blink detection is on)
    if (sessionSettings.blink && blinkRate !== null) {
      if      (blinkRate > 35) score -= 25;
      else if (blinkRate > 25) score -= 15;
      else if (blinkRate < 6)  score -= 10;
    }

    // Head movement penalty (only if head detection is on)
    if (sessionSettings.head && headScore !== null) {
      if      (headScore > 3.0) score -= 30;
      else if (headScore > 1.5) score -= 15;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
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

    // Render charts after DOM paint
    setTimeout(() => {
      const d = document.getElementById('focusChart');
      const m = document.getElementById('m-focusChart');
      if (d) renderChart(d, session.timeline, session.duration);
      if (m) renderChart(m, session.timeline, session.duration);
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
    sessionSettings = {
      blink:     blinkToggle ? blinkToggle.checked : true,
      head:      headToggle  ? headToggle.checked  : true,
      threshold: thresh      ? +thresh.value       : 6,
    };

    // Configure tracker
    Tracker.setOptions({ blink: sessionSettings.blink, head: sessionSettings.head });
    Tracker.resetSession();

    // Wire tracker events
    let eyeMoveCount = 0;
    Tracker.onGazeChange = (dir) => {
      eyeMoveCount++;
      sampleEyeMoves++;
    };
    Tracker.onBlink = () => { sampleBlinks++; };

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
      summary:  {
        avgFocus:         0,
        minFocus:         100,
        distractionEvents:0,
        eyeMoveTotal:     0,
        totalBlinks:      0,
        headEvents:       0,
      },
    };

    sampleEyeMoves = 0;
    sampleBlinks   = 0;

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

    let elapsedSeconds = 0;
    timerInterval = setInterval(() => {
      elapsedSeconds++;
      activeSession.duration = elapsedSeconds;
      const str = formatDuration(elapsedSeconds);
      setEl('timerDisplay',   str);
      setEl('m-timerDisplay', str);
      setEl('camTimer',   str);
      setEl('m-camTimer', str);
    }, 1000);

    // ── Fast display refresh (every 0.5s) ──
    displayInterval = setInterval(() => {
      if (!activeSession) return;
      const blinkRate = Tracker.getBlinkRate();
      const headScore = Tracker.getHeadScore();
      const liveScore = calcFocusScore(sampleEyeMoves, blinkRate, headScore);
      updateLiveUI(liveScore, Tracker.currentDir, blinkRate, headScore);
    }, 500);

    // Focus sampling — every 10s record a data point to the timeline
    sampleInterval = setInterval(() => {
      if (!activeSession) return;
      const t          = activeSession.duration;
      const blinkRate  = Tracker.getBlinkRate();
      const headScore  = Tracker.getHeadScore();
      const score      = calcFocusScore(sampleEyeMoves, blinkRate, headScore);

      activeSession.timeline.push({
        t,
        score,
        eyeMoves:  sampleEyeMoves,
        blinkRate: blinkRate,
        headScore: headScore,
      });

      // Update summary stats
      activeSession.summary.eyeMoveTotal  += sampleEyeMoves;
      activeSession.summary.totalBlinks   += sampleBlinks;
      if (score < 70) activeSession.summary.distractionEvents++;
      if (score < activeSession.summary.minFocus) activeSession.summary.minFocus = score;
      if (headScore !== null && headScore > 3.0) activeSession.summary.headEvents++;

      // Reset per-sample accumulators
      sampleEyeMoves = 0;
      sampleBlinks   = 0;

    }, SAMPLE_INTERVAL_MS);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session end
  // ─────────────────────────────────────────────────────────────────────────
  function end() {
    if (!activeSession) return;

    // Stop timers
    clearInterval(sampleInterval);
    clearInterval(displayInterval);
    clearInterval(timerInterval);
    sampleInterval  = null;
    displayInterval = null;
    timerInterval   = null;

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
      const score     = calcFocusScore(sampleEyeMoves, blinkRate, headScore);
      activeSession.timeline.push({
        t:         activeSession.duration,
        score,
        eyeMoves:  sampleEyeMoves,
        blinkRate: blinkRate,
        headScore: headScore,
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
      </div>`;

    document.body.appendChild(modal);

    // Render chart inside modal
    setTimeout(() => {
      const c = document.getElementById('modalChart');
      if (c) renderChart(c, session.timeline, session.duration);
    }, 60);

    // Close on backdrop click
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
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
  return { start, end, newSession, clearHistory, viewSession };

})();
