// neko - talk to the Neko Terminal this shell runs in.
// Runs as plain node inside the Electron binary (ELECTRON_RUN_AS_NODE=1), started by bin/neko(.cmd).
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');

const HELP = `neko – Befehle für Neko Terminal

  neko img <datei|url> [--popup] [--rows N] [--title T]
        Bild im Terminal anzeigen. Ohne Terminal-Ausgabe (z. B. aus dem
        Bash-Tool von Claude Code) erscheint es automatisch als Popup.
  neko popup [--title T] [--image BILD] [--link URL]... [--timeout S] <text | ->
        Popup-Karte anzeigen. Text "-" liest von stdin. Unterstützt
        **fett**, \`code\` und Links.
  neko notify [--title T] <text>
        Kurze Benachrichtigung (Windows-Meldung, wenn Neko im Hintergrund ist).
  neko ask [--title T] [--buttons "Ja,Nein"] [--input] [--timeout S] <frage>
        Fragt im Terminal nach und gibt die Antwort aus.
        Exit-Code 1, wenn das Popup geschlossen wurde.
  neko progress <0-100|busy|done|error>
        Fortschritt im Tab anzeigen.
  neko open <url|datei[:zeile]> [--reveal]
        URL im Browser, Datei im Editor oder Ordner im Explorer öffnen.
  neko update [--restart] [--no-pull]
        Neko aus dem Quellordner neu laden, ohne neue exe.
  neko info
        Version, Quellordner und Pipe anzeigen.`;

const VALUE_FLAGS = new Set(['title', 'image', 'link', 'buttons', 'timeout', 'rows', 'cols', 'placeholder']);
function parse(argv) {
  const flags = { link: [] };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    const m = /^--?([a-z-]+)(?:=(.*))?$/i.exec(a);
    if (m && a !== '-') {
      const k = m[1].replace(/-/g, '_');
      if (VALUE_FLAGS.has(k)) {
        const v = m[2] !== undefined ? m[2] : argv[++i];
        if (k === 'link') flags.link.push(v); else flags[k] = v;
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

function request(msg) {
  const pipe = process.env.NEKO_PIPE;
  if (!pipe) { console.error('neko: diese Shell läuft nicht in Neko Terminal (NEKO_PIPE fehlt).'); process.exit(2); }
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe, () => sock.write(JSON.stringify({ pane: process.env.NEKO_PANE, cwd: process.cwd(), ...msg }) + '\n'));
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', d => (data += d));
    sock.on('end', () => {
      if (process.env.NEKO_CLI_DEBUG) console.error('[neko] response:', data.trim());
      try { resolve(JSON.parse(data.trim() || '{}')); } catch (e) { reject(e); }
    });
    sock.on('error', e => reject(new Error(`keine Verbindung zu Neko (${e.code || e.message}). Ist das Fenster noch offen?`)));
  });
}

function readStdin() {
  return new Promise(resolve => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => (s += d));
    process.stdin.on('end', () => resolve(s.replace(/\s+$/, '')));
  });
}

async function textArg(pos) {
  const t = pos.join(' ');
  if (t === '-' || (!t && !process.stdin.isTTY)) return readStdin();
  return t;
}

function fail(res) {
  console.error('neko: ' + (res && res.error || 'unbekannter Fehler'));
  process.exit(1);
}

const absSrc = s => (/^(https?:|data:)/i.test(s) ? s : path.resolve(s));

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parse(rest);
  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help':
      console.log(HELP); return;
    case 'img': case 'image': case 'show': {
      if (!pos[0]) { console.error('neko img <datei|url>'); process.exit(2); }
      const tty = !!process.stdout.isTTY;
      const mode = flags.popup || cmd === 'show' || !tty ? 'popup' : 'inline';
      const res = await request({ cmd: 'img', src: absSrc(pos[0]), mode, title: flags.title, rows: flags.rows ? +flags.rows : undefined, cols: flags.cols ? +flags.cols : undefined });
      if (!res || res.error) fail(res);
      // reserve the rows the image covers, so the shell output continues below it
      if (mode === 'inline' && res.rows) process.stdout.write('\n'.repeat(res.rows));
      else if (!tty) console.log(`Bild angezeigt: ${pos[0]}`);
      return;
    }
    case 'popup': case 'notify': {
      const text = await textArg(pos);
      const res = await request({ cmd, text, title: flags.title, image: flags.image ? absSrc(flags.image) : undefined, links: flags.link, timeout: flags.timeout ? +flags.timeout : undefined });
      if (!res || res.error) fail(res);
      return;
    }
    case 'ask': {
      const text = await textArg(pos);
      const buttons = flags.buttons ? String(flags.buttons).split(',').map(s => s.trim()).filter(Boolean) : (flags.input ? ['OK'] : ['Ja', 'Nein']);
      const res = await request({ cmd: 'ask', text, title: flags.title, buttons, input: !!flags.input, placeholder: flags.placeholder, timeout: flags.timeout ? +flags.timeout : undefined, image: flags.image ? absSrc(flags.image) : undefined });
      if (!res || res.error) fail(res);
      if (res.dismissed) process.exit(1);
      console.log(flags.input ? (res.value || '') : res.button);
      return;
    }
    case 'progress': {
      const a = String(pos[0] || 'done').toLowerCase();
      const st = /^\d+$/.test(a) ? { state: 'value', value: Math.min(100, +a) } : { state: a };
      const res = await request({ cmd: 'progress', ...st });
      if (res && res.error) fail(res);
      return;
    }
    case 'open': {
      if (!pos[0]) { console.error('neko open <url|datei>'); process.exit(2); }
      const t = /^[a-z]+:\/\//i.test(pos[0]) || /^mailto:/i.test(pos[0]) ? pos[0] : path.resolve(pos[0].replace(/(:\d+){1,2}$/, '')) + (pos[0].match(/(:\d+){1,2}$/) || [''])[0];
      const res = await request({ cmd: 'open', target: t, reveal: !!flags.reveal });
      if (!res || res.error) fail(res);
      return;
    }
    case 'update': {
      const res = await request({ cmd: 'update', restart: !!flags.restart, pull: !flags.no_pull });
      if (!res || res.error) fail(res);
      for (const l of res.log || []) console.log(l);
      console.log(`Neko ${res.version} aus ${res.root}`);
      return;
    }
    case 'hook': {
      // called by Claude Code hooks (see claude-settings.json): must stay silent and never fail,
      // stdout of some hooks is added to Claude's context
      if (!process.env.NEKO_PIPE) return;
      let data = {};
      try {
        const raw = process.stdin.isTTY ? '' : await Promise.race([readStdin(), new Promise(r => setTimeout(() => r(''), 1500))]);
        data = JSON.parse(raw || '{}');
      } catch {}
      try {
        await Promise.race([
          request({ cmd: 'claude-hook', event: pos[0] || data.hook_event_name, data }),
          new Promise(r => setTimeout(r, 2500)),
        ]);
      } catch {}
      process.exit(0);
    }
    case 'info': case 'ping': {
      const res = await request({ cmd: 'ping' });
      if (!res || res.error) fail(res);
      console.log(`Neko Terminal ${res.version}\nQuellordner: ${res.root}${!res.packaged ? ' (Entwicklungsmodus)' : res.fromSource ? '' : ' (in der exe, kein Quellordner)'}\nPipe: ${res.pipe}\nPane: ${process.env.NEKO_PANE}`);
      return;
    }
    default:
      console.error(`neko: unbekannter Befehl "${cmd}"\n`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch(e => {
  if (process.argv[2] === 'hook') process.exit(0);
  console.error('neko: ' + (e && e.message || e)); process.exit(1);
});
