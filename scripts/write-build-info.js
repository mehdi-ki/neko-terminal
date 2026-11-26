// Records the source folder inside the exe, so the bootstrap can load updates from it.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({ source: root, version: pkg.version, builtAt: new Date().toISOString() }, null, 2));
console.log('build-info.json ->', root);
