import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { invariantSettings } from './worker-deployment-settings.mjs';

const directory = path.resolve(process.argv[2]);
const sha = process.env.GITHUB_SHA;
assert.match(sha || '', /^[a-f0-9]{40}$/);
assert.equal(process.env.GITHUB_REPOSITORY, 'gptenv/mirror-worker');
assert.equal(process.env.GITHUB_REF, 'refs/heads/codex/worker-reliability');
assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
assert.ok(process.env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN must be configured through the approved GitHub secret setup');
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, '711ab96baee8597bf61ed973363715d6');
execFileSync(process.execPath, ['scripts/worker-artifact.mjs', 'check', directory, '--deployment'], { stdio: 'inherit' });
const head = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/codex/worker-reliability'], { encoding: 'utf8' }).split(/\s/)[0];
const receiptPath = path.join(process.env.RUNNER_TEMP, 'mirror-worker-deployment.json');
if (head !== sha) {
  writeFileSync(receiptPath, JSON.stringify({ sha, status: 'skipped', reason: 'A newer commit is already on the deployment branch', head }, null, 2));
  console.log('Skipped stale deployment; a newer commit owns the deployment branch.');
  process.exit(0);
}
const prefix = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CLOUDFLARE_ACCOUNT_ID + '/workers/scripts/mirror-worker';
async function api(suffix) {
  const response = await fetch(prefix + suffix, { headers: { authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  assert.equal(response.ok, true, `Cloudflare metadata request failed (${response.status})`);
  const body = await response.json();
  assert.equal(body.success, true, 'Cloudflare metadata request failed');
  return body.result;
}
const before = await api('/deployments');
const settingsBefore = invariantSettings(await api('/settings'), true);
const receipt = { sha, previousDeployment: before.deployments[0], status: 'deploying' };
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
const latestHead = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/codex/worker-reliability'], { encoding: 'utf8' }).split(/\s/)[0];
if (latestHead !== sha) {
  receipt.status = 'skipped'; receipt.reason = 'Branch advanced during metadata preflight'; receipt.head = latestHead;
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2)); process.exit(0);
}
execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', path.join(directory, 'wrangler.json'), '--no-bundle', '--keep-vars', '--strict', '--tag', sha, '--message', 'CI: deploy the verified Worker artifact'], { stdio: 'inherit' });
const after = await api('/deployments');
receipt.deployment = after.deployments[0];
receipt.status = 'uploaded; verification pending';
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
const settingsAfter = await api('/settings');
assert.equal(settingsAfter.annotations['workers/tag'], sha);
assert.equal(JSON.stringify(invariantSettings(settingsAfter)), JSON.stringify(settingsBefore), 'Deployment changed unrelated settings or bindings');
receipt.status = 'deployed';
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
const base = 'https://mirror-worker.defcronyke.workers.dev';
assert.equal((await fetch(base + '/api/health', { redirect: 'error' })).status, 200);
assert.equal((await fetch(base + '/api/conversations', { redirect: 'error' })).status, 401);
const shell = await new Promise((resolve, reject) => {
  const req = httpsRequest(base + '/space/files', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    res.on('error', reject);
  });
  req.on('error', reject); req.setTimeout(30_000, () => req.destroy(new Error('Smoke request timed out'))); req.end();
});
assert.equal(shell.status, 200);
assert.match(shell.body, /<form id="connect">/);
receipt.status = 'live smoke passed';
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
console.log(`Deployed and smoke-verified ${sha}`);
