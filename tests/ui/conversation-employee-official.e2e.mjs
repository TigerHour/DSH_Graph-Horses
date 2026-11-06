/** Explicit Chat residency, real header layout, and native streaming on an isolated official host. */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliInstallation } from '../../integration/harness-baseline.mjs';
import { authenticateWeb, redactWebAuth } from '../../integration/web-auth.mjs';
import { installEmployeeSettingsFixture } from './employee-settings-offline.fixture.mjs';
import { prepareOfficialPluginRuntime } from './official-plugin-runtime.mjs';
import { closeFixtureBrowser } from './browser-cleanup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.env.DSH_INSTALLATION_MANIFEST ||= resolve(root, '.local/official-0.2.2-rc.1/node_modules/@deepseek-ai/dsh/package.json');
const installation = await resolveCliInstallation(root), temp = await mkdtemp(resolve(tmpdir(), 'workforce-resident-official-ui-'));
const artifacts = resolve(process.env.WORKFORCE_RESIDENT_UI_ARTIFACTS || resolve(root, 'artifacts/conversation-employee/official-ui'));
const archive = process.env.WORKFORCE_UI_ARCHIVE && resolve(process.env.WORKFORCE_UI_ARCHIVE);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hostHash = async () => sha(Buffer.concat([await readFile(installation.entry), await readFile(installation.manifest)]));
const hostBefore = await hostHash(), checks = [], pageErrors = [];
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
let child, browser, browserServer, page, callsPath, inspectState, log = '', cookie = '';
const networkErrors = [];
async function start() {
  const home = resolve(temp, 'harness'), profile = resolve(home, 'profiles/web'), target = resolve(profile, 'node_modules/dsh-plugin-composable-workforce');
  const runtime = await prepareOfficialPluginRuntime({ root, packageDirectory: target, installation, archive });
  const fixture = await installEmployeeSettingsFixture(profile, root, installation); callsPath = fixture.llmCallsPath;
  await writeFile(resolve(profile, 'node_modules/dsh-plugin-employee-settings-fixture/index.js'), `
import { LlmAdapter } from '@deepseek-ai/dsh-llm'; import { appendFile } from 'node:fs/promises';
export const name = 'employee-settings-fixture'; export const inject = ['llm'];
class ResidentAdapter extends LlmAdapter {
  listModels(provider) { return Promise.resolve(['native-default','resident-specialist','temporary-specialist'].map(id=>({provider,id,name:id}))); }
  resolveModel(provider,id) { return Promise.resolve({provider,id,name:id,inputModalities:['text','image'],context:{contextWindow:262144}}); }
  async *stream(request) {
    const current = request.messages.findLast(message=>message.role==='user'&&message.source?.kind==='user');
    const marker = JSON.stringify(current?.content ?? []);
    const title = request.messages.some(message=>message.source?.kind==='dsh-session-title-llm');
    await appendFile(${JSON.stringify(callsPath)},JSON.stringify({stage:title?'title':'business',marker,provider:request.provider,model:request.model,system:request.system,messages:request.messages,tools:request.tools?.map(tool=>tool.name)})+'\\n');
    if(marker.includes('RESIDENT_SLOW')) await new Promise(done=>setTimeout(done,6000));
    const text='RESIDENT_REPLY:'+request.model;
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};
    yield {type:'usage',usage:{inputTokens:10,outputTokens:10}};yield {type:'finish',reason:{kind:'stop'}};
  }
}
export function apply(ctx){ctx.llm.registerAdapter(['employee-settings-fixture'],new ResidentAdapter());}
`);
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ name: 'resident-official-test', private: true, type: 'module', dependencies: { 'dsh-plugin-composable-workforce': `file:${archive || target}`, 'dsh-plugin-employee-settings-fixture': '0.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-composable-workforce', 'dsh-plugin-employee-settings-fixture'] } } }));
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: composable-workforce\n  config:\n    statePath: ${JSON.stringify(resolve(temp, 'state.json'))}\n- id: agent-default-model\n  config:\n    provider: employee-settings-fixture\n    model: native-default\n`);
  const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port; await new Promise(done => socket.close(done));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [installation.entry, '--profile', 'web', '--port', String(port), '--no-open'], { cwd: temp, env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, XDG_CONFIG_HOME: resolve(temp, 'config'), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NO_PROXY: '127.0.0.1,localhost', LANG: 'en_US.UTF-8', TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-60000); });
  for (let attempt = 0; attempt < 240; attempt++) {
    assert.equal(child.exitCode, null, redactWebAuth(log)); cookie ||= (await authenticateWeb(log, base).catch(() => undefined))?.cookie || '';
    if (cookie && (await fetch(base + '/digital-workers/api/state', { headers: { Cookie: cookie } }).catch(() => undefined))?.ok) return { base, sdk: Object.fromEntries(Object.entries(runtime.packages).map(([name, item]) => [name, item.version])) };
    await delay(250);
  }
  throw Error('Official host readiness timeout: ' + redactWebAuth(log));
}
try {
  await mkdir(artifacts, { recursive: true }); const { base, sdk } = await start();
  const get = async path => { const response = await fetch(base + path, { headers: { Cookie: cookie } }); assert.ok(response.ok, await response.clone().text()); return response.json(); };
  const post = async (path, body) => { const response = await fetch(base + path, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(response.ok, await response.clone().text()); return response.json(); };
  const rpc = async (method, request) => { const result = await post('/api/' + method, { type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }); assert.equal(result.result?.ok, true, JSON.stringify(result)); return result.result.value; };
  const state = () => get('/digital-workers/api/state');
  inspectState = state;
  const command = (action, payload, options) => post('/digital-workers/api/command', { action, payload, options });
  const calls = async () => (await readFile(callsPath, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.stage === 'business');
  const modules = structuredClone((await state()).templates[0].modules);
  modules.model = { mode: 'override', provider: 'employee-settings-fixture', model: 'resident-specialist' };
  modules.responsibilities.mission = 'RESIDENT_SAVED_MISSION：负责产品需求与验收。';
  modules.capabilities.skills = [{ id: 'architecture-analysis', name: '架构分析', description: 'RESIDENT_REQUIRED_SKILL', usage: 'required' }];
  modules.knowledge.sources = []; modules.knowledge.projectMemory = false; modules.knowledge.employeeMemory = false;
  let role, temporaryRole;
  const temporaryModules = structuredClone(modules); temporaryModules.model.model = 'temporary-specialist'; temporaryModules.responsibilities.mission = 'TEMPORARY_SAVED_MISSION：负责本轮临时架构分析。';
  const chatPath = resolve(temp, 'Chat'); await mkdir(chatPath); const workspace = (await rpc('workspace/create', { path: chatPath })).workspace, projectId = workspace.workspaceId;
  const sessionId = (await rpc('session/create', { workspaceId: projectId })).sessionId, otherId = (await rpc('session/create', { workspaceId: projectId })).sessionId;
  const resident = id => get('/digital-workers/api/conversation-employee?sessionId=' + encodeURIComponent(id));
  const prompt = (id, text) => rpc('session/prompt', { requestId: randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text }] });
  await prompt(sessionId, 'RESIDENT_BASE_ONE'); await prompt(otherId, 'RESIDENT_BASE_TWO');
  await expect.poll(async () => (await calls()).filter(item => item.marker.includes('RESIDENT_BASE')).length).toBe(2);
  await rpc('session/rename', { sessionId, title: 'QA-显式常驻对话' }); await rpc('session/rename', { sessionId: otherId, title: 'QA-其他Chat对话' });
  assert.equal((await resident(sessionId)).conversationEmployee, null); assert.equal((await state()).employees.length, 0); assert.equal((await state()).runs.length, 0);
  check('default-Chat-native-turns-create-no-resident-binding-employee-or-run');
  browserServer = await chromium.launchServer({ headless: true, host: '127.0.0.1', ...(process.env.WORKFORCE_BROWSER_CHANNEL === 'bundled' ? {} : { channel: process.env.WORKFORCE_BROWSER_CHANNEL || 'chrome' }) });
  browser = await chromium.connect(browserServer.wsEndpoint());
  page = await browser.newPage({ viewport: { width: 1512, height: 1050 }, colorScheme: 'dark', locale: 'zh-CN' }); page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => networkErrors.push({ url: request.url(), failure: request.failure() }));
  page.on('response', async response => { if (response.url().includes('/api/') && (response.url().includes('/session/prompt') || response.url().includes('/mention-ticket'))) { const body = await response.json().catch(() => undefined); networkErrors.push({ url: response.url(), status: response.status(), body }); } });
  const split = cookie.indexOf('='); await page.context().addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base, httpOnly: true, sameSite: 'Strict' }]);
  await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: '继续', exact: true }).click();
  const later = page.getByRole('button', { name: '稍后配置', exact: true }); if (await later.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) await later.click();
  const openSession = async id => {
    const row = page.locator(`[data-row-key=${JSON.stringify('session:' + id)}]`);
    if (!await row.isVisible()) { const folder = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'Chat' }).first(); await expect(folder).toBeVisible(); if (await folder.getAttribute('aria-expanded') !== 'true') await folder.click(); }
    await expect(row).toBeVisible(); await row.click(); await expect(page.locator('[data-composer-input][contenteditable=true]')).toBeEditable();
    await expect(page.locator('.wf-conversation-employee-trigger')).toBeVisible(); await expect(page.locator('.wf-conversation-workflow-picker, .wf-conversation-workflow-bar')).toHaveCount(0);
  };
  const trigger = page.locator('.wf-conversation-employee-trigger'), menu = page.locator('.wf-conversation-employee-menu');
  await openSession(sessionId); await expect(trigger).toHaveText('选择对话员工');
  await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(page.locator('.wf-conversation-employee')).toHaveAttribute('data-contact-aligned', 'true');
  const geometry = await page.evaluate(() => {
    const seat = document.querySelector('.wf-conversation-employee-seat'), header = seat.closest('header');
    const glyph = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect(); };
    const tab = [...header.querySelectorAll('[data-conversation-tabs] [role="tab"]')].at(-1), trigger = document.querySelector('.wf-conversation-employee-trigger'), label = trigger.querySelector('span');
    return { tabBottom: glyph(tab).bottom, contactBottom: glyph(label).bottom, triggerOutsideHeader: !trigger.closest('header'), triggerPosition: getComputedStyle(trigger.closest('.wf-conversation-employee')).position };
  });
  assert.ok(Math.abs(geometry.tabBottom - geometry.contactBottom) < 1, JSON.stringify(geometry));
  assert.equal(geometry.triggerOutsideHeader, true); assert.equal(geometry.triggerPosition, 'fixed');
  const beforeBrowseCalls = (await calls()).length;
  await trigger.focus(); await trigger.press('ArrowDown'); await expect(menu).toBeVisible();
  await expect(menu.getByRole('radio')).toHaveCount(0); await expect(menu.locator('details, summary, p, fieldset')).toHaveCount(0);
  const choices = (await resident(sessionId)).choices.map(choice => choice.name);
  assert.deepEqual(await menu.getByRole('option').allTextContents(), ['无', ...choices]);
  const popupBounds = await menu.boundingBox(); assert.ok(popupBounds.x >= 8 && popupBounds.x + popupBounds.width <= 1504 && popupBounds.width === 240, JSON.stringify(popupBounds));
  const portalPopup = await menu.evaluate(node => ({ outsideHeader: !node.closest('header'), position: getComputedStyle(node.closest('.wf-conversation-employee-popup')).position, headerBottom: document.querySelector('.wf-conversation-employee-seat').closest('header').getBoundingClientRect().bottom }));
  assert.equal(portalPopup.outsideHeader, true); assert.equal(portalPopup.position, 'fixed'); assert.ok(popupBounds.y >= portalPopup.headerBottom + 3.5);
  await page.screenshot({ path: resolve(artifacts, 'resident-menu-names-only.png'), clip: { x: Math.max(0, popupBounds.x - 24), y: 0, width: Math.min(1512 - Math.max(0, popupBounds.x - 24), popupBounds.width + 48), height: Math.min(800, popupBounds.y + popupBounds.height + 24) } });
  const triggerBounds = await trigger.boundingBox(), clipX = Math.max(0, Math.min(triggerBounds.x, popupBounds.x) - 12), clipY = Math.max(0, Math.min(triggerBounds.y, popupBounds.y) - 12);
  await page.screenshot({ path: resolve(artifacts, 'simple-employee-selector.png'), clip: { x: clipX, y: clipY, width: Math.min(1512, Math.max(triggerBounds.x + triggerBounds.width, popupBounds.x + popupBounds.width) + 12) - clipX, height: Math.max(triggerBounds.y + triggerBounds.height, popupBounds.y + popupBounds.height) + 12 - clipY } });
  assert.equal((await calls()).length, beforeBrowseCalls); assert.equal((await state()).employees.length, 0);
  await menu.locator('[role="listbox"]').press('Escape'); await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.click(); await page.locator('[data-composer-input][contenteditable=true]').click(); await expect(menu).toHaveCount(0);
  role = (await command('template.save', { name: 'QA-常驻产品负责人', status: 'ready', modules })).result;
  temporaryRole = (await command('template.save', { name: 'QA-临时架构师', status: 'ready', modules: temporaryModules })).result;
  await trigger.click(); await menu.getByRole('option', { name: role.name, exact: true }).hover(); await menu.locator('[role="listbox"]').press('Enter');
  await expect.poll(async () => (await resident(sessionId)).conversationEmployee?.mode).toBe('execute');
  await expect(trigger).toHaveText(role.name); assert.equal((await state()).employees.length, 1); assert.equal((await state()).runs.length, 0); assert.equal((await resident(otherId)).conversationEmployee, null);
  await page.screenshot({ path: resolve(artifacts, 'resident-header-bound.png') });
  check('simple-header-shows-placeholder-then-name-only-menu-without-cards-copy-or-mode-controls');
  check('explicit-selection-affects-only-selected-session-and-browsing-calls-no-model');
  const promptRequests = [];
  page.on('request', request => { if (request.url().endsWith('/api/session/prompt') && request.method() === 'POST') promptRequests.push(request.postDataJSON()); });
  const waitTurn = async text => {
    await expect.poll(async () => (await calls()).filter(item => item.marker.includes(text)).length, { timeout: 30000 }).toBe(1);
    await expect.poll(async () => (await resident(sessionId)).busy, { timeout: 30000 }).toBe(false);
    await expect.poll(async () => (await state()).runs.filter(run => run.request.includes(text)).every(run => !['queued', 'running', 'blocked'].includes(run.status)), { timeout: 30000 }).toBe(true);
  };
  const send = async text => { const editor = page.locator('[data-composer-input][contenteditable=true]'), before = promptRequests.length; await editor.fill(text); await editor.press('Enter'); await waitTurn(text); assert.equal(promptRequests.length, before + 1, 'one native submission per user send'); };
  for (const text of ['RESIDENT_EXECUTE_ONE', 'RESIDENT_EXECUTE_TWO']) await send(text);
  for (const call of (await calls()).filter(item => /RESIDENT_EXECUTE_(ONE|TWO)/.test(item.marker))) { assert.equal(call.model, 'resident-specialist'); assert.match(JSON.stringify(call), /RESIDENT_SAVED_MISSION/); assert.match(JSON.stringify(call), /本轮已载入的必备 Skill/); }
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(trigger).toHaveText(role.name);
  check('two-native-streamed-employee-turns-stay-in-same-conversation-and-choice-survives-reload');
  const editor = page.locator('[data-composer-input][contenteditable=true]');
  await editor.fill('@' + temporaryRole.name);
  const candidate = page.locator('[data-trigger-menu] [role="option"]').filter({ hasText: temporaryRole.name }); await expect(candidate).toHaveCount(1);
  await candidate.click();
  assert.equal((await state()).runs.length, 2, 'picking @ does not execute');
  await page.locator('[data-composer-card] input[type=file]').setInputFiles({ name: 'temporary-evidence.png', mimeType: 'image/png', buffer: await page.screenshot({ clip: { x: 10, y: 10, width: 2, height: 2 } }) });
  const beforeMention = promptRequests.length;
  await editor.press('End'); await editor.pressSequentially(' TEMPORARY_CHIP_WITH_IMAGE');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled(); await page.getByRole('button', { name: '发送消息', exact: true }).click(); await waitTurn('TEMPORARY_CHIP_WITH_IMAGE');
  assert.equal(promptRequests.length, beforeMention + 1);
  const chipCall = (await calls()).find(item => item.marker.includes('TEMPORARY_CHIP_WITH_IMAGE'));
  assert.equal(chipCall.model, 'temporary-specialist'); assert.match(JSON.stringify(chipCall), /TEMPORARY_SAVED_MISSION/);
  const submittedUser = chipCall.messages.findLast(message => message.role === 'user' && message.source?.kind === 'user'); assert.ok(submittedUser.content.some(block => block.type === 'image'), 'native image remains in the same user message');
  await expect(page.getByText(/<graph-horses-employee:/)).toHaveCount(0);
  await expect(trigger).toHaveText(role.name); assert.equal((await resident(sessionId)).conversationEmployee.employeeId, (await state()).employees.find(employee => employee.templateId === role.id).id);
  await send('RESIDENT_AFTER_TEMPORARY'); assert.equal((await calls()).find(item => item.marker.includes('RESIDENT_AFTER_TEMPORARY')).model, 'resident-specialist');
  check('temporary-reference-overrides-resident-only-for-one-turn-preserves-image-and-native-send');
  const raw = '@' + temporaryRole.name + ' TEMPORARY_PASTED_TEXT';
  await send(raw); assert.equal((await calls()).find(item => item.marker.includes('TEMPORARY_PASTED_TEXT')).model, 'temporary-specialist');
  await expect(trigger).toHaveText(role.name); await send('RESIDENT_AFTER_PASTE'); assert.equal((await calls()).find(item => item.marker.includes('RESIDENT_AFTER_PASTE')).model, 'resident-specialist');
  check('pasted-leading-at-text-routes-through-real-native-send-once-and-restores-resident-next-turn');
  await prompt(sessionId, 'RESIDENT_SLOW_ONE'); await expect.poll(async () => (await resident(sessionId)).busy).toBe(true);
  await trigger.click(); await expect(menu.getByRole('option').first()).toHaveAttribute('aria-disabled', 'true'); await menu.locator('[role="listbox"]').press('Escape');
  await openSession(otherId); await expect(trigger).toHaveText('选择对话员工'); await trigger.click(); await expect(menu.getByRole('option').first()).toHaveAttribute('aria-disabled', 'false'); await menu.locator('[role="listbox"]').press('Escape');
  await expect.poll(async () => (await resident(sessionId)).busy, { timeout: 30000 }).toBe(false); await openSession(sessionId);
  check('busy-employee-conversation-does-not-disable-another-Chat-employee-menu');
  const residentEmployeeId = (await resident(sessionId)).conversationEmployee.employeeId;
  await command('employee.update', { id: residentEmployeeId, input: { status: 'paused' } });
  await trigger.click(); await expect(menu).toContainText('常驻员工已暂停');
  await menu.getByRole('option', { name: '无', exact: true }).click(); await expect.poll(async () => (await resident(sessionId)).conversationEmployee).toBe(null);
  await expect(trigger).toHaveText('选择对话员工');
  const beforeNative = (await state()).runs.length; await send('RESIDENT_NATIVE_AFTER_CLEAR'); assert.equal((await state()).runs.length, beforeNative);
  await send('@' + temporaryRole.name + ' TEMPORARY_FROM_NONE'); assert.equal((await calls()).find(item => item.marker.includes('TEMPORARY_FROM_NONE')).model, 'temporary-specialist');
  assert.equal((await resident(sessionId)).conversationEmployee, null);
  const beforeDefaultFollowup = (await state()).runs.length; await send('RESIDENT_NATIVE_AFTER_TEMP_NONE'); assert.equal((await state()).runs.length, beforeDefaultFollowup);
  const native = (await calls()).find(item => item.marker.includes('RESIDENT_NATIVE_AFTER_TEMP_NONE')); assert.ok(!native.tools?.some(name => name.startsWith('worker_')));
  const activeContexts = native.messages.filter(message => message.source?.kind === 'runtime-context' && message.source?.form === 'snapshot').at(-1);
  assert.ok(!activeContexts?.source?.sections?.some(section => section.name === 'digital-worker:identity' || section.name === 'composable-workforce:task-context'));
  await expect(page.locator('[data-row-key^="session:"]')).toHaveCount(2);
  assert.ok((await state()).runs.every(run => run.sessionId === sessionId), 'all resident/temporary turns use the original native session');
  check('none-clears-even-paused-employee-and-temporary-mention-then-restores-native-without-extra-session');
  for (const width of [1024, 768]) {
    await page.setViewportSize({ width, height: 1050 }); await expect(trigger).toBeVisible();
    await expect.poll(async () => { const bounds = await trigger.boundingBox(); return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= width; }).toBe(true);
    await trigger.click(); const popup = await menu.boundingBox(); assert.ok(popup.x >= 8 && popup.x + popup.width <= width - 8, JSON.stringify(popup)); await menu.locator('[role="listbox"]').press('Escape');
  }
  await page.setViewportSize({ width: 1512, height: 1050 });
  await trigger.click(); await expect(menu).toBeVisible();
  await page.getByRole('button', { name: 'graph_horses', exact: true }).click();
  await expect(trigger).not.toBeVisible(); await expect(page.locator('.wf-conversation-employee-popup')).toHaveCount(0);
  await openSession(sessionId); await expect(trigger).toHaveText('选择对话员工');
  check('portal-controls-hide-in-resource-panel-and-restore-with-native-conversation');
  await page.screenshot({ path: resolve(artifacts, 'resident-dropdown-exited.png') });
  assert.deepEqual(pageErrors, []); assert.equal(await hostHash(), hostBefore);
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify({ status: 'passed', checks, checkCount: checks.length, sdk, pluginArchive: archive ? { sha256: sha(await readFile(archive)) } : undefined, modelCalls: { offline: (await calls()).length, external: 0 }, headerAlignment: geometry, popupBounds, responsiveWidths: [1024, 768], pageErrors, hostUnchanged: true }, null, 2));
  console.log(`PASS ${checks.length} official resident employee checks`);
} catch (error) {
  await mkdir(artifacts, { recursive: true }); await page?.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {});
  await writeFile(resolve(artifacts, 'failure-report.json'), JSON.stringify({ status: 'failed', checks, pageErrors, networkErrors, composerText: await page?.locator('[data-composer-card]').innerText().catch(() => undefined), error: String(error), state: await inspectState?.().catch(() => undefined), hostLog: redactWebAuth(log).slice(-10000), calls: (await readFile(callsPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)) }, null, 2));
  throw error;
 } finally {
  if (child?.exitCode === null) { child.kill('SIGTERM'); for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) await delay(100); if (child.exitCode === null) child.kill('SIGKILL'); }
  await closeFixtureBrowser({ page, browser, browserServer });
  await rm(temp, { recursive: true, force: true });
}
