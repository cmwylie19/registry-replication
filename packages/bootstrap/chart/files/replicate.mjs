import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '/app/node_modules/playwright/index.mjs';
import { loginAsAdmin } from '/app/login.js';
import { createLogger } from '/app/logger.js';
import { bootstrapReplication } from './replication.mjs';

const config = JSON.parse(await readFile('/bootstrap/config.json', 'utf8'));
const { stdout } = await promisify(execFile)('kubectl', [
  '-n', 'uds-system', 'get', 'secret', 'organization-token', '-o', 'json',
]);
const token = JSON.parse(stdout).data;
const env = {
  ...process.env,
  DESTINATION_USERNAME: Buffer.from(token.username, 'base64').toString(),
  DESTINATION_PASSWORD: Buffer.from(token.password, 'base64').toString(),
};
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: config.ignoreLocalTlsErrors,
  });
  const page = await context.newPage();
  await loginAsAdmin(page, {
    registryUrl: config.registryUrl,
    adminUsername: process.env.REGISTRY_ADMIN_USERNAME,
    adminPassword: process.env.REGISTRY_ADMIN_PASSWORD,
    idp: config.idp,
  }, createLogger());
  const result = await bootstrapReplication(page.request, config, env);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
