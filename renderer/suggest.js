// Autofill engine: fish-style ghost text + completion popup.
// Sources: command history, commands on PATH / PowerShell cmdlets, sub-commands of common tools, file paths.
(function () {
  const SUBCOMMANDS = {
    git: ['add', 'add .', 'branch', 'checkout', 'checkout -b', 'cherry-pick', 'clone', 'commit', 'commit -m "', 'commit --amend', 'diff', 'diff --staged', 'fetch', 'init', 'log', 'log --oneline --graph', 'merge', 'pull', 'push', 'push -u origin', 'rebase', 'remote -v', 'reset', 'restore', 'revert', 'stash', 'stash pop', 'status', 'switch', 'tag'],
    npm: ['install', 'install -D', 'run', 'run dev', 'run build', 'run start', 'test', 'start', 'init -y', 'uninstall', 'update', 'outdated', 'ls', 'publish', 'ci', 'audit fix'],
    npx: ['create-react-app', 'create-vite@latest', 'tsc', 'prettier --write .', 'eslint .'],
    pnpm: ['install', 'add', 'add -D', 'run', 'dev', 'build', 'remove', 'update'],
    yarn: ['add', 'add -D', 'install', 'run', 'dev', 'build', 'remove'],
    winget: ['install', 'search', 'upgrade', 'upgrade --all', 'uninstall', 'list', 'show'],
    docker: ['ps', 'ps -a', 'images', 'run', 'run -it', 'build -t', 'exec -it', 'logs -f', 'compose up', 'compose up -d', 'compose down', 'pull', 'stop', 'rm', 'rmi'],
    pip: ['install', 'install -r requirements.txt', 'uninstall', 'list', 'freeze', 'show'],
    python: ['-m venv .venv', '-m pip install', '-m http.server'],
    code: ['.', '-r', '--diff'],
    choco: ['install', 'upgrade all', 'list', 'search', 'uninstall'],
    cargo: ['build', 'build --release', 'run', 'test', 'new', 'add', 'check', 'clippy', 'fmt'],
    dotnet: ['new', 'build', 'run', 'test', 'add package', 'restore', 'publish'],
  };
  const PATH_HINT_CMDS = new Set(['cd', 'set-location', 'sl', 'chdir', 'pushd', 'ls', 'dir', 'get-childitem', 'gci', 'cat', 'type', 'get-content', 'gc', 'rm', 'del', 'remove-item', 'ri', 'cp', 'copy', 'copy-item', 'mv', 'move', 'move-item', 'code', 'notepad', 'start', 'start-process', 'ii', 'invoke-item', 'mkdir', 'md', 'ni', 'new-item', 'node', 'python', 'py', 'explorer', 'tree']);
  const DIR_ONLY = new Set(['cd', 'set-location', 'sl', 'chdir', 'pushd']);

  const store = { history: [], commands: [] };

  function tokenize(line) {
    const toks = [];
    let cur = '', q = null, start = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { if (!cur) start = i; q = c; cur += c; continue; }
      if (c === ' ') { if (cur) toks.push({ text: cur, start }); cur = ''; continue; }
      if (!cur) start = i;
      cur += c;
    }
    if (cur || line.endsWith(' ') || !line) toks.push({ text: cur, start: cur ? start : line.length });
    return toks;
  }

  async function compute(line, ctx) {
    const out = [];
    const seen = new Set();
    const lower = line.toLowerCase();
    const add = (value, kind, label) => {
      if (value.length <= line.length && value.toLowerCase() === lower) return;
      const k = value.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ value, kind, label: label || value });
    };
    if (!line.trim()) return out;

    // 1) history — newest first, exact-case prefix wins
    const h = store.history;
    let hcount = 0;
    for (let i = h.length - 1; i >= 0 && hcount < 5; i--) {
      if (h[i].startsWith(line) && h[i] !== line) { add(h[i], 'history'); hcount++; }
    }
    for (let i = h.length - 1; i >= 0 && hcount < 5; i--) {
      if (h[i].toLowerCase().startsWith(lower)) { add(h[i], 'history'); hcount++; }
    }

    const toks = tokenize(line);
    const last = toks[toks.length - 1];
    const head = line.slice(0, last.start);
    const first = toks[0].text.toLowerCase();

    // 2) command names for the first word
    if (toks.length === 1 && last.text && !/[\\/]/.test(last.text)) {
      const t = last.text.toLowerCase();
      const cmds = store.commands.filter(c => c.toLowerCase().startsWith(t));
      cmds.sort((a, b) => a.length - b.length || a.localeCompare(b));
      for (const c of cmds.slice(0, 8)) add(c, 'command');
    }

    // 3) sub-commands (git, npm, docker ...)
    if (toks.length >= 2 && SUBCOMMANDS[first]) {
      const rest = line.slice(toks[1].start);
      for (const s of SUBCOMMANDS[first]) {
        if (s.toLowerCase().startsWith(rest.toLowerCase()) && s.length > rest.length) add(line.slice(0, toks[1].start) + s, 'sub', s);
      }
    }

    // 4) file system paths for the last word
    const looksPath = /[\\/~.]/.test(last.text) || /^[a-zA-Z]:/.test(last.text);
    const isSubPos = toks.length === 2 && SUBCOMMANDS[first] && !looksPath;
    if (!isSubPos && !last.text.startsWith('-') && (toks.length >= 2 || looksPath)) {
      try {
        const style = ctx.shell === 'bash' || ctx.shell === 'wsl' ? 'posix' : 'win';
        let entries = await window.neko.completePath(ctx.cwd, last.text, style);
        if (DIR_ONLY.has(first)) entries = entries.filter(e => e.isDir);
        else if (!PATH_HINT_CMDS.has(first) && !looksPath && !last.text) entries = entries.slice(0, 6);
        for (const e of entries.slice(0, 30)) add(head + e.value, e.isDir ? 'dir' : 'file', e.value);
      } catch {}
    }
    return out.slice(0, 40);
  }

  window.NekoSuggest = {
    store,
    compute,
    pushHistory(line) {
      const l = line.trim();
      if (!l || l.length > 1000) return;
      const i = store.history.lastIndexOf(l);
      if (i !== -1) store.history.splice(i, 1);
      store.history.push(l);
      window.neko.history.append(l);
    },
  };
})();
