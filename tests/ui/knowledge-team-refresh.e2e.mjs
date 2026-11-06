/** Real official host + packaged/shared Web UI, with isolated data and an offline-only model fixture. */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliInstallation } from '../../integration/harness-baseline.mjs';
import { authenticateWeb, redactWebAuth } from '../../integration/web-auth.mjs';
import { prepareOfficialPluginRuntime } from './official-plugin-runtime.mjs';
import { installEmployeeSettingsFixture } from './employee-settings-offline.fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.env.DSH_INSTALLATION_MANIFEST ||= resolve(root, '.local/official-0.2.2-rc.1/node_modules/@deepseek-ai/dsh/package.json');
const installation = await resolveCliInstallation(root);
const temp = await mkdtemp(resolve(tmpdir(), 'workforce-knowledge-team-refresh-'));
const home = resolve(temp, 'home'), profile = resolve(home, 'profiles/web'), statePath = resolve(temp, 'state.json');
const output = resolve(process.env.WORKFORCE_KNOWLEDGE_TEAM_ARTIFACTS || resolve(root, 'artifacts/knowledge-team-refresh'));
const archive = process.env.WORKFORCE_UI_ARCHIVE && resolve(process.env.WORKFORCE_UI_ARCHIVE);
const delay = ms => new Promise(done => setTimeout(done, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const programHash = async () => sha(Buffer.concat([await readFile(installation.entry), await readFile(installation.manifest)]));
const before = await programHash(), checks = [], metrics = {}, errors = [];
let child, browser, page, log = '', cookie = '', base;
const passed = name => { checks.push(name); console.log(`PASS ${name}`); };

async function freePort() {
  const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port; await new Promise(done => socket.close(done)); return port;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM'); for (let i = 0; i < 60 && child.exitCode === null; i++) await delay(100);
  if (child.exitCode === null) { child.kill('SIGKILL'); await delay(150); }
}
async function start() {
  log = ''; cookie = '';
  child = spawn(process.execPath, [installation.entry, '--profile', 'web', '--port', new URL(base).port, '--no-open'], { cwd: temp,
    env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, DSH_HOME: home, XDG_CONFIG_HOME: resolve(temp, 'config'),
      DSH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', LANG: 'zh_CN.UTF-8', NO_PROXY: '127.0.0.1,localhost' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-50000); });
  for (let i = 0; i < 160; i++) {
    assert.equal(child.exitCode, null, redactWebAuth(log));
    cookie ||= (await authenticateWeb(log, base).catch(() => undefined))?.cookie || '';
    if (cookie && (await fetch(base + '/digital-workers/api/state', { headers: { Cookie: cookie } }).catch(() => undefined))?.ok) return;
    await delay(250);
  }
  throw Error(redactWebAuth(log));
}
async function get(path) {
  const response = await fetch(base + path, { headers: { Cookie: cookie } });
  assert.ok(response.ok, await response.clone().text()); return response.json();
}
async function authenticatePage() {
  const separator = cookie.indexOf('=');
  await page.context().addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base, httpOnly: true, sameSite: 'Strict' }]);
}
const knowledgePath = (suffix, id, teamId) => '/digital-workers/api/knowledge' + suffix + '?' + new URLSearchParams({ scope: 'template', employeeId: id, library: teamId ? 'team' : 'employee', ...(teamId ? { teamId } : {}) });
async function readRoleGraph(id, teamId) {
  const library = await get(knowledgePath('', id, teamId)), wiki = await get(knowledgePath('/wiki', id, teamId));
  return { library, wiki };
}
const graphIdentity = ({ library, wiki }) => ({ version: wiki.version, nodes: wiki.graph.nodes.map(node => node.id).sort(), edges: wiki.graph.edges.map(edge => edge.id).sort(), sourceVersions: library.sources.map(source => `${source.id}:${source.version}`).sort() });
async function knowledgeInventory() {
  const directory = resolve(temp, 'knowledge/state.json'), files = {};
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      // Wiki projection JSON is a derived cache that may be rebuilt; A/B/C and reading files are durable evidence.
      else if (!entry.name.endsWith('.lock') && !entry.name.includes('.tmp') && !/\/wiki\/v\d+\/projection\.json$/.test(file)) files[relative(directory, file)] = sha(await readFile(file));
    }
  }
  await visit(directory); return Object.fromEntries(Object.entries(files).sort());
}
async function openLibrary() {
  await page.getByRole('button', { name: 'graph_horses', exact: true }).click();
  await expect(page.getByRole('button', { name: /自由职业人库 6/ })).toBeVisible();
  await page.getByRole('button', { name: /自由职业人库 6/ }).click();
}
async function openProductKnowledge() {
  await openLibrary();
  await page.getByRole('button', { name: '产品负责人', exact: true }).click();
  await page.getByRole('tab', { name: '认知记忆', exact: true }).click();
  await expect(page.locator('.wf-knowledge-category')).toHaveCount(4);
  await expect.poll(() => page.frameLocator('.wf-shared-wiki iframe').locator('.wiki-network button[data-node-id]').count(), { timeout: 20000 }).toBeGreaterThan(0);
}
const measureKnowledge = () => page.locator('.wf-knowledge-library').evaluate(library => {
  const box = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, top: rect.top, bottom: rect.bottom }; };
  const group = library.querySelector('.wf-knowledge-categories'), graph = library.querySelector('.wf-knowledge-browser');
  return { cards: [...library.querySelectorAll('.wf-knowledge-category')].map(box), group: box(group), graph: box(graph),
    groupOverflow: group.scrollWidth - group.clientWidth, libraryOverflow: library.scrollWidth - library.clientWidth };
});
const measureOrg = () => page.locator('.wf-team-org').evaluate(chart => {
  const viewport = chart.querySelector('.wf-team-org-viewport'), canvas = chart.querySelector('.wf-team-org-canvas');
  const bounds = viewport.getBoundingClientRect();
  return { scale: Number(canvas.dataset.scale), fitScale: Math.min(bounds.width / canvas.offsetWidth, bounds.height / canvas.offsetHeight), viewport: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
    overflow: viewport.scrollWidth - viewport.clientWidth, nodes: [...chart.querySelectorAll('.wf-team-org-node')].map(element => {
      const rect = element.getBoundingClientRect(); return { text: element.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }) };
});
function assertOrgFits(geometry) {
  assert.equal(geometry.nodes.length, 6);
  for (const node of geometry.nodes) {
    assert.ok(node.left >= geometry.viewport.left - 1 && node.right <= geometry.viewport.right + 1, `full horizontal visibility: ${node.text}`);
    assert.ok(node.top >= geometry.viewport.top - 1 && node.bottom <= geometry.viewport.bottom + 1, `full vertical visibility: ${node.text}`);
  }
}

try {
  await mkdir(output, { recursive: true }); await mkdir(resolve(profile, 'node_modules'), { recursive: true });
  await prepareOfficialPluginRuntime({ root, packageDirectory: resolve(profile, 'node_modules/dsh-plugin-composable-workforce'), installation, archive });
  await installEmployeeSettingsFixture(profile, root, installation);
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ name: 'knowledge-team-refresh-validation', private: true, type: 'module',
    dependencies: { 'dsh-plugin-composable-workforce': '0.0.0', 'dsh-plugin-employee-settings-fixture': '0.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-composable-workforce', 'dsh-plugin-employee-settings-fixture'] } } }));
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: composable-workforce\n  config:\n    statePath: ${JSON.stringify(statePath)}\n- id: agent-default-model\n  config:\n    provider: employee-settings-fixture\n    model: offline\n`);
  base = `http://127.0.0.1:${await freePort()}`; await start();
  const state = await get('/digital-workers/api/state'), team = state.teams.find(item => item.id === 'team-template-software');
  assert.equal(state.workflowTemplates.length, 1); assert.equal(state.workflowTemplates[0].name, '软件工程');
  assert.equal(team.members.find(member => member.memberId === 'product').reportsTo, undefined);
  assert.equal(team.members.find(member => member.memberId === 'architect').reportsTo, 'product');
  assert.equal(team.members.find(member => member.memberId === 'developer').reportsTo, 'architect');
  for (const id of ['designer', 'tester', 'operator']) assert.equal(team.members.find(member => member.memberId === id).reportsTo, 'product');
  const workflow = state.workflowTemplates[0]; assert.deepEqual(workflow.team.members, team.members);
  assert.equal(workflow.steps.length, 11);
  const acceptanceIndex = workflow.steps.findIndex(step => step.id === 'acceptance');
  const deploymentIndex = workflow.steps.findIndex(step => step.id === 'deployment');
  const retrospectiveIndex = workflow.steps.findIndex(step => step.id === 'retrospective');
  assert.ok(acceptanceIndex >= 0 && deploymentIndex === acceptanceIndex + 1 && retrospectiveIndex === deploymentIndex + 1, 'User acceptance precedes deployment and engineering retrospective');
  const deploymentRole = workflow.roles.find(role => role.id === workflow.steps[deploymentIndex].roleId);
  assert.equal(deploymentRole?.memberId, 'operator');
  for (const step of workflow.steps) {
    const role = workflow.roles.find(role => role.id === step.roleId); assert.ok(role);
    assert.ok(team.members.some(member => member.memberId === role.memberId));
    assert.ok(step.instruction && step.outputs.length && step.acceptanceCriteria.length);
  }
  passed('single-software-workflow-uses-product-led-team-and-valid-owners-for-every-complete-step');
  const original = {};
  for (const template of state.templates) {
    await expect.poll(async () => (await readRoleGraph(template.id)).wiki.graph.nodes.length, { timeout: 25000 }).toBeGreaterThan(0);
    const { library, wiki } = await readRoleGraph(template.id);
    assert.ok(library.snapshot?.conceptGraph?.concepts.length); assert.ok(wiki.graph.edges.length);
    const sources = new Set(library.sources.map(source => `${source.id}:${source.version}`));
    const citations = wiki.pages.flatMap(page => page.citations);
    assert.ok(citations.length && citations.every(citation => sources.has(`${citation.sourceId}:${citation.sourceVersion}`)));
    original[template.id] = graphIdentity({ library, wiki });
  }
  passed('all-six-professional-graphs-have-grounded-concepts-relations-and-existing-source-citations');
  metrics.graphs = original;
  const teamReader = team.members.find(member => member.memberId === 'product').templateId;
  const teamGraph = await readRoleGraph(teamReader, team.id);
  assert.ok(teamGraph.library.snapshot?.conceptGraph?.concepts.length && teamGraph.wiki.graph.nodes.length && teamGraph.wiki.graph.edges.length);
  const originalTeamGraph = graphIdentity(teamGraph); metrics.teamGraph = originalTeamGraph;
  passed('software-team-shared-library-also-has-a-source-backed-semantic-graph');
  browser = await chromium.launch({ headless: true, ...(process.env.WORKFORCE_BROWSER_CHANNEL === 'bundled' ? {} : { channel: process.env.WORKFORCE_BROWSER_CHANNEL || 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1512, height: 1050 }, locale: 'zh-CN', colorScheme: 'light' });
  page.on('pageerror', error => errors.push(error.message)); await authenticatePage(); await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '继续', exact: true }).click({ timeout: 20000 });
  const later = page.getByRole('button', { name: '稍后配置', exact: true });
  if (await later.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false)) await later.click();
  await openProductKnowledge(); metrics.knowledgeGeometry = [];
  for (const width of [1512, 1024, 768]) {
    await page.setViewportSize({ width, height: 1050 });
    await expect.poll(async () => { const geometry = await measureKnowledge(); return Math.max(...geometry.cards.map(card => card.width)) - Math.min(...geometry.cards.map(card => card.width)); }).toBeLessThan(1);
    const geometry = await measureKnowledge(); assert.equal(geometry.cards.length, 4);
    assert.ok(Math.abs(geometry.cards[3].right - geometry.graph.right) <= 1); assert.ok(Math.abs(geometry.cards[0].left - geometry.graph.left) <= 1);
    assert.ok(geometry.groupOverflow <= 1 && geometry.libraryOverflow <= 1);
    metrics.knowledgeGeometry.push({ width, ...geometry }); await page.screenshot({ path: resolve(output, `knowledge-${width}.png`) });
  }
  passed('four-knowledge-cards-share-width-and-align-with-graph-edges-without-horizontal-overflow');
  await page.setViewportSize({ width: 1512, height: 1050 }); await page.getByRole('button', { name: /团队 1/ }).click();
  const chart = page.locator('.wf-team-org'), viewport = chart.locator('.wf-team-org-viewport'); await expect(chart).toBeVisible();
  await expect.poll(async () => { const geometry = await measureOrg(); return geometry.nodes.length === 6 && Math.abs(geometry.scale - geometry.fitScale) < .001 && geometry.nodes.every(node => node.left >= geometry.viewport.left - 1 && node.right <= geometry.viewport.right + 1); }).toBe(true);
  const initialOrg = await measureOrg(); assertOrgFits(initialOrg);
  assert.ok(initialOrg.nodes.some(node => node.text.includes('第 1 级') && node.text.includes('产品负责人')));
  assert.ok(initialOrg.nodes.some(node => node.text.includes('第 2 级') && node.text.includes('技术负责人')));
  assert.ok(initialOrg.nodes.some(node => node.text.includes('第 3 级') && node.text.includes('开发人员')));
  for (const name of ['UX/UI设计师', '测试负责人', '运维负责人']) assert.ok(initialOrg.nodes.some(node => node.text.includes('第 2 级') && node.text.includes(name)));
  assert.equal(initialOrg.nodes.filter(node => node.text.includes('第 3 级')).length, 1, 'Only the developer reports through the architect');
  await viewport.hover(); await page.mouse.wheel(0, -200); await expect.poll(async () => (await measureOrg()).scale).toBeGreaterThan(initialOrg.scale);
  await page.mouse.wheel(0, 400); await expect.poll(async () => (await measureOrg()).scale).toBeLessThan(initialOrg.scale);
  await chart.getByRole('button', { name: '适配视图', exact: true }).click(); assertOrgFits(await measureOrg());
  await chart.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, 'organization-fit-wide.png') });
  await page.setViewportSize({ width: 768, height: 900 }); await expect.poll(async () => (await measureOrg()).scale).toBeLessThan(initialOrg.scale); assertOrgFits(await measureOrg());
  metrics.organization = initialOrg; await chart.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, 'organization-fit.png') });
  passed('org-chart-fits-all-six-people-at-correct-levels-and-supports-wheel-zoom-and-fit-reset');
  await page.getByRole('button', { name: /工作流 1/ }).click();
  await expect(page.getByRole('button', { name: '缺陷修复', exact: true })).toHaveCount(0);
  const owners = page.locator('.wf-workflow-step-assignee select'); await expect(owners).toHaveCount(workflow.steps.length);
  for (let i = 0; i < workflow.steps.length; i++) assert.equal(await owners.nth(i).inputValue(), workflow.steps[i].roleId);
  await expect(page.locator('.wf-workflow-map-node')).toHaveCount(workflow.steps.length);
  for (const [index, step] of workflow.steps.entries()) {
    const target = workflow.steps.findIndex(candidate => candidate.id === step.onRejectStepId);
    const node = page.locator('.wf-workflow-map-node').nth(index);
    await expect(node.locator('small')).toHaveCount(target >= 0 && target < index ? 1 : 0);
    assert.ok(!(await node.getAttribute('title')).includes('本步骤返工'), 'self rework has no special node tooltip');
  }
  passed('workflow-map-labels-only-cross-step-returns-without-self-rework-hints');
  await page.locator('.wf-workflow-diagram').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, 'software-workflow.png') });
  await page.setViewportSize({ width: 1512, height: 1050 });
  await expect.poll(() => page.locator('.wf-workflow-map-viewport').evaluate(viewport => Math.abs(viewport.clientWidth - viewport.querySelector('.wf-workflow-map-canvas').offsetWidth))).toBeLessThan(3);
  const diagram = page.locator('.wf-workflow-diagram'), diagramSize = await diagram.boundingBox();
  // Give the real scroll container enough room for every row before taking a complete, readable diagram image.
  await page.setViewportSize({ width: 1512, height: Math.max(1050, Math.ceil(diagramSize.height + 240)) });
  await diagram.scrollIntoViewIfNeeded();
  await diagram.screenshot({ path: resolve(output, 'software-workflow-wide.png') });
  await page.screenshot({ path: resolve(output, 'software-workflow-wide-context.png') });
  passed('workflow-editor-and-flowchart-render-every-saved-step-with-its-bound-team-owner');
  const filesBefore = await knowledgeInventory(); assert.ok(Object.keys(filesBefore).length);
  await stop(); await start(); await authenticatePage();
  for (const [id, expected] of Object.entries(original)) {
    assert.deepEqual(graphIdentity(await readRoleGraph(id)), expected);
  }
  assert.deepEqual(graphIdentity(await readRoleGraph(teamReader, team.id)), originalTeamGraph);
  assert.deepEqual(await knowledgeInventory(), filesBefore);
  await page.reload({ waitUntil: 'domcontentloaded' }); await openProductKnowledge();
  metrics.persistence = { authoritativeAndReadingFileCount: Object.keys(filesBefore).length, excludedDerivedCache: 'wiki/v*/projection.json' };
  passed('persisted-source-versions-concepts-relations-and-authoritative-knowledge-files-survive-official-host-restart');
  assert.deepEqual(errors, []); assert.equal(await programHash(), before);
  passed('no-page-errors-and-official-launcher-manifest-and-program-remain-unchanged');
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, checks, metrics, pageErrors: errors, archiveSha256: archive ? sha(await readFile(archive)) : undefined, officialLauncherHash: before }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ error: String(error), checks, metrics, pageErrors: errors, log: redactWebAuth(log) }, null, 2));
  throw error;
} finally { await browser?.close(); await stop(); await rm(temp, { recursive: true, force: true }); }
