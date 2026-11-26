// Records the source folder inside the app, so the bootstrap can load updates from it ("neko update").
// Release builds (NEKO_RELEASE=1, used by CI) record no folder: they run the code bundled in the app.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const release = !!process.env.NEKO_RELEASE;
fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({ source: release ? '' : root, version: pkg.version, builtAt: new Date().toISOString() }, null, 2));
console.log('build-info.json ->', release ? '(release, no source folder)' : root);
