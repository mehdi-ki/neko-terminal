// Neko Terminal - main process
// Owns the window, the pseudo terminals (ConPTY via node-pty), config, history and completion data.
const { app, BrowserWindow, ipcMain, shell, clipboard, screen, Notification, nativeImage, dialog, net: enet } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn: spawnChild } = require('child_process');
const pty = require('@lydell/node-pty');

const USER_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DIR, 'neko.json');
const HISTORY_PATH = path.join(USER_DIR, 'history.txt');
const CMD_CACHE_PATH = path.join(USER_DIR, 'commands-cache.json');
const PS_INIT_PATH = path.join(USER_DIR, 'shell-integration.ps1');
const BIN_DIR = path.join(USER_DIR, 'bin');
const CLI_PATH = path.join(BIN_DIR, 'neko-cli.js');
const SESSION_PATH = path.join(USER_DIR, 'session-restore.json');
const CLIP_DIR = path.join(USER_DIR, 'clipboard');
const CLAUDE_SETTINGS_PATH = path.join(USER_DIR, 'claude-settings.json');
const PIPE_PATH = `\\\\.\\pipe\\neko-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
const BOOT = global.NEKO_BOOT || { root: __dirname, bundled: __dirname, fromSource: false };
const APP_ROOT = __dirname; // folder this main.js was loaded from (source folder or the exe's app.asar)
const fileHash = p => { try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; } };
const MAIN_HASH = fileHash(path.join(APP_ROOT, 'main.js'));
const VERSION = (() => { try { return require(path.join(APP_ROOT, 'package.json')).version; } catch { return app.getVersion(); } })();

const DEFAULT_CONFIG = {
  font_family: 'JetBrains Mono',
  font_size: 14,
  line_height: 1.15,
  theme: 'Tokyo Night',
  shell: 'powershell',
  window_padding: 10,
  cursor_shape: 'bar',
  background_opacity: 0.82,
  cursor_blink: true,
  scrollback_lines: 10000,
  autosuggest: true,
  copy_on_select: false,
  inactive_pane_dim: 0.6,
  // folder with the Neko source code; "neko update" loads new code from here (empty = folder the exe was built from)
  source_dir: '',
  // Windows notification when a program rings the bell while the window is in the background (Claude Code waiting)
  notify_on_bell: true,
  // underline links and file paths permanently (not only on hover)
  link_underline: true,
  // inline images (neko img): max height in rows
  image_max_rows: 20,
  // Claude mode: app-like input box, buttons and status while Claude Code runs in a pane
  claude_ui: true,
  // color theme while Claude Code runs ("" = keep the normal theme)
  claude_theme: 'Claude',
  // notify when Claude is done or needs you while you are elsewhere
  claude_notify: true,
  layouts:['tall', 'fat', 'grid', 'horizontal', 'vertical', 'stack'],
};

// ---------------------------------------------------------------- config
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
}

// ---------------------------------------------------------------- shells
const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  path.join(os.homedir(), 'AppData\\Local\\Programs\\Git\\bin\\bash.exe'),
];

function findOnPath(exe) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, exe);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function availableShells() {
  const list = [];
  const pwsh = findOnPath('pwsh.exe');
  if (pwsh) list.push({ id: 'pwsh', name: 'PowerShell 7', file: pwsh });
  list.push({ id: 'powershell', name: 'Windows PowerShell', file: 'powershell.exe' });
  list.push({ id: 'cmd', name: 'Eingabeaufforderung', file: 'cmd.exe' });
  const bash = GIT_BASH_CANDIDATES.find(p => fs.existsSync(p));
  if (bash) list.push({ id: 'bash', name: 'Git Bash', file: bash });
  if (findOnPath('wsl.exe')) list.push({ id: 'wsl', name: 'WSL', file: 'wsl.exe' });
  return list;
}

const PS_INIT = String.raw`

if (Get-Module -ListAvailable PSReadLine) {
  Import-Module PSReadLine -ErrorAction SilentlyContinue
  try {
    Set-PSReadLineOption -BellStyle None -HistoryNoDuplicates
    Set-PSReadLineOption -Colors @{ Command = "$([char]27)[94m"; Parameter = "$([char]27)[90m"; String = "$([char]27)[33m"; Operator = "$([char]27)[95m"; Variable = "$([char]27)[96m"; Number = "$([char]27)[35m"; Comment = "$([char]27)[90;3m" }
    Set-PSReadLineKeyHandler -Key Tab -Function MenuComplete
  } catch {}
}
function global:__neko_git_branch {
  $d = (Get-Location).ProviderPath
  while ($d) {
    $h = Join-Path $d '.git\HEAD'
    if (Test-Path -LiteralPath $h) {
      $c = (Get-Content -LiteralPath $h -TotalCount 1)
      if ($c -match 'ref: refs/heads/(.+)') { return $Matches[1] }
      return $c.Substring(0, [Math]::Min(7, $c.Length))
    }
    $p = Split-Path $d -Parent
    if ($p -eq $d) { break }
    $d = $p
  }
  return $null
}
function global:prompt {
  $ok = $?
  $e = [char]27; $bel = [char]7
  $loc = $executionContext.SessionState.Path.CurrentLocation
  $p = $loc.ProviderPath
  $disp = $p
  if ($p -and $p.StartsWith($HOME, [StringComparison]::OrdinalIgnoreCase)) { $disp = '~' + $p.Substring($HOME.Length) }
  $osc = ''
  if ($loc.Provider.Name -eq 'FileSystem') { $osc = "$e]7;file://$env:COMPUTERNAME/$($p -replace '\\','/')$bel" }
  $osc += "$e]133;A$bel"
  $branch = __neko_git_branch
  $git = ''
  if ($branch) { $git = " $e[90mon$e[0m $e[33m$([char]0x2387) $branch$e[0m" }
  $admin = ''
  try { if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $admin = " $e[31m[admin]$e[0m" } } catch {}
  $arrow = if ($ok) { "$e[32m$([char]0x276F)$e[0m" } else { "$e[31m$([char]0x276F)$e[0m" }
  $host.UI.RawUI.WindowTitle = Split-Path -Leaf $p
  "$osc$e[1;34m$env:USERNAME$e[0m $e[90min$e[0m $e[1;35m$disp$e[0m$git$admin$([char]10)$arrow "
}
# Claude Code in Neko: load Neko's hooks (busy / done / needs you) on top of the user's own settings
function global:claude {
  if (-not $global:__nekoClaudeExe) {
    $global:__nekoClaudeExe = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  }
  if (-not $global:__nekoClaudeExe) { Write-Error 'claude wurde nicht gefunden (ist Claude Code installiert?)'; return }
  $sub = @('mcp', 'config', 'doctor', 'update', 'upgrade', 'install', 'setup-token', 'migrate-installer', 'plugin', 'plugins', 'auth', 'agents', '-v', '--version', '-h', '--help')
  if (-not $env:NEKO_CLAUDE_SETTINGS -or -not (Test-Path -LiteralPath $env:NEKO_CLAUDE_SETTINGS) -or ($args.Count -gt 0 -and $sub -contains [string]$args[0])) { & $global:__nekoClaudeExe @args }
  else { & $global:__nekoClaudeExe --settings $env:NEKO_CLAUDE_SETTINGS @args }
}
Clear-Host
`;

function shellLaunch(shellId, cwd, paneId) {
  const shells = availableShells();
  const sh = shells.find(s => s.id === shellId) || shells.find(s => s.id === 'powershell');
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'neko', TERM_PROGRAM_VERSION: VERSION };
  // side channel for the "neko" command (images, popups, notifications, update)
  env.NEKO_PIPE = PIPE_PATH;
  env.NEKO_PANE = String(paneId);
  env.NEKO_NODE = process.execPath;
  env.NEKO_CLI = CLI_PATH;
  env.NEKO_CLAUDE_SETTINGS = CLAUDE_SETTINGS_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  // a shell in Neko is a fresh start, even when Neko itself was started from inside Claude Code
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  // variables of the portable exe wrapper belong to Neko itself, not to programs started in it
  for (const k of Object.keys(env)) if (k.startsWith('PORTABLE_EXECUTABLE_')) delete env[k];
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = BIN_DIR + path.delimiter + (env[pathKey] || '');
  let args = [];
  if (sh.id === 'powershell' || sh.id === 'pwsh') {
    fs.writeFileSync(PS_INIT_PATH, '\ufeff' + PS_INIT, 'utf8');
    args = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${PS_INIT_PATH.replace(/'/g, "''")}'`];
  } else if (sh.id === 'bash') {
    args = ['--login', '-i'];
    env.CHERE_INVOKING = '1';
    env.PROMPT_COMMAND = 'printf "\\033]133;A\\007\\033]7;file://%s/%s\\007" "$HOSTNAME" "$(pwd -W 2>/dev/null || pwd)"';
  } else if (sh.id === 'cmd') {
    // $E]133;A$E\ marks the prompt start for cmd as well
    env.PROMPT = '$E]133;A$E\\$E[1;35m$P$E[0m$_$E[32m>$E[0m ';
  }
  return { file: sh.file, args, env, name: sh.name, id: sh.id };
}

// ---------------------------------------------------------------- ptys
// id -> { p, win, shell, shellName, cwd, ring, total }
// ring keeps the most recent output so a reloaded renderer (hot update) can reattach to running shells.
const ptys = new Map();
let nextId = 1;
const RING_MAX = 512 * 1024;

function createPty(win, { cols, rows, shellId, cwd }) {
  const cfg = loadConfig();
  const id = nextId++;
  const launch = shellLaunch(shellId || cfg.shell, cwd, id);
  let startDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const p = pty.spawn(launch.file, launch.args, {
    name: 'xterm-256color',
    cols: Math.max(2, cols | 0),
    rows: Math.max(2, rows | 0),
    cwd: startDir,
    env: launch.env,
    useConpty: true,
    // bundled OpenConsole (same as Windows Terminal) instead of the old inbox conhost of Windows 10,
    // whose cursor tracking drifts with TUI apps like Claude Code
    useConptyDll: true,
  });
  const rec = { p, win, shell: launch.id, shellName: launch.name, cwd: startDir, ring: '', total: 0, buf: '', timer: null };
  ptys.set(id, rec);
  // Batch output a little to keep IPC traffic low during heavy output.
  // Every message carries its stream offset so a reattaching renderer can drop what the replay already showed.
  const flush = () => {
    rec.timer = null;
    if (!rec.buf) return;
    const data = rec.buf; rec.buf = '';
    const off = rec.total;
    rec.total += data.length;
    rec.ring += data;
    if (rec.ring.length > RING_MAX) rec.ring = rec.ring.slice(rec.ring.length - RING_MAX);
    if (!rec.win.isDestroyed()) rec.win.webContents.send('pty:data', id, data, off);
  };
  rec.flush = flush;
  p.onData(d => {
    if (process.env.NEKO_PTYLOG) fs.appendFileSync(process.env.NEKO_PTYLOG, JSON.stringify(d) + '\n');
    rec.buf += d;
    if (!rec.timer) rec.timer = setTimeout(flush, 4);
  });
  p.onExit(({ exitCode }) => {
    flush();
    ptys.delete(id);
    const cst = claudeStates.get(id);
    if (cst) { if (cst.poll) clearInterval(cst.poll); claudeStates.delete(id); }
    setTimeout(() => { if (!rec.win.isDestroyed()) rec.win.webContents.send('pty:exit', id, exitCode); }, 10);
  });
  return { id, shell: launch.id, shellName: launch.name, cwd: startDir };
}

// ptys that belong to a window whose renderer just (re)loaded
function livePtysFor(win) {
  const out = [];
  for (const [id, r] of ptys) {
    if (r.win !== win) continue;
    if (r.timer) { clearTimeout(r.timer); r.flush(); }
    out.push({ id, shell: r.shell, shellName: r.shellName, cwd: r.cwd, buffer: r.ring, end: r.total });
  }
  return out;
}

// ---------------------------------------------------------------- history
function loadHistory() {
  let lines = [];
  try { lines = fs.readFileSync(HISTORY_PATH, 'utf8').split(/\r?\n/); } catch {
    // first run: import PSReadLine history so suggestions are useful immediately
    const psHist = path.join(process.env.APPDATA || '', 'Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt');
    try { lines = fs.readFileSync(psHist, 'utf8').split(/\r?\n/); } catch {}
    const bashHist = path.join(os.homedir(), '.bash_history');
    try { lines = lines.concat(fs.readFileSync(bashHist, 'utf8').split(/\r?\n/)); } catch {}
    lines = lines.filter(l => l.trim() && !l.endsWith('`')).slice(-5000);
    try { fs.mkdirSync(USER_DIR, { recursive: true }); fs.writeFileSync(HISTORY_PATH, lines.join('\n') + '\n'); } catch {}
  }
  return lines.filter(l => l.trim());
}
function appendHistory(line) {
  try { fs.appendFileSync(HISTORY_PATH, line.replace(/[\r\n]/g, ' ') + '\n'); } catch {}
}

// ---------------------------------------------------------------- command list (for autofill)
const EXEC_EXT = new Set(['.exe', '.cmd', '.bat', '.ps1', '.com']);
function scanPathCommands() {
  const out = new Set();
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      const ext = path.extname(f).toLowerCase();
      if (EXEC_EXT.has(ext)) out.add(f.slice(0, -ext.length));
    }
  }
  return [...out];
}
let commandCache = null;
function getCommands() {
  if (commandCache) return commandCache;
  let cached = [];
  try { cached = JSON.parse(fs.readFileSync(CMD_CACHE_PATH, 'utf8')); } catch {}
  commandCache = [...new Set([...cached, ...scanPathCommands()])];
  // refresh PowerShell command names in the background (cmdlets, functions, aliases)
  const ps = spawnChild('powershell.exe', ['-NoProfile', '-NoLogo', '-Command',
    'Get-Command -CommandType Cmdlet,Function,Alias -ErrorAction SilentlyContinue | ForEach-Object Name'], { windowsHide: true });
  let data = '';
  ps.stdout.on('data', d => (data += d));
  ps.on('close', () => {
    const names = data.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.includes(':') && s.length < 60);
    if (names.length) {
      try { fs.writeFileSync(CMD_CACHE_PATH, JSON.stringify(names)); } catch {}
      commandCache = [...new Set([...commandCache, ...names])];
    }
  });
  ps.on('error', () => {});
  return commandCache;
}

// ---------------------------------------------------------------- path completion
function completePath(cwd, token, style) {
  // style: 'win' -> backslashes, 'posix' -> forward slashes
  let quote = '';
  let t = token;
  if (t.startsWith('"') || t.startsWith("'")) { quote = t[0]; t = t.slice(1); }
  const home = os.homedir();
  let expanded = t;
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) expanded = home + t.slice(1);
  // Git Bash style /c/Users -> C:/Users
  const msys = /^\/([a-zA-Z])(\/|$)/.exec(expanded);
  if (style === 'posix' && msys) expanded = msys[1] + ':/' + expanded.slice(3);
  const lastSep = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  const typedDir = lastSep >= 0 ? t.slice(0, lastSep + 1) : '';
  const partial = lastSep >= 0 ? t.slice(lastSep + 1) : t;
  const expLastSep = Math.max(expanded.lastIndexOf('/'), expanded.lastIndexOf('\\'));
  const expDir = expLastSep >= 0 ? expanded.slice(0, expLastSep + 1) : '';
  let base;
  if (/^[a-zA-Z]:$/.test(expanded)) return [];
  if (path.isAbsolute(expDir) || /^[a-zA-Z]:/.test(expDir)) base = expDir;
  else base = path.join(cwd || home, expDir || '.');
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const lp = partial.toLowerCase();
  const sep = style === 'posix' ? '/' : '\\';
  const res = [];
  for (const e of entries) {
    if (!e.name.toLowerCase().startsWith(lp)) continue;
    if (!partial.startsWith('.') && e.name.startsWith('.') && lp === '') continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(base, e.name)).isDirectory(); } catch {} }
    let value = typedDir + e.name + (isDir ? sep : '');
    const needsQuote = /\s/.test(value) && !quote;
    if (needsQuote) value = (style === 'posix' ? "'" : "'") + value + (isDir ? '' : "'");
    else if (quote) value = quote + value + (isDir ? '' : quote);
    res.push({ value, isDir, name: e.name });
    if (res.length > 300) break;
  }
  res.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  return res;
}

// ---------------------------------------------------------------- "neko" command (side channel)
// The shell gets NEKO_PIPE / NEKO_PANE and bin/ on PATH. "neko img|popup|notify|ask|open|update"
// runs the Electron binary as plain node with cli/neko.js, which talks to this named pipe.
// This bypasses ConPTY, so it also works from Claude Code's Bash tool (stdout is not a tty there).
function installCli() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const write = (p, s) => { try { if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== s) fs.writeFileSync(p, s); } catch (e) { console.error(e); } };
  write(CLI_PATH, fs.readFileSync(path.join(APP_ROOT, 'cli', 'neko.js'), 'utf8'));
  write(path.join(BIN_DIR, 'neko.cmd'), '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%NEKO_NODE%" "%NEKO_CLI%" %*\r\n');
  // Git Bash (also used by Claude Code's Bash tool)
  write(path.join(BIN_DIR, 'neko'), '#!/bin/sh\nn="$NEKO_NODE"; c="$NEKO_CLI"\nif command -v cygpath >/dev/null 2>&1; then n="$(cygpath -u "$n")"; c="$(cygpath -w "$c")"; fi\nELECTRON_RUN_AS_NODE=1 exec "$n" "$c" "$@"\n');
}

// ---------------------------------------------------------------- Claude Code integration
// "claude" started from a Neko PowerShell loads CLAUDE_SETTINGS_PATH, whose hooks run "neko hook".
// That reports session start, prompt submit, stop and notifications for the pane; the transcript
// (JSONL) gives the model, the context size and what Claude is doing right now.
function writeClaudeSettings() {
  const hook = [{ hooks: [{ type: 'command', command: 'neko hook', timeout: 5 }] }];
  const settings = { hooks: {} };
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']) settings.hooks[ev] = hook;
  try {
    const s = JSON.stringify(settings, null, 2);
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH) || fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8') !== s) fs.writeFileSync(CLAUDE_SETTINGS_PATH, s);
  } catch (e) { console.error('[neko] claude settings:', e); }
}

const claudeStates = new Map(); // paneId -> state
function claudeState(paneId) {
  if (!claudeStates.has(paneId)) claudeStates.set(paneId, { hooked: false, active: false, busy: false, since: 0, waiting: null, model: '', ctx: 0, activity: '', lastText: '', transcript: '', cwd: '', poll: null, mtime: 0 });
  return claudeStates.get(paneId);
}
function publicClaudeState(st) {
  const { poll, mtime, newestId, waitingAt, interrupted, ...rest } = st;
  return rest;
}

function readTail(file, max = 512 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const s = buf.toString('utf8');
    return start ? s.slice(s.indexOf('\n') + 1) : s;
  } finally { fs.closeSync(fd); }
}

function describeTool(t) {
  const i = t.input || {};
  const file = i.file_path || i.notebook_path || i.path;
  const short = s => String(s).replace(/\s+/g, ' ').slice(0, 60);
  switch (t.name) {
    case 'Read': return `liest ${path.basename(file || '')}`;
    case 'Edit': case 'MultiEdit': return `bearbeitet ${path.basename(file || '')}`;
    case 'Write': return `schreibt ${path.basename(file || '')}`;
    case 'Bash': case 'PowerShell': return `führt aus: ${short(i.description || i.command || '')}`;
    case 'Grep': return `sucht „${short(i.pattern || '')}“`;
    case 'Glob': return `sucht Dateien ${short(i.pattern || '')}`;
    case 'WebSearch': return `sucht im Web: ${short(i.query || '')}`;
    case 'WebFetch': return 'liest eine Webseite';
    case 'Agent': case 'Task': return `Agent: ${short(i.description || '')}`;
    case 'TodoWrite': return 'plant die Schritte';
    default: return t.name ? `nutzt ${t.name.replace(/^mcp__[^_]+__/, '')}` : '';
  }
}

// model, context tokens, last answer text and current activity from the end of the transcript
function readTranscript(st) {
  if (!st.transcript) return false;
  let mtime = 0;
  try { mtime = fs.statSync(st.transcript).mtimeMs; } catch { return false; }
  if (mtime === st.mtime) return false;
  st.mtime = mtime;
  let lines;
  try { lines = readTail(st.transcript).split('\n'); } catch { return false; }
  let gotUsage = false, gotText = false, gotActivity = false, newest = true;
  st.interrupted = false;
  for (let i = lines.length - 1, n = 0; i >= 0 && n < 600 && !(gotUsage && gotText && gotActivity); i--, n++) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.isSidechain) continue;
    if (newest && (o.type === 'user' || o.type === 'assistant')) {
      newest = false;
      st.newestId = o.uuid || lines[i].length + ':' + i;
      // Esc or "No" on a permission prompt: Claude stops without a Stop hook
      if (o.type === 'user' && /Request interrupted by user/.test(JSON.stringify(o.message && o.message.content || ''))) st.interrupted = true;
    }
    if (o.type === 'user' && !gotActivity) {
      // a tool result or the user's prompt comes after the last tool call: nothing specific running
      gotActivity = true;
      st.activity = '';
    }
    if (o.type !== 'assistant' || !o.message) continue;
    const m = o.message;
    const content = Array.isArray(m.content) ? m.content : [];
    if (!gotActivity) {
      gotActivity = true;
      const tool = [...content].reverse().find(c => c.type === 'tool_use');
      st.activity = tool ? describeTool(tool) : content.some(c => c.type === 'thinking') ? 'denkt nach' : 'schreibt';
    }
    if (!gotUsage && m.usage && m.model && m.model !== '<synthetic>') {
      gotUsage = true;
      const u = m.usage;
      st.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      st.model = m.model;
    }
    if (!gotText) {
      const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      if (text) { gotText = true; st.lastText = text.slice(0, 600); }
    }
  }
  return true;
}

function sendClaude(paneId, event, extra = {}) {
  const st = claudeState(paneId);
  const r = ptys.get(paneId);
  const win = r ? r.win : null;
  if (win && !win.isDestroyed()) win.webContents.send('claude:event', { paneId, event, state: publicClaudeState(st), ...extra });
}

function setClaudePolling(paneId, on) {
  const st = claudeState(paneId);
  if (on && !st.poll) {
    st.poll = setInterval(() => {
      if (!ptys.has(paneId)) { clearInterval(st.poll); st.poll = null; return; }
      if (!readTranscript(st)) return;
      // a new message after a permission prompt: it was answered
      if (st.waiting && st.newestId !== st.waitingAt) st.waiting = null;
      if (st.interrupted) {
        st.busy = false; st.activity = '';
        clearInterval(st.poll); st.poll = null;
        sendClaude(paneId, 'Interrupted');
      } else sendClaude(paneId, 'Update');
    }, 1500);
  } else if (!on && st.poll) { clearInterval(st.poll); st.poll = null; }
}

function onClaudeHook(paneId, event, d) {
  if (!paneId) return;
  const st = claudeState(paneId);
  st.hooked = true;
  if (d.transcript_path) { if (d.transcript_path !== st.transcript) st.mtime = 0; st.transcript = d.transcript_path; }
  if (d.cwd) st.cwd = d.cwd;
  let message = '';
  switch (event) {
    case 'SessionStart': st.active = true; st.busy = false; st.waiting = null; st.activity = ''; if (d.model) st.model = typeof d.model === 'string' ? d.model : (d.model.id || ''); break;
    case 'UserPromptSubmit': st.active = true; st.busy = true; st.since = Date.now(); st.waiting = null; st.activity = 'denkt nach'; setClaudePolling(paneId, true); break;
    case 'Stop':
      st.busy = false; st.waiting = null; st.activity = '';
      setClaudePolling(paneId, false);
      st.mtime = 0;
      readTranscript(st);
      st.activity = '';
      if (typeof d.last_assistant_message === 'string' && d.last_assistant_message.trim()) st.lastText = d.last_assistant_message.trim().slice(0, 600);
      break;
    case 'Notification':
      message = d.message || '';
      // "waiting for your input" comes 60 s after a reply: not worth a second alarm
      st.waiting = /waiting for your input/i.test(message) ? null : (message || 'Claude braucht dich');
      break;
    case 'SessionEnd': st.active = false; st.busy = false; st.waiting = null; st.activity = ''; setClaudePolling(paneId, false); break;
  }
  if (event !== 'Stop') readTranscript(st);
  if (event === 'Notification') st.waitingAt = st.newestId;
  sendClaude(paneId, event, { message });
}

// slash commands for the input box: built-in ones plus the user's commands and skills
function frontmatterDesc(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
    const m = /^---[\s\S]*?\ndescription:\s*(.+)/m.exec(head);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}
function claudeCommands(cwd) {
  const out = [];
  const seen = new Set();
  const add = (name, desc, kind) => { if (!seen.has(name)) { seen.add(name); out.push({ name, desc, kind }); } };
  const roots = [path.join(os.homedir(), '.claude')];
  if (cwd) roots.unshift(path.join(cwd, '.claude'));
  for (const root of roots) {
    const walk = (dir, prefix) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(dir, e.name), prefix + e.name + ':');
        else if (e.name.endsWith('.md')) add(prefix + e.name.slice(0, -3), frontmatterDesc(path.join(dir, e.name)), 'command');
      }
    };
    walk(path.join(root, 'commands'), '');
    let skills = [];
    try { skills = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true }); } catch {}
    for (const e of skills) {
      const f = path.join(root, 'skills', e.name, 'SKILL.md');
      if (e.isDirectory() && fs.existsSync(f)) add(e.name, frontmatterDesc(f), 'skill');
    }
  }
  return out;
}

const uiPending = new Map(); // reqId -> resolve
let uiSeq = 0;
function askRenderer(win, payload, timeoutMs = 0) {
  return new Promise(resolve => {
    if (!win || win.isDestroyed()) return resolve({ error: 'kein Fenster' });
    const reqId = ++uiSeq;
    uiPending.set(reqId, resolve);
    if (timeoutMs) setTimeout(() => { if (uiPending.has(reqId)) { uiPending.delete(reqId); resolve({ error: 'timeout' }); } }, timeoutMs);
    win.webContents.send('ui:request', reqId, payload);
  });
}

const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif' };
const IMG_MAX = 40 * 1024 * 1024;
async function loadImage(src, cwd) {
  if (/^https?:\/\//i.test(src)) {
    const r = await enet.fetch(src);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > IMG_MAX) throw new Error('Bild zu groß');
    const mime = (r.headers.get('content-type') || '').split(';')[0] || IMG_MIME[path.extname(new URL(src).pathname).slice(1).toLowerCase()] || 'image/png';
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, name: path.basename(new URL(src).pathname) || src, src };
  }
  if (/^data:image\//.test(src)) return { dataUrl: src, name: 'bild', src: '' };
  const p = path.resolve(cwd || os.homedir(), src.replace(/^~(?=$|[\\/])/, os.homedir()));
  const st = fs.statSync(p);
  if (st.size > IMG_MAX) throw new Error('Bild zu groß');
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = IMG_MIME[ext];
  if (!mime) throw new Error(`kein unterstütztes Bildformat: .${ext}`);
  return { dataUrl: `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`, name: path.basename(p), src: p };
}

function findEditor() {
  return findOnPath('code.cmd') || findOnPath('cursor.cmd') || null;
}
// open a URL, file or folder; "file.js:12:3" jumps to the line when VS Code is installed
async function openTarget(target, cwd, { reveal = false } = {}) {
  if (/^(https?|mailto|ftp):/i.test(target)) { await shell.openExternal(target); return { ok: true }; }
  if (/^file:\/\//i.test(target)) { try { target = decodeURIComponent(new URL(target).pathname).replace(/^\/([a-zA-Z]:)/, '$1'); } catch {} }
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(target);
  let file = m[1], line = m[2], col = m[3];
  file = file.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/^\/([a-zA-Z])\//, '$1:/');
  const p = path.resolve(cwd || os.homedir(), file);
  if (!fs.existsSync(p)) return { error: `nicht gefunden: ${p}` };
  if (reveal) { shell.showItemInFolder(p); return { ok: true }; }
  const editor = line && fs.statSync(p).isFile() ? findEditor() : null;
  if (editor) {
    spawnChild('cmd.exe', ['/c', editor, '-g', `${p}:${line}${col ? ':' + col : ''}`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }
  const err = await shell.openPath(p);
  return err ? { error: err } : { ok: true };
}

function statMany(cwd, list) {
  return list.map(t => {
    try {
      let f = t.replace(/(:\d+){1,2}$/, '').replace(/^~(?=$|[\\/])/, os.homedir()).replace(/^\/([a-zA-Z])\//, '$1:/');
      const st = fs.statSync(path.resolve(cwd || os.homedir(), f));
      return st.isDirectory() ? 'dir' : 'file';
    } catch { return null; }
  });
}

function nativeNotify(win, { title, body, paneId }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title || 'Neko Terminal', body: body || '', icon: path.join(APP_ROOT, 'assets', 'icon.png'), silent: false });
  n.on('click', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    if (paneId) win.webContents.send('ui:focus-pane', paneId);
  });
  n.show();
}

function winForPane(paneId) {
  const r = ptys.get(Number(paneId));
  if (r && !r.win.isDestroyed()) return r.win;
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
}

async function handleCli(msg) {
  const paneId = Number(msg.pane) || 0;
  const win = winForPane(paneId);
  const cwd = msg.cwd || (ptys.get(paneId) || {}).cwd;
  switch (msg.cmd) {
    case 'ping': return { ok: true, version: VERSION, root: APP_ROOT, fromSource: BOOT.fromSource, packaged: app.isPackaged, pipe: PIPE_PATH };
    case 'img': {
      const img = await loadImage(msg.src, cwd);
      return askRenderer(win, { type: 'img', paneId, mode: msg.mode, title: msg.title, maxRows: msg.rows, maxCols: msg.cols, ...img }, 15000);
    }
    case 'popup': case 'notify': case 'ask': {
      let image = null;
      if (msg.image) image = await loadImage(msg.image, cwd);
      const payload = { type: msg.cmd, paneId, title: msg.title, text: msg.text, links: msg.links, buttons: msg.buttons, input: msg.input, placeholder: msg.placeholder, timeout: msg.timeout, image };
      if (!win.isFocused() && msg.notify !== false) nativeNotify(win, { title: msg.title || 'Neko', body: msg.text, paneId });
      return askRenderer(win, payload, msg.cmd === 'ask' ? (msg.timeout ? msg.timeout * 1000 + 500 : 0) : 15000);
    }
    case 'progress': return askRenderer(win, { type: 'progress', paneId, state: msg.state, value: msg.value }, 5000);
    case 'claude-hook': onClaudeHook(paneId, String(msg.event || (msg.data && msg.data.hook_event_name) || ''), msg.data || {}); return { ok: true };
    case 'open': return openTarget(msg.target, cwd, { reveal: !!msg.reveal });
    case 'update': {
      const res = await runUpdate({ restart: !!msg.restart, pull: msg.pull !== false });
      return res;
    }
    default: return { error: `unbekannter Befehl: ${msg.cmd}` };
  }
}

function startPipeServer() {
  const server = net.createServer(sock => {
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', async chunk => {
      data += chunk;
      const nl = data.indexOf('\n');
      if (nl < 0) return;
      let res;
      try { res = await handleCli(JSON.parse(data.slice(0, nl))); }
      catch (e) { res = { error: String(e && e.message || e) }; }
      try { sock.end(JSON.stringify(res || {}) + '\n'); } catch {}
    });
    sock.on('error', () => {});
  });
  server.on('error', e => console.error('[neko] pipe:', e));
  server.listen(PIPE_PATH);
}

// ---------------------------------------------------------------- update without a new exe
// Renderer changes (renderer/*, preload.js): reload the windows, the shells keep running.
// main.js changes: restart the app, tabs come back in the same folders.
const pendingSnapshots = new Map(); // webContents id -> snapshot to restore after reload/restart

function gitPull(root) {
  return new Promise(resolve => {
    if (!fs.existsSync(path.join(root, '.git'))) return resolve(null);
    const g = spawnChild('git', ['pull', '--ff-only'], { cwd: root, windowsHide: true });
    let out = '';
    g.stdout.on('data', d => (out += d)); g.stderr.on('data', d => (out += d));
    g.on('close', code => resolve({ code, out: out.trim() }));
    g.on('error', e => resolve({ code: -1, out: String(e.message) }));
  });
}

async function runUpdate({ restart = false, pull = true } = {}) {
  if (APP_ROOT.includes('app.asar')) {
    return { error: 'Neko läuft aus der exe ohne Quellordner. Setze "source_dir" in neko.json (oder baue die exe einmal mit "npm run dist" neu).' };
  }
  const log = [];
  if (pull) { const g = await gitPull(APP_ROOT); if (g) log.push(`git pull: ${g.out || 'ok'}`); }
  const mainChanged = fileHash(path.join(APP_ROOT, 'main.js')) !== MAIN_HASH;
  const doRestart = restart || mainChanged;
  const wins = BrowserWindow.getAllWindows();
  const snaps = [];
  for (const w of wins) {
    const s = await askRenderer(w, { type: 'snapshot' }, 3000);
    snaps.push({ w, s: s && !s.error ? s : null });
  }
  if (doRestart) {
    fs.writeFileSync(SESSION_PATH, JSON.stringify(snaps.map(x => x.s).filter(Boolean)));
    log.push(mainChanged ? 'main.js geändert: Neko startet neu (Tabs öffnen sich in denselben Ordnern).' : 'Neko startet neu.');
    setTimeout(() => {
      // start the new instance ourselves (app.relaunch() did not come back reliably on Windows)
      // the portable exe wrapper is only ours when we are packaged (a dev instance started from a Neko shell inherits it)
      const execPath = (app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE) || process.execPath;
      const args = app.isPackaged ? [] : process.argv.slice(1).map(a => (a === '.' ? APP_ROOT : a));
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      try {
        spawnChild(execPath, args, { detached: true, stdio: 'ignore', cwd: process.cwd(), env }).unref();
      } catch (e) {
        console.error('[neko] restart failed:', e);
        app.relaunch({ execPath, args });
      }
      app.exit(0);
    }, 400);
  } else {
    log.push('Oberfläche neu geladen, laufende Shells bleiben erhalten.');
    setTimeout(() => {
      for (const { w, s } of snaps) {
        if (w.isDestroyed()) continue;
        if (s) pendingSnapshots.set(w.webContents.id, s);
        w.webContents.reloadIgnoringCache();
      }
    }, 300);
  }
  return { ok: true, restart: doRestart, version: VERSION, root: APP_ROOT, log };
}

// ---------------------------------------------------------------- frameless window helpers
// Transparent windows on Windows have no native resize border and report isMaximized()
// unreliably, so maximize and edge resizing are done by hand.
const winState = new WeakMap(); // win -> { restore: bounds | null, resize: timer }
function stateOf(win) { if (!winState.has(win)) winState.set(win, { restore: null, resize: null }); return winState.get(win); }
function isMax(win) { return !!stateOf(win).restore; }
function sendWinState(win) {
  if (!win.isDestroyed()) win.webContents.send('window:state', { maximized: isMax(win), fullscreen: win.isFullScreen() });
}
function toggleMaximize(win) {
  const st = stateOf(win);
  if (st.restore) { win.setBounds(st.restore); st.restore = null; }
  else {
    st.restore = win.getBounds();
    win.setBounds(screen.getDisplayMatching(st.restore).workArea);
  }
  sendWinState(win);
}
function startResize(win, edge) {
  const st = stateOf(win);
  stopResize(win);
  if (st.restore || win.isFullScreen()) return;
  const start = win.getBounds();
  const p0 = screen.getCursorScreenPoint();
  const [minW, minH] = win.getMinimumSize();
  st.resize = setInterval(() => {
    if (win.isDestroyed()) return stopResize(win);
    const p = screen.getCursorScreenPoint();
    const dx = p.x - p0.x, dy = p.y - p0.y;
    let { x, y, width, height } = start;
    if (edge.includes('e')) width = Math.max(minW, start.width + dx);
    if (edge.includes('s')) height = Math.max(minH, start.height + dy);
    if (edge.includes('w')) { width = Math.max(minW, start.width - dx); x = start.x + start.width - width; }
    if (edge.includes('n')) { height = Math.max(minH, start.height - dy); y = start.y + start.height - height; }
    win.setBounds({ x, y, width, height });
  }, 16);
}
function stopResize(win) {
  const st = stateOf(win);
  if (st.resize) { clearInterval(st.resize); st.resize = null; }
}

// ---------------------------------------------------------------- window
function createWindow(snapshot = null) {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 420,
    minHeight: 260,
    // transparent, frameless window: the renderer paints a semi transparent background
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    hasShadow: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.removeMenu();
  if (snapshot) pendingSnapshots.set(win.webContents.id, snapshot);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (process.env.NEKO_STEPS) {
    // debug: run scripted steps, e.g. [["type","g"],["wait",800],["shot","a.png"],["key","Backspace"]]
    const steps = JSON.parse(process.env.NEKO_STEPS);
    (async () => {
      await new Promise(r => setTimeout(r, 3500));
      for (const [op, arg] of steps) {
        if (op === 'wait') await new Promise(r => setTimeout(r, arg));
        else if (op === 'type') { for (const ch of arg) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch }); win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch }); await new Promise(r => setTimeout(r, 120)); } }
        else if (op === 'key') {
          // "Shift+Tab", "Control+Enter", ...
          const parts = String(arg).split('+');
          const keyCode = parts.pop();
          const modifiers = parts.map(m => m.toLowerCase());
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
          await new Promise(r => setTimeout(r, 150));
        }
        else if (op === 'eval') { try { const v = await win.webContents.executeJavaScript(arg[0]); if (arg[1]) fs.writeFileSync(arg[1], typeof v === 'string' ? v : JSON.stringify(v, null, 2)); } catch (e) { console.error('eval failed', e); } }
        else if (op === 'click') { const [x, y] = arg; for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 }); await new Promise(r => setTimeout(r, 150)); }
        else if (op === 'shot') { try { fs.writeFileSync(arg, (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error('shot failed', e); } }
        else if (op === 'dump') fs.writeFileSync(arg, String(await win.webContents.executeJavaScript('window.__nekoDump ? window.__nekoDump() : ""')));
      }
    })();
  }
  if (process.env.NEKO_DEBUG) {
    win.webContents.on('console-message', ev => console.log(`[renderer:${ev.level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`));
    if (process.env.NEKO_TYPE) setTimeout(() => { for (const ch of process.env.NEKO_TYPE) win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); if (process.env.NEKO_BS) setTimeout(() => { for (let i = 0; i < +process.env.NEKO_BS; i++) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' }); } }, 600); if (process.env.NEKO_TAB) setTimeout(() => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' }); }, 800); }, 3500);
    setTimeout(() => {
      win.webContents.capturePage().then(img => fs.writeFileSync(process.env.NEKO_DEBUG, img.toPNG()));
    }, 6000);
  }
  win.on('maximize', () => sendWinState(win));
  win.on('unmaximize', () => sendWinState(win));
  win.on('enter-full-screen', () => sendWinState(win));
  win.on('leave-full-screen', () => sendWinState(win));
  win.on('closed', () => {
    // only this window's shells
    for (const [id, r] of ptys) if (r.win === win) { try { r.p.kill(); } catch {} ptys.delete(id); }
  });
  // open links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());

  let watchTimer = null;
  try {
    fs.watch(CONFIG_PATH, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { if (!win.isDestroyed()) win.webContents.send('config:changed', loadConfig()); }, 150);
    });
  } catch {}
  return win;
}

app.whenReady().then(() => {
  ensureConfigFile();
  ipcMain.handle('config:get', () => loadConfig());
  ipcMain.handle('config:open', () => shell.openPath(CONFIG_PATH));
  ipcMain.handle('config:set', (_e, patch) => {
    const cfg = { ...loadConfig(), ...patch };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return cfg;
  });
  ipcMain.handle('shells:list', () => availableShells());
  ipcMain.handle('pty:create', (e, opts) => createPty(BrowserWindow.fromWebContents(e.sender), opts));
  ipcMain.on('pty:write', (_e, id, data) => { const r = ptys.get(id); if (r) r.p.write(data); });
  ipcMain.on('pty:resize', (_e, id, cols, rows) => {
    const r = ptys.get(id);
    if (r && cols > 1 && rows > 1) { try { r.p.resize(cols, rows); } catch {} }
  });
  ipcMain.on('pty:kill', (_e, id) => { const r = ptys.get(id); if (r) { try { r.p.kill(); } catch {} ptys.delete(id); } });
  ipcMain.on('pty:cwd', (_e, id, cwd) => { const r = ptys.get(id); if (r && cwd) r.cwd = cwd; });
  // renderer boot: snapshot to restore (after hot update) + shells still running for this window
  ipcMain.handle('session:restore', e => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const snapshot = pendingSnapshots.get(e.sender.id) || null;
    pendingSnapshots.delete(e.sender.id);
    return { snapshot, live: livePtysFor(win) };
  });
  ipcMain.on('ui:response', (_e, reqId, result) => { const r = uiPending.get(reqId); if (r) { uiPending.delete(reqId); r(result); } });
  ipcMain.on('ui:notify', (e, opts) => { const w = BrowserWindow.fromWebContents(e.sender); if (w && (!w.isFocused() || opts.force)) nativeNotify(w, opts); });
  ipcMain.handle('app:update', (_e, opts) => runUpdate(opts || {}));
  ipcMain.handle('app:info', () => ({ version: VERSION, root: APP_ROOT, fromSource: BOOT.fromSource, bootError: BOOT.error || null, pipe: PIPE_PATH, bin: BIN_DIR }));
  ipcMain.handle('open:target', (_e, target, cwd, opts) => openTarget(String(target), cwd, opts || {}));
  ipcMain.handle('fs:stat-many', (_e, cwd, list) => statMany(cwd, list || []));
  ipcMain.handle('img:load', async (_e, src, cwd) => { try { return await loadImage(String(src), cwd); } catch (err) { return { error: String(err.message || err) }; } });
  // clipboard image -> png file, so it can be pasted as a path (Claude Code attaches image paths)
  ipcMain.handle('clipboard:info', () => {
    const formats = clipboard.availableFormats();
    return { text: clipboard.readText(), hasImage: formats.some(f => f.startsWith('image/')) && clipboard.readImage().isEmpty() === false };
  });
  ipcMain.handle('clipboard:save-image', () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    fs.mkdirSync(CLIP_DIR, { recursive: true });
    // keep the folder small
    try { const old = fs.readdirSync(CLIP_DIR).sort(); for (const f of old.slice(0, Math.max(0, old.length - 30))) fs.unlinkSync(path.join(CLIP_DIR, f)); } catch {}
    const p = path.join(CLIP_DIR, `clip-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    fs.writeFileSync(p, img.toPNG());
    return p;
  });
  ipcMain.handle('claude:state', (_e, paneId) => { const st = claudeStates.get(Number(paneId)); return st ? publicClaudeState(st) : null; });
  ipcMain.handle('claude:commands', (_e, cwd) => claudeCommands(cwd ? String(cwd) : ''));
  ipcMain.handle('dialog:open-files', async e => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('history:load', () => loadHistory());
  ipcMain.on('history:append', (_e, line) => appendHistory(line));
  ipcMain.handle('commands:get', () => getCommands());
  ipcMain.handle('fs:complete', (_e, cwd, token, style) => completePath(cwd, token, style));
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.on('clipboard:write', (_e, t) => clipboard.writeText(t));
  const winOf = e => BrowserWindow.fromWebContents(e.sender);
  ipcMain.on('window:minimize', e => winOf(e).minimize());
  ipcMain.on('window:maximize', e => toggleMaximize(winOf(e)));
  ipcMain.on('window:resize-start', (e, edge) => startResize(winOf(e), String(edge)));
  ipcMain.on('window:resize-stop', e => stopResize(winOf(e)));
  ipcMain.on('window:fullscreen', e => { const w = winOf(e); w.setFullScreen(!w.isFullScreen()); });
  ipcMain.on('window:close', e => BrowserWindow.fromWebContents(e.sender).close());
  ipcMain.on('window:new', () => createWindow());
  getCommands();
  installCli();
  writeClaudeSettings();
  startPipeServer();
  // tabs saved by "neko update --restart"
  let restore = [];
  try { restore = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8')); fs.unlinkSync(SESSION_PATH); } catch {}
  if (Array.isArray(restore) && restore.length) restore.forEach(s => createWindow(s));
  else createWindow();
});

app.on('window-all-closed', () => app.quit());
