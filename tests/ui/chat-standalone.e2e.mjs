/** Chat workflow exclusion, temporary native @ turns, and explicit historical-work-order compatibility. */
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
const installation = await resolveCliInstallation(root);
const temp = await mkdtemp(resolve(tmpdir(), 'workforce-chat-standalone-ui-'));
const artifacts = resolve(process.env.WORKFORCE_CHAT_UI_ARTIFACTS || resolve(root, 'artifacts/chat-workflow/official-ui'));
const archive = process.env.WORKFORCE_UI_ARCHIVE && resolve(process.env.WORKFORCE_UI_ARCHIVE);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hostHash = async () => sha(Buffer.concat([await readFile(installation.entry), await readFile(installation.manifest)]));
const hostBefore = await hostHash(), checks = [], errors = [];
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
let child, browser, browserServer, page, callsPath, log = '', cookie = '';
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM'); for (let i = 0; i < 80 && child.exitCode === null; i++) await delay(100);
  if (child.exitCode === null) { child.kill('SIGKILL'); await delay(100); }
}
async function start() {
  const home = resolve(temp, 'harness'), profile = resolve(home, 'profiles/web');
  const target = resolve(profile, 'node_modules/dsh-plugin-composable-workforce');
  const runtime = await prepareOfficialPluginRuntime({ root, packageDirectory: target, installation, archive });
  const fixture = await installEmployeeSettingsFixture(profile, root, installation); callsPath = fixture.llmCallsPath;
  const file = resolve(profile, 'node_modules/dsh-plugin-employee-settings-fixture/index.js');
  let source = await readFile(file, 'utf8');
  source = source.replace("export const inject = ['llm'];", "export const inject = ['llm', 'sessions'];");
  source = source.replace("import { LlmAdapter } from '@deepseek-ai/dsh-llm';", "import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';");
  source = source.replace(/  listModels\(provider\) \{[^\n]+/, "  listModels(provider) { return Promise.resolve(['native-default', 'chat-specialist'].map(id => ({ provider, id, name: id }))); }");
  source = source.replace(/  resolveModel\(provider, model\) \{[^\n]+/, "  resolveModel(provider, id) { return Promise.resolve({ provider, id, name: id, context: { contextWindow: 262144 } }); }");
  source = source.replace('  async *stream(request) {', `  async *stream(request) {
    if (JSON.stringify(request.messages).includes('CHAT_NATIVE_BASELINE_431') || JSON.stringify(request.messages).includes('CHAT_AT_TASK_431_') || JSON.stringify(request.messages).includes('CHAT_NATIVE_FOLLOWUP_432')) {
      await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ stage: request.messages.some(message => message.source?.kind === 'dsh-session-title-llm') ? 'native-title' : 'business', provider: request.provider, model: request.model, system: request.system, messages: request.messages, tools: request.tools?.map(tool => tool.name) }) + '\\n');
      const text = 'CHAT_STANDALONE_REPLY:' + request.model;
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }; yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
  `);
  // Restore a synthetic old workflow contribution after the first completed
  // native turn. This uses only the public append surface, creates no fake turn
  // or binding, and exercises source-context isolation before the @ interceptor.
  source = source.replace("export function apply(ctx) { ctx.llm.registerAdapter(['employee-settings-fixture'], new OfflineKnowledgeAdapter()); }", `export function apply(ctx) {
    ctx.llm.registerAdapter(['employee-settings-fixture'], new OfflineKnowledgeAdapter());
    const seeded = new Set();
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end' || seeded.has(session.id)) return;
      void appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ stage: 'fixture-turn-end', sessionId: session.id, baseline: JSON.stringify(session.deriveMessages()).includes('CHAT_NATIVE_BASELINE_431') }) + '\\n');
      if (!session.deriveMessages().some(message => message.role === 'user' && JSON.stringify(message.content).includes('CHAT_NATIVE_BASELINE_431'))) return;
      seeded.add(session.id);
      const sections = [{ name: 'composable-workforce:conversation-workflow', text: 'OLD_WORKFLOW_ROLE_MUST_NOT_COPY_431' }];
      queueMicrotask(() => {
        session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot', sections }, content: [{ type: 'text', text: sections[0].text }] }), { surfaceOp: 'append' });
        void appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ stage: 'legacy-seed', sessionId: session.id }) + '\\n');
      });
    });
  }`);
  assert.ok(source.includes('queueMicrotask'), 'legacy context fixture is actually installed');
  await writeFile(file, source);
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ name: 'chat-standalone-official-test', private: true, type: 'module',
    dependencies: { 'dsh-plugin-composable-workforce': `file:${archive || target}`, 'dsh-plugin-employee-settings-fixture': '0.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-composable-workforce', 'dsh-plugin-employee-settings-fixture'] } } }));
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: composable-workforce\n  config:\n    statePath: ${JSON.stringify(resolve(temp, 'state.json'))}\n- id: agent-default-model\n  config:\n    provider: employee-settings-fixture\n    model: native-default\n`);
  const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port; await new Promise(done => socket.close(done));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [installation.entry, '--profile', 'web', '--port', String(port), '--no-open'], { cwd: temp,
    env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, XDG_CONFIG_HOME: resolve(temp, 'config'), DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NO_PROXY: '127.0.0.1,localhost', LANG: 'en_US.UTF-8', TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-60000); });
  for (let i = 0; i < 240; i++) {
    assert.equal(child.exitCode, null, redactWebAuth(log));
    cookie ||= (await authenticateWeb(log, base).catch(() => undefined))?.cookie || '';
    if (cookie && (await fetch(base + '/digital-workers/api/state', { headers: { Cookie: cookie } }).catch(() => undefined))?.ok) return { base, sdk: Object.fromEntries(Object.entries(runtime.packages).map(([name, item]) => [name, item.version])) };
    await delay(250);
  }
  throw Error('Official host readiness timeout: ' + redactWebAuth(log));
}
try {
  await mkdir(artifacts, { recursive: true }); const { base, sdk } = await start();
  const get = async path => { const r = await fetch(base + path, { headers: { Cookie: cookie } }); assert.ok(r.ok, await r.clone().text()); return r.json(); };
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(r.ok, await r.clone().text()); return r.json(); };
  const rpc = async (method, request) => { const result = await post('/api/' + method, { type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }); assert.equal(result.result?.ok, true, JSON.stringify(result)); return result.result.value; };
  const state = () => get('/digital-workers/api/state');
  const command = (action, payload) => post('/digital-workers/api/command', { action, payload });
  const calls = async () => (await readFile(callsPath, 'utf8').catch(e => e.code === 'ENOENT' ? '' : Promise.reject(e))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.stage === 'business');
  const currentTask = item => JSON.stringify(item.messages?.findLast(message => message.role === 'user' && message.source?.kind === 'user')?.content ?? []);
  const isNativeTask = item => /CHAT_NATIVE_(?:BASELINE_431|FOLLOWUP_432)/.test(currentTask(item));
  const isEmployeeTask = item => currentTask(item).includes('CHAT_AT_TASK_431_');
  const initial = await state(), modules = structuredClone(initial.templates[0].modules);
  modules.model = { mode: 'override', provider: 'employee-settings-fixture', model: 'chat-specialist' };
  modules.responsibilities.mission = 'CHAT_SPECIALIST_MISSION_431：作为独立员工交付可核查结果。';
  modules.capabilities.skills = [{ id: 'architecture-analysis', name: '架构分析', description: 'CHAT_REQUIRED_SKILL_431', usage: 'required' }];
  modules.knowledge.sources = []; modules.knowledge.projectMemory = false; modules.knowledge.employeeMemory = false;
  const role = (await command('template.save', { name: 'QA-Chat专家', status: 'ready', modules })).result;
  const chatPath = resolve(temp, 'Chat'); await mkdir(chatPath);
  const workspace = (await rpc('workspace/create', { path: chatPath })).workspace, projectId = workspace.workspaceId;
  const sessionId = (await rpc('session/create', { workspaceId: projectId })).sessionId;
  const view = () => get('/digital-workers/api/conversation-workflow?sessionId=' + encodeURIComponent(sessionId));
  await rpc('session/prompt', { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'CHAT_NATIVE_BASELINE_431' }] });
  await expect.poll(async () => (await calls()).length, { timeout: 30000 }).toBe(1);
  await expect.poll(async () => (await readFile(callsPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).some(item => item.stage === 'legacy-seed' && item.sessionId === sessionId), { timeout: 30000 }).toBe(true);
  await rpc('session/rename', { sessionId, title: 'QA-Chat普通对话' });
  const disabled = await view(); assert.equal(disabled.workflowEnabled, false); assert.equal(disabled.instanceId, null); assert.deepEqual(disabled.steps, []); assert.deepEqual(disabled.choices, []); assert.equal(disabled.owner, undefined);
  const pristine = await state(); assert.equal(pristine.employees.filter(item => item.projectId === projectId).length, 0); assert.equal(pristine.runs.length, 0); assert.equal(pristine.projectTeams?.filter(item => item.projectId === projectId).length ?? 0, 0);
  const native = (await calls())[0]; assert.equal(native.model, 'native-default'); assert.ok(!native.tools?.some(name => name.startsWith('worker_'))); assert.ok(!JSON.stringify(native).includes('workforce_role_definition'));
  check('fresh-Chat-uses-native-model-without-workflow-owner-binding-team-or-run');
  browserServer = await chromium.launchServer({ headless: true, host: '127.0.0.1', ...(process.env.WORKFORCE_BROWSER_CHANNEL === 'bundled' ? {} : { channel: process.env.WORKFORCE_BROWSER_CHANNEL || 'chrome' }) });
  browser = await chromium.connect(browserServer.wsEndpoint());
  page = await browser.newPage({ viewport: { width: 1512, height: 1050 }, colorScheme: 'dark', locale: 'zh-CN' }); page.on('pageerror', error => errors.push(error.message));
  const split = cookie.indexOf('='); await page.context().addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base, httpOnly: true, sameSite: 'Strict' }]);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const preview = page.getByRole('button', { name: '继续', exact: true }); await expect(preview).toBeVisible({ timeout: 20000 }); await preview.click();
  const later = page.getByRole('button', { name: '稍后配置', exact: true }); if (await later.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) await later.click();
  const openChat = async () => {
    const row = page.locator(`[data-row-key=${JSON.stringify('session:' + sessionId)}]`);
    if (!await row.isVisible()) { const folder = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'Chat' }).first(); await expect(folder).toBeVisible(); if (await folder.getAttribute('aria-expanded') !== 'true') await folder.click(); }
    await expect(row).toBeVisible(); await row.click(); await expect(page.locator('[data-composer-input][contenteditable=true]')).toBeVisible();
    await expect(page.locator('.wf-conversation-workflow-picker, .wf-conversation-workflow-bar')).toHaveCount(0);
    await expect(page.locator('.wf-conversation-workflow-contact')).toHaveCount(0);
  };
  await openChat(); await page.screenshot({ path: resolve(artifacts, 'Chat-no-workflow.png') });
  check('Chat-native-composer-and-header-show-no-workflow-selector-steps-or-owner');
  let employeeId;
  for (let index = 0; index < 2; index++) {
    if (index) await openChat();
    const before = await state(), employeeCount = before.employees.filter(item => item.projectId === projectId).length;
    const editor = page.locator('[data-composer-input][contenteditable=true]'); await editor.fill('@' + role.name);
    const candidate = page.locator('[data-trigger-menu] [role="option"]').filter({ hasText: role.name }); await expect(candidate).toHaveCount(1);
    await expect(page.locator('[data-trigger-menu]')).toContainText(index ? '本工作区已启用员工' : '自由职业人模板');
    await candidate.click(); await expect(page.locator('[data-trigger-menu]')).toHaveCount(0);
    assert.equal((await state()).employees.filter(item => item.projectId === projectId).length, employeeCount, 'picking does not create an employee');
    assert.equal((await state()).runs.length, index, 'picking does not create a run');
    if (!index) await page.screenshot({ path: resolve(artifacts, 'Chat-picked-temporary-employee.png') });
    const requestText = 'CHAT_AT_TASK_431_' + index;
    const ticketRequest = page.waitForRequest(request => request.url().endsWith('/digital-workers/api/conversation-employee/mention-ticket') && request.method() === 'POST');
    const nativeRequest = page.waitForRequest(request => request.url().endsWith('/api/session/prompt') && request.method() === 'POST');
    await editor.press('End'); await editor.pressSequentially(' ' + requestText); await editor.press('Enter');
    const ticket = (await ticketRequest).postDataJSON(); await nativeRequest;
    assert.equal(ticket.sessionId, sessionId); if (!index) assert.equal(ticket.templateId, role.id); else assert.equal(ticket.employeeId, employeeId);
    await expect.poll(async () => (await state()).runs.length, { timeout: 30000 }).toBe(index + 1);
    await expect.poll(async () => (await state()).runs.at(-1)?.status, { timeout: 30000 }).toBe('awaiting-review');
    const after = await state(), run = after.runs.at(-1), employee = after.employees.find(item => item.id === run.employeeId);
    assert.equal(run.sessionId, sessionId, 'temporary mention remains in the original conversation');
    assert.equal(run.conversationEmployee?.invocation, 'temporary'); assert.equal(after.conversationEmployees?.length ?? 0, 0);
    await expect(page.getByText('CHAT_STANDALONE_REPLY:chat-specialist', { exact: false }).first()).toBeVisible({ timeout: 30000 });
    employeeId ??= run.employeeId; assert.equal(run.employeeId, employeeId); assert.equal(employee.teamInstanceId, undefined); assert.equal(employee.managerId, undefined);
    assert.equal(run.conversationWorkflow, undefined); assert.equal(run.workflow, undefined); assert.equal(run.parentRunId, undefined); assert.equal(run.workTaskId, undefined);
    assert.equal(after.employees.filter(item => item.projectId === projectId).length, 1); assert.equal(after.projectTeams?.filter(item => item.projectId === projectId).length ?? 0, 0);
    assert.equal(after.conversationWorkflows?.instances.filter(item => item.projectId === projectId).length ?? 0, 0);
    const request = (await calls()).filter(item => item.model === 'chat-specialist').at(-1), body = JSON.stringify(request);
    assert.match(body, /CHAT_SPECIALIST_MISSION_431/); assert.match(body, /本轮已载入的必备 Skill/); assert.match(body, /architecture-analysis/); assert.match(body, /不主动展示后台运行与配置/);
    const active = request.messages.filter(message => message.source?.kind === 'runtime-context' && message.source?.form === 'snapshot').at(-1);
    assert.ok(!active?.source?.sections?.some(section => section.text.includes('OLD_WORKFLOW_ROLE_MUST_NOT_COPY_431')));
    await expect(page.locator('[data-row-key^="session:"]')).toHaveCount(1);
  }
  check('native-at-pick-creates-nothing-and-submit-stays-in-same-session-with-one-reused-employee');
  check('temporary-at-uses-role-model-and-required-skill-without-active-workflow-context');
  check('Chat-at-is-one-turn-only-with-no-resident-binding-or-extra-work-order-session');
  await page.locator('[data-composer-input][contenteditable=true]').fill('CHAT_NATIVE_FOLLOWUP_432');
  const immediateModel = await page.getByRole('button', { name: /^选择模型，当前 / }).getAttribute('aria-label');
  await page.locator('[data-composer-input][contenteditable=true]').press('Enter');
  await expect.poll(async () => (await calls()).filter(isNativeTask).length, { timeout: 30000 }).toBe(2);
  const followup = (await calls()).filter(isNativeTask).at(-1);
  assert.ok(immediateModel.includes(followup.model), 'ordinary followup uses the visible native model');
  const followupContext = followup.messages.filter(message => message.source?.kind === 'runtime-context' && message.source?.form === 'snapshot').at(-1);
  assert.ok(!followupContext?.source?.sections?.some(section => section.name === 'digital-worker:identity' || section.name === 'composable-workforce:task-context'));
  assert.ok(!followup.tools?.some(name => name.startsWith('worker_'))); assert.equal((await state()).runs.length, 2);
  check('ordinary-followup-after-temporary-mention-is-native-without-resident-employee-context');
  // The legacy /run API is retained for explicit old work orders. New @ input no
  // longer uses it; this fixture constructs history through that explicit API.
  const legacy = (await post('/digital-workers/api/run', { projectId, employeeId, request: 'CHAT_AT_TASK_431_LEGACY', sourceSessionId: sessionId })).run;
  await expect.poll(async () => (await state()).runs.find(run => run.id === legacy.id)?.status, { timeout: 30000 }).toBe('awaiting-review');
  const firstDeliverySessionId = (await state()).runs.find(run => run.id === legacy.id).sessionId;
  assert.notEqual(firstDeliverySessionId, sessionId);
  const earlierDelivery = page.locator(`[data-row-key=${JSON.stringify('session:' + firstDeliverySessionId)}]`); await expect(earlierDelivery).toBeVisible(); await earlierDelivery.click();
  await expect(page.locator('[data-composer-input][contenteditable=true]')).toBeEditable({ timeout: 30000 });
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('[data-composer-input][contenteditable=true]')).toBeEditable();
  const selectedModel = await page.getByRole('button', { name: /^选择模型，当前 / }).getAttribute('aria-label');
  await page.locator('[data-composer-input][contenteditable=true]').fill('CHAT_NATIVE_FOLLOWUP_432_HISTORY'); await page.locator('[data-composer-input][contenteditable=true]').press('Enter');
  await expect.poll(async () => (await calls()).filter(isNativeTask).length, { timeout: 30000 }).toBe(3);
  const historicalFollowup = (await calls()).filter(isNativeTask).at(-1); assert.ok(selectedModel.includes(historicalFollowup.model));
  const historicalContext = historicalFollowup.messages.filter(message => message.source?.kind === 'runtime-context' && message.source?.form === 'snapshot').at(-1);
  assert.ok(!historicalContext?.source?.sections?.some(section => section.name === 'digital-worker:identity' || section.name === 'composable-workforce:task-context'));
  assert.ok(!historicalFollowup.tools?.some(name => name.startsWith('worker_'))); assert.equal((await state()).runs.length, 3, 'historical continuation does not replay an employee task');
  check('explicit-legacy-work-order-history-reloads-and-continues-natively');
  await openChat(); await page.reload({ waitUntil: 'domcontentloaded' }); await openChat();
  await expect(page.locator('.wf-conversation-workflow-picker, .wf-conversation-workflow-bar')).toHaveCount(0);
  const normalPath = resolve(temp, 'normal-project'); await mkdir(normalPath); const normal = (await rpc('workspace/create', { path: normalPath })).workspace;
  const normalId = (await rpc('session/create', { workspaceId: normal.workspaceId })).sessionId;
  const normalView = await get('/digital-workers/api/conversation-workflow?sessionId=' + encodeURIComponent(normalId)); assert.equal(normalView.workflowEnabled, true); assert.ok(normalView.choices.length > 0);
  check('Chat-exclusion-survives-reload-while-normal-project-workflow-service-remains-enabled');
  assert.deepEqual(errors, []); assert.equal(await hostHash(), hostBefore);
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify({ status: 'passed', checks, checkCount: checks.length, sdk, pluginArchive: archive ? { sha256: sha(await readFile(archive)) } : undefined,
    modelCalls: { native: (await calls()).filter(isNativeTask).length, standalone: (await calls()).filter(isEmployeeTask).length, external: 0 },
    nativeModels: [...new Set((await calls()).filter(isNativeTask).map(item => item.model))],
    historicalNativeModel: historicalFollowup.model,
    employeesCreated: 1, temporaryTurns: 2, legacyWorkOrders: 1, workflowInstancesCreated: 0, projectTeamsCreated: 0, hostUnchanged: true, pageErrors: errors }, null, 2));
  console.log(`PASS ${checks.length} official Chat standalone checks`);
} catch (error) {
  await mkdir(artifacts, { recursive: true }); await page?.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {});
  const captured = (await readFile(callsPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  await writeFile(resolve(artifacts, 'failure-report.json'), JSON.stringify({ status: 'failed', checks, pageErrors: errors, calls: captured.map(item => ({ stage: item.stage, model: item.model, tools: item.tools, messageKinds: item.messages?.map(message => ({ role: message.role, source: message.source?.kind, contextSections: message.source?.sections?.map(section => section.name) })), baseline: item.baseline ?? JSON.stringify(item.messages ?? []).includes('CHAT_NATIVE_BASELINE_431'), standaloneTask: JSON.stringify(item.messages ?? []).includes('CHAT_AT_TASK_431_') })), hostLog: redactWebAuth(log).slice(-10000) }, null, 2));
  throw error;
} finally {
  await stop(); await closeFixtureBrowser({ page, browser, browserServer }); await rm(temp, { recursive: true, force: true });
}
