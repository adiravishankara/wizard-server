"use strict";
/* Points journey: cumulative score per player across hands, hand-written SVG. */

const PointsChart = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const MS_PER_HAND = 400;

  const el = (tag, attrs = {}, parent = null) => {
    const node = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    if (parent) parent.appendChild(node);
    return node;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function niceStep(span, target) {
    const raw = span / Math.max(1, target);
    const mag = 10 ** Math.floor(Math.log10(raw || 1));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
    return 10 * mag;
  }

  /* Spread end labels so they never overlap; keeps them near their line. */
  function spread(items, gap, lo, hi) {
    const sorted = [...items].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
    }
    const over = sorted.length ? sorted[sorted.length - 1].y - hi : 0;
    if (over > 0) sorted.forEach((s) => { s.y -= over; });
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (sorted[i + 1].y - sorted[i].y < gap) sorted[i].y = sorted[i + 1].y - gap;
    }
    if (sorted.length && sorted[0].y < lo) {
      const shift = lo - sorted[0].y;
      sorted.forEach((s) => { s.y += shift; });
    }
  }

  /* series: [{name, hue, points: [..], totals: [..]}], one entry per hand. */
  function mount(root, series, opts = {}) {
    const hands = Math.max(0, ...series.map((s) => s.totals.length));
    root.innerHTML = "";
    root.classList.add("pc");
    if (!hands) return null;

    const head = document.createElement("div");
    head.className = "pc-head";
    head.innerHTML = `<span class="pc-title">${esc(opts.title || "Points journey")}</span>
      <span class="pc-hand" aria-live="off"></span>
      <button type="button" class="ghost pc-replay" aria-label="Replay">↻ Replay</button>`;
    root.appendChild(head);
    const wrap = document.createElement("div");
    wrap.className = "pc-wrap";
    root.appendChild(wrap);
    const tip = document.createElement("div");
    tip.className = "pc-tip hidden";
    wrap.appendChild(tip);

    const W = Math.max(280, Math.round(wrap.clientWidth || root.clientWidth || 600));
    const compact = W < 520;
    const H = opts.height || (compact ? 230 : W > 760 ? 330 : 280);
    const pad = { l: compact ? 34 : 44, r: compact ? 74 : 104, t: 14, b: 26 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;

    const all = series.flatMap((s) => s.totals).concat([0]);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (hi - lo < 40) { hi += 20; lo -= 20; }
    const step = niceStep(hi - lo, compact ? 4 : 5);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const x = (h) => pad.l + (h / hands) * iw;
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;

    const svg = el("svg", {
      viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "pc-svg", role: "img",
      "aria-label": `${opts.title || "Points journey"}: cumulative score for each player over ${hands} hands`,
    }, wrap);

    const grid = el("g", { class: "pc-grid" }, svg);
    for (let v = lo; v <= hi + 1e-9; v += step) {
      el("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: v === 0 ? "pc-zero" : "pc-gridline" }, grid);
      const t = el("text", { x: pad.l - 6, y: y(v) + 4, class: "pc-ylab", "text-anchor": "end" }, grid);
      t.textContent = String(v);
    }
    const every = Math.max(1, Math.ceil(hands / Math.floor(iw / (compact ? 26 : 34))));
    for (let h = 1; h <= hands; h++) {
      if (h !== hands && (h % every || hands - h < Math.max(2, every * 0.75))) continue;
      const t = el("text", { x: x(h), y: H - 8, class: "pc-xlab", "text-anchor": "middle" }, grid);
      t.textContent = String(h);
    }

    const guide = el("line", { y1: pad.t, y2: pad.t + ih, class: "pc-guide", visibility: "hidden" }, svg);
    const lines = series.map((s) => {
      const g = el("g", { class: "pc-series", style: `--hue:${s.hue}` }, svg);
      const path = el("path", { class: "pc-line", d: "" }, g);
      const dot = el("circle", { class: "pc-dot", r: compact ? 3.5 : 4 }, g);
      const label = el("text", { class: "pc-label", "dominant-baseline": "middle" }, g);
      const maxChars = compact ? 7 : 11;
      const short = s.name.length > maxChars ? `${s.name.slice(0, maxChars - 1)}…` : s.name;
      label.innerHTML = `<tspan class="pc-label-name">${esc(short)}</tspan><tspan class="pc-label-total" dx="4"></tspan>`;
      const marks = el("g", { class: "pc-marks" }, g);
      return { s, path, dot, label, marks };
    });

    const valueAt = (s, t) => {
      if (t <= 0) return 0;
      const i = Math.floor(t);
      const a = i === 0 ? 0 : s.totals[Math.min(i, s.totals.length) - 1];
      if (i >= s.totals.length) return s.totals[s.totals.length - 1];
      const b = s.totals[i];
      return a + (b - a) * (t - i);
    };

    function draw(t) {
      const ends = [];
      lines.forEach((ln) => {
        const pts = [[x(0), y(0)]];
        const whole = Math.min(Math.floor(t), ln.s.totals.length);
        for (let h = 1; h <= whole; h++) pts.push([x(h), y(ln.s.totals[h - 1])]);
        if (t > whole && whole < ln.s.totals.length) pts.push([x(t), y(valueAt(ln.s, t))]);
        ln.path.setAttribute("d", pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(""));
        const [hx, hy] = pts[pts.length - 1];
        ln.dot.setAttribute("cx", hx);
        ln.dot.setAttribute("cy", hy);
        ln.label.querySelector(".pc-label-total").textContent = String(Math.round(valueAt(ln.s, Math.min(t, ln.s.totals.length))));
        ends.push({ ln, x: hx, y: hy });
      });
      spread(ends, compact ? 13 : 15, pad.t + 4, pad.t + ih - 2);
      ends.forEach(({ ln, x: hx, y: ly }) => {
        ln.label.setAttribute("x", hx + 8);
        ln.label.setAttribute("y", ly);
      });
      head.querySelector(".pc-hand").textContent = t >= hands ? `${hands} hands` : `Hand ${Math.max(1, Math.ceil(t))}`;
    }

    function drawMarks() {
      lines.forEach((ln) => {
        ln.marks.innerHTML = "";
        ln.s.totals.forEach((v, i) => el("circle", { cx: x(i + 1), cy: y(v), r: 2.2, class: "pc-mark" }, ln.marks));
      });
    }

    let raf = 0;
    function play() {
      cancelAnimationFrame(raf);
      lines.forEach((ln) => { ln.marks.innerHTML = ""; });
      if (reducedMotion()) { draw(hands); drawMarks(); return; }
      const start = performance.now();
      const total = hands * MS_PER_HAND;
      const frame = (now) => {
        const t = Math.min(hands, ((now - start) / total) * hands);
        draw(t);
        if (t < hands) raf = requestAnimationFrame(frame);
        else drawMarks();
      };
      draw(0);
      raf = requestAnimationFrame(frame);
    }

    function showTip(h) {
      if (h < 1 || h > hands) { hideTip(); return; }
      guide.setAttribute("x1", x(h));
      guide.setAttribute("x2", x(h));
      guide.setAttribute("visibility", "visible");
      const rows = series
        .map((s) => ({ s, total: s.totals[h - 1], pts: s.points[h - 1] }))
        .filter((r) => r.total !== undefined)
        .sort((a, b) => b.total - a.total);
      tip.innerHTML = `<div class="pc-tip-head">Hand ${h}</div>${rows.map((r) => `
        <div class="pc-tip-row" style="--hue:${r.s.hue}">
          <i></i><span class="pc-tip-name">${esc(r.s.name)}</span>
          <span class="pc-tip-pts ${r.pts >= 0 ? "pos" : "neg"}">${signed(r.pts)}</span>
          <b>${r.total}</b>
        </div>`).join("")}`;
      tip.classList.remove("hidden");
      const tw = tip.offsetWidth;
      let left = x(h) + 12;
      if (left + tw > W - 4) left = x(h) - tw - 12;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${pad.t}px`;
    }
    function hideTip() {
      guide.setAttribute("visibility", "hidden");
      tip.classList.add("hidden");
    }

    const hit = el("rect", { x: pad.l, y: pad.t, width: iw + 8, height: ih, class: "pc-hit" }, svg);
    const handAt = (ev) => {
      const box = svg.getBoundingClientRect();
      const px = ((ev.clientX - box.left) / box.width) * W;
      return Math.round(((px - pad.l) / iw) * hands);
    };
    let pinned = null;
    hit.addEventListener("pointermove", (ev) => { if (ev.pointerType === "mouse") showTip(handAt(ev)); });
    hit.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse" && pinned === null) hideTip(); });
    hit.addEventListener("click", (ev) => {
      const h = handAt(ev);
      if (pinned === h) { pinned = null; hideTip(); } else { pinned = h; showTip(h); }
    });

    const replay = head.querySelector(".pc-replay");
    replay.classList.toggle("hidden", reducedMotion());
    replay.onclick = () => { pinned = null; hideTip(); play(); };

    if (opts.animate === false) { draw(hands); drawMarks(); } else play();
    return { replay: play, showTip, hideTip, width: W };
  }

  /* Give players visibly different hues while staying close to their avatar colour. */
  function distinctHues(hues) {
    const out = [];
    hues.forEach((h) => {
      let hue = h;
      for (let i = 0; i < 9 && out.some((o) => Math.min(Math.abs(o - hue), 360 - Math.abs(o - hue)) < 34); i++) {
        hue = (hue + 41) % 360;
      }
      out.push(hue);
    });
    return out;
  }

  return { mount, distinctHues };
})();
