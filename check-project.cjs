const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const required = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'shangou.js', 'config.example.json', 'regression.cjs',
  'docs/SETUP.md', 'docs/ARCHITECTURE.md', 'docs/CONFIGURATION.md', 'docs/DEVELOPMENT.md',
  'docs/EVIDENCE.md', 'docs/TROUBLESHOOTING.md', 'docs/DECISIONS.md', 'examples/session-summary.json'];
for (const item of required) assert(fs.existsSync(path.join(root, item)), `Missing ${item}`);
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const files = walk(root);
let links = 0;
for (const file of files.filter(file => file.endsWith('.md'))) {
  const body = fs.readFileSync(file, 'utf8');
  for (const match of body.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const relative = decodeURIComponent(target.split('#')[0]);
    assert(!path.isAbsolute(relative), `Absolute local link: ${file} -> ${target}`);
    const resolved = path.resolve(path.dirname(file), relative);
    assert(resolved.startsWith(root + path.sep), `Link escapes project: ${target}`);
    assert(fs.existsSync(resolved), `Broken link: ${file} -> ${target}`);
    links++;
  }
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8').replace(/^\uFEFF/, ''));
assert.equal(config.notify.webhook, '', 'Example must not contain a webhook');
assert.equal(config.timing.fireMode, 'timerBurst');
assert.equal(config.timing.fireWindowMs, 10000);
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'examples/session-summary.json'), 'utf8'));
assert.equal(evidence.sessions.length, 4);
for (const session of evidence.sessions) {
  assert.equal(session.serviceErrorCode, null);
  assert.equal(session.causeConfirmed, false);
}
for (const relative of ['config.json', 'result.json', 'daemon.heartbeat', 'autostart.flag', 'shangou-daemon.js', 'logs', 'results']) {
  assert(!fs.existsSync(path.join(root, relative)), `Runtime data in publication tree: ${relative}`);
}
console.log(`Project check passed: ${required.length} required files, ${links} local documentation links.`);
