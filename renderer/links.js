/* Neko Terminal – links: URLs and file paths become clickable, stay underlined and show a hover tip.
   File paths (also relative ones like "renderer/main.js:42" that Claude Code prints) only become links
   once the main process has confirmed that they exist. */
(() => {
  const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s<>"'`─-▟]+|\bwww\.[a-z0-9-]+\.[a-z]{2,}[^\s<>"'`─-▟]*/gi;
  const TOKEN_RE = /[\p{L}\p{N}_.~:\\/@+\-#%$]+/gu;
  const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;

  function trimUrl(u) {
    let s = u.replace(/[.,;:!?'"*]+$/, '');
    for (const [o, c] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (s.endsWith(c) && s.split(o).length < s.split(c).length) s = s.slice(0, -1);
    }
    return s.replace(/[.,;:!?'"*]+$/, '');
  }

  function looksLikePath(t) {
    if (t.length < 3 || t.length > 260) return false;
    if (/^[A-Za-z]:[\\/]/.test(t) || /^~[\\/]/.test(t) || /^\.{1,2}[\\/]/.test(t) || /^\/[a-zA-Z]\//.test(t)) return true;
    const bare = t.replace(/(:\d+){1,2}$/, '');
    if (/[\\/]/.test(bare)) return /[\p{L}_]/u.test(bare) && !/^[\\/]+$/.test(bare) && !/:/.test(bare.slice(2));
    // bare file name with an extension: main.js, README.md:10
    return /^[\p{L}\p{N}_@+\-.]+\.[A-Za-z][A-Za-z0-9]{0,7}$/u.test(bare) && !/^\d/.test(bare.split('.').pop());
  }

  // links in a plain string: [{ start, end (exclusive), text, kind }]
  function find(text) {
    const out = [];
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text))) {
      const t = trimUrl(m[0]);
      if (t.length < 8) continue;
      out.push({ start: m.index, end: m.index + t.length, text: t, kind: 'url' });
    }
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) {
      let t = m[0];
      let start = m.index;
      // strip leading/trailing punctuation that is not part of a path
      const lead = /^[:.\-#@+%$]+(?![\\/.])/.exec(t);
      if (lead && !/^\.{1,2}[\\/]/.test(t)) { start += lead[0].length; t = t.slice(lead[0].length); }
      t = t.replace(/[.:,\-]+$/, '');
      if (!t || out.some(l => start < l.end && start + t.length > l.start)) continue;
      if (looksLikePath(t)) out.push({ start, end: start + t.length, text: t, kind: 'path' });
    }
    return out;
  }

  // the logical (unwrapped) line that contains buffer row y, with a char -> cell map
  const cellObj = {};
  function logicalLine(buf, y) {
    let top = y;
    while (top > 0) { const l = buf.getLine(top); if (!l || !l.isWrapped) break; top--; }
    let text = '';
    const map = []; // per char: [row, col, width]
    let row = top;
    let cell = null;
    for (; row < buf.length; row++) {
      const line = buf.getLine(row);
      if (!line) break;
      if (row > top && !line.isWrapped) break;
      for (let x = 0; x < line.length; x++) {
        cell = line.getCell(x, cell || undefined);
        if (!cell) break;
        const w = cell.getWidth();
        if (w === 0) continue;
        const ch = cell.getChars() || ' ';
        for (let k = 0; k < ch.length; k++) map.push([row, x, w]);
        text += ch;
      }
    }
    return { top, bottom: row - 1, text, map };
  }

  function rangeOf(ll, l) {
    const a = ll.map[l.start], b = ll.map[l.end - 1];
    if (!a || !b) return null;
    return { sr: a[0], sc: a[1], er: b[0], ec: b[1] + b[2] - 1 };
  }

  // ------------------------------------------------ existence cache for file paths
  const statCache = new Map(); // key -> 'file' | 'dir' | null | 'pending'
  const statTime = new Map();
  let waiters = [];
  let statQueue = new Map(); // cwd -> Set(text)
  let statT = null;
  const keyOf = (cwd, t) => cwd + '\u0000' + t;
  function statOf(cwd, t) {
    const k = keyOf(cwd, t);
    const v = statCache.get(k);
    if (v !== undefined && (v === 'pending' || Date.now() - statTime.get(k) < 8000)) return v;
    statCache.set(k, 'pending'); statTime.set(k, Date.now());
    if (!statQueue.has(cwd)) statQueue.set(cwd, new Set());
    statQueue.get(cwd).add(t);
    if (!statT) statT = setTimeout(flushStat, 30);
    return v === undefined ? 'pending' : v;
  }
  async function flushStat() {
    statT = null;
    const q = statQueue; statQueue = new Map();
    for (const [cwd, set] of q) {
      const list = [...set];
      let res = [];
      try { res = await window.neko.statMany(cwd, list); } catch {}
      list.forEach((t, i) => { const k = keyOf(cwd, t); statCache.set(k, res[i] || null); statTime.set(k, Date.now()); });
    }
    if (statCache.size > 5000) { statCache.clear(); statTime.clear(); }
    const w = waiters; waiters = [];
    w.forEach(fn => fn());
  }
  function whenStatDone() { return new Promise(r => { if (!statT && !statQueue.size) r(); else waiters.push(r); }); }

  // ------------------------------------------------ hover tip
  const tip = document.createElement('div');
  tip.id = 'link-tip';
  tip.className = 'hidden';
  document.body.appendChild(tip);
  let tipSeq = 0;
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function showTip(ev, link, cwd) {
    const seq = ++tipSeq;
    const isImg = IMG_EXT.test(link.text.replace(/[?#].*$/, '').replace(/(:\d+){1,2}$/, ''));
    const icon = link.kind === 'url' ? '🔗' : link.stat === 'dir' ? '📁' : isImg ? '🖼' : '📄';
    const hint = link.kind === 'url' ? 'Klick: im Browser öffnen'
      : link.stat === 'dir' ? 'Klick: im Explorer öffnen'
      : isImg ? 'Klick: Vorschau · Strg+Klick: im Ordner zeigen'
      : 'Klick: öffnen · Strg+Klick: im Ordner zeigen';
    tip.innerHTML = `<div class="lt-row"><span class="lt-ic">${icon}</span><span class="lt-tx">${esc(link.text)}</span></div><div class="lt-hint">${hint}</div>`;
    tip.classList.remove('hidden');
    placeTip(ev);
    if (isImg) {
      window.neko.loadImage(link.kind === 'url' ? link.href : link.text.replace(/(:\d+){1,2}$/, ''), cwd).then(r => {
        if (seq !== tipSeq || !r || r.error) return;
        const img = new Image();
        img.className = 'lt-img';
        img.onload = () => { if (seq === tipSeq) { tip.prepend(img); placeTip(ev); } };
        img.src = r.dataUrl;
      });
    }
  }
  function placeTip(ev) {
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + 14, y = ev.clientY + 18;
    if (x + w > window.innerWidth - 6) x = Math.max(6, window.innerWidth - w - 6);
    if (y + h > window.innerHeight - 6) y = Math.max(6, ev.clientY - h - 12);
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  function hideTip() { tipSeq++; tip.classList.add('hidden'); }

  // ------------------------------------------------ open
  async function activate(ev, link, cwd) {
    hideTip();
    const target = link.kind === 'url' ? link.href : link.text;
    if (link.kind === 'url') { window.neko.open(target, cwd); return; }
    const plain = target.replace(/(:\d+){1,2}$/, '');
    if (ev.ctrlKey) { window.neko.open(plain, cwd, { reveal: true }); return; }
    if (IMG_EXT.test(plain) && window.NekoPopups) { window.NekoPopups.lightboxFromPath(plain, cwd); return; }
    const r = await window.neko.open(target, cwd);
    if (r && r.error && window.NekoPopups) window.NekoPopups.toast(r.error);
  }

  // ------------------------------------------------ per pane
  function attach(pane) {
    const term = pane.term;
    const cwd = () => pane.cwd || '';
    term.registerLinkProvider({
      provideLinks: async (y, cb) => {
        const buf = term.buffer.active;
        const ll = logicalLine(buf, y - 1);
        const found = find(ll.text);
        const res = [];
        let pending = false;
        for (const l of found) {
          if (l.kind === 'path') {
            l.stat = statOf(cwd(), l.text);
            if (l.stat === 'pending') pending = true;
          }
        }
        if (pending) {
          await whenStatDone();
          for (const l of found) if (l.kind === 'path') l.stat = statCache.get(keyOf(cwd(), l.text));
        }
        for (const l of found) {
          if (l.kind === 'path' && !l.stat) continue;
          const r = rangeOf(ll, l);
          if (!r || y - 1 < r.sr || y - 1 > r.er) continue;
          l.href = l.kind === 'url' && /^www\./i.test(l.text) ? 'https://' + l.text : l.text;
          res.push({
            range: { start: { x: r.sc + 1, y: r.sr + 1 }, end: { x: r.ec + 1, y: r.er + 1 } },
            text: l.text,
            decorations: { pointerCursor: true, underline: true },
            activate: (ev) => activate(ev, l, cwd()),
            hover: (ev) => showTip(ev, l, cwd()),
            leave: () => hideTip(),
          });
        }
        cb(res.length ? res : undefined);
      },
    });

    // permanent underline layer for the visible rows
    const layer = document.createElement('div');
    layer.className = 'link-layer';
    pane.el.appendChild(layer);
    let t = null;
    let lastKey = '';
    function draw() {
      t = null;
      const cfg = window.NekoConfig ? window.NekoConfig() : {};
      if (cfg.link_underline === false || pane.dead) { layer.innerHTML = ''; lastKey = ''; return; }
      const cs = pane.cellSize();
      if (!cs) return;
      const buf = term.buffer.active;
      const top = buf.viewportY, rows = term.rows;
      let html = '';
      let wait = false;
      for (let y = top; y < top + rows && y < buf.length;) {
        const ll = logicalLine(buf, y);
        for (const l of find(ll.text)) {
          if (l.kind === 'path') {
            const st = statOf(cwd(), l.text);
            if (st === 'pending') { wait = true; continue; }
            if (!st) continue;
          }
          const r = rangeOf(ll, l);
          if (!r) continue;
          for (let row = r.sr; row <= r.er; row++) {
            if (row < top || row >= top + rows) continue;
            const c0 = row === r.sr ? r.sc : 0;
            const c1 = row === r.er ? r.ec : term.cols - 1;
            html += `<i class="${l.kind}" style="left:${(cs.x + c0 * cs.w).toFixed(1)}px;top:${(cs.y + (row - top + 1) * cs.h - 2).toFixed(1)}px;width:${((c1 - c0 + 1) * cs.w).toFixed(1)}px"></i>`;
          }
        }
        y = Math.max(y + 1, ll.bottom + 1);
      }
      if (html !== lastKey) { layer.innerHTML = html; lastKey = html; }
      if (wait) whenStatDone().then(schedule);
    }
    function schedule() { if (!t) t = setTimeout(draw, 60); }
    term.onRender(schedule);
    term.onScroll(schedule);
    term.onResize(schedule);
    return { schedule, layer };
  }

  // OSC 8 hyperlinks written by programs
  function oscLinkHandler(getCwd) {
    return {
      allowNonHttpProtocols: true,
      activate: (ev, uri) => activate(ev, { kind: /^(https?|ftp|mailto):/i.test(uri) ? 'url' : 'path', text: uri, href: uri }, getCwd()),
      hover: (ev, uri) => showTip(ev, { kind: /^(https?|ftp|mailto):/i.test(uri) ? 'url' : 'path', text: uri, href: uri, stat: 'file' }, getCwd()),
      leave: () => hideTip(),
    };
  }

  window.NekoLinks = { find, attach, oscLinkHandler, hideTip, IMG_EXT };
})();
