import { access, readdir, readFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const env = { ...process.env };
const resume = process.argv.includes('--resume');
const packages = process.argv.filter(arg => arg.startsWith('--packages=')).map(arg => arg.slice(11));
const registry = 'registry.defenseunicorns.com';
const hasConfig = await access('uds-config.yaml').then(() => true, () => false);
if (!hasConfig && !(env.UDS_SOURCE_USERNAME && env.UDS_SOURCE_PASSWORD)) {
  const docker = JSON.parse(await readFile(join(homedir(), '.docker', 'config.json'), 'utf8'));
  const authKey = Object.keys(docker.auths ?? {}).find(key =>
    key.replace(/^https?:\/\//, '').replace(/\/$/, '') === registry) ?? registry;
  const helper = docker.credHelpers?.[registry] ?? docker.credsStore;
  let credentials;
  if (helper) {
    if (!/^[a-zA-Z0-9._-]+$/.test(helper)) throw new Error('Invalid Docker credential helper');
    credentials = await new Promise((resolve, reject) => {
      const child = spawn('docker-credential-' + helper, ['get'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.once('error', reject);
      child.stdin.once('error', reject);
      child.once('close', code => {
        if (code !== 0) reject(new Error('Docker login credentials unavailable for ' + registry));
        else {
          try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid credential helper response')); }
        }
      });
      child.stdin.end(authKey + '\n');
    });
  } else {
    const auth = Buffer.from(docker.auths?.[authKey]?.auth ?? '', 'base64').toString();
    const colon = auth.indexOf(':');
    if (colon >= 0) credentials = { Username: auth.slice(0, colon), Secret: auth.slice(colon + 1) };
  }
  if (!credentials?.Username || !credentials?.Secret) {
    throw new Error('Login to ' + registry + ' with Docker, or supply uds-config.yaml');
  }
  env.UDS_SOURCE_USERNAME = credentials.Username;
  env.UDS_SOURCE_PASSWORD = credentials.Secret;
  console.log('Using Docker login credentials for ' + registry + ' (not written to disk)');
}
const clusters = JSON.parse((await exec('k3d', ['cluster', 'list', '-o', 'json'])).stdout);
if (!resume && packages.length === 0 && clusters.some(cluster => cluster.name === 'registry-replication')) {
  throw new Error('Demo cluster already exists; refusing to destroy it. For a failed bootstrap, run node deploy.mjs --packages=replication-bootstrap.');
}
const bundles = (await readdir('build')).filter(file =>
  /^uds-bundle-registry-replication-(arm64|amd64)-0\.1\.0\.tar\.zst$/.test(file));
if (bundles.length !== 1) throw new Error('Run the create task; expected one architecture-specific bundle');
const child = spawn('uds', [
  '--uds-cache', '.cache/uds', 'deploy', join('build', bundles[0]),
  '--confirm', '--retries', '0',
  ...(resume ? ['--resume'] : []),
  ...packages.flatMap(name => ['--packages', name]),
], { stdio: 'inherit', env });
await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', code => code === 0
    ? resolve() : reject(new Error('Demo deployment failed; see UDS output above')));
});
