'use strict';

const GazeMap = (() => {
  let canvas = null;
  let ctx = null;
  let w = 0;
  let h = 0;
  let rafId = null;

  const points = [];
  const MAX_AGE = 7000;
  const MAX_POINTS = 180;

  function resize() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    w = Math.max(1, rect.width);
    h = Math.max(1, rect.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function init(canvasEl) {
    canvas = canvasEl;
    resize();
    window.addEventListener('resize', resize);
    if (!rafId) rafId = requestAnimationFrame(render);
  }

  function clear() {
    points.length = 0;
    if (ctx) ctx.clearRect(0, 0, w, h);
  }

  function addPoint(gazePoint) {
    if (!canvas || !gazePoint) return;

    // Webcam-space -> screen-space approximation
    const x = gazePoint.nx * w;
    const y = gazePoint.ny * h;

    points.push({
      x,
      y,
      t: performance.now(),
      r: Math.max(w, h) * 0.12
    });

    if (points.length > MAX_POINTS) points.shift();
  }

  function render(now) {
    rafId = requestAnimationFrame(render);
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);

    const live = points.filter(p => now - p.t <= MAX_AGE);
    points.length = 0;
    points.push(...live);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const p of live) {
      const age = now - p.t;
      const life = 1 - (age / MAX_AGE);
      const alpha = 0.14 * life;

      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      grad.addColorStop(0.00, `rgba(124, 58, 237, ${alpha})`);
      grad.addColorStop(0.35, `rgba(59, 130, 246, ${alpha * 0.65})`);
      grad.addColorStop(0.70, `rgba(99, 102, 241, ${alpha * 0.22})`);
      grad.addColorStop(1.00, `rgba(99, 102, 241, 0)`);

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  return { init, addPoint, clear, resize };
})();
