// Neko Terminal - bootstrap (the "main" entry of the exe).
// Loads main.js from the source folder when one is configured, so code updates
// ("neko update") need no new exe. Only an Electron upgrade needs a rebuild.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function pickRoot() {
  if (!app.isPackaged || process.env.NEKO_NO_SOURCE) return __dirname;
  const cfg = readJson(path.join(app.getPath('userData'), 'neko.json')) || {};
  const info = readJson(path.join(__dirname, 'build-info.json')) || {};
  const src = cfg.source_dir || info.source || '';
  const ok = src
    && fs.existsSync(path.join(src, 'main.js'))
    && fs.existsSync(path.join(src, 'node_modules', '@lydell', 'node-pty'));
  return ok ? src : __dirname;
}

const root = pickRoot();
global.NEKO_BOOT = { root, bundled: __dirname, fromSource: root !== __dirname };
try {
  require(path.join(root, 'main.js'));
} catch (e) {
  if (root === __dirname) throw e;
  // broken source checkout: fall back to the code inside the exe
  console.error('[neko] source main.js failed, using bundled copy:', e);
  global.NEKO_BOOT = { root: __dirname, bundled: __dirname, fromSource: false, error: String(e && e.stack || e) };
  require('./main.js');
}
