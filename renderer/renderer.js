/* Neko Terminal – renderer: tabs, kitty-style layouts, panes, autofill UI, palette, search. */
(() => {
  const $ = s => document.querySelector(s);
  const mod = (g, n) => (g && g[n]) || g;
  const XTerminal = window.Terminal && window.Terminal.Terminal ? window.Terminal.Terminal : window.Terminal;
  const FitAddon = mod(window.FitAddon, 'FitAddon');
  const ImageAddon = mod(window.ImageAddon, 'ImageAddon');
  const WebglAddon = mod(window.WebglAddon, 'WebglAddon');
  const Unicode11Addon = mod(window.Unicode11Addon, 'Unicode11Addon');
  const SearchAddon = mod(window.SearchAddon, 'SearchAddon');
  const S = window.NekoSuggest;
  const P = window.NekoPopups;
  const L = window.NekoLinks;
  const C = window.NekoClaude;

  let config = null;
  let theme = null;
  let shells = [];
  const tabs = [];
  let activeTab = null;
  const workspace = $('#workspace');

  const LAYOUT_LABEL = { tall: 'tall', fat: 'fat', grid: 'grid', horizontal: 'horizontal', vertical: 'vertical', stack: 'stack' };

  // ================================================================ helpers
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden'); t.style.opacity = 1;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.classList.add('hidden'), 200); }, 1400);
  }
  function basename(p) {
    if (!p) return '';
    const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }
  function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  const claudeUiOn = () => config.claude_ui !== false;
  // panes running Claude Code get the Claude theme (config "claude_theme"), all others the normal one
  function themeFor(isClaude) {
    const T = window.NEKO_THEMES;
    return (isClaude && claudeUiOn() && config.claude_theme && T[config.claude_theme]) || T[config.theme] || T['Tokyo Night'];
  }
  let appliedThemeKey = '';
  function applyTheme(force) {
    const p = activeTab && activeTab.focused;
    const claude = !!(p && p.isClaude);
    const key = `${claude}|${config.theme}|${config.claude_theme}|${config.claude_ui}|${config.background_opacity}|${config.font_family}|${config.window_padding}|${config.inactive_pane_dim}`;
    if (!force && key === appliedThemeKey) return;
    appliedThemeKey = key;
    theme = themeFor(claude);
    document.body.classList.toggle('claude-active', claude && claudeUiOn());
    const r = document.documentElement.style;
    const u = theme.ui;
    r.setProperty('--bg', theme.term.background);
    r.setProperty('--fg', theme.term.foreground);
    r.setProperty('--bar', u.bar);
    r.setProperty('--accent', u.accent);
    r.setProperty('--tab-active-bg', u.tabActiveBg);
    r.setProperty('--tab-active-fg', u.tabActiveFg);
    r.setProperty('--tab-bg', u.tabBg);
    r.setProperty('--tab-fg', u.tabFg);
    r.setProperty('--border', u.border);
    r.setProperty('--ghost', u.ghost);
    r.setProperty('--popup-bg', u.popupBg);
    r.setProperty('--popup-sel', u.popupSel);
    r.setProperty('--muted', u.muted);
    r.setProperty('--alert', u.alert);
    r.setProperty('--font', `'${config.font_family}', 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace`);
    r.setProperty('--pad', `${config.window_padding}px`);
    r.setProperty('--dim', String(config.inactive_pane_dim));
    const op = Math.max(0.2, Math.min(1, Number(config.background_opacity ?? 0.82)));
    r.setProperty('--bg-a', hexToRgba(theme.term.background, op));
    r.setProperty('--bar-a', hexToRgba(u.bar, Math.min(1, op + 0.06)));
  }
  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})/i.exec(hex || '');
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  // the terminal draws on a transparent canvas so the window background shows through
  function termTheme(pane) { return { ...themeFor(!!(pane && pane.isClaude)).term, background: '#00000000' }; }

  function termOptions() {
    return {
      fontFamily: `'${config.font_family}', 'JetBrains Mono', 'Cascadia Mono', Consolas, 'Segoe UI Symbol', monospace`,
      fontSize: config.font_size,
      lineHeight: config.line_height,
      cursorStyle: config.cursor_shape === 'beam' ? 'bar' : config.cursor_shape,
      cursorWidth: 2,
      cursorBlink: !!config.cursor_blink,
      cursorInactiveStyle: config.cursor_shape === 'block' ? 'outline' : 'bar',
      allowTransparency: true,
      scrollback: config.scrollback_lines,
      theme: termTheme(),
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
      fontWeightBold: 'bold',
      smoothScrollDuration: 80,
      rightClickSelectsWord: false,
      windowsPty: { backend: 'conpty', buildNumber: 19045 },
      // OSC 8 hyperlinks (Claude Code and others print these)
      linkHandler: L.oscLinkHandler(() => (activeTab && activeTab.focused ? activeTab.focused.cwd : '')),
    };
  }

  // ================================================================ Pane
  class Pane {
    constructor(tab, opts = {}) {
      this.tab = tab;
      this.opts = opts;
      this.title = '';
      this.cwd = opts.cwd || '';
      this.shellId = opts.shellId || config.shell;
      this.id = null;
      this.dead = false;
      this.el = document.createElement('div');
      this.el.className = 'pane';
      this.host = document.createElement('div');
      this.host.className = 'term-host';
      this.ghostEl = document.createElement('div');
      this.ghostEl.className = 'ghost';
      this.popupEl = document.createElement('div');
      this.popupEl.className = 'suggest';
      this.imgLayer = document.createElement('div');
      this.imgLayer.className = 'img-layer';
      this.el.append(this.host, this.imgLayer, this.ghostEl, this.popupEl);
      this.inlineImgs = [];   // { marker, el, rows, w, h } images shown by "neko img"
      this.isClaude = false;  // Claude Code runs in this pane (detected from the window title)
      this.progress = null;   // OSC 9;4 / neko progress: { state, value }
      this.replayEnd = 0;     // stream offset already shown by a reattach replay
      tab.view.appendChild(this.el);

      // autofill state
      this.inputMarker = null;   // xterm marker on the line where the user's input starts
      this.inputX = 0;
      this.promptPending = false;
      this.line = '';
      this.atEnd = false;
      this.cands = [];
      this.sel = 0;
      this.popupOpen = false;
      this.popupDismissed = false;
      this.reqSeq = 0;

      this.term = new XTerminal(termOptions());
      this.fit = new FitAddon();
      this.search = new SearchAddon();
      this.term.loadAddon(this.fit);
      this.term.loadAddon(this.search);
      const u11 = new Unicode11Addon();
      this.term.loadAddon(u11);
      this.term.unicode.activeVersion = '11';
      this.term.open(this.host);
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        this.term.loadAddon(gl);
      } catch (e) { console.warn('webgl unavailable', e); }
      // sixel + iTerm2 inline images (OSC 1337): the bundled ConPTY passes both through
      try {
        if (ImageAddon) this.term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true, enableSizeReports: true, pixelLimit: 16777216, storageLimit: 128, showPlaceholder: true }));
      } catch (e) { console.warn('image addon unavailable', e); }
      this.links = L.attach(this);
      this.cm = C.create(this, claudeCtx);
      this.term.onRender(() => { if (this.cm.on && !this._scanT) this._scanT = setTimeout(() => { this._scanT = null; this.cm.scan(); }, 90); });

      this.term.parser.registerOscHandler(7, data => {
        try {
          const u = new URL(data);
          let p = decodeURIComponent(u.pathname);
          if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
          this.cwd = p.replace(/\//g, this.shellId === 'bash' || this.shellId === 'wsl' ? '/' : '\\');
          if (this.shellId === 'wsl') this.cwd = '';
          if (this.id && this.cwd) window.neko.pty.setCwd(this.id, this.cwd);
        } catch {}
        this.tab.render();
        return true;
      });
      this.term.parser.registerOscHandler(133, data => {
        if (data.startsWith('A')) {
          this.promptPending = true;
          this.clearInput();
        }
        return true;
      });
      // notifications: OSC 9 (iTerm2; 9;4 = progress), OSC 777 (notify;title;body), OSC 99 (kitty)
      this.term.parser.registerOscHandler(9, data => {
        const pm = /^4;(\d)(?:;(\d+))?/.exec(data);
        if (pm) { this.setProgress(['none', 'value', 'error', 'busy', 'paused'][+pm[1]] || 'none', pm[2] ? +pm[2] : null); return true; }
        if (/^9;/.test(data)) return false; // ConEmu cwd report, not a notification
        if (data.trim()) this.notify({ body: data });
        return true;
      });
      this.term.parser.registerOscHandler(777, data => {
        const parts = data.split(';');
        if (parts[0] === 'notify') this.notify({ title: parts[1], body: parts.slice(2).join(';') });
        return true;
      });
      this.kittyNotif = {};
      this.term.parser.registerOscHandler(99, data => {
        const i = data.indexOf(';');
        const meta = Object.fromEntries((i < 0 ? data : data.slice(0, i)).split(':').filter(Boolean).map(kv => kv.split('=')));
        const payload = i < 0 ? '' : data.slice(i + 1);
        const key = meta.i || '0';
        const n = this.kittyNotif[key] || (this.kittyNotif[key] = { title: '', body: '' });
        n[meta.p === 'body' ? 'body' : 'title'] += payload;
        if (meta.d !== '0') { delete this.kittyNotif[key]; this.notify(n.body ? n : { body: n.title }); }
        return true;
      });
      this.term.onTitleChange(t => {
        this.title = t;
        // Claude Code sets titles like "✳ Claude Code" or "✳ <task>"
        const claude = /claude/i.test(t) || /^✳\s/.test(t) || C.BUSY_TITLE.test(t);
        if (claude !== this.isClaude) this.setClaude(claude);
        this.cm.onTitle(t);
        this.tab.render();
      });
      this.term.onBell(() => {
        this.el.classList.remove('bell'); void this.el.offsetWidth; this.el.classList.add('bell');
        if (this.tab !== activeTab) { this.tab.bell = true; renderTabs(); }
        // Claude Code rings the bell when it waits for you: tell Windows when Neko is in the background
        // (with Neko's hooks the Claude mode sends its own, more precise message)
        if (config.notify_on_bell && !document.hasFocus() && !(this.isClaude && this.cm.st.hooked)) {
          const now = Date.now();
          if (!this._lastBellNote || now - this._lastBellNote > 15000) {
            this._lastBellNote = now;
            window.neko.ui.notify({ title: this.isClaude ? 'Claude Code wartet auf dich' : 'Neko Terminal', body: `${this.tab.title()}${this.title ? ' — ' + this.title : ''}`, paneId: this.id });
          }
        }
      });
      this.term.onSelectionChange(() => {
        if (config.copy_on_select && this.term.hasSelection()) window.neko.clipboard.write(this.term.getSelection());
      });
      // while old output is replayed after a hot update, xterm answers old queries (DA, size): drop those answers
      this.term.onData(d => { if (!this.replaying) this.onInput(d); });
      this.term.onBinary(d => { if (!this.replaying && this.id) window.neko.pty.write(this.id, d); });
      this.term.onRender(() => { this.scheduleSync(); this.placeImages(); });
      this.term.onScroll(() => { this.scheduleSync(); this.placeImages(); });
      this.term.onResize(({ cols, rows }) => {
        if (this.id) window.neko.pty.resize(this.id, cols, rows);
        if (this.tab === activeTab && this.tab.focused === this) updateChrome();
      });
      this.term.attachCustomKeyEventHandler(e => this.onKey(e));
      this.term.textarea.addEventListener('focus', () => this.tab.setFocused(this));

      this.el.addEventListener('mousedown', () => this.tab.setFocused(this, false));
      this.el.addEventListener('contextmenu', async e => {
        e.preventDefault();
        if (this.term.hasSelection()) { window.neko.clipboard.write(this.term.getSelection()); this.term.clearSelection(); toast('Kopiert'); }
        else await this.pasteClipboard();
        this.term.focus();
      });
      // drag & drop files: paste their paths (Claude Code turns image paths into attachments)
      this.el.addEventListener('dragover', e => {
        if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; $('#drop-hint').classList.remove('hidden'); }
      });
      this.el.addEventListener('dragleave', e => { if (!this.el.contains(e.relatedTarget)) $('#drop-hint').classList.add('hidden'); });
      this.el.addEventListener('drop', e => {
        e.preventDefault();
        $('#drop-hint').classList.add('hidden');
        const paths = [...(e.dataTransfer ? e.dataTransfer.files : [])].map(f => window.neko.pathForFile(f)).filter(Boolean);
        if (!paths.length) return;
        if (this.cm.on && !this.cm.menu) { this.tab.setFocused(this, false); this.cm.addPaths(paths); return; }
        this.tab.setFocused(this);
        this.term.paste(paths.map(p => this.quotePath(p)).join(' ') + ' ');
        this.term.focus();
      });
      this.el.addEventListener('wheel', e => {
        if (e.ctrlKey) { e.preventDefault(); changeFontSize(e.deltaY < 0 ? 1 : -1); }
      }, { passive: false });
    }

    async start() {
      this.doFit();
      const att = this.opts.attach;
      const info = att || await window.neko.pty.create({ cols: this.term.cols, rows: this.term.rows, shellId: this.shellId, cwd: this.cwd });
      this.id = info.id;
      this.shellId = info.shell;
      this.shellName = info.shellName;
      if (!this.cwd) this.cwd = info.cwd;
      if (att) {
        // hot update: replay what the shell printed so far, then continue live
        this.replayEnd = att.end || 0;
        if (att.buffer) {
          this.replaying = true;
          await new Promise(res => this.term.write(att.buffer, res));
          this.replaying = false;
        }
      }
      window.neko.pty.onData(this.id, (d, off) => {
        if (off != null && off < this.replayEnd) {
          if (off + d.length <= this.replayEnd) return;
          d = d.slice(this.replayEnd - off);
        }
        this.term.write(d);
        if (this.tab !== activeTab && !this.tab.activity) { this.tab.activity = true; renderTabs(); }
      });
      window.neko.pty.onExit(this.id, code => this.onExit(code));
      this.cm.restoreDraft();
      if (att) {
        // hot update: Claude's state lives in the main process
        window.neko.claude.state(this.id).then(st => { if (st) this.cm.applyState(st); });
        // a resize makes ConPTY and TUI apps (Claude Code) repaint the screen cleanly
        const { cols, rows } = this.term;
        window.neko.pty.resize(this.id, cols, Math.max(2, rows - 1));
        setTimeout(() => this.id && window.neko.pty.resize(this.id, cols, rows), 150);
      }
      this.tab.render();
    }

    quotePath(p) {
      if (this.shellId === 'bash' || this.shellId === 'wsl') {
        p = p.replace(/\\/g, '/');
        return /[\s'"()&;$]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
      }
      if (this.shellId === 'cmd' || this.isClaude) return /\s/.test(p) ? `"${p}"` : p;
      return /[\s'()&;$`{}]/.test(p) ? `'${p.replace(/'/g, "''")}'` : p;
    }

    // Claude Code started or ended in this pane
    setClaude(on) {
      this.isClaude = on;
      this.el.classList.toggle('claude', on);
      this.term.options.theme = termTheme(this);
      this.cm.setActive(on && claudeUiOn());
      if (this.tab === activeTab) applyTheme();
      renderTabs();
    }

    // room for the Claude input box under the terminal
    relayout() {
      const h = this.cm.height();
      if (h === this._ccH) return;
      this._ccH = h;
      this.host.style.bottom = h ? `calc(var(--pad) + ${h + 6}px)` : '';
      clearTimeout(this._fitT);
      this._fitT = setTimeout(() => { this.doFit(); this.placeImages(); }, 40);
    }

    notify({ title, body }) {
      const t = title || (this.isClaude ? 'Claude Code' : 'Benachrichtigung');
      P.card({ kind: 'osc', title: t, text: body, source: this.tab.title(), claude: this.isClaude, cwd: this.cwd, onActivate: () => focusPane(this) });
      if (!document.hasFocus() || this.tab !== activeTab) window.neko.ui.notify({ title: t, body: body || '', paneId: this.id, force: this.tab !== activeTab });
    }

    setProgress(state, value) {
      this.progress = state === 'none' || state === 'done' ? null : { state, value };
      renderTabs();
    }

    // ---------------------------------------------------- inline images ("neko img")
    // The image floats over blank rows that the neko command prints, so ConPTY's idea of the
    // cursor stays correct. It scrolls with the buffer through an xterm marker.
    async addInlineImage(img, maxRows, maxCols) {
      const cs = this.cellSize();
      if (!cs) throw new Error('Terminal nicht sichtbar');
      const el = new Image();
      await new Promise((res, rej) => { el.onload = res; el.onerror = () => rej(new Error('Bild nicht lesbar')); el.src = img.dataUrl; });
      const dpr = window.devicePixelRatio || 1;
      const nw = el.naturalWidth / dpr || cs.w * 20, nh = el.naturalHeight / dpr || cs.h * 8;
      const rowsCap = Math.max(2, Math.min(maxRows || config.image_max_rows || 20, this.term.rows - 2));
      const colsCap = Math.max(4, Math.min(maxCols || this.term.cols, this.term.cols));
      const scale = Math.min(1, (colsCap * cs.w) / nw, (rowsCap * cs.h) / nh);
      const rows = Math.max(1, Math.ceil((nh * scale) / cs.h));
      const marker = this.term.registerMarker(0);
      if (!marker) throw new Error('Marker fehlgeschlagen');
      const box = document.createElement('div');
      box.className = 'inline-img';
      box.title = `${img.name || ''} – Klick: groß anzeigen`;
      el.draggable = false;
      box.appendChild(el);
      box.onclick = () => P.lightbox(img);
      this.imgLayer.appendChild(box);
      const rec = { marker, el: box, rows, w: nw * scale, h: nh * scale };
      this.inlineImgs.push(rec);
      marker.onDispose(() => { box.remove(); this.inlineImgs = this.inlineImgs.filter(r => r !== rec); });
      this.placeImages();
      return { rows };
    }

    placeImages() {
      if (!this.inlineImgs.length) return;
      const cs = this.cellSize();
      if (!cs) return;
      const b = this.term.buffer.active;
      const alt = b.type === 'alternate';
      for (const r of this.inlineImgs) {
        const y = r.marker.line - b.viewportY;
        const visible = !alt && r.marker.line >= 0 && y + r.rows > 0 && y < this.term.rows;
        r.el.style.display = visible ? 'block' : 'none';
        if (!visible) continue;
        Object.assign(r.el.style, { left: `${cs.x}px`, top: `${cs.y + y * cs.h}px`, width: `${r.w}px`, height: `${r.h}px` });
      }
    }

    // clipboard with an image and no text: Claude Code reads it itself (Alt+V), shells get a png path
    async pasteClipboard() {
      const c = await window.neko.clipboard.info();
      if (c.text) { this.term.paste(c.text); return; }
      if (!c.hasImage || !this.id) return;
      if (this.isClaude) { window.neko.pty.write(this.id, '\x1bv'); return; }
      const p = await window.neko.clipboard.saveImage();
      if (p) { this.term.paste(this.quotePath(p) + ' '); toast('Bild aus der Zwischenablage gespeichert'); }
    }

    onExit(code) {
      this.dead = true;
      this.id = null;
      this.tab.removePane(this);
    }

    doFit() {
      if (!this.el.offsetParent) return;
      try { this.fit.fit(); } catch {}
    }

    focus() {
      if (this.cm.on && !this.cm.termMode) this.cm.focus();
      else this.term.focus();
    }

    dispose() {
      L.hideTip();
      this.cm.dispose();
      if (this.id) window.neko.pty.kill(this.id);
      this.id = null;
      try { this.term.dispose(); } catch {}
      this.el.remove();
    }

    // ---------------------------------------------------- input tracking
    onInput(d) {
      if (!this.id) return;
      if (this.promptPending && !this.inputMarker && d !== '\r') this.beginInput();
      if (d === '\r' || d === '\n') {
        if (this.inputMarker) {
          const l = this.readLine().text.trim();
          if (l) S.pushHistory(l);
        }
        this.clearInput();
        this.promptPending = false;
      }
      window.neko.pty.write(this.id, d);
    }

    beginInput() {
      const b = this.term.buffer.active;
      this.inputMarker = this.term.registerMarker(0);
      this.inputX = b.cursorX;
      this.promptPending = false;
    }

    clearInput() {
      if (this.inputMarker) { try { this.inputMarker.dispose(); } catch {} }
      this.inputMarker = null;
      this.line = '';
      this.cands = [];
      this.hideSuggest();
    }

    readLine() {
      const b = this.term.buffer.active;
      const m = this.inputMarker;
      if (!m || m.isDisposed || m.line < 0) return { text: '', atEnd: false, ok: false };
      let y = m.line;
      let text = '';
      let first = true;
      const cursorAbs = b.baseY + b.cursorY;
      let cursorIdx = -1;
      while (y < b.length) {
        const row = b.getLine(y);
        if (!row) break;
        if (!first && !row.isWrapped) break;
        const startX = first ? this.inputX : 0;
        const s = row.translateToString(false, startX);
        if (y === cursorAbs) cursorIdx = text.length + (b.cursorX - startX);
        text += s;
        first = false;
        y++;
      }
      text = text.replace(/\s+$/, '');
      return { text, atEnd: cursorIdx >= text.length, ok: cursorIdx >= 0 };
    }

    scheduleSync() {
      if (this._syncT) return;
      this._syncT = setTimeout(() => { this._syncT = null; this.sync(); }, 16);
    }

    async sync() {
      if (!config.autosuggest || !this.inputMarker || this.dead) { this.hideSuggest(); return; }
      const b = this.term.buffer.active;
      if (b.type === 'alternate' || b.viewportY !== b.baseY) { this.hideSuggest(); return; }
      const r = this.readLine();
      if (!r.ok) { this.hideSuggest(); return; }
      this.atEnd = r.atEnd;
      if (r.text !== this.line) {
        this.line = r.text;
        this.popupDismissed = false;
        const seq = ++this.reqSeq;
        const c = await S.compute(this.line, { cwd: this.cwd, shell: this.shellId });
        if (seq !== this.reqSeq) return;
        this.cands = c;
        this.sel = 0;
      }
      this.renderSuggest();
    }

    cellSize() {
      const scr = this.host.querySelector('.xterm-screen');
      if (!scr) return null;
      const rect = scr.getBoundingClientRect();
      const pr = this.el.getBoundingClientRect();
      return { w: rect.width / this.term.cols, h: rect.height / this.term.rows, x: rect.left - pr.left, y: rect.top - pr.top, pw: pr.width, ph: pr.height };
    }

    renderSuggest() {
      const cs = this.cellSize();
      if (!cs || !this.line || !this.cands.length || !this.atEnd || this.tab.focused !== this) { this.hideSuggest(); return; }
      const b = this.term.buffer.active;
      const cand = this.cands[this.sel] || this.cands[0];
      const fs = this.term.options.fontSize;

      // ghost text (inline, fish style)
      let ghost = '';
      if (cand.value.toLowerCase().startsWith(this.line.toLowerCase())) ghost = cand.value.slice(this.line.length);
      const room = this.term.cols - b.cursorX;
      if (ghost && room > 0) {
        ghost = ghost.slice(0, room);
        this.ghostEl.innerHTML = [...ghost].map(ch => `<span style="width:${cs.w}px">${escapeHtml(ch === ' ' ? ' ' : ch)}</span>`).join('');
        Object.assign(this.ghostEl.style, {
          display: 'block', left: `${cs.x + b.cursorX * cs.w}px`, top: `${cs.y + b.cursorY * cs.h}px`,
          height: `${cs.h}px`, lineHeight: `${cs.h}px`, fontSize: `${fs}px`,
        });
      } else this.ghostEl.style.display = 'none';

      // popup list
      const showPopup = !this.popupDismissed && (this.cands.length > 1 || this.popupOpen || !ghost);
      if (!showPopup) { this.popupEl.style.display = 'none'; this.popupOpen = false; return; }
      this.popupOpen = true;
      const max = 8;
      const start = Math.max(0, Math.min(this.sel - max + 1, this.cands.length - max));
      const view = this.cands.slice(Math.max(0, start), Math.max(0, start) + max);
      const icon = { history: '⏱', command: '›_', sub: '⚙', dir: '▸', file: '·' };
      const kind = { history: 'Verlauf', command: 'Befehl', sub: 'Option', dir: 'Ordner', file: 'Datei' };
      const lineLower = this.line.toLowerCase();
      this.popupEl.innerHTML = view.map((c, i) => {
        const idx = i + Math.max(0, start);
        let label = c.kind === 'history' || c.kind === 'command' ? c.value : c.label;
        let html;
        if (label.toLowerCase().startsWith(lineLower)) html = `<b>${escapeHtml(label.slice(0, this.line.length))}</b>${escapeHtml(label.slice(this.line.length))}`;
        else html = escapeHtml(label);
        return `<div class="item${idx === this.sel ? ' sel' : ''}" data-i="${idx}"><span class="ic">${icon[c.kind] || '·'}</span><span class="tx">${html}</span><span class="kd">${kind[c.kind] || ''}</span></div>`;
      }).join('') + `<div class="hint"><span><kbd>Tab</kbd>/<kbd>→</kbd> übernehmen</span><span><kbd>↑↓</kbd> wählen</span><span><kbd>Esc</kbd> schließen</span></div>`;
      this.popupEl.style.fontSize = `${Math.max(11, fs - 1)}px`;
      this.popupEl.style.display = 'block';
      const pw = this.popupEl.offsetWidth, ph = this.popupEl.offsetHeight;
      let left = cs.x + Math.max(0, this.inputX) * cs.w - 6;
      left = Math.max(4, Math.min(left, cs.pw - pw - 4));
      let top = cs.y + (b.cursorY + 1) * cs.h + 4;
      if (top + ph > cs.ph - 4) top = cs.y + b.cursorY * cs.h - ph - 4;
      this.popupEl.style.left = `${left}px`;
      this.popupEl.style.top = `${Math.max(2, top)}px`;
      this.popupEl.querySelectorAll('.item').forEach(it => {
        it.onmousedown = ev => { ev.preventDefault(); this.sel = +it.dataset.i; this.accept(); };
      });
    }

    hideSuggest() {
      this.ghostEl.style.display = 'none';
      this.popupEl.style.display = 'none';
      this.popupOpen = false;
    }

    suggestVisible() { return this.ghostEl.style.display === 'block' || this.popupEl.style.display === 'block'; }

    accept(wordOnly = false) {
      const cand = this.cands[this.sel] || this.cands[0];
      if (!cand || !this.id) return false;
      let target = cand.value;
      if (wordOnly && target.toLowerCase().startsWith(this.line.toLowerCase())) {
        const rest = target.slice(this.line.length);
        const m = /^(\s*[^\s\\/]+[\\/]?|\s+)/.exec(rest);
        target = this.line + (m ? m[0] : rest);
      }
      let k = 0;
      while (k < this.line.length && k < target.length && this.line[k] === target[k]) k++;
      const out = '\x7f'.repeat(this.line.length - k) + target.slice(k);
      if (out) window.neko.pty.write(this.id, out);
      this.popupDismissed = !(cand.kind === 'dir');
      this.hideSuggest();
      return true;
    }

    // ---------------------------------------------------- keys
    onKey(e) {
      if (e.type !== 'keydown') return !this._swallowNext;
      this._swallowNext = false;
      if (handleGlobalKey(e, this)) { e.preventDefault(); this._swallowNext = true; return false; }

      // clipboard (Windows-style in addition to kitty's ctrl+shift+c/v)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'c' && this.term.hasSelection()) {
        window.neko.clipboard.write(this.term.getSelection()); this.term.clearSelection(); toast('Kopiert');
        e.preventDefault(); return false;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'v') {
        e.preventDefault();
        this.pasteClipboard();
        return false;
      }

      // Claude mode: typing while the terminal has focus goes to the input box (unless a menu is open
      // or the user chose to type into the terminal directly)
      if (this.cm.on && !this.cm.menu && !this.cm.termMode && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        this.cm.focus(e.key);
        return false;
      }

      // autofill keys
      const vis = this.suggestVisible();
      if (e.ctrlKey && e.code === 'Space' && config.autosuggest) {
        this.popupDismissed = false; this.popupOpen = true; this.line = null; this.sync();
        e.preventDefault(); return false;
      }
      if (!vis || e.altKey) return true;
      const popup = this.popupEl.style.display === 'block';
      const ghost = this.ghostEl.style.display === 'block';
      if (popup && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.ctrlKey && !e.shiftKey) {
        const n = this.cands.length;
        this.sel = (this.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        this.renderSuggest();
        e.preventDefault(); return false;
      }
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && (popup || ghost)) { this.accept(); e.preventDefault(); return false; }
      if ((e.key === 'ArrowRight' || e.key === 'End') && !e.shiftKey && ghost) {
        this.accept(e.ctrlKey && e.key === 'ArrowRight'); e.preventDefault(); return false;
      }
      if (e.key === 'Escape' && popup) { this.popupDismissed = true; this.hideSuggest(); this.renderSuggest(); e.preventDefault(); return false; }
      return true;
    }
  }

  // ================================================================ Tab with kitty layouts
  let tabSeq = 0;
  class Tab {
    constructor() {
      this.n = ++tabSeq;
      this.view = document.createElement('div');
      this.view.className = 'tab-view';
      workspace.appendChild(this.view);
      this.panes = [];
      this.focused = null;
      this.layout = config.layouts[0] || 'tall';
      this.activity = false;
      this.bell = false;
      this.done = false;   // Claude finished while you were in another tab
      this.customTitle = null;
    }

    isActive() { return this === activeTab; }

    async addPane(opts = {}, after = null) {
      const p = new Pane(this, opts);
      const idx = after ? this.panes.indexOf(after) + 1 : this.panes.length;
      this.panes.splice(idx, 0, p);
      this.focused = p;
      this.arrange();
      await p.start();
      this.arrange();
      if (this === activeTab) p.focus();
      return p;
    }

    removePane(p) {
      const i = this.panes.indexOf(p);
      if (i === -1) return;
      this.panes.splice(i, 1);
      p.dispose();
      if (!this.panes.length) { closeTab(this); return; }
      if (this.focused === p) this.focused = this.panes[Math.min(i, this.panes.length - 1)];
      this.arrange();
      if (this === activeTab) this.focused.focus();
    }

    setFocused(p, focusTerm = true) {
      if (this.focused === p) return;
      const prev = this.focused;
      this.focused = p;
      if (prev && prev !== p) prev.hideSuggest();
      if (this.layout === 'stack') this.arrange();
      else this.updateFocusClasses();
      if (focusTerm) p.focus();
      this.render();
    }

    updateFocusClasses() {
      for (const p of this.panes) p.el.classList.toggle('focused', p === this.focused);
    }

    cycleFocus(d) {
      if (this.panes.length < 2) return;
      const i = this.panes.indexOf(this.focused);
      const p = this.panes[(i + d + this.panes.length) % this.panes.length];
      this.setFocused(p);
    }

    movePane(d) {
      const i = this.panes.indexOf(this.focused);
      const j = (i + d + this.panes.length) % this.panes.length;
      if (i === j) return;
      [this.panes[i], this.panes[j]] = [this.panes[j], this.panes[i]];
      this.arrange();
    }

    arrange() {
      const W = this.view.clientWidth || workspace.clientWidth;
      const H = this.view.clientHeight || workspace.clientHeight;
      const n = this.panes.length;
      const multi = n > 1 && this.layout !== 'stack';
      this.view.classList.toggle('has-multi', multi);
      const rects = [];
      const L = this.layout;
      if (n === 1 || L === 'stack') {
        for (let i = 0; i < n; i++) rects.push([0, 0, W, H]);
      } else if (L === 'tall' || L === 'fat') {
        const tall = L === 'tall';
        const main = Math.round((tall ? W : H) * 0.5);
        rects.push(tall ? [0, 0, main, H] : [0, 0, W, main]);
        const rest = n - 1;
        for (let i = 0; i < rest; i++) {
          if (tall) {
            const y0 = Math.round(i * H / rest), y1 = Math.round((i + 1) * H / rest);
            rects.push([main, y0, W - main, y1 - y0]);
          } else {
            const x0 = Math.round(i * W / rest), x1 = Math.round((i + 1) * W / rest);
            rects.push([x0, main, x1 - x0, H - main]);
          }
        }
      } else if (L === 'grid') {
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        for (let i = 0; i < n; i++) {
          const r = Math.floor(i / cols);
          const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
          const c = i - r * cols;
          const x0 = Math.round(c * W / inRow), x1 = Math.round((c + 1) * W / inRow);
          const y0 = Math.round(r * H / rows), y1 = Math.round((r + 1) * H / rows);
          rects.push([x0, y0, x1 - x0, y1 - y0]);
        }
      } else if (L === 'horizontal') {
        for (let i = 0; i < n; i++) { const x0 = Math.round(i * W / n), x1 = Math.round((i + 1) * W / n); rects.push([x0, 0, x1 - x0, H]); }
      } else {
        for (let i = 0; i < n; i++) { const y0 = Math.round(i * H / n), y1 = Math.round((i + 1) * H / n); rects.push([0, y0, W, y1 - y0]); }
      }
      this.panes.forEach((p, i) => {
        const [x, y, w, h] = rects[i];
        Object.assign(p.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
        p.el.classList.toggle('multi', multi);
        p.el.classList.toggle('stack-hidden', L === 'stack' && p !== this.focused);
      });
      this.updateFocusClasses();
      requestAnimationFrame(() => this.panes.forEach(p => p.doFit()));
      this.render();
    }

    nextLayout() {
      const ls = config.layouts.length ? config.layouts : ['tall'];
      this.layout = ls[(ls.indexOf(this.layout) + 1) % ls.length];
      this.arrange();
      toast(`Layout: ${this.layout}`);
    }

    title() {
      if (this.customTitle) return this.customTitle;
      const p = this.focused;
      if (!p) return 'neko';
      if (p.cwd) return basename(p.cwd) || p.cwd;
      return p.title || p.shellName || 'shell';
    }

    render() {
      if (this === activeTab) updateChrome();
      renderTabs();
    }
  }

  // ================================================================ tabs management
  async function newTab(opts = {}) {
    const cwd = opts.cwd !== undefined ? opts.cwd : (activeTab && activeTab.focused ? activeTab.focused.cwd : '');
    const t = new Tab();
    tabs.push(t);
    activateTab(t);
    await t.addPane({ cwd, shellId: opts.shellId });
    return t;
  }

  function activateTab(t) {
    if (activeTab && activeTab !== t) { activeTab.view.classList.remove('active'); activeTab.panes.forEach(p => p.hideSuggest()); }
    activeTab = t;
    t.view.classList.add('active');
    t.activity = false; t.bell = false; t.done = false;
    t.arrange();
    if (t.focused) t.focused.focus();
    updateChrome();
  }

  function closeTab(t) {
    const i = tabs.indexOf(t);
    if (i === -1) return;
    tabs.splice(i, 1);
    t.panes.slice().forEach(p => p.dispose());
    t.panes = [];
    t.view.remove();
    if (!tabs.length) { window.neko.window.close(); return; }
    if (activeTab === t) activateTab(tabs[Math.min(i, tabs.length - 1)]);
    renderTabs();
  }

  function moveTab(d) {
    const i = tabs.indexOf(activeTab);
    const j = i + d;
    if (j < 0 || j >= tabs.length) return;
    [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
    renderTabs();
  }

  function renderTabs() {
    const box = $('#tabs');
    box.innerHTML = '';
    tabs.forEach((t, i) => {
      const el = document.createElement('div');
      const cl = t.panes.filter(p => p.isClaude);
      const waiting = cl.some(p => p.cm.waiting), busy = cl.some(p => p.cm.busy);
      el.className = 'tab' + (t === activeTab ? ' active' : '') + (t.activity ? ' has-activity' : '') + (t.bell || waiting ? ' has-bell' : '') + (t.done ? ' has-done' : '');
      const count = t.panes.length > 1 ? `<span class="count">[${t.panes.length}]</span>` : '';
      const claude = cl.length ? `<span class="claude${busy ? ' busy' : ''}${waiting ? ' wait' : ''}" title="${waiting ? 'Claude wartet auf dich' : busy ? 'Claude arbeitet' : 'Claude Code'}">✳</span>` : '';
      const pr = (t.panes.find(p => p.progress) || {}).progress;
      const prog = pr ? `<span class="prog ${pr.state}" title="${pr.value != null ? pr.value + ' %' : pr.state}">${pr.state === 'value' && pr.value != null ? `<i style="width:${pr.value}%"></i>` : '<i></i>'}</span>` : '';
      const done = t.done && t !== activeTab ? '<span class="done" title="Claude ist fertig">✓</span>' : '';
      el.innerHTML = `<span class="num">${i + 1}</span>${claude}<span class="name">${escapeHtml(t.title())}</span>${count}${prog}${done}<span class="activity"></span>`;
      el.title = t.focused ? (t.focused.cwd || t.focused.title) : '';
      el.onmousedown = e => {
        if (e.button === 1) { e.preventDefault(); closeTab(t); }
        else if (e.button === 0) activateTab(t);
      };
      el.ondblclick = () => renameTab(t);
      box.appendChild(el);
    });
  }

  function updateChrome() {
    const t = activeTab;
    if (!t) return;
    const p = t.focused;
    applyTheme();
    const where = p ? (p.cwd || p.title || '') : '';
    $('#title').innerHTML = `${escapeHtml(p && p.shellName ? p.shellName : 'neko')} — <b>${escapeHtml(where)}</b>`;
    document.title = `${t.title()} — Neko`;
    $('#status').innerHTML = `<span class="lay">${LAYOUT_LABEL[t.layout] || t.layout}</span><span>${p && p.term ? `${p.term.cols}×${p.term.rows}` : ''}</span>`;
  }

  function renameTab(t) {
    openPalette({
      placeholder: 'Neuer Tab-Name (leer = automatisch)…',
      items: [],
      onSubmit: v => { t.customTitle = v.trim() || null; renderTabs(); updateChrome(); },
    });
  }

  // ================================================================ font size / config
  function changeFontSize(d) {
    if (d === 0) config.font_size = config._baseFont;
    else config.font_size = Math.max(7, Math.min(40, config.font_size + d));
    for (const t of tabs) for (const p of t.panes) p.term.options.fontSize = config.font_size;
    for (const t of tabs) t.arrange();
    toast(`Schriftgröße ${config.font_size}`);
  }

  function applyConfigToAll() {
    applyTheme(true);
    const o = termOptions();
    for (const t of tabs) for (const p of t.panes) {
      for (const k of ['fontFamily', 'fontSize', 'lineHeight', 'cursorStyle', 'cursorWidth', 'cursorBlink', 'cursorInactiveStyle', 'scrollback']) p.term.options[k] = o[k];
      p.term.options.theme = termTheme(p);
      p.cm.setActive(p.isClaude && claudeUiOn());
    }
    for (const t of tabs) t.arrange();
  }

  // ================================================================ Claude mode glue
  const claudeCtx = {
    globalKey: (e, pane) => handleGlobalKey(e, pane),
    toast: msg => toast(msg),
    relayout: pane => pane.relayout(),
    changed: pane => { if (pane.tab) renderTabs(); },
    // Claude is done or needs you: tab marker, and a message when you are looking elsewhere
    alert(pane, kind, text) {
      if (config.claude_notify === false) return;
      const here = document.hasFocus() && pane.tab === activeTab;
      if (here) return;
      if (pane.tab !== activeTab) { if (kind === 'done') pane.tab.done = true; else pane.tab.bell = true; renderTabs(); }
      const title = kind === 'done' ? 'Claude ist fertig' : 'Claude braucht dich';
      const body = String(text || (kind === 'done' ? 'Die Antwort ist da.' : 'Claude wartet auf eine Entscheidung.')).replace(/\s+/g, ' ').slice(0, 180);
      if (document.hasFocus()) P.card({ kind: 'notify', title, text: body, source: pane.tab.title(), claude: true, cwd: pane.cwd, onActivate: () => focusPane(pane) });
      else window.neko.ui.notify({ title: `${title} — ${pane.tab.title()}`, body, paneId: pane.id, force: true });
    },
  };

  let opacitySaveT = null;
  function changeOpacity(d) {
    const cur = Number(config.background_opacity ?? 0.82);
    config.background_opacity = Math.round(Math.max(0.2, Math.min(1, cur + d)) * 100) / 100;
    applyTheme();
    toast(`Transparenz ${Math.round((1 - config.background_opacity) * 100)} %`);
    clearTimeout(opacitySaveT);
    opacitySaveT = setTimeout(() => window.neko.config.set({ background_opacity: config.background_opacity }), 400);
  }

  async function setTheme(name) {
    config.theme = name;
    applyConfigToAll();
    await window.neko.config.set({ theme: name });
    toast(`Theme: ${name}`);
  }

  // ================================================================ keyboard shortcuts (kitty defaults)
  function handleGlobalKey(e, pane) {
    const cs = e.ctrlKey && e.shiftKey && !e.altKey;
    const k = e.key.toLowerCase();
    const t = activeTab;
    if (cs) {
      switch (e.code) {
        case 'KeyT': newTab(); return true;
        case 'KeyQ': closeTab(t); return true;
        case 'KeyW': t.removePane(t.focused); return true;
        case 'Enter': t.addPane({ cwd: t.focused.cwd, shellId: t.focused.shellId }, t.focused); return true;
        case 'KeyN': window.neko.window.newWindow(); return true;
        case 'KeyL': t.nextLayout(); return true;
        case 'BracketRight': t.cycleFocus(1); return true;
        case 'BracketLeft': t.cycleFocus(-1); return true;
        case 'KeyF': t.movePane(1); return true;
        case 'KeyB': t.movePane(-1); return true;
        case 'ArrowRight': activateTab(tabs[(tabs.indexOf(t) + 1) % tabs.length]); return true;
        case 'ArrowLeft': activateTab(tabs[(tabs.indexOf(t) - 1 + tabs.length) % tabs.length]); return true;
        case 'Period': moveTab(1); return true;
        case 'Comma': moveTab(-1); return true;
        case 'KeyC': if (pane.term.hasSelection()) { window.neko.clipboard.write(pane.term.getSelection()); toast('Kopiert'); } return true;
        case 'KeyV': pane.pasteClipboard(); return true;
        case 'Equal': case 'NumpadAdd': changeFontSize(1); return true;
        case 'Minus': case 'NumpadSubtract': changeFontSize(-1); return true;
        case 'Backspace': changeFontSize(0); return true;
        case 'ArrowUp': pane.term.scrollLines(-1); return true;
        case 'ArrowDown': pane.term.scrollLines(1); return true;
        case 'PageUp': pane.term.scrollPages(-1); return true;
        case 'PageDown': pane.term.scrollPages(1); return true;
        case 'Home': pane.term.scrollToTop(); return true;
        case 'End': pane.term.scrollToBottom(); return true;
        case 'KeyP': openCommandPalette(); return true;
        case 'KeyH': openSearch(); return true;
        case 'KeyK': pane.term.clear(); return true;
        case 'F2': window.neko.config.open(); return true;
        case 'F5': window.neko.config.get().then(c => { config = { ...c, _baseFont: c.font_size }; applyConfigToAll(); toast('Config neu geladen'); }); return true;
        case 'F11': window.neko.window.fullscreen(); return true;
      }
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m) { const tt = tabs[+m[1] - 1]; if (tt) activateTab(tt); return true; }
    }
    if (e.ctrlKey && e.shiftKey && e.altKey && e.code === 'KeyT') { renameTab(t); return true; }
    if (e.ctrlKey && e.shiftKey && e.altKey && e.code === 'KeyR') { runUpdate(false); return true; }
    if (e.ctrlKey && e.shiftKey && e.altKey && e.code === 'ArrowUp') { changeOpacity(0.05); return true; }
    if (e.ctrlKey && e.shiftKey && e.altKey && e.code === 'ArrowDown') { changeOpacity(-0.05); return true; }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'f' && false) return true;
    if (e.key === 'F11' && !e.ctrlKey && !e.shiftKey) { window.neko.window.fullscreen(); return true; }
    return false;
  }

  // ================================================================ command palette
  let paletteState = null;
  function fuzzy(q, s) {
    q = q.toLowerCase(); s = s.toLowerCase();
    if (!q) return 1;
    if (s.includes(q)) return 100 - s.indexOf(q);
    let i = 0;
    for (const c of s) if (c === q[i]) i++;
    return i === q.length ? 10 : 0;
  }
  function openPalette(state) {
    paletteState = { sel: 0, ...state };
    const bd = $('#palette-backdrop');
    bd.classList.remove('hidden');
    const inp = $('#palette-input');
    inp.value = '';
    inp.placeholder = state.placeholder || 'Befehl eingeben…';
    renderPalette();
    inp.focus();
  }
  function closePalette() {
    $('#palette-backdrop').classList.add('hidden');
    paletteState = null;
    if (activeTab && activeTab.focused) activeTab.focused.focus();
  }
  function paletteItems() {
    const q = $('#palette-input').value;
    return paletteState.items
      .map(it => ({ it, s: fuzzy(q, (it.group || '') + ' ' + it.label) }))
      .filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.it);
  }
  function renderPalette() {
    const list = $('#palette-list');
    const items = paletteItems();
    paletteState.sel = Math.min(paletteState.sel, Math.max(0, items.length - 1));
    list.innerHTML = items.map((it, i) => `<div class="row${i === paletteState.sel ? ' sel' : ''}" data-i="${i}"><span>${it.group ? `<span class="g">${escapeHtml(it.group)}:</span>` : ''}${escapeHtml(it.label)}</span><span class="k">${escapeHtml(it.keys || '')}</span></div>`).join('');
    list.querySelectorAll('.row').forEach(r => { r.onmousedown = e => { e.preventDefault(); runPaletteItem(items[+r.dataset.i]); }; });
    const sel = list.querySelector('.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function runPaletteItem(it) {
    const st = paletteState;
    closePalette();
    if (it) it.run();
    else if (st && st.onSubmit) st.onSubmit($('#palette-input').value);
  }
  $('#palette-input').addEventListener('input', () => { if (paletteState) { paletteState.sel = 0; renderPalette(); } });
  $('#palette-input').addEventListener('keydown', e => {
    if (!paletteState) return;
    const items = paletteItems();
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); paletteState.sel = Math.min(items.length - 1, paletteState.sel + 1); renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteState.sel = Math.max(0, paletteState.sel - 1); renderPalette(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (paletteState.onSubmit && !paletteState.items.length) { const st = paletteState; const v = $('#palette-input').value; closePalette(); st.onSubmit(v); }
      else runPaletteItem(items[paletteState.sel]);
    }
  });
  $('#palette-backdrop').addEventListener('mousedown', e => { if (e.target.id === 'palette-backdrop') closePalette(); });

  function openCommandPalette() {
    const t = activeTab;
    const items = [];
    for (const sh of shells) items.push({ group: 'Neuer Tab', label: sh.name, keys: sh.id === config.shell ? 'Ctrl+Shift+T' : '', run: () => newTab({ shellId: sh.id }) });
    for (const sh of shells) items.push({ group: 'Neues Fenster (Split)', label: sh.name, keys: sh.id === config.shell ? 'Ctrl+Shift+Enter' : '', run: () => t.addPane({ cwd: t.focused.cwd, shellId: sh.id }, t.focused) });
    for (const l of ['tall', 'fat', 'grid', 'horizontal', 'vertical', 'stack']) items.push({ group: 'Layout', label: l, keys: '', run: () => { t.layout = l; t.arrange(); } });
    for (const name of Object.keys(window.NEKO_THEMES)) items.push({ group: 'Theme', label: name + (name === config.theme ? '  ✓' : ''), run: () => setTheme(name) });
    for (const sh of shells) items.push({ group: 'Standard-Shell', label: sh.name + (sh.id === config.shell ? '  ✓' : ''), run: async () => { config.shell = sh.id; await window.neko.config.set({ shell: sh.id }); toast(`Standard-Shell: ${sh.name}`); } });
    items.push(
      { label: 'Neko aktualisieren (Shells bleiben offen)', keys: 'Ctrl+Shift+Alt+R', run: () => runUpdate(false) },
      { label: 'Neko neu starten (Tabs kommen zurück)', run: () => runUpdate(true) },
      { label: `Links dauerhaft unterstreichen ${config.link_underline === false ? 'einschalten' : 'ausschalten'}`, run: async () => { config.link_underline = config.link_underline === false; await window.neko.config.set({ link_underline: config.link_underline }); for (const tt of tabs) for (const p of tt.panes) p.links.schedule(); } },
      { label: 'Neko-Befehle anzeigen (neko help)', run: () => t.focused.id && window.neko.pty.write(t.focused.id, 'neko help\r') },
      { label: 'Nächstes Layout', keys: 'Ctrl+Shift+L', run: () => t.nextLayout() },
      { label: 'Fenster schließen', keys: 'Ctrl+Shift+W', run: () => t.removePane(t.focused) },
      { label: 'Tab schließen', keys: 'Ctrl+Shift+Q', run: () => closeTab(t) },
      { label: 'Tab umbenennen', keys: 'Ctrl+Shift+Alt+T', run: () => renameTab(t) },
      { label: 'Suchen', keys: 'Ctrl+Shift+H', run: () => openSearch() },
      { label: 'Bildschirm leeren', keys: 'Ctrl+Shift+K', run: () => t.focused.term.clear() },
      { label: 'Schrift größer', keys: 'Ctrl+Shift+=', run: () => changeFontSize(1) },
      { label: 'Schrift kleiner', keys: 'Ctrl+Shift+-', run: () => changeFontSize(-1) },
      { label: 'Schriftgröße zurücksetzen', keys: 'Ctrl+Shift+⌫', run: () => changeFontSize(0) },
      { label: `Claude-Oberfläche ${claudeUiOn() ? 'ausschalten' : 'einschalten'}`, run: async () => { config.claude_ui = !claudeUiOn(); await window.neko.config.set({ claude_ui: config.claude_ui }); applyConfigToAll(); toast(`Claude-Oberfläche ${config.claude_ui ? 'an' : 'aus'}`); } },
      { label: `Claude-Farben ${config.claude_theme ? 'ausschalten' : 'einschalten'}`, run: async () => { config.claude_theme = config.claude_theme ? '' : 'Claude'; await window.neko.config.set({ claude_theme: config.claude_theme }); applyConfigToAll(); } },
      { label: `Claude-Meldungen ${config.claude_notify === false ? 'einschalten' : 'ausschalten'}`, run: async () => { config.claude_notify = config.claude_notify === false; await window.neko.config.set({ claude_notify: config.claude_notify }); toast(`Claude-Meldungen ${config.claude_notify ? 'an' : 'aus'}`); } },
      { label: `Autofill ${config.autosuggest ? 'ausschalten' : 'einschalten'}`, run: async () => { config.autosuggest = !config.autosuggest; await window.neko.config.set({ autosuggest: config.autosuggest }); toast(`Autofill ${config.autosuggest ? 'an' : 'aus'}`); } },
      { label: 'Konfiguration öffnen (neko.json)', keys: 'Ctrl+Shift+F2', run: () => window.neko.config.open() },
      { label: 'Vollbild', keys: 'F11', run: () => window.neko.window.fullscreen() },
      { label: 'Durchsichtiger', keys: 'Ctrl+Shift+Alt+↓', run: () => changeOpacity(-0.05) },
      { label: 'Weniger durchsichtig', keys: 'Ctrl+Shift+Alt+↑', run: () => changeOpacity(0.05) },
      { label: `Cursor: ${config.cursor_shape === 'block' ? 'Strich |' : 'Block █'}`, run: async () => { config.cursor_shape = config.cursor_shape === 'block' ? 'bar' : 'block'; applyConfigToAll(); await window.neko.config.set({ cursor_shape: config.cursor_shape }); } },
      { label: 'Neues Fenster', keys: 'Ctrl+Shift+N', run: () => window.neko.window.newWindow() },
    );
    openPalette({ items });
  }

  // ================================================================ search
  const sb = $('#searchbar'), si = $('#search-input');
  const searchOpts = () => ({
    decorations: { matchBackground: theme.ui.popupSel, matchOverviewRuler: theme.ui.accent, activeMatchBackground: theme.ui.accent, activeMatchColorOverviewRuler: theme.ui.accent },
  });
  function openSearch() { sb.classList.remove('hidden'); si.focus(); si.select(); }
  function closeSearch() {
    sb.classList.add('hidden');
    const p = activeTab && activeTab.focused;
    if (p) { p.search.clearDecorations(); p.focus(); }
  }
  function doSearch(back) {
    const p = activeTab && activeTab.focused;
    if (!p || !si.value) return;
    if (back) p.search.findPrevious(si.value, searchOpts()); else p.search.findNext(si.value, searchOpts());
  }
  si.addEventListener('input', () => doSearch(false));
  si.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    else if (e.key === 'Enter') { e.preventDefault(); doSearch(e.shiftKey); }
  });
  $('#search-next').onclick = () => doSearch(false);
  $('#search-prev').onclick = () => doSearch(true);
  $('#search-close').onclick = closeSearch;

  // ================================================================ boot
  $('#newtab').onclick = () => newTab();
  window.addEventListener('keydown', e => {
    // shortcuts while focus is outside a terminal (palette, search)
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyP' && !paletteState) { e.preventDefault(); openCommandPalette(); }
  });
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (activeTab) activeTab.arrange(); }, 30);
  });

  // ================================================================ frameless window chrome
  $('#win-min').addEventListener('click', () => window.neko.window.minimize());
  $('#win-max').addEventListener('click', () => window.neko.window.maximize());
  $('#win-close').addEventListener('click', () => window.neko.window.close());
  $('#titlebar').addEventListener('dblclick', e => { if (!e.target.closest('#winctl')) window.neko.window.maximize(); });
  window.neko.window.onState(st => {
    document.body.classList.toggle('maximized', !!st.maximized);
    document.body.classList.toggle('fullscreen', !!st.fullscreen);
    $('#win-max').title = st.maximized ? 'Wiederherstellen' : 'Maximieren';
  });
  for (const h of document.querySelectorAll('.rz')) {
    h.addEventListener('pointerdown', e => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      window.neko.window.resizeStart(h.dataset.edge);
    });
    const stop = () => window.neko.window.resizeStop();
    h.addEventListener('pointerup', stop);
    h.addEventListener('lostpointercapture', stop);
  }

  // ================================================================ update / session restore
  async function runUpdate(restart) {
    toast(restart ? 'Neko startet neu…' : 'Neko wird aktualisiert…');
    const r = await window.neko.app.update({ restart });
    if (r && r.error) P.card({ kind: 'popup', title: 'Update nicht möglich', text: r.error });
  }

  function snapshot() {
    return {
      active: tabs.indexOf(activeTab),
      fontSize: config.font_size,
      tabs: tabs.map(t => ({
        layout: t.layout,
        customTitle: t.customTitle,
        focused: t.panes.indexOf(t.focused),
        panes: t.panes.map(p => ({ ptyId: p.id, cwd: p.cwd, shellId: p.shellId })),
      })),
    };
  }

  // rebuild tabs after a hot update (shells still running) or a restart (new shells in the same folders)
  async function restoreSession(snap, live) {
    const byId = new Map(live.map(l => [l.id, l]));
    const used = new Set();
    if (snap && snap.tabs) {
      if (snap.fontSize) config.font_size = snap.fontSize;
      for (const st of snap.tabs) {
        if (!st.panes || !st.panes.length) continue;
        const t = new Tab();
        t.layout = st.layout || t.layout;
        t.customTitle = st.customTitle || null;
        tabs.push(t);
        activateTab(t);
        for (const ps of st.panes) {
          const att = byId.get(ps.ptyId);
          if (att) used.add(att.id);
          await t.addPane({ cwd: ps.cwd || (att && att.cwd) || '', shellId: ps.shellId, attach: att });
        }
        if (st.focused >= 0 && t.panes[st.focused]) t.setFocused(t.panes[st.focused], false);
      }
    }
    // shells without a saved layout (e.g. the renderer reloaded on its own)
    for (const l of live) {
      if (used.has(l.id)) continue;
      const t = new Tab();
      tabs.push(t);
      activateTab(t);
      await t.addPane({ cwd: l.cwd, shellId: l.shell, attach: l });
    }
    if (!tabs.length) return false;
    activateTab(tabs[Math.max(0, Math.min(snap && snap.active >= 0 ? snap.active : 0, tabs.length - 1))]);
    return true;
  }

  function findPane(id) {
    for (const t of tabs) for (const p of t.panes) if (p.id === id) return p;
    return null;
  }
  function focusPane(p) {
    if (!p) return;
    if (p.tab !== activeTab) activateTab(p.tab);
    p.tab.setFocused(p);
    p.focus();
  }
  window.NekoConfig = () => config || {};
  window.NekoRefocus = () => { if (activeTab && activeTab.focused) activeTab.focused.focus(); };
  // debug (NEKO_STEPS "eval"): the focused pane
  window.__nekoPane = () => activeTab && activeTab.focused;
  // debug (NEKO_STEPS "dump"): text of the focused pane
  window.__nekoDump = () => {
    const p = activeTab && activeTab.focused;
    if (!p) return '';
    const b = p.term.buffer.active;
    const out = [];
    for (let y = 0; y < b.length; y++) out.push(b.getLine(y).translateToString(true));
    return out.join('\n').replace(/\n+$/, '');
  };

  // requests from the "neko" command and the main process
  async function handleUiRequest(req) {
    const pane = findPane(req.paneId) || (activeTab && activeTab.focused);
    const source = pane ? pane.tab.title() : '';
    const common = { source, cwd: pane ? pane.cwd : '', claude: pane ? pane.isClaude : false, onActivate: () => focusPane(pane), refocus: () => window.NekoRefocus() };
    switch (req.type) {
      case 'snapshot': return snapshot();
      case 'img': {
        if (req.mode === 'inline' && pane) return pane.addInlineImage(req, req.maxRows, req.maxCols);
        P.card({ ...common, kind: 'popup', title: req.title || req.name, image: req, timeout: 0 });
        return { ok: true, popup: true };
      }
      case 'popup': case 'notify':
        P.card({ ...common, kind: req.type, title: req.title, text: req.text, image: req.image, links: req.links, timeout: req.timeout });
        if (pane && pane.tab !== activeTab) { pane.tab.bell = true; renderTabs(); }
        return { ok: true };
      case 'ask':
        if (pane && pane.tab !== activeTab) { pane.tab.bell = true; renderTabs(); }
        return P.card({ ...common, kind: 'ask', title: req.title, text: req.text, image: req.image, buttons: req.buttons, input: req.input, placeholder: req.placeholder, timeout: req.timeout });
      case 'progress':
        if (pane) pane.setProgress(req.state === 'value' ? 'value' : req.state, req.value);
        return { ok: true };
      default: return { error: `unbekannt: ${req.type}` };
    }
  }

  async function boot() {
    config = await window.neko.config.get();
    config._baseFont = config.font_size;
    applyTheme();
    try { await document.fonts.load(`${config.font_size}px "JetBrains Mono"`); await document.fonts.load(`bold ${config.font_size}px "JetBrains Mono"`); } catch {}
    shells = await window.neko.shells();
    const hist = await window.neko.history.load();
    const seen = new Set();
    const dedup = [];
    for (let i = hist.length - 1; i >= 0; i--) { const h = hist[i].trim(); if (h && !seen.has(h)) { seen.add(h); dedup.push(h); } }
    S.store.history = dedup.reverse();
    S.store.commands = await window.neko.commands();
    setTimeout(async () => { S.store.commands = await window.neko.commands(); }, 6000);
    window.neko.config.onChange(c => { const base = config._baseFont; config = { ...c, _baseFont: c.font_size || base }; applyConfigToAll(); });
    window.neko.ui.onRequest(handleUiRequest);
    window.neko.ui.onFocusPane(id => focusPane(findPane(id)));
    window.neko.claude.onEvent(ev => { const p = findPane(ev.paneId); if (p) p.cm.onHook(ev); });
    const { snapshot: snap, live } = await window.neko.session.restore();
    if (!(await restoreSession(snap, live || []))) await newTab({ cwd: '' });
    window.neko.app.info().then(i => { if (i.bootError) P.card({ kind: 'popup', title: 'Quellordner fehlerhaft', text: 'Neko läuft mit der Version aus der exe, weil main.js im Quellordner nicht geladen werden konnte:\n' + i.bootError.split('\n')[0] }); });
  }
  boot();
})();
