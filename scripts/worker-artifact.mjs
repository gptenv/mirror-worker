import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// CI records the exact tested bundle and its hashes for later release use.
// This manifest contains no runtime secrets.
const [action, destination] = process.argv.slice(2);
assert.ok(['build', 'check'].includes(action) && destination, 'Usage: worker-artifact.mjs build|check DIRECTORY [--deployment]');
const directory = path.resolve(destination);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
function hashes(root = directory, prefix = '') {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = prefix + entry.name;
    if (name === 'release.json') return [];
    assert.ok(!entry.isSymbolicLink(), 'Artifact must not contain symlinks');
    if (entry.isDirectory()) return Object.entries(hashes(path.join(root, entry.name), name + '/'));
    assert.ok(entry.isFile(), 'Artifact must contain only files');
    return [[name, createHash('sha256').update(readFileSync(path.join(root, entry.name))).digest('hex')]];
  }));
}
if (action === 'build') {
  mkdirSync(directory, { recursive: true });
  assert.equal(readdirSync(directory).length, 0, 'Artifact directory must be empty');
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' };
  for (const key of Object.keys(env)) if (/^(CLOUDFLARE_|CF_API_|MIRROR_|OPENAI_API_KEY)/.test(key)) delete env[key];
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', path.join(directory, 'worker')], { env, stdio: 'inherit' });
  cpSync('apps/web/dist', path.join(directory, 'assets'), { recursive: true });
  writeFileSync(path.join(directory, 'wrangler.json'), JSON.stringify({ ...config, $schema: undefined, main: './worker/cloudflare-worker.js', assets: { ...config.assets, directory: './assets' } }, null, 2) + '\n');
  writeFileSync(path.join(directory, 'release.json'), JSON.stringify({ sha: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '', files: hashes() }, null, 2) + '\n');
}
const release = JSON.parse(readFileSync(path.join(directory, 'release.json'), 'utf8'));
assert.equal(release.sha, process.env.GITHUB_SHA || git('rev-parse', 'HEAD'), 'Artifact belongs to a different commit');
assert.deepEqual(hashes(), release.files, 'Artifact bytes changed after bundling');
if (process.argv.includes('--deployment')) assert.equal(release.dirty, false, 'Deployment artifact must come from a clean checkout');
console.log(`Verified Worker artifact for ${release.sha} (${Object.keys(release.files).length} files)`);
