// Test fixtures must never inherit real upstream credentials or a real data directory.
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
for (const name of ['MIRROR_API_KEY', 'MIRROR_API_KEYS', 'OPENAI_API_KEY', 'MIRROR_STORE_KEY', 'MIRROR_DATA_DIR']) delete env[name];
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Expected a command to run in the isolated test environment');
const result = spawnSync(command, args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
