import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '/app/node_modules/playwright/index.mjs';

const exec = promisify(execFile);
const { stdout } = await exec('kubectl', [
  '-n', 'keycloak', 'get', 'secret', 'keycloak-admin-password', '-o', 'json',
]);
const secret = JSON.parse(stdout);
const adminUsername = Buffer.from(secret.data.username, 'base64').toString();
const adminPassword = Buffer.from(secret.data.password, 'base64').toString();
const api = await request.newContext({
  baseURL: 'https://keycloak.admin.uds.dev',
  ignoreHTTPSErrors: true,
});
try {
  const auth = await api.post('/realms/master/protocol/openid-connect/token', {
    form: { client_id: 'admin-cli', grant_type: 'password',
      username: adminUsername, password: adminPassword },
  });
  if (!auth.ok()) throw new Error('Keycloak admin authentication failed: HTTP ' + auth.status());
  const { access_token: token } = await auth.json();
  if (!token) throw new Error('Keycloak admin token missing');
  const headers = { Authorization: 'Bearer ' + token };
  const username = process.env.REGISTRY_ADMIN_USERNAME;
  const users = await api.get('/admin/realms/uds/users', {
    headers, params: { username, exact: 'true' },
  });
  if (!users.ok()) throw new Error('Unable to list demo users');
  if ((await users.json()).length) {
    console.log('Demo login already exists');
  } else {
    const created = await api.post('/admin/realms/uds/users', {
      headers,
      data: {
        username, firstName: 'Registry', lastName: 'Demo',
        email: username + '@uds.dev', emailVerified: true, enabled: true,
        requiredActions: [], groups: ['/UDS Core/Admin'],
        credentials: [{ type: 'password', temporary: false,
          value: process.env.REGISTRY_ADMIN_PASSWORD }],
      },
    });
    if (!created.ok()) throw new Error('Unable to create demo login: HTTP ' + created.status());
    console.log('Demo login created');
  }
} finally {
  await api.dispose();
}
