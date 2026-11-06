/** Upgrade the previous public archive on its exact official host, preserving user data. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { authenticateWeb, redactWebAuth } from '../integration/web-auth.mjs';
import { harnessVersion, resolveCliInstallation } from '../integration/harness-baseline.mjs';

const root = process.cwd();
assert.ok(process.env.DSH_UPGRADE_FROM_MANIFEST, 'Provide the official previous DSH package.json');
assert.ok(process.env.DSH_UPGRADE_FROM_ARCHIVE, 'Provide the previous public plugin archive');
const previous = resolve(process.env.DSH_UPGRADE_FROM_MANIFEST);
const oldArchive = resolve(process.env.DSH_UPGRADE_FROM_ARCHIVE);
const current = await resolveCliInstallation(root);
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const archive = resolve(process.argv[2] || `artifacts/dsh-plugin-composable-workforce-${pkg.version}.tgz`);
const directory = await mkdtemp(resolve(tmpdir(), 'graph-horses-current-upgrade-'));
const home = resolve(directory, 'home');
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
const checks = [];
let child;
const cliEntry = manifest => resolve(dirname(manifest), 'lib/bin.js');
async function cli(manifest, ...args) {
  const proc = spawn(process.execPath, [cliEntry(manifest), ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; for (const stream of [proc.stdout, proc.stderr]) stream.on('data', chunk => { log += chunk; });
  assert.equal(await new Promise((done, reject) => { proc.once('exit', done); proc.once('error', reject); }), 0, redactWebAuth(log));
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(done => child.once('exit', done)); child.kill('SIGTERM'); await exited;
}
async function start(manifest) {
  const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port; await new Promise(done => socket.close(done));
  const base = `http://127.0.0.1:${port}`; let log = '', cookie;
  child = spawn(process.execPath, [cliEntry(manifest), '--profile', 'web', '--port', String(port), '--no-open'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-40000); });
  for (let attempt = 0; attempt < 240; attempt++) {
    assert.equal(child.exitCode, null, redactWebAuth(log));
    cookie ||= (await authenticateWeb(log, base).catch(() => undefined))?.cookie;
    if (cookie) {
      const response = await fetch(`${base}/digital-workers/api/state`, { headers: { Cookie: cookie } }).catch(() => undefined);
      if (response?.ok) return { base, cookie, state: await response.json() };
    }
    await new Promise(done => setTimeout(done, 250));
  }
  throw Error(redactWebAuth(log));
}
try {
  assert.equal(JSON.parse(await readFile(previous, 'utf8')).version, '0.2.1-rc.3');
  const args = ['--config.auto-install-peers=false', '--config.strict-peer-dependencies=false', '--ignore-scripts'];
  await cli(previous, 'plugin', '--profile', 'web', 'add', oldArchive, ...args);
  let connection = await start(previous);
  const template = connection.state.templates[0], modules = structuredClone(template.modules);
  modules.responsibilities.mission = 'UPGRADE_PRESERVED_CUSTOM_MISSION';
  const response = await fetch(`${connection.base}/digital-workers/api/command`, {
    method: 'POST', headers: { Cookie: connection.cookie, Origin: connection.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'employee.configuration.save', payload: { template: { ...template, name: 'UPGRADE_CUSTOM_ROLE', modules } }, options: { expectedVersion: template.version } }),
  });
  assert.equal(response.status, 200, await response.text());
  await stop();
  const statePath = resolve(home, 'composable-workforce/state.json'), before = await readFile(statePath);
  const profilePath = resolve(home, 'profiles/web/package.json');
  const bundles = JSON.parse(await readFile(profilePath, 'utf8')).dsh.profile.bundles;
  await cli(current.manifest, 'plugin', '--profile', 'web', 'add', archive, ...args);
  assert.deepEqual(await readFile(statePath), before, 'Installing a new archive must not rewrite user state');
  checks.push('official upgrade replaces 0.2.1/plugin.5 without rewriting user state');
  connection = await start(current.manifest);
  const saved = connection.state.templates.find(item => item.id === template.id);
  assert.equal(saved.name, 'UPGRADE_CUSTOM_ROLE');
  assert.equal(saved.modules.responsibilities.mission, 'UPGRADE_PRESERVED_CUSTOM_MISSION');
  for (const key of ['templates', 'teams', 'workflowTemplates', 'employees', 'runs', 'projects']) {
    assert.deepEqual(connection.state[key].map(item => item.id), JSON.parse(before)[key].map(item => item.id), `${key} identities must survive`);
  }
  assert.deepEqual(JSON.parse(await readFile(profilePath, 'utf8')).dsh.profile.bundles, bundles);
  checks.push('custom role, object identities, task history and bundle configuration survive new-host startup');
  const result = await fetch(`${connection.base}/api/session/list`, {
    method: 'POST', headers: { Cookie: connection.cookie, Origin: connection.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }),
  });
  assert.ok(result.ok); assert.equal((await result.json()).result.ok, true);
  checks.push('native session-list RPC remains functional after upgrade');
  await stop();
  const report = { archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), previousArchiveSha256: createHash('sha256').update(await readFile(oldArchive)).digest('hex'), from: { plugin: '0.2.1', dsh: '0.2.1-rc.3' }, to: { plugin: pkg.version, dsh: harnessVersion }, checks };
  const output = resolve(root, 'artifacts/compatibility-2026-11-06/upgrade'); await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await stop(); }
