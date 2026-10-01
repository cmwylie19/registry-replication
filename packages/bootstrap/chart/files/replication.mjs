const accept = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

async function sourceDigest(request, config, env) {
  const url = config.source.endpoint + '/v2/' + config.source.repository +
    '/manifests/' + config.verifyTag;
  const basic = 'Basic ' + Buffer.from(env.SOURCE_USERNAME + ':' + env.SOURCE_PASSWORD).toString('base64');
  let response = await request.get(url, {
    headers: { Accept: accept, Authorization: basic }, maxRedirects: 0,
    ignoreHTTPSErrors: false,
  });
  if (response.status() === 401) {
    const challenge = response.headers()['www-authenticate'] ?? '';
    if (!/^Bearer /i.test(challenge)) throw new Error('Unsupported upstream authentication');
    const params = Object.fromEntries([...challenge.matchAll(/([a-z]+)="([^"]*)"/gi)]
      .map(match => [match[1].toLowerCase(), match[2]]));
    const tokenUrl = new URL(params.realm);
    if (tokenUrl.protocol !== 'https:' || tokenUrl.origin !== new URL(config.source.endpoint).origin) {
      throw new Error('Upstream token realm must use the configured HTTPS registry origin');
    }
    for (const key of ['service', 'scope']) {
      if (params[key]) tokenUrl.searchParams.set(key, params[key]);
    }
    const auth = await request.get(tokenUrl.href, {
      headers: { Authorization: basic }, maxRedirects: 0, ignoreHTTPSErrors: false,
    });
    if (!auth.ok()) throw new Error('Upstream token request failed: HTTP ' + auth.status());
    const body = await auth.json();
    const token = body.token ?? body.access_token;
    if (!token) throw new Error('Upstream did not return an access token');
    response = await request.get(url, {
      headers: { Accept: accept, Authorization: 'Bearer ' + token },
      maxRedirects: 0, ignoreHTTPSErrors: false,
    });
  }
  const digest = response.headers()['docker-content-digest'];
  if (!response.ok() || !digest) throw new Error('Unable to verify source manifest');
  return digest;
}

export async function bootstrapReplication(request, config, env, {
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  async function rpc(service, method, data) {
    const response = await request.post(
      config.registryUrl + '/registry.v1alpha1.' + service + '/' + method,
      { data, headers: { 'Connect-Protocol-Version': '1' } },
    );
    if (!response.ok()) throw new Error(method + ': HTTP ' + response.status());
    return response.json();
  }
  const expectedDigest = await sourceDigest(request, config, env);
  const { remotes = [] } = await rpc('RegistryRemoteService', 'ListRegistryRemotes', {
    filterToOrganizations: [config.organization], excludeGlobal: true,
  });
  const existingRemote = remotes.find(remote => remote.name === 'Replication source');
  const remoteInput = {
    name: 'Replication source', endpointUrl: config.source.endpoint,
    username: env.SOURCE_USERNAME, password: env.SOURCE_PASSWORD,
    disabled: false, insecureSkipVerify: false,
  };
  const { remote } = existingRemote
    ? await rpc('RegistryRemoteService', 'UpdateRegistryRemote', { id: existingRemote.id, ...remoteInput })
    : await rpc('RegistryRemoteService', 'CreateRegistryRemote', {
        scope: { organization: config.organization }, ...remoteInput,
      });
  const { rules = [] } = await rpc('ReplicationService', 'ListPullReplicationRules', {
    filterToOrganizations: [config.organization],
  });
  const existingRule = rules.find(rule =>
    rule.sourceRepository === config.source.repository &&
    rule.destinationRepository === config.destinationRepository);
  const ruleInput = {
    remoteId: remote.id, sourceRepository: config.source.repository,
    state: 'PULL_REPLICATION_RULE_STATE_ENABLED',
    overwriteExisting: config.overwriteExisting, tagFilter: config.tagFilter,
  };
  const { rule } = existingRule
    ? await rpc('ReplicationService', 'UpdatePullReplicationRule', { id: existingRule.id, ...ruleInput })
    : await rpc('ReplicationService', 'CreatePullReplicationRule', {
        organization: config.organization, destinationRepository: config.destinationRepository,
        ...ruleInput,
      });
  const activeRun = existingRule?.lastRun;
  const run = activeRun?.status?.running || activeRun?.status?.queued
    ? activeRun
    : (await rpc('ReplicationService', 'RunPullReplicationRule', { id: rule.id })).run;
  let queuedAt = Date.parse(run.lifecycle?.queuedAt);
  if (!Number.isFinite(queuedAt)) throw new Error('Missing replication queue timestamp');
  const deadline = now() + (config.timeoutSeconds - 60) * 1000;
  let runId;
  let attempts = 1;
  while (now() < deadline) {
    const current = await rpc('ReplicationService', 'GetPullReplicationRule', { id: rule.id });
    const last = current.rule.lastRun;
    // The trigger response has no persisted ID yet.
    if (Date.parse(last?.lifecycle?.queuedAt) === queuedAt) {
      if (last.status?.failed && attempts < (config.maxAttempts ?? 1)) {
        attempts++;
        const retry = await rpc('ReplicationService', 'RunPullReplicationRule', { id: rule.id });
        queuedAt = Date.parse(retry.run.lifecycle?.queuedAt);
        if (!Number.isFinite(queuedAt)) throw new Error('Missing retry queue timestamp');
        continue;
      }
      if (last.status?.failed || last.status?.canceled) throw new Error('Replication failed or canceled');
      if (last.status?.succeeded) { runId = last.runId; break; }
    }
    await sleep(5000);
  }
  if (!runId) throw new Error('Replication wait timed out');
  const destination = config.organization + '/' + config.destinationRepository;
  const destinationAuth = 'Basic ' + Buffer.from(
    env.DESTINATION_USERNAME + ':' + env.DESTINATION_PASSWORD,
  ).toString('base64');
  const response = await request.get(
    config.registryUrl + '/v2/' + destination + '/manifests/' + config.verifyTag,
    { headers: { Accept: accept, Authorization: destinationAuth } },
  );
  const digest = response.headers()['docker-content-digest'];
  if (!response.ok() || digest !== expectedDigest) {
    throw new Error('Destination digest does not match source');
  }
  return {
    ruleId: rule.id, runId, digest,
    destination: new URL(config.registryUrl).host + '/' + destination + ':' + config.verifyTag,
    credentialSecret: 'uds-system/organization-token',
  };
}
