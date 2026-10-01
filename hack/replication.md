# Registry Replication Demo

This is one bundle: **k3d -> Zarf init -> UDS Core -> PostgreSQL -> Registry ->
demo login -> organization/token -> replication**. No existing cluster or user
is required. No post-deployment setup commands or UI clicks are required.

## Run

Start Docker and activate the repository's mise tools. You need Docker, UDS CLI,
k3d, Node, and access to the build/package registries. Ports 80, 443, and 6550 must
be available. Your existing Docker login must be able to pull the source image.

From the repository root:

```sh
cd demo/registry-replication
uds run -f tasks.yaml create
uds run -f tasks.yaml deploy
```

Create builds the Registry package if missing and packages all dependencies.
Deploy reads the upstream credential from Docker's credential helper in memory.
Alternatively, supply the upstream username/token in a private `uds-config.yaml`
based on the example. Never commit that file.

The bundle creates a cluster named `registry-replication`. It refuses to replace
an existing cluster. UDS changes your current kubeconfig context to this cluster.
This is a disposable local demo, not a production deployment.

## What You Get

- Registry at `https://registry.uds.dev`, with `pullReplication` and `connectApi` enabled.
- A generated encryption key, saved as `uds-system/replication-encryption`.
- A `doug` demo login, created automatically with a generated password.
- Organization `replication-test` and a seven-day write token, saved as
  `uds-system/organization-token` (`username`, `password`, `organization`).
- A replication rule for:

```text
registry.defenseunicorns.com/navy-tide/netbox:v4.6.0-uds.0-upstream
  -> registry.uds.dev/replication-test/netbox:v4.6.0-uds.0-upstream
```

The bootstrap uses the published `provision-organization:0.1.1` image to provision
the org/token. It then triggers replication and verifies matching source and
destination manifest digests. Deployment waits for the bootstrap and fails on
an error. The destination check authenticates with the generated organization
token. Its logs report the digest and rule/run IDs, not credentials.

Optional verification:

```sh
uds zarf tools kubectl -n uds-system logs job/replication-bootstrap -c replicate
uds zarf tools kubectl -n uds-system get secret organization-token
```

## Replication Settings

Settings are code in `uds-bundle.yaml` and
`packages/bootstrap/chart/values.yaml`. Credentials are deployment inputs.

The bundle sets `registry.features.pullReplication: true` (replication),
`registry.features.connectApi: true` (automation API), and
`secret.encryptionKey.secretRef` (encrypt stored upstream credentials).
There is no manual `kubectl set env` step. The generated demo password is in
`uds-system/replication-credentials`, key `REGISTRY_ADMIN_PASSWORD`.
The bootstrap allows one hour for slow image transfers (`timeoutSeconds`);
its bundle package timeout is `1h5m`. `maxAttempts: 2` retries a failed run once;
an existing active copy is waited on rather than duplicated.

**A rule specifies one repository.** There is no namespace-wide repository
wildcard. `tagFilter: {}` copies all tags in that repository; the default selects
only your exact NetBox tag. Other knobs include tag include/exclude regexes,
semver selectors, `latest`, and `overwriteExisting`. Overwrite is off by default.

Replication runs once during deployment. Continuous sync needs an external
scheduler. The organization token is for artifact push/pull; the bootstrap uses
the admin session to manage replication. Test signatures, SBOMs, and referrers
separately before replacing the artifact promoter.

## Result

Git cleanup: removed the generated cache and obsolete runbook from the repository,
and restored the vendor file's original contents. Only the demo is changed.
Verified on ARM64, October 1, 2026: the bundle created k3d, initialized Zarf,
deployed Core/Registry, and automatically created the login, org, and token.
Replication succeeded; the generated token read the destination manifest with
the same digest as the source:

```text
sha256:65c172d4b4c87f67b90ec41632e9ac5f8e8e76e25bf221554234b25a5db6b6d0
```

One fresh-cluster test hit Registry's hard-coded 15-minute HTTP read timeout
on a slow layer transfer. Retrying succeeded. The final demo includes that
bounded retry (covered by tests); the complete final bundle was not re-tested
from scratch after adding it. Its final bootstrap package passed live (rule 1,
run 3). Nine focused tests pass. This demonstrates image replication, not yet
parity with the artifact promoter.
