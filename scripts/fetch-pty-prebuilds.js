// Makes sure the node-pty prebuilds for the given platforms are in node_modules.
// npm only installs the one for the machine it runs on; a macOS build for arm64 and x64 needs both.
// usage: node scripts/fetch-pty-prebuilds.js darwin-arm64 darwin-x64
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const lock = require(path.join(root, 'package-lock.json'));
for (const target of process.argv.slice(2)) {
  const name = `@lydell/node-pty-${target}`;
  const dest = path.join(root, 'node_modules', name);
  if (fs.existsSync(path.join(dest, 'package.json'))) { console.log(`${name}: present`); continue; }
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry) throw new Error(`${name} is not in package-lock.json`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-'));
  const tgz = execSync(`npm pack ${name}@${entry.version} --silent`, { cwd: tmp }).toString().trim().split('\n').pop();
  fs.mkdirSync(dest, { recursive: true });
  execSync(`tar -xzf "${path.join(tmp, tgz)}" -C "${dest}" --strip-components=1`);
  console.log(`${name}@${entry.version}: installed`);
}
