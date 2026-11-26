/* Neko Terminal – Claude mode: an app-like input box, buttons and status around a running Claude Code.
   Claude Code keeps running unchanged in the terminal; this layer types into it for you. */
(() => {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const KEY = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', shiftTab: '\x1b[Z', ctrlC: '\x03' };
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  // the window title while Claude works starts with a spinner glyph, "✳" when idle
  const BUSY_TITLE = /^[✶✻✽✢·*⠁-⣿◐◑◒◓]\s/;

  const BUILTIN = [
    ['clear', 'Unterhaltung leeren und neu anfangen'],
    ['compact', 'Verlauf zusammenfassen, Kontext frei machen'],
    ['model', 'Modell wählen'],
    ['resume', 'Frühere Unterhaltung fortsetzen'],
    ['context', 'Zeigen, was den Kontext füllt'],
    ['rewind', 'Zu einem früheren Stand zurück'],
    ['effort', 'Wie gründlich Claude nachdenkt'],
    ['init', 'CLAUDE.md für das Projekt anlegen'],
    ['memory', 'Gedächtnis-Dateien bearbeiten'],
    ['permissions', 'Erlaubte Befehle verwalten'],
    ['config', 'Einstellungen'],
    ['mcp', 'MCP-Server verwalten'],
    ['agents', 'Subagents verwalten'],
    ['hooks', 'Hooks verwalten'],
    ['usage', 'Verbrauch und Limits'],
    ['status', 'Version, Modell, Konto'],
    ['export', 'Unterhaltung exportieren'],
    ['add-dir', 'Weiteren Ordner freigeben'],
    ['doctor', 'Installation prüfen'],
    ['help', 'Hilfe'],
    ['exit', 'Claude beenden'],
  ].map(([name, desc]) => ({ name, desc, kind: 'builtin' }));

  const MODES = [
    [/accept edits on/i, 'Bearbeiten erlaubt', 'edits'],
    [/plan mode on/i, 'Planen', 'plan'],
    [/auto mode on/i, 'Auto', 'auto'],
    [/bypass permissions on/i, 'Ohne Nachfrage', 'bypass'],
  ];

  // prompts the user sent from the input box, newest last (shared by all panes)
  const HIST_KEY = 'neko.claude.history';
  let history = [];
  try { history = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch {}
  function pushHistory(t) {
    history = history.filter(h => h !== t);
    history.push(t);
    if (history.length > 200) history = history.slice(-200);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(history)); } catch {}
  }

  function prettyModel(m) {
    if (!m) return '';
    const x = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(m);
    if (!x) return m.replace(/^claude-/, '');
    return x[1][0].toUpperCase() + x[1].slice(1) + ' ' + x[2] + (x[3] ? '.' + x[3] : '');
  }
  function fmtTokens(n) { return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0); }
  function fmtTime(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

  class ClaudeUI {
    constructor(pane, ctx) {
      this.pane = pane;
      this.ctx = ctx;
      this.on = false;
      this.menu = null;        // { title, options: [{ label, desc, num }], selected }
      this.mode = { label: 'Normal', id: 'normal' };
      this.st = { hooked: false, busy: false, since: 0, waiting: null, model: '', ctx: 0, activity: '', lastText: '' };
      this.chips = [];         // attached images: { path, dataUrl }
      this.histIdx = -1;
      this.draft = '';
      this.autoTerm = false;   // focus went to the terminal because a menu opened
      // no input box of our own: typing always goes straight to Claude's own prompt in the terminal
      this.termMode = true;
      this.slash = null;       // { items, sel }
      this.commands = null;
      this.build();
    }

    // ------------------------------------------------------------ DOM
    build() {
      const el = this.el = document.createElement('div');
      el.className = 'cc hidden';
      el.innerHTML = `
        <div class="cc-menu hidden"></div>
        <div class="cc-slash hidden"></div>
        <div class="cc-box">
          <div class="cc-chips hidden"></div>
          <textarea class="cc-input" rows="1" spellcheck="false" placeholder="Schreib Claude eine Nachricht …"></textarea>
          <div class="cc-row">
            <button class="cc-btn cc-attach" title="Bild oder Datei anhängen (auch per Drag &amp; Drop oder Strg+V)">＋</button>
            <button class="cc-btn cc-mode" title="Modus wechseln (Shift+Tab)"></button>
            <span class="cc-sp"></span>
            <span class="cc-hint">Enter senden · Shift+Enter neue Zeile</span>
            <button class="cc-btn cc-term" title="Direkt ins Terminal tippen">⌨</button>
            <button class="cc-send" title="Senden (Enter)"></button>
          </div>
        </div>
        <div class="cc-bar">
          <div class="cc-quick">
            <button data-cmd="/clear" title="Unterhaltung leeren (zweimal klicken)">Neu</button>
            <button data-cmd="/compact" title="Verlauf zusammenfassen">Komprimieren</button>
            <button data-cmd="/model" title="Modell wählen">Modell</button>
            <button data-cmd="/resume" title="Frühere Unterhaltung fortsetzen">Fortsetzen</button>
            <button data-cmd="/context" title="Was den Kontext füllt">Kontext</button>
          </div>
          <div class="cc-status"></div>
        </div>`;
      this.pane.el.appendChild(el);
      this.ta = el.querySelector('.cc-input');
      this.menuEl = el.querySelector('.cc-menu');
      this.slashEl = el.querySelector('.cc-slash');
      this.chipsEl = el.querySelector('.cc-chips');
      this.statusEl = el.querySelector('.cc-status');
      this.modeBtn = el.querySelector('.cc-mode');
      this.sendBtn = el.querySelector('.cc-send');

      this.ta.addEventListener('input', () => { this.autosize(); this.updateSlash(); this.renderSend(); this.saveDraft(); });
      this.ta.addEventListener('keydown', e => this.onKey(e));
      this.ta.addEventListener('focus', () => { this.termMode = false; this.pane.tab.setFocused(this.pane, false); this.el.classList.add('focus'); });
      this.ta.addEventListener('blur', () => { this.el.classList.remove('focus'); setTimeout(() => this.hideSlash(), 120); });
      this.ta.addEventListener('paste', e => this.onPaste(e));
      el.querySelector('.cc-attach').onclick = () => this.pickFiles();
      this.modeBtn.onclick = () => { this.write(KEY.shiftTab); this.refocus(); };
      el.querySelector('.cc-term').onclick = () => { this.termMode = true; this.pane.term.focus(); this.ctx.toast('Tippen geht jetzt direkt an Claude im Terminal. Ein Klick ins Eingabefeld holt es zurück.'); };
      this.sendBtn.onclick = () => { if (this.showStop()) this.write(KEY.esc); else this.send(); this.refocus(); };
      for (const b of el.querySelectorAll('.cc-quick button')) b.onclick = () => this.quick(b);
      // clicks on empty parts of the dock focus the input
      el.addEventListener('mousedown', e => { if (!e.target.closest('button,.cc-menu')) { e.preventDefault(); this.pane.term.focus(); } });
      new ResizeObserver(() => this.ctx.relayout(this.pane)).observe(el);
      this.restoreDraft();
      this.render();
    }

    setActive(on) {
      if (on === this.on) return;
      this.on = on;
      this.el.classList.toggle('hidden', !on);
      this.pane.el.classList.toggle('cc-on', on);
      if (on) {
        this.scan();
        if (this.pane.tab.focused === this.pane && this.pane.tab.isActive()) this.focus();
      } else {
        this.setMenu(null);
        this.hideSlash();
        clearInterval(this.tick); this.tick = null;
        if (document.activeElement === this.ta) this.pane.term.focus();
      }
      this.ctx.relayout(this.pane);
    }

    height() { return this.on ? this.el.offsetHeight : 0; }

    focus(insert) {
      if (!this.on || this.termMode) return this.pane.term.focus();
      if (this.menu) { this.pane.term.focus(); return; }
      this.ta.focus();
      if (insert) {
        const s = this.ta.selectionStart, e = this.ta.selectionEnd;
        this.ta.setRangeText(insert, s, e, 'end');
        this.ta.dispatchEvent(new Event('input'));
      }
    }
    refocus() { this.pane.term.focus(); }
    hasFocus() { return document.activeElement === this.ta; }

    write(d) { if (this.pane.id) window.neko.pty.write(this.pane.id, d); }

    // ------------------------------------------------------------ input box keys
    onKey(e) {
      if (this.ctx.globalKey(e, this.pane)) { e.preventDefault(); return; }
      const empty = !this.ta.value && !this.chips.length;
      if (this.slash) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = this.slash.items.length;
          this.slash.sel = (this.slash.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
          this.renderSlash();
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          const it = this.slash.items[this.slash.sel];
          this.ta.value = `/${it.name} `;
          this.hideSlash();
          this.autosize();
          if (e.key === 'Enter') this.send();
          return;
        }
        if (e.key === 'Escape') { e.preventDefault(); this.hideSlash(true); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (empty) this.write(KEY.enter); else this.send();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); this.write(KEY.esc); return; }
      if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); this.write(KEY.shiftTab); return; }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'c' && empty && this.ta.selectionStart === this.ta.selectionEnd) {
        e.preventDefault(); this.write(KEY.ctrlC); return;
      }
      // history: arrow up on the first line / down on the last line
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        const v = this.ta.value, pos = this.ta.selectionStart;
        const firstLine = !v.slice(0, pos).includes('\n');
        const lastLine = !v.slice(pos).includes('\n');
        if (e.key === 'ArrowUp' && firstLine && history.length && (this.histIdx >= 0 || !v || pos === 0)) {
          e.preventDefault();
          if (this.histIdx < 0) { this.draft = v; this.histIdx = history.length; }
          this.histIdx = Math.max(0, this.histIdx - 1);
          this.setText(history[this.histIdx]);
          return;
        }
        if (e.key === 'ArrowDown' && lastLine && this.histIdx >= 0) {
          e.preventDefault();
          this.histIdx++;
          if (this.histIdx >= history.length) { this.histIdx = -1; this.setText(this.draft); }
          else this.setText(history[this.histIdx]);
          return;
        }
      }
    }

    setText(t) {
      this.ta.value = t || '';
      this.ta.selectionStart = this.ta.selectionEnd = this.ta.value.length;
      this.autosize(); this.renderSend(); this.saveDraft();
    }

    autosize() {
      this.ta.style.height = 'auto';
      this.ta.style.height = `${Math.min(this.ta.scrollHeight, 220)}px`;
    }

    // ------------------------------------------------------------ sending
    async send() {
      if (this.sending || !this.pane.id) return;
      const text = this.ta.value.replace(/\s+$/, '');
      const imgs = this.chips.slice();
      if (!text.trim() && !imgs.length) return;
      this.sending = true;
      try {
        // image paths become attachments in Claude Code when they are pasted on their own
        for (const c of imgs) { this.pane.term.paste(this.pane.quotePath(c.path)); await sleep(150); this.pane.term.paste(' '); await sleep(40); }
        if (text) this.pane.term.paste(text);
        await sleep(text.length > 2000 ? 260 : 90);
        this.write(KEY.enter);
        if (text.trim()) pushHistory(text);
      } finally { this.sending = false; }
      this.histIdx = -1;
      this.chips = [];
      this.renderChips();
      this.setText('');
      this.hideSlash();
    }

    async quick(btn) {
      const cmd = btn.dataset.cmd;
      if (cmd === '/clear' && !btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.textContent = 'Wirklich leeren?';
        clearTimeout(btn._t);
        btn._t = setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = 'Neu'; }, 2500);
        return;
      }
      if (cmd === '/clear') { clearTimeout(btn._t); btn.classList.remove('confirm'); btn.textContent = 'Neu'; }
      await this.runCommand(cmd);
    }

    async runCommand(cmd) {
      if (!this.pane.id) return;
      this.pane.term.paste(cmd);
      await sleep(120);
      this.write(KEY.enter);
      this.refocus();
    }

    // ------------------------------------------------------------ attachments
    async addPaths(paths) {
      const other = [];
      for (const p of paths) {
        if (IMG_RE.test(p)) {
          const r = await window.neko.loadImage(p, this.pane.cwd);
          this.chips.push({ path: p, dataUrl: r && !r.error ? r.dataUrl : '' });
        } else other.push(this.pane.quotePath(p));
      }
      this.renderChips();
      if (other.length) this.focus((this.ta.value && !/\s$/.test(this.ta.value) ? ' ' : '') + other.join(' ') + ' ');
      else this.ta.focus();
      this.renderSend();
    }

    async pickFiles() {
      const paths = await window.neko.dialog.openFiles();
      if (paths && paths.length) await this.addPaths(paths);
      else this.ta.focus();
    }

    async onPaste(e) {
      const dt = e.clipboardData;
      if (!dt) return;
      const text = dt.getData('text/plain');
      const files = [...(dt.files || [])];
      if (files.length) {
        const paths = files.map(f => window.neko.pathForFile(f)).filter(Boolean);
        if (paths.length) { e.preventDefault(); await this.addPaths(paths); return; }
      }
      if (!text && [...dt.items].some(i => i.type.startsWith('image/'))) {
        e.preventDefault();
        const p = await window.neko.clipboard.saveImage();
        if (p) await this.addPaths([p]);
      }
    }

    renderChips() {
      this.chipsEl.classList.toggle('hidden', !this.chips.length);
      this.chipsEl.innerHTML = this.chips.map((c, i) => `<div class="cc-chip" data-i="${i}" title="${esc(c.path)}">${c.dataUrl ? `<img src="${c.dataUrl}" alt="">` : '<span class="cc-chip-ic">▣</span>'}<span class="cc-chip-name">${esc(c.path.split(/[\\/]/).pop())}</span><button title="Entfernen">✕</button></div>`).join('');
      this.chipsEl.querySelectorAll('.cc-chip').forEach(ch => {
        ch.querySelector('button').onclick = () => { this.chips.splice(+ch.dataset.i, 1); this.renderChips(); this.renderSend(); this.ta.focus(); };
        const img = ch.querySelector('img');
        if (img) img.onclick = () => window.NekoPopups.lightbox({ dataUrl: this.chips[+ch.dataset.i].dataUrl, name: ch.title, src: ch.title });
      });
    }

    // ------------------------------------------------------------ slash commands
    async updateSlash() {
      const v = this.ta.value;
      const m = /^\/([^\s]*)$/.exec(v);
      if (!m || this.slashClosedFor === v) { this.hideSlash(); return; }
      if (!this.commands) {
        let own = [];
        try { own = await window.neko.claude.commands(this.pane.cwd); } catch {}
        this.commands = [...BUILTIN, ...own];
      }
      const q = m[1].toLowerCase();
      const items = this.commands
        .map(c => ({ c, s: c.name.toLowerCase().startsWith(q) ? 2 : c.name.toLowerCase().includes(q) ? 1 : 0 }))
        .filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.c).slice(0, 40);
      if (!items.length) { this.hideSlash(); return; }
      this.slash = { items, sel: 0 };
      this.renderSlash();
    }
    renderSlash() {
      const s = this.slash;
      if (!s) return;
      const kind = { builtin: '', command: 'Befehl', skill: 'Skill' };
      this.slashEl.innerHTML = s.items.map((c, i) => `<div class="cc-slash-item${i === s.sel ? ' sel' : ''}" data-i="${i}"><span class="n">/${esc(c.name)}</span><span class="d">${esc(c.desc || '')}</span><span class="k">${kind[c.kind] || ''}</span></div>`).join('');
      this.slashEl.classList.remove('hidden');
      this.slashEl.querySelectorAll('.cc-slash-item').forEach(it => {
        it.onmousedown = ev => { ev.preventDefault(); s.sel = +it.dataset.i; this.ta.value = `/${s.items[s.sel].name} `; this.hideSlash(); this.autosize(); this.ta.focus(); };
      });
      const sel = this.slashEl.querySelector('.sel');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
    hideSlash(byUser) {
      if (byUser) this.slashClosedFor = this.ta.value;
      this.slash = null;
      this.slashEl.classList.add('hidden');
    }

    // ------------------------------------------------------------ reading Claude's screen
    // mode line ("⏵⏵ accept edits on") and selection menus ("❯ 1. Yes") at the bottom of the screen
    scan() {
      if (!this.on) return;
      const term = this.pane.term;
      const b = term.buffer.active;
      const lines = [];
      for (let y = 0; y < term.rows; y++) {
        const l = b.getLine(b.baseY + y);
        lines.push(l ? l.translateToString(true) : '');
      }
      let mode = { label: 'Normal', id: 'normal' };
      for (const l of lines.slice(-6)) for (const [re, label, id] of MODES) if (re.test(l)) mode = { label, id };
      if (mode.id !== this.mode.id) { this.mode = mode; this.renderMode(); }
      this.setMenu(this.findMenu(lines));
    }

    findMenu(lines) {
      let ci = -1;
      for (let y = lines.length - 1; y >= Math.max(0, lines.length - 40); y--) {
        if (!/^\s*❯( |$)/.test(lines[y])) continue;
        // Claude's own input box (prompt line right under a horizontal rule) is only shown when no
        // menu is open; "❯ text" above it are earlier prompts in the conversation
        if (/^\s*[─━▔]{6,}/.test(lines[y - 1] || '')) return null;
        if (!/^\s*❯ \S/.test(lines[y])) continue;
        ci = y; break;
      }
      if (ci < 0) return null;
      const col = lines[ci].indexOf('❯');
      const start = col + 2;
      const indent = s => s.length - s.trimStart().length;
      const isOpt = s => s.trim() && indent(s) === start;
      const isCont = s => s.trim() && indent(s) > start;
      let a = ci;
      while (a - 1 >= 0 && (isOpt(lines[a - 1]) || isCont(lines[a - 1]))) a--;
      while (a < ci && !isOpt(lines[a])) a++;
      let z = ci;
      while (z + 1 < lines.length && (isOpt(lines[z + 1]) || isCont(lines[z + 1]))) z++;
      const options = [];
      let selected = -1;
      for (let y = a; y <= z; y++) {
        const raw = lines[y];
        // "↓ 4 more" only says the list scrolls
        if (y !== ci && /^\s*[↑↓]\s*\d+\s+more/.test(raw)) continue;
        if (y === ci) { selected = options.length; options.push(raw.slice(start)); }
        else if (isOpt(raw)) options.push(raw.slice(start));
        else if (options.length) options[options.length - 1] += ' ' + raw.trim();
      }
      if (options.length < 2 || selected < 0) return null;
      // title: the question above the options ("Do you want to proceed?"), else the dialog's heading
      let title = '', top = Math.max(0, a - 14);
      for (let y = a - 1; y >= Math.max(0, a - 14); y--) {
        const t = lines[y].trim();
        if (/^[─━▔]{6,}/.test(t)) { top = y + 1; break; }
        if (!title && /\?(\s|\(|$)/.test(t)) title = t.replace(/\s*\(.*$/, '');
      }
      if (!title) for (let y = top; y < a; y++) { const t = lines[y].trim(); if (t) { title = t.replace(/:$/, ''); break; } }
      return {
        title: title.slice(0, 220),
        selected,
        options: options.map(o => {
          const t = o.replace(/✔/g, '').trim();
          const num = (/^(\d+)\.\s+/.exec(t) || [])[1] || '';
          const rest = t.replace(/^\d+\.\s+/, '').replace(/^▸\s*/, '');
          const parts = rest.split(/\s{2,}/);
          return { num, label: parts[0], desc: parts.slice(1).join(' · ') };
        }),
      };
    }

    setMenu(menu) {
      const key = menu ? JSON.stringify(menu) : '';
      if (key === this.menuKey) return;
      const had = !!this.menu;
      this.menu = menu;
      this.menuKey = key;
      if (menu) {
        this.menuEl.innerHTML = `${menu.title ? `<div class="cc-menu-title"><span class="cc-menu-ic">✳</span>${esc(menu.title)}</div>` : ''}<div class="cc-menu-opts">${menu.options.map((o, i) => `<button class="cc-opt${i === menu.selected ? ' sel' : ''}" data-i="${i}">${o.num ? `<span class="num">${esc(o.num)}</span>` : ''}<span class="lb">${esc(o.label)}</span>${o.desc ? `<span class="ds">${esc(o.desc)}</span>` : ''}</button>`).join('')}</div><div class="cc-menu-hint">Klicken oder mit ↑ ↓ und Enter wählen · Esc bricht ab</div>`;
        this.menuEl.querySelectorAll('.cc-opt').forEach(b => { b.onclick = () => this.choose(+b.dataset.i); });
        this.menuEl.classList.remove('hidden');
        // keys belong to the menu now: let the terminal have them
        if (!had && this.hasFocus()) { this.autoTerm = true; this.pane.term.focus(); }
      } else {
        this.menuEl.classList.add('hidden');
        this.menuEl.innerHTML = '';
        // the question was answered
        if (had && this.st.waiting) { this.st.waiting = null; this.render(); }
        if (had && this.autoTerm) {
          this.autoTerm = false;
          if (!this.termMode && this.pane.tab.focused === this.pane && document.activeElement === this.pane.term.textarea) this.ta.focus();
        }
      }
      this.el.classList.toggle('menu-open', !!menu);
    }

    async choose(i) {
      const m = this.menu;
      if (!m) return;
      const d = i - m.selected;
      this.write((d > 0 ? KEY.down : KEY.up).repeat(Math.abs(d)));
      await sleep(80);
      this.write(KEY.enter);
      this.pane.term.focus();
    }

    // ------------------------------------------------------------ state from hooks / title
    applyState(st) {
      if (!st) return;
      const wasBusy = this.st.busy;
      this.st = { ...this.st, ...st };
      if (this.st.busy && !wasBusy && !this.st.since) this.st.since = Date.now();
      this.render();
    }

    onHook(ev) {
      const prev = this.st;
      this.applyState(ev.state);
      if (ev.event === 'Stop' && prev.busy) this.ctx.alert(this.pane, 'done', this.st.lastText);
      if (ev.event === 'Notification' && this.st.waiting) this.ctx.alert(this.pane, 'need', this.st.waiting);
    }

    // without hooks (Claude started from cmd or Git Bash) the window title tells busy / idle
    onTitle(t) {
      if (this.st.hooked) return;
      const busy = BUSY_TITLE.test(t || '');
      if (busy === this.st.busy) return;
      this.st.busy = busy;
      this.st.since = busy ? Date.now() : 0;
      this.render();
      if (!busy) this.ctx.alert(this.pane, 'done', '');
    }

    get busy() { return !!this.st.busy; }
    get waiting() { return !!this.st.waiting; }

    showStop() { return this.st.busy && !this.ta.value && !this.chips.length; }

    renderSend() {
      const stop = this.showStop();
      this.sendBtn.classList.toggle('stop', stop);
      this.sendBtn.classList.toggle('ready', !stop && !!(this.ta.value.trim() || this.chips.length));
      this.sendBtn.innerHTML = stop ? '<i class="sq"></i>' : '<svg viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>';
      this.sendBtn.title = stop ? 'Claude stoppen (Esc)' : 'Senden (Enter)';
    }

    renderMode() {
      this.modeBtn.textContent = `⇄ ${this.mode.label}`;
      this.modeBtn.dataset.mode = this.mode.id;
    }

    render() {
      this.renderMode();
      this.renderSend();
      const st = this.st;
      const parts = [];
      let dot = 'idle', text = 'bereit';
      if (st.waiting) { dot = 'wait'; text = 'wartet auf dich'; }
      else if (st.busy) { dot = 'busy'; text = `arbeitet${st.since ? ' · ' + fmtTime(Date.now() - st.since) : ''}${st.activity ? ' · ' + st.activity : ''}`; }
      parts.push(`<span class="cc-state ${dot}"><i></i>${esc(text)}</span>`);
      if (st.model) parts.push(`<span class="cc-model">${esc(prettyModel(st.model))}</span>`);
      if (st.ctx) {
        const limit = st.ctx > 200000 ? 1000000 : 200000;
        const pct = Math.min(100, Math.round(st.ctx / limit * 100));
        parts.push(`<span class="cc-ctx${pct >= 80 ? ' high' : ''}" title="Kontext: ${st.ctx.toLocaleString('de-DE')} von ${limit.toLocaleString('de-DE')} Tokens"><b><i style="width:${pct}%"></i></b>${pct} %</span>`);
      }
      this.statusEl.innerHTML = parts.join('');
      this.el.classList.toggle('busy', !!st.busy);
      if (st.busy && !this.tick) this.tick = setInterval(() => this.render(), 1000);
      if (!st.busy && this.tick) { clearInterval(this.tick); this.tick = null; }
      this.ctx.changed(this.pane);
    }

    // ------------------------------------------------------------ drafts survive a hot update
    saveDraft() { if (this.pane.id) try { sessionStorage.setItem(`neko.claude.draft.${this.pane.id}`, this.ta.value); } catch {} }
    restoreDraft() {
      if (!this.pane.id) return;
      try { const d = sessionStorage.getItem(`neko.claude.draft.${this.pane.id}`); if (d) { this.ta.value = d; this.autosize(); } } catch {}
    }

    dispose() {
      clearInterval(this.tick);
      if (this.pane.id) try { sessionStorage.removeItem(`neko.claude.draft.${this.pane.id}`); } catch {}
      this.el.remove();
    }
  }

  window.NekoClaude = { create: (pane, ctx) => new ClaudeUI(pane, ctx), prettyModel, BUSY_TITLE };
})();
