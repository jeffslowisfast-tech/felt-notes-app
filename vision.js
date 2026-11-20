/* Offline board reader.
   Finds one horizontal row of 3-5 face-up cards in a photo and reads the rank
   and suit printed in each card's corner with small canvas templates.
   Everything runs on this device: no network, no libraries, no model files.
   The result is only a suggestion; the app always asks the user to confirm. */
(() => {
  "use strict";

  const RANKS = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"];
  const GW = 14, GH = 18;          // glyph comparison grid
  const CW = 200, CH = 280;        // normalised card size for reading
  const SURE = 0.6;                // confidence at or above this is "sure"

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  const ctx2d = (c) => c.getContext("2d", { willReadFrequently: true });
  const clamp = (v) => Math.max(0, Math.min(1, v));

  /* ---------- connected components ---------- */

  // Labels non-zero pixels of `mask`. Returns { labels, list } where every item
  // has a bounding box and pixel count.
  function components(mask, w, h, eight) {
    const labels = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    const list = [];
    let next = 0;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || labels[i]) continue;
      next++;
      let sp = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
      stack[sp++] = i;
      labels[i] = next;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p - x) / w;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            if (!eight && dx && dy) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const q = ny * w + nx;
            if (mask[q] && !labels[q]) {
              labels[q] = next;
              stack[sp++] = q;
            }
          }
        }
      }
      list.push({ id: next, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
    }
    return { labels, list };
  }

  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, threshold = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; threshold = i; }
    }
    return threshold;
  }

  /* ---------- 1. find the row of cards ---------- */

  // Top and bottom edge of a component in every column of [x0, x1].
  function edges(labels, w, c, x0, x1) {
    const top = [], bottom = [];
    for (let x = x0; x <= x1; x++) {
      let a = -1, z = -1;
      for (let y = c.y0; y <= c.y1; y++) if (labels[y * w + x] === c.id) { a = y; break; }
      if (a >= 0) for (let y = c.y1; y >= a; y--) if (labels[y * w + x] === c.id) { z = y; break; }
      top.push(a);
      bottom.push(z);
    }
    return { top, bottom };
  }

  // Cards dealt touching merge into one wide white blob. Rounded corners leave
  // a dip in the column heights where two cards meet; split at those dips.
  // Column spans (top to bottom edge) ignore pictures printed on court cards.
  function splitRow(labels, w, c) {
    const { top, bottom } = edges(labels, w, c, c.x0, c.x1);
    const col = top.map((t, i) => (t >= 0 ? bottom[i] - t + 1 : 0));
    const sorted = [...col].sort((a, b) => a - b);
    const cardH = sorted[Math.floor(sorted.length * 0.6)];
    if (!cardH) return [];
    let best = null;
    for (let k = 2; k <= 6; k++) {
      const cw = c.w / k, ratio = cardH / cw;
      if (ratio < 1.2 || ratio > 1.75) continue;
      const cuts = [0];
      let dip = 0;
      for (let i = 1; i < k; i++) {
        const guess = Math.round(i * cw), span = Math.round(cw * 0.2);
        let at = guess;
        for (let x = Math.max(1, guess - span); x <= Math.min(c.w - 2, guess + span); x++) if (col[x] < col[at]) at = x;
        cuts.push(at);
        dip += col[at] / cardH;
      }
      cuts.push(c.w);
      const score = dip / (k - 1) + Math.abs(ratio - 1.45);
      if (!best || score < best.score) best = { score, cuts };
    }
    if (!best) return [];
    const out = [];
    for (let i = 0; i + 1 < best.cuts.length; i++) {
      // Each piece gets its own vertical extent: neighbours may sit higher or lower.
      let y0 = Infinity, y1 = -Infinity;
      for (let x = best.cuts[i]; x < best.cuts[i + 1]; x++) {
        if (col[x] < cardH * 0.5) continue;
        y0 = Math.min(y0, top[x]);
        y1 = Math.max(y1, bottom[x]);
      }
      if (!Number.isFinite(y0)) return [];
      out.push({ x: c.x0 + best.cuts[i], y: y0, w: best.cuts[i + 1] - best.cuts[i], h: y1 - y0 + 1, comp: c });
    }
    return out.length <= 5 ? out : [];
  }

  // Straightens one card: the slope of its top and bottom edges gives the angle,
  // then its pixels projected on the card's own axes give the true size.
  function refine(labels, w, b) {
    const c = b.comp;
    const x0 = Math.max(c.x0, Math.round(b.x)), x1 = Math.min(c.x1, Math.round(b.x + b.w) - 1);
    const { top, bottom } = edges(labels, w, c, x0, x1);
    const n = x1 - x0 + 1, a = Math.floor(n * 0.2), z = Math.ceil(n * 0.8);
    const slope = (ys) => {
      let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
      for (let i = a; i < z; i++) {
        if (ys[i] < 0) continue;
        sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; m++;
      }
      const d = m * sxx - sx * sx;
      return m > 3 && d ? (m * sxy - sx * sy) / d : 0;
    };
    let angle = Math.atan((slope(top) + slope(bottom)) / 2);
    if (!(Math.abs(angle) <= 0.3)) angle = 0;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const cx = (x0 + x1) / 2, cy = (b.y + b.y + b.h) / 2;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let y = Math.max(c.y0, Math.floor(b.y)); y <= Math.min(c.y1, Math.ceil(b.y + b.h)); y++) {
      for (let x = x0; x <= x1; x++) {
        if (labels[y * w + x] !== c.id) continue;
        const dx = x - cx, dy = y - cy;
        const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
    }
    if (!Number.isFinite(u0)) return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, angle: 0 };
    const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
    return {
      cx: cx + mu * cos - mv * sin,
      cy: cy + mu * sin + mv * cos,
      w: u1 - u0 + 1,
      h: v1 - v0 + 1,
      angle,
    };
  }

  function findCards(image) {
    const { width: w, height: h, data } = image;
    const mask = new Uint8Array(w * h);
    const lum = new Uint8Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const l = (r * 299 + g * 587 + b * 114) / 1000 | 0;
      lum[i] = l;
      hist[l]++;
    }
    const t = Math.max(otsu(hist, w * h), 110);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      mask[i] = lum[i] >= t && max - min <= max * 0.35 ? 1 : 0;
    }
    const { labels, list } = components(mask, w, h, false);
    const minArea = w * h * 0.002;
    const blobs = [];
    for (const c of list) {
      if (c.area < minArea || c.w < 6 || c.h < 8) continue;
      // Row-span fill ignores the printed picture inside a card's white frame.
      let spans = 0;
      for (let y = c.y0; y <= c.y1; y++) {
        let a = -1, z = -1;
        for (let x = c.x0; x <= c.x1; x++) if (labels[y * w + x] === c.id) { a = x; break; }
        if (a < 0) continue;
        for (let x = c.x1; x >= a; x--) if (labels[y * w + x] === c.id) { z = x; break; }
        spans += z - a + 1;
      }
      const fill = spans / (c.w * c.h);
      if (fill < 0.75) continue;
      const ratio = c.h / c.w;
      if (ratio >= 1.05 && ratio <= 2.0) {
        blobs.push({ x: c.x0, y: c.y0, w: c.w, h: c.h, comp: c });
      } else if (ratio < 1.05) {
        blobs.push(...splitRow(labels, w, c));
      }
    }
    let best = null;
    for (const anchor of blobs) {
      const cy = anchor.y + anchor.h / 2;
      // Real boards are rarely perfectly aligned: allow some height and offset.
      const peers = blobs
        .filter((b) => Math.abs(b.h - anchor.h) <= anchor.h * 0.25 &&
          Math.abs(b.y + b.h / 2 - cy) <= anchor.h * 0.45 &&
          Math.abs(b.w - anchor.w) <= anchor.w * 0.35)
        .sort((a, b) => a.x - b.x);
      // Chain neighbours with sensible gaps; overlapping duplicates are dropped.
      let chain = [];
      for (const b of peers) {
        const prev = chain[chain.length - 1];
        if (!prev) { chain.push(b); continue; }
        const gap = b.x - (prev.x + prev.w);
        if (gap < -prev.w * 0.5) continue;
        if (gap > anchor.w * 1.3) {
          if (chain.includes(anchor)) break;
          chain = [b];
          continue;
        }
        chain.push(b);
      }
      if (!chain.includes(anchor) || chain.length < 3) continue;
      if (chain.length > 5) {
        const i = Math.max(0, Math.min(chain.indexOf(anchor) - 2, chain.length - 5));
        chain = chain.slice(i, i + 5);
      }
      const area = chain.reduce((s, b) => s + b.w * b.h, 0);
      const score = chain.length * 1e9 + area;
      if (!best || score > best.score) best = { score, chain };
    }
    return best ? best.chain.map((b) => refine(labels, w, b)) : [];
  }

  /* ---------- 2. glyph templates ---------- */

  function vectorOf(test, x0, y0, w, h) {
    const v = new Float32Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) {
      const ya = y0 + (gy * h) / GH, yb = y0 + ((gy + 1) * h) / GH;
      for (let gx = 0; gx < GW; gx++) {
        const xa = x0 + (gx * w) / GW, xb = x0 + ((gx + 1) * w) / GW;
        let s = 0, n = 0;
        for (let y = Math.floor(ya); y < Math.max(Math.ceil(yb), Math.floor(ya) + 1); y++) {
          for (let x = Math.floor(xa); x < Math.max(Math.ceil(xb), Math.floor(xa) + 1); x++) {
            s += test(x, y) ? 1 : 0;
            n++;
          }
        }
        v[gy * GW + gx] = n ? s / n : 0;
      }
    }
    let mean = 0;
    for (const x of v) mean += x;
    mean /= v.length;
    let norm = 0;
    for (let i = 0; i < v.length; i++) { v[i] -= mean; norm += v[i] * v[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }

  // Row-width profile: how wide the shape is from top to bottom. It separates
  // a spade (widening steadily) from a club (narrow waist under the top lobe).
  const PROF = 12;
  function profileOf(test, x0, y0, w, h) {
    const out = new Float32Array(PROF);
    for (let r = 0; r < PROF; r++) {
      const ya = Math.floor(y0 + (r * h) / PROF), yb = Math.max(ya + 1, Math.floor(y0 + ((r + 1) * h) / PROF));
      let sum = 0, rows = 0;
      for (let y = ya; y < yb; y++) {
        let a = -1, z = -1;
        for (let x = x0; x < x0 + w; x++) if (test(x, y)) { if (a < 0) a = x; z = x; }
        sum += a < 0 ? 0 : (z - a + 1) / w;
        rows++;
      }
      out[r] = rows ? sum / rows : 0;
    }
    return out;
  }

  function fromCanvas(c) {
    const { width: w, height: h } = c;
    const d = ctx2d(c).getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 110) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const test = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 110;
    return { v: vectorOf(test, x0, y0, bw, bh), prof: profileOf(test, x0, y0, bw, bh), aspect: bw / bh };
  }

  const suitPaths = {
    d(c) { c.moveTo(50, 0); c.lineTo(92, 60); c.lineTo(50, 120); c.lineTo(8, 60); c.closePath(); },
    h(c) {
      c.moveTo(50, 116);
      c.bezierCurveTo(14, 84, 0, 58, 0, 32);
      c.bezierCurveTo(0, 12, 14, 0, 28, 0);
      c.bezierCurveTo(40, 0, 48, 8, 50, 20);
      c.bezierCurveTo(52, 8, 60, 0, 72, 0);
      c.bezierCurveTo(86, 0, 100, 12, 100, 32);
      c.bezierCurveTo(100, 58, 86, 84, 50, 116);
      c.closePath();
    },
    s(c) {
      c.moveTo(50, 0);
      c.bezierCurveTo(86, 34, 100, 52, 100, 70);
      c.bezierCurveTo(100, 88, 88, 98, 74, 98);
      c.bezierCurveTo(64, 98, 57, 93, 53, 86);
      c.lineTo(60, 120); c.lineTo(40, 120); c.lineTo(47, 86);
      c.bezierCurveTo(43, 93, 36, 98, 26, 98);
      c.bezierCurveTo(12, 98, 0, 88, 0, 70);
      c.bezierCurveTo(0, 52, 14, 34, 50, 0);
      c.closePath();
    },
    c(c) {
      for (const [x, y] of [[50, 26], [24, 66], [76, 66]]) { c.moveTo(x + 25, y); c.arc(x, y, 25, 0, Math.PI * 2); }
      c.moveTo(64, 60); c.arc(50, 60, 14, 0, Math.PI * 2);
      c.moveTo(47, 70); c.lineTo(60, 120); c.lineTo(40, 120); c.lineTo(53, 70); c.closePath();
    },
  };
  const suitChars = { s: "♠︎", h: "♥︎", d: "♦︎", c: "♣︎" };

  let templates = null;
  function buildTemplates() {
    if (templates) return templates;
    const fonts = [
      '700 100px -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif',
      '400 100px -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif',
      '700 100px Georgia, "Times New Roman", serif',
      '400 100px "Times New Roman", Times, serif',
      '700 100px "Arial Narrow", Arial, sans-serif',
    ];
    const rank = [], suit = [];
    for (const font of fonts) {
      for (const squeeze of [1, 0.72]) {
        for (const r of RANKS) {
          const c = makeCanvas(260, 160), x = ctx2d(c);
          x.font = font;
          x.textAlign = "center";
          x.textBaseline = "middle";
          x.translate(130, 80);
          x.scale(squeeze, 1);
          x.fillText(r, 0, 0);
          const t = fromCanvas(c);
          if (t) rank.push({ key: r, ...t });
        }
      }
    }
    for (const s of "shdc") {
      const c = makeCanvas(140, 160), x = ctx2d(c);
      x.translate(20, 20);
      x.beginPath();
      suitPaths[s](x);
      x.fill("nonzero");
      const t = fromCanvas(c);
      if (t) suit.push({ key: s, ...t });
      for (const font of ['100px "Apple Symbols", "Segoe UI Symbol", "DejaVu Sans", sans-serif', fonts[2]]) {
        const g = makeCanvas(160, 170), y = ctx2d(g);
        y.font = font;
        y.textAlign = "center";
        y.textBaseline = "middle";
        y.fillText(suitChars[s], 80, 85);
        const u = fromCanvas(g);
        if (u) suit.push({ key: s, ...u });
      }
    }
    templates = { rank, suit };
    return templates;
  }

  function rankScores(sample, pool, allowed, useProfile) {
    const best = new Map();
    for (const t of pool) {
      if (allowed && !allowed.includes(t.key)) continue;
      let dot = 0;
      for (let i = 0; i < t.v.length; i++) dot += t.v[i] * sample.v[i];
      let score = dot - 0.45 * Math.abs(Math.log(sample.aspect / t.aspect));
      if (useProfile) {
        let diff = 0;
        for (let i = 0; i < PROF; i++) diff += Math.abs(t.prof[i] - sample.prof[i]);
        score -= (diff / PROF) * 1.5;
      }
      if (!best.has(t.key) || score > best.get(t.key)) best.set(t.key, score);
    }
    return [...best.entries()].sort((a, b) => b[1] - a[1]);
  }

  /* ---------- 3. read one card corner ---------- */

  function readCorner(px, flip) {
    // Wide enough for a two-digit "10"; pips reaching the right edge are ignored.
    const RW = Math.round(CW * 0.5), RH = Math.round(CH * 0.47);
    const at = (x, y) => (flip ? (CH - 1 - y) * CW + (CW - 1 - x) : y * CW + x);
    // Paper brightness: 85th percentile of the whole card.
    const hist = new Uint32Array(256);
    for (let i = 0; i < CW * CH; i++) hist[px.lum[i]]++;
    let acc = 0, paper = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= CW * CH * 0.85) { paper = i; break; } }
    const ink = new Uint8Array(RW * RH), red = new Uint8Array(RW * RH);
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const p = at(x, y);
      const isRed = px.r[p] > 80 && px.r[p] - px.g[p] > 50 && px.r[p] - px.b[p] > 30;
      red[y * RW + x] = isRed ? 1 : 0;
      ink[y * RW + x] = isRed || px.lum[p] < paper * 0.6 ? 1 : 0;
    }
    const { labels, list } = components(ink, RW, RH, true);
    const parts = list.filter((c) => c.area >= 12 && c.h >= 6 &&
      c.w <= RW * 0.9 && c.h <= RH * 0.8 && c.area / (c.w * c.h) >= 0.06 &&
      !(c.x0 === 0 && c.w <= 3) && !(c.y0 === 0 && c.h <= 3) &&
      !(c.x1 >= RW - 1 && c.x0 > CW * 0.25) && !(c.x0 === 0 && c.y0 === 0));
    if (!parts.length) return null;
    const biggest = Math.max(...parts.map((c) => c.area));
    parts.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    // The index hugs the left edge; big pips sit further in and can be larger
    // than the index itself, so prefer the topmost glyph near the edge.
    const head = parts.find((c) => c.x0 + c.w / 2 < CW * 0.22 && c.h >= CH * 0.04) ||
      parts.find((c) => c.area >= biggest * 0.2);
    if (!head) return null;
    // "10" prints as two side-by-side parts.
    const rank = [head];
    for (const c of parts) {
      if (c === head) continue;
      const overlap = Math.min(c.y1, head.y1) - Math.max(c.y0, head.y0);
      const gap = c.x0 > head.x1 ? c.x0 - head.x1 : head.x0 - c.x1;
      if (overlap >= Math.min(c.h, head.h) * 0.6 && gap <= head.h * 0.5 && c.area >= head.area * 0.2) rank.push(c);
    }
    const box = (cs) => {
      const x0 = Math.min(...cs.map((c) => c.x0)), y0 = Math.min(...cs.map((c) => c.y0));
      const x1 = Math.max(...cs.map((c) => c.x1)), y1 = Math.max(...cs.map((c) => c.y1));
      return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, ids: new Set(cs.map((c) => c.id)) };
    };
    let rb = box(rank);
    const suitPart = parts
      .filter((c) => !rank.includes(c) && c.y0 >= rb.y1 - rb.h * 0.15 &&
        c.x0 + c.w / 2 >= rb.x0 - rb.w * 0.6 && c.x0 + c.w / 2 <= rb.x1 + rb.w * 0.6 &&
        c.area >= rb.w * rb.h * 0.08 && c.y0 - rb.y1 <= rb.h * 1.2)
      .sort((a, b) => a.y0 - b.y0)[0];
    let sb = suitPart ? box([suitPart]) : null;
    const inside = (b) => (x, y) => x >= b.x0 && y >= b.y0 && x <= b.x1 && y <= b.y1 && b.ids.has(labels[y * RW + x]);
    // On small or blurry cards the rank and the suit below it can touch. Cut
    // at the thinnest row of the lower half when the glyph is unusually tall.
    if (!sb && rb.h > rb.w * 1.5) {
      const test = inside(rb), widths = [];
      for (let y = rb.y0; y <= rb.y1; y++) {
        let n = 0;
        for (let x = rb.x0; x <= rb.x1; x++) n += test(x, y) ? 1 : 0;
        widths.push(n);
      }
      let cut = -1;
      for (let i = Math.floor(rb.h * 0.4); i <= Math.floor(rb.h * 0.8); i++) if (cut < 0 || widths[i] < widths[cut]) cut = i;
      if (cut > 0 && widths[cut] <= Math.max(...widths) * 0.25) {
        const tight = (y0, y1) => {
          let x0 = Infinity, x1 = -1, a = Infinity, z = -1;
          for (let y = y0; y <= y1; y++) for (let x = rb.x0; x <= rb.x1; x++) {
            if (!test(x, y)) continue;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); a = Math.min(a, y); z = Math.max(z, y);
          }
          return x1 < 0 ? null : { x0, y0: a, x1, y1: z, w: x1 - x0 + 1, h: z - a + 1, ids: rb.ids };
        };
        const upper = tight(rb.y0, rb.y0 + cut - 1), lower = tight(rb.y0 + cut + 1, rb.y1);
        if (upper && lower && lower.h >= upper.h * 0.3) { rb = upper; sb = lower; }
      }
    }
    const sample = (b) => {
      const test = inside(b);
      return { v: vectorOf(test, b.x0, b.y0, b.w, b.h), prof: profileOf(test, b.x0, b.y0, b.w, b.h), aspect: b.w / b.h };
    };
    let inkCount = 0, redCount = 0;
    for (const b of sb ? [rb, sb] : [rb]) {
      const test = inside(b);
      for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
        if (test(x, y)) { inkCount++; redCount += red[y * RW + x]; }
      }
    }
    return { rank: sample(rb), suit: sb ? sample(sb) : null, redShare: inkCount ? redCount / inkCount : 0 };
  }

  // Both corners print the same index upright (after the 180° turn), so their
  // evidence is averaged; a corner that could not be read is left out.
  function judge(corners) {
    const t = buildTemplates();
    const pool = (list) => {
      const sum = new Map();
      for (const scores of list) for (const [k, v] of scores) sum.set(k, (sum.get(k) || 0) + v / list.length);
      return [...sum.entries()].sort((a, b) => b[1] - a[1]);
    };
    const rs = pool(corners.map((c) => rankScores(c.rank, t.rank)));
    const [r1, r2] = rs;
    const rankConf = clamp((r1[1] - 0.45) / 0.3) * clamp((r1[1] - (r2 ? r2[1] : 0)) / 0.08);
    const withSuit = corners.filter((c) => c.suit);
    if (!withSuit.length) return { rank: r1[0], suit: null, conf: 0 };
    const redShare = withSuit.reduce((s, c) => s + c.redShare, 0) / withSuit.length;
    const isRed = redShare >= 0.35;
    const colourSure = redShare >= 0.55 || redShare <= 0.12 ? 1 : 0.5;
    const ss = pool(withSuit.map((c) => rankScores(c.suit, t.suit, isRed ? ["h", "d"] : ["s", "c"], true)));
    const suitConf = colourSure * clamp((ss[0][1] - 0.4) / 0.3) * clamp((ss[0][1] - ss[1][1]) / 0.1);
    return { rank: r1[0], suit: ss[0][0], conf: Math.min(rankConf, suitConf) };
  }

  function readCard(full, box) {
    const c = makeCanvas(CW, CH), x = ctx2d(c);
    x.fillStyle = "#fff";
    x.fillRect(0, 0, CW, CH);
    x.translate(CW / 2, CH / 2);
    x.scale(CW / box.w, CH / box.h);
    x.rotate(-box.angle);
    x.drawImage(full, -box.cx, -box.cy);
    const d = x.getImageData(0, 0, CW, CH).data;
    const n = CW * CH;
    const px = { r: new Uint8Array(n), g: new Uint8Array(n), b: new Uint8Array(n), lum: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
      px.r[i] = d[i * 4]; px.g[i] = d[i * 4 + 1]; px.b[i] = d[i * 4 + 2];
      px.lum[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    }
    const corners = [false, true].map((flip) => readCorner(px, flip)).filter(Boolean);
    const best = corners.length ? judge(corners) : null;
    if (!best || !best.suit) return { code: null, conf: 0 };
    const rank = best.rank === "10" ? "T" : best.rank;
    return { code: rank + best.suit, conf: Math.round(best.conf * 100) / 100 };
  }

  /* ---------- public ---------- */

  // source: a decoded <img>, <canvas> or ImageBitmap.
  function detect(source) {
    const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
    if (!sw || !sh) return { found: false, cards: [] };
    const fs = Math.min(1, 1600 / Math.max(sw, sh));
    const full = makeCanvas(sw * fs, sh * fs);
    ctx2d(full).drawImage(source, 0, 0, full.width, full.height);
    const ss = Math.min(1, 480 / Math.max(full.width, full.height));
    const small = makeCanvas(full.width * ss, full.height * ss);
    const sx = ctx2d(small);
    sx.drawImage(full, 0, 0, small.width, small.height);
    const boxes = findCards(sx.getImageData(0, 0, small.width, small.height));
    if (boxes.length < 3) return { found: false, cards: [] };
    const k = full.width / small.width;
    const cards = boxes.map((b) => readCard(full, { cx: b.cx * k, cy: b.cy * k, w: b.w * k, h: b.h * k, angle: b.angle }));
    // The same card cannot appear twice on one board.
    const seen = new Map();
    for (const c of cards) if (c.code) seen.set(c.code, (seen.get(c.code) || 0) + 1);
    for (const c of cards) if (c.code && seen.get(c.code) > 1) c.conf = Math.min(c.conf, 0.2);
    return {
      found: true,
      sure: cards.every((c) => c.code && c.conf >= SURE),
      cards: cards.map((c) => ({ ...c, sure: !!c.code && c.conf >= SURE })),
    };
  }

  window.BoardVision = Object.freeze({ detect, SURE, _findCards: findCards });
})();
