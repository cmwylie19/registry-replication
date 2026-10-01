import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapReplication } from '../packages/bootstrap/chart/files/replication.mjs';

const queuedAt = '2026-10-01T12:00:00Z';
const config = {
  registryUrl: 'https://registry.uds.dev', organization: 'replication-test',
  source: { endpoint: 'https://registry.defenseunicorns.com', repository: 'navy-tide/netbox' },
  destinationRepository: 'netbox', verifyTag: 'v4.6.0-uds.0-upstream',
  tagFilter: { versionSelector: 'v4.6.0-uds.0-upstream' },
  overwriteExisting: false, timeoutSeconds: 90,
};
const env = { SOURCE_USERNAME: 'test-reader', SOURCE_PASSWORD: 'test-secret',
  DESTINATION_USERNAME: 'test-org', DESTINATION_PASSWORD: 'test-token' };
function response(body, status = 200, headers = {}) {
  return { ok: () => status >= 200 && status < 300, status: () => status,
    headers: () => headers, json: async () => body };
}
function fixture({ existing = false, failure = false, mismatch = false,
  bearer = false, stale = false, neverFinishes = false, active = false,
  transientFailure = false } = {}) {
  const calls = [];
  let polls = 0;
  let sourceRequests = 0;
  let clock = 0;
  const request = {
    async get(url, options) {
      calls.push({ url, options });
      if (url.includes('/token')) return response({ token: 'bearer-test' });
      if (url.startsWith(config.source.endpoint)) {
        if (bearer && sourceRequests++ === 0) return response({}, 401, {
          'www-authenticate': 'Bearer realm="https://registry.defenseunicorns.com/token",service="registry",scope="repository:navy-tide/netbox:pull"',
        });
        return response({}, 200, { 'docker-content-digest': 'sha256:source' });
      }
      return response({}, 200, { 'docker-content-digest': mismatch ? 'sha256:other' : 'sha256:source' });
    },
    async post(url, { data }) {
      const method = url.split('/').at(-1);
      calls.push({ method, data });
      switch (method) {
        case 'ListRegistryRemotes':
          return response({ remotes: existing ? [{ id: 'remote-1', name: 'Replication source' }] : [] });
        case 'CreateRegistryRemote':
        case 'UpdateRegistryRemote': return response({ remote: { id: 'remote-1' } });
        case 'ListPullReplicationRules':
          return response({ rules: existing ? [{ id: 'rule-1',
            sourceRepository: config.source.repository, destinationRepository: 'netbox',
            ...(active ? { lastRun: { runId: 'run-1', lifecycle: { queuedAt }, status: { running: {} } } } : {}),
          }] : [] });
        case 'CreatePullReplicationRule':
        case 'UpdatePullReplicationRule': return response({ rule: { id: 'rule-1' } });
        case 'RunPullReplicationRule': return response({ run: { lifecycle: { queuedAt } } });
        case 'GetPullReplicationRule': {
          const poll = polls++;
          const old = stale && poll === 0;
          return response({ rule: { lastRun: {
            runId: 'run-1', lifecycle: { queuedAt: old ? '2026-09-30T12:00:00Z' : queuedAt },
            status: neverFinishes ? { running: {} }
              : failure || (transientFailure && poll === 0) ? { failed: {} } : { succeeded: {} },
          } } });
        }
        default: throw new Error('Unexpected RPC ' + method);
      }
    },
  };
  return { calls, run: () => bootstrapReplication(request, config, env, {
    now: () => clock, sleep: async ms => { clock += ms; },
  }) };
}
test('creates scoped remote and exact-tag rule; verifies equal digests', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.runId, 'run-1');
  assert.equal(result.digest, 'sha256:source');
  const remote = f.calls.find(c => c.method === 'CreateRegistryRemote');
  assert.deepEqual(remote.data.scope, { organization: 'replication-test' });
  assert.equal(remote.data.endpointUrl, config.source.endpoint);
  const rule = f.calls.find(c => c.method === 'CreatePullReplicationRule');
  assert.deepEqual(rule.data.tagFilter, config.tagFilter);
  assert.equal(rule.data.sourceRepository, 'navy-tide/netbox');
  assert.equal(JSON.stringify(result).includes(env.SOURCE_PASSWORD), false);
  const destination = f.calls.find(c => c.url?.startsWith(config.registryUrl));
  assert.equal(destination.options.headers.Authorization,
    'Basic ' + Buffer.from('test-org:test-token').toString('base64'));
  assert.equal(JSON.stringify(result).includes(env.DESTINATION_PASSWORD), false);
});
test('rerun updates remote/rule rather than duplicating', async () => {
  const f = fixture({ existing: true });
  await f.run();
  assert.ok(f.calls.some(c => c.method === 'UpdateRegistryRemote'));
  assert.ok(f.calls.some(c => c.method === 'UpdatePullReplicationRule'));
  assert.ok(!f.calls.some(c => c.method === 'CreatePullReplicationRule'));
});
test('recovery waits on an active copy without triggering another run', async () => {
  const f = fixture({ existing: true, active: true });
  assert.equal((await f.run()).runId, 'run-1');
  assert.ok(!f.calls.some(c => c.method === 'RunPullReplicationRule'));
});
test('ignores a stale successful run', async () => {
  const f = fixture({ stale: true });
  await f.run();
  assert.equal(f.calls.filter(c => c.method === 'GetPullReplicationRule').length, 2);
});
test('accepts upstream bearer challenge', async () => {
  const f = fixture({ bearer: true });
  await f.run();
  assert.ok(f.calls.some(c => c.options?.headers?.Authorization === 'Bearer bearer-test'));
});
test('fails when replication fails', async () => {
  await assert.rejects(fixture({ failure: true }).run(), /failed or canceled/);
});
test('retries a transient failed run once when configured', async () => {
  config.maxAttempts = 2;
  try {
    const f = fixture({ transientFailure: true });
    assert.equal((await f.run()).digest, 'sha256:source');
    assert.equal(f.calls.filter(c => c.method === 'RunPullReplicationRule').length, 2);
    await assert.rejects(fixture({ failure: true }).run(), /failed or canceled/);
  } finally {
    delete config.maxAttempts;
  }
});
test('fails on conflicting destination digest', async () => {
  await assert.rejects(fixture({ mismatch: true }).run(), /does not match source/);
});
test('fails if a run never finishes', async () => {
  await assert.rejects(fixture({ neverFinishes: true }).run(), /timed out/);
});
