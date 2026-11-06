/** Real native conversation slots + ordinary Agent turns in an isolated official Harness. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliInstallation } from '../../integration/harness-baseline.mjs';
import { authenticateWeb, redactWebAuth } from '../../integration/web-auth.mjs';
import { installEmployeeSettingsFixture } from './employee-settings-offline.fixture.mjs';
import { prepareOfficialPluginRuntime } from './official-plugin-runtime.mjs';
import { switchDshLocale } from './locale-switch.checks.mjs';
import { closeFixtureBrowser } from './browser-cleanup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.env.DSH_INSTALLATION_MANIFEST ||= resolve(root, '.local/official-validation-complete/node_modules/@deepseek-ai/dsh/package.json');
const installation = await resolveCliInstallation(root);
const temp = await mkdtemp(resolve(tmpdir(), 'workforce-native-workflow-ui-'));
const artifacts = resolve(process.env.WORKFORCE_CONVERSATION_UI_ARTIFACTS || resolve(root, 'artifacts/conversation-workflow-validation/official'));
const archive = process.env.WORKFORCE_UI_ARCHIVE ? resolve(process.env.WORKFORCE_UI_ARCHIVE) : undefined;
const delay = ms => new Promise(done => setTimeout(done, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hostHash = async () => sha(Buffer.concat([await readFile(installation.entry), await readFile(installation.manifest)]));
const hostBefore = await hostHash();
let child, browser, browserServer, page, cookie = '', log = '', pluginRoot = root, callsPath;
const checks = [], errors = [], metrics = {};
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const luminance = color => {
  assert.match(color, /^rgba?\(/, 'browser resolves the node text and fill to sRGB');
  const channels = color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
};
const contrast = (first, second) => { const values = [luminance(first), luminance(second)].sort((a, b) => a - b); return (values[1] + .05) / (values[0] + .05); };
const assertNumberedGraph = (graph, definition) => {
  for (const node of graph.nodes) {
    const index = definition.findIndex(step => step.name === node.labelText);
    assert.ok(index >= 0, 'step annotations remain the complete saved step names');
    assert.equal(node.number.text, String(index + 1), 'circle numbering follows the full workflow even when earlier steps are hidden');
    assert.equal(node.number.fontSize, '12px'); assert.equal(node.number.fontWeight, '600'); assert.ok(node.number.variantNumeric.includes('tabular-nums'));
    assert.ok(Math.abs(node.number.box.x + node.number.box.width / 2 - node.center.x) < 1 && Math.abs(node.number.box.y + node.number.box.height / 2 - node.center.y) < 1, 'step number is centered inside its circle');
    assert.equal(node.ring.content, '\"\"'); assert.equal(node.ring.borderWidth, '1px'); assert.equal(node.ring.borderStyle, 'solid'); assert.equal(node.ring.borderRadius, '50%');
    if (graph.cornerShapeSupported) {
      assert.ok(['round','superellipse(1)'].includes(node.cornerShape), 'outer numbered circle remains mathematically round (Chrome 155 serializes round as superellipse(1))');
      assert.ok(['round','superellipse(1)'].includes(node.ring.cornerShape), 'inner border is independently round');
    }
    assert.ok(Number.parseFloat(node.ring.width) > 0 && Number.parseFloat(node.ring.width) < node.dot.width, 'an inner circular border is visible inside the outer circle');
    assert.ok(Number(node.ring.opacity) > 0 && Number(node.ring.opacity) <= 1); assert.equal(node.ring.pointerEvents, 'none');
    assert.ok(contrast(node.number.color, node.fill) >= 4.5, `12px step number contrast is readable on ${node.status}: ${node.number.color} / ${node.fill}`);
  }
};
async function freePort() {
  const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address === 'object'); await new Promise(done => server.close(done)); return address.port;
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM'); for (let i = 0; i < 50 && child.exitCode === null; i++) await delay(100);
  if (child.exitCode === null) { child.kill('SIGKILL'); await delay(250); }
}
async function start() {
  await access(resolve(root, 'lib/client.js'));
  const home = resolve(temp, 'harness'), profile = resolve(home, 'profiles/web');
  await mkdir(resolve(profile, 'node_modules'), { recursive: true });
  const target = resolve(profile, 'node_modules/dsh-plugin-composable-workforce');
  metrics.officialRuntime = await prepareOfficialPluginRuntime({ root, packageDirectory: target, installation, archive });
  pluginRoot = target;
  if (archive) metrics.pluginArchive = { path: archive, sha256: sha(await readFile(archive)) };
  const fixture = await installEmployeeSettingsFixture(profile, root, installation); callsPath = fixture.llmCallsPath;
  metrics.fixtureOfficialRuntime = fixture.officialSdk;
  // This is the test plugin just created above, not host code or a production package file.
  await writeFile(resolve(profile, 'node_modules/dsh-plugin-employee-settings-fixture/index.js'), `
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { access, appendFile } from 'node:fs/promises';
export const name = 'employee-settings-fixture';
export const inject = ['llm'];
class OfflineNativeAdapter extends LlmAdapter {
  listModels(provider) { return Promise.resolve(['native-default', 'owner-product', 'owner-developer'].map(id => ({ provider, id, name: id }))); }
  resolveModel(provider, id) { return Promise.resolve({ provider, id, name: id, context: { contextWindow: 262144 } }); }
  async *stream(request) {
    const last = request.messages.filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1);
    const lastText = (last?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\\n');
    await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ provider: request.provider, model: request.model, system: request.system, messages: request.messages, tools: request.tools?.map(tool => tool.name), maxTokens: request.maxTokens }) + '\\n');
    const planningTarget = lastText.match(/WF_PLAN_TARGET:([a-zA-Z0-9-]+)/)?.[1];
    if (planningTarget && !request.messages.slice(request.messages.indexOf(last) + 1).some(message => message.role === 'tool')) {
      const id = ToolCallId('fixture-plan-919');
      const args = JSON.stringify({ title: 'QA-实现接口规划', description: '按照已确认的接口要求实现并验证', employeeId: planningTarget,
        deliverables: ['可验证的接口实现'], acceptanceCriteria: ['接口测试通过'] });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'worker_plan_task', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'worker_plan_task', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    if (lastText.includes('WF_GATE_030')) {
      const deadline = Date.now() + 30000;
      while (!await access(${JSON.stringify(resolve(temp, 'release-concurrency-030'))}).then(() => true, () => false)) {
        request.signal?.throwIfAborted();
        if (Date.now() > deadline) throw new Error('Fixture concurrency gate timed out');
        await new Promise(done => setTimeout(done, 25));
      }
    }
    if (lastText.includes('WF_SLOW_917')) await new Promise((done, reject) => {
      const timer = setTimeout(done, 8000);
      const abort = () => { clearTimeout(timer); reject(new Error('Fixture native turn cancelled')); };
      if (request.signal?.aborted) abort(); else request.signal?.addEventListener('abort', abort, { once: true });
    });
    const text = 'WF_REPLY:' + request.model + '。已按当前步骤说明提交可核验的离线验证回答，等待用户验收。';
    yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }; yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx) { ctx.llm.registerAdapter(['employee-settings-fixture'], new OfflineNativeAdapter()); }
`);
  await writeFile(resolve(profile, 'package.json'), JSON.stringify({ name: 'conversation-workflow-official-test', private: true, type: 'module',
    dependencies: { 'dsh-plugin-composable-workforce': `file:${archive || target}`, 'dsh-plugin-employee-settings-fixture': '0.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-composable-workforce', 'dsh-plugin-employee-settings-fixture'] } } }));
  await writeFile(resolve(profile, 'cordis.patch.yml'), `- id: composable-workforce\n  config:\n    statePath: ${JSON.stringify(resolve(temp, 'state.json'))}\n- id: agent-default-model\n  config:\n    provider: employee-settings-fixture\n    model: native-default\n`);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [installation.entry, '--profile', 'web', '--port', String(port), '--no-open'], { cwd: temp,
    env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, XDG_CONFIG_HOME: resolve(temp, 'config'), DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NO_PROXY: '127.0.0.1,localhost', LANG: 'en_US.UTF-8', TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + String(chunk)).slice(-60000); });
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`Official host exited: ${redactWebAuth(log)}`);
    if (!cookie) cookie = (await authenticateWeb(log, base).catch(() => undefined))?.cookie || '';
    if (cookie && (await fetch(base + '/digital-workers/api/state', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(1000) }).catch(() => undefined))?.ok) return base;
    await delay(250);
  }
  throw new Error(`Official host readiness timeout: ${redactWebAuth(log)}`);
}
try {
  await (async () => {
  await mkdir(artifacts, { recursive: true }); const base = await start();
  const get = async path => { const response = await fetch(base + path, { headers: { Cookie: cookie } }); assert.ok(response.ok, await response.clone().text()); return response.json(); };
  const post = async (path, data) => { const response = await fetch(base + path, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); assert.ok(response.ok, await response.clone().text()); return response.json(); };
  const rpc = async (method, request) => { const result = await post('/api/' + method, { type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }); assert.equal(result.result?.ok, true, JSON.stringify(result)); return result.result.value; };
  const command = (action, payload, options) => post('/digital-workers/api/command', { action, payload, options });
  const state = () => get('/digital-workers/api/state'); const view = id => get('/digital-workers/api/conversation-workflow?sessionId=' + encodeURIComponent(id));
  const calls = async () => (await readFile(callsPath, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const projectPath = resolve(temp, 'software-project'); await mkdir(projectPath); const workspace = (await rpc('workspace/create', { path: projectPath })).workspace;
  const initial = await state(), modules = structuredClone(initial.templates[0].modules);
  modules.knowledge.sources = []; modules.knowledge.projectMemory = false; modules.knowledge.employeeMemory = false;
  modules.capabilities.skills = [{ id: 'architecture-analysis', name: '架构分析', description: '每个任务分析目标和证据', usage: 'required' }];
  modules.model = { mode: 'override', provider: 'employee-settings-fixture', model: 'owner-product' };
  const lead = (await command('template.save', { name: 'QA-产品负责人', status: 'ready', modules })).result;
  const devModules = structuredClone(modules); devModules.model.model = 'owner-developer';
  const developer = (await command('template.save', { name: 'QA-开发负责人', status: 'ready', modules: devModules })).result;
  const team = (await command('team.save', { name: 'QA-软件开发团', knowledgeEnabled: false, members: [{ memberId: 'lead', templateId: lead.id, name: lead.name }, { memberId: 'dev', templateId: developer.id, name: developer.name, reportsTo: 'lead' }] })).result;
  const flow = (await command('workflow.template.save', { name: 'QA-软件工程', team: { sourceTeamId: team.id, sourceTeamVersion: team.version, name: team.name, members: team.members },
    roles: [{ id: 'lead', name: lead.name, memberId: 'lead' }, { id: 'dev', name: developer.name, memberId: 'dev' }], steps: [
      { id: 'requirements', name: '需求确认', roleId: 'lead', instruction: 'WF_STEP_REQUIREMENTS_917：澄清需求、规划任务并委派下级', outputs: ['WF_OUTPUT_REQUIREMENTS_917'], acceptanceCriteria: ['WF_ACCEPT_REQUIREMENTS_917'] },
      { id: 'implementation', name: '开发验证', roleId: 'dev', instruction: 'WF_STEP_IMPLEMENTATION_917：实现与验证', outputs: ['WF_OUTPUT_IMPLEMENTATION_917'], acceptanceCriteria: ['WF_ACCEPT_IMPLEMENTATION_917'], onRejectStepId: 'requirements' },
    ] })).result;
  const longFlow = (await command('workflow.template.save', { name: 'QA-紧凑十二步骤工作流', team: flow.team, roles: flow.roles,
    steps: Array.from({ length: 12 }, (_, index) => ({ id: `long-step-${index + 1}`, name: `第${index + 1}步：足够长的步骤名称用于验证截断`, roleId: index === 11 ? 'dev' : 'lead',
      instruction: `长流程第${index + 1}步说明`, outputs: ['对应交付内容'], acceptanceCriteria: ['对应验收标准'] })) })).result;
  const multiReturnFlow = (await command('workflow.template.save', { name: 'QA-三层退回布局', team: flow.team, roles: flow.roles,
    steps: Array.from({ length: 6 }, (_, index) => ({ id: `return-step-${index + 1}`, name: `布局步骤${index + 1}`, roleId: 'lead', instruction: '仅验证流程图布局，不启动任务', outputs: ['布局证据'], acceptanceCriteria: ['位置不变'],
      ...(index === 0 ? { onRejectStepId: 'return-step-1' } : index >= 3 ? { onRejectStepId: 'return-step-2' } : {}) })) })).result;
  const a = (await rpc('session/create', { workspaceId: workspace.workspaceId })).sessionId;
  const b = (await rpc('session/create', { workspaceId: workspace.workspaceId })).sessionId;
  // The shipped sidebar intentionally hides never-used empty sessions. These real
  // native turns also prove workflow adoption preserves an existing history.
  for (const [id, label] of [[a, 'A'], [b, 'B']]) await rpc('session/prompt', { requestId: randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: 'WF_NATIVE_PREHISTORY_' + label + '_917' }] });
  await expect.poll(async () => (await calls()).filter(request => request.model === 'native-default' && JSON.stringify(request.messages).includes('WF_NATIVE_PREHISTORY_')).length, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
  await delay(250);
  await rpc('session/rename', { sessionId: a, title: 'QA-工作流对话甲' }); await rpc('session/rename', { sessionId: b, title: 'QA-工作流对话乙' });
  browserServer = await chromium.launchServer({ headless: true, host: '127.0.0.1', ...(process.env.WORKFORCE_BROWSER_CHANNEL === 'bundled' ? { args: ['--enable-unsafe-swiftshader'] } : { channel: process.env.WORKFORCE_BROWSER_CHANNEL || 'chrome' }) });
  browser = await chromium.connect(browserServer.wsEndpoint());
  page = await browser.newPage({ viewport: { width: 1512, height: 1050 }, colorScheme: 'dark', locale: 'zh-CN' }); page.on('pageerror', error => errors.push(error.message));
  metrics.pageNavigations = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) metrics.pageNavigations.push({ time: Date.now(), url: redactWebAuth(frame.url()) }); });
  const separator = cookie.indexOf('='); await page.context().addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base, httpOnly: true, sameSite: 'Strict' }]);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  // A fresh browser profile always shows the shipped preview acknowledgement;
  // hydration can finish after the sidebar, so wait for that explicit dialog.
  const continueButton = page.getByRole('button', { name: '继续', exact: true });
  await expect(continueButton).toBeVisible({ timeout: 20000 }); await continueButton.click();
  const later = page.getByRole('button', { name: '稍后配置', exact: true });
  if (await later.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) await later.click();
  const sessions = { 'QA-工作流对话甲': a, 'QA-工作流对话乙': b };
  const open = async title => {
    const row = page.locator(`[data-row-key=${JSON.stringify('session:' + sessions[title])}]`);
    if (!await row.isVisible()) {
      const folder = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'software-project' }).first();
      await expect(folder).toBeVisible(); if (await folder.getAttribute('aria-expanded') !== 'true') await folder.click();
    }
    await expect(row).toBeVisible(); await row.click(); await expect(page.locator('.wf-conversation-workflow-trigger')).toBeVisible();
  };
  const picker = () => page.locator('.wf-conversation-workflow-picker'); const strip = () => page.locator('.wf-conversation-workflow-steps');
  const steps = () => strip().locator('.wf-conversation-workflow-step');
  const graphGeometry = () => strip().evaluate(nav => {
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
    const textRect = node => { const range = document.createRange(); range.selectNodeContents(node); return rect(range); };
    const svg = nav.querySelector('.wf-conversation-workflow-connections');
    const point = (path, length) => { const p = path.getPointAtLength(length).matrixTransform(path.getScreenCTM()); return { x: p.x, y: p.y }; };
    const header = nav.closest('header'), bar = nav.closest('.wf-conversation-workflow-bar');
    const protectedControls = [...header.querySelectorAll('button')].filter(button => !bar.contains(button)).map(rect).filter(box => box.width > 0 && box.height > 0);
    const clipping = [];
    for (let node = svg; node; node = node.parentElement) {
      const style = getComputedStyle(node), box = rect(node);
      if (box.width > 0 && box.height > 0 && (style.overflowX !== 'visible' || style.overflowY !== 'visible')) clipping.push({ box, x: style.overflowX !== 'visible', y: style.overflowY !== 'visible' });
      if (node === header) break;
    }
    const nodes = [...nav.querySelectorAll('.wf-conversation-workflow-step')].map(button => {
        const dot = button.querySelector('.wf-conversation-workflow-dot'), box = rect(dot);
        const number = button.querySelector('.wf-conversation-workflow-step-number'), numberStyle = getComputedStyle(number), ring = getComputedStyle(dot, '::before');
        return { dot: box, center: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, label: rect(button.querySelector('.wf-conversation-workflow-step-label')), labelTextBox: textRect(button.querySelector('.wf-conversation-workflow-step-label')),
          status: button.className, labelText: button.querySelector('.wf-conversation-workflow-step-label').textContent, fill: getComputedStyle(dot).backgroundColor, cornerShape: getComputedStyle(dot).getPropertyValue('corner-shape'),
          number: { text: number.textContent, box: rect(number), color: numberStyle.color, fontSize: numberStyle.fontSize, fontWeight: numberStyle.fontWeight, variantNumeric: numberStyle.fontVariantNumeric },
          ring: { content: ring.content, width: ring.width, borderWidth: ring.borderTopWidth, borderStyle: ring.borderTopStyle, borderRadius: ring.borderRadius, cornerShape: ring.getPropertyValue('corner-shape'), opacity: ring.opacity, pointerEvents: ring.pointerEvents },
          hitTargetIsButton: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === button,
          labelHitTargetIsButton: (() => { const box = rect(button.querySelector('.wf-conversation-workflow-step-label')); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === button; })(),
          labelHitStack: (() => { const box = rect(button.querySelector('.wf-conversation-workflow-step-label')); return document.elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2).slice(0, 6).map(element => ({ tag: element.tagName, class: element.className, role: element.getAttribute('role') })); })() };
      });
    const inside = (point, box, expand = 0) => point.x >= box.x - expand && point.x <= box.x + box.width + expand && point.y >= box.y - expand && point.y <= box.y + box.height + expand;
    const clipped = sample => clipping.some(clip => clip.x && (sample.x < clip.box.x - .1 || sample.x > clip.box.x + clip.box.width + .1) || clip.y && (sample.y < clip.box.y - .1 || sample.y > clip.box.y + clip.box.height + .1));
    const circleIntersections = sample => nodes.flatMap((node, index) => Math.hypot(sample.x - node.center.x, sample.y - node.center.y) < node.dot.width / 2 - .05 ? [index] : []);
    const edges = [...svg.querySelectorAll(':scope > path')].map(path => {
      const total = path.getTotalLength(), samples = path.dataset.kind === 'reject' ? Math.max(1, Math.ceil(total * 2)) : 0;
      const labelHits = new Set(), controlHits = new Set(), circleHits = new Set(); let clippedSamples = 0, maxY = -Infinity, minY = Infinity;
      const halfStroke = Number.parseFloat(getComputedStyle(path).strokeWidth) / 2;
      for (let index = 0; index <= samples && samples > 0; index++) {
        const sample = point(path, total * index / samples); maxY = Math.max(maxY, sample.y); minY = Math.min(minY, sample.y);
        nodes.forEach((node, labelIndex) => { if (inside(sample, node.label, halfStroke)) labelHits.add(labelIndex); });
        protectedControls.forEach((box, controlIndex) => { if (inside(sample, box, halfStroke)) controlHits.add(controlIndex); });
        circleIntersections(sample).forEach(index => circleHits.add(index));
        if (clipped(sample)) clippedSamples++;
      }
      let arrow;
      if (path.dataset.kind === 'reject') {
        const markerId = path.getAttribute('marker-end')?.match(/^url\(#(.+)\)$/)?.[1], marker = markerId && document.getElementById(markerId), shape = marker?.querySelector('path');
        if (shape) {
          const end = path.getPointAtLength(total), prior = path.getPointAtLength(Math.max(0, total - .1));
          const dx = end.x - prior.x, dy = end.y - prior.y, magnitude = Math.hypot(dx, dy), ux = dx / magnitude, uy = dy / magnitude;
          const shapeLength = shape.getTotalLength(), count = Math.max(1, Math.ceil(shapeLength * 4)), transform = path.getScreenCTM();
          const labelHits = new Set(), controlHits = new Set(), circleHits = new Set(), positions = []; let clippedSamples = 0;
          for (let index = 0; index <= count; index++) {
            const local = shape.getPointAtLength(shapeLength * index / count), x = local.x - marker.refX.baseVal.value, y = local.y - marker.refY.baseVal.value;
            const transformed = new DOMPoint(end.x + x * ux - y * uy, end.y + x * uy + y * ux).matrixTransform(transform);
            const sample = { x: transformed.x, y: transformed.y }; positions.push(sample);
            nodes.forEach((node, labelIndex) => { if (inside(sample, node.label)) labelHits.add(labelIndex); });
            protectedControls.forEach((box, controlIndex) => { if (inside(sample, box)) controlHits.add(controlIndex); });
            circleIntersections(sample).forEach(index => circleHits.add(index));
            if (clipped(sample)) clippedSamples++;
          }
          arrow = { markerUnits: marker.getAttribute('markerUnits'), orient: marker.getAttribute('orient'), refX: marker.refX.baseVal.value, refY: marker.refY.baseVal.value,
            markerWidth: marker.markerWidth.baseVal.value, markerHeight: marker.markerHeight.baseVal.value, samples: count + 1,
            tangent: { x: ux, y: uy }, minY: Math.min(...positions.map(position => position.y)), maxY: Math.max(...positions.map(position => position.y)),
            labelHits: [...labelHits], controlHits: [...controlHits], circleHits: [...circleHits], clippedSamples };
        }
      }
      return { kind: path.dataset.kind, source: path.dataset.source, target: path.dataset.target, start: point(path, 0), end: point(path, total), box: rect(path),
        totalLength: total, strokeDasharray: getComputedStyle(path).strokeDasharray, markerEnd: path.getAttribute('marker-end'), samples, maxY: Number.isFinite(maxY) ? maxY : undefined, minY: Number.isFinite(minY) ? minY : undefined,
        labelHits: [...labelHits], controlHits: [...controlHits], circleHits: [...circleHits], clippedSamples, arrow };
    });
    const details = bar.querySelector('.wf-conversation-workflow-details-trigger');
    const more = [...nav.querySelectorAll('.wf-conversation-workflow-more')].map(span => ({ side: span.classList.contains('is-before') ? 'before' : 'after', box: rect(span), textBox: textRect(span) }));
    return { nav: rect(nav), svg: rect(svg), header: rect(header), details: rect(details), detailsTextBox: textRect(details), more, offsetY: Number(nav.dataset.offsetY), navOverflowX: getComputedStyle(nav).overflowX, navOverflowY: getComputedStyle(nav).overflowY,
      svgOverflowX: getComputedStyle(svg).overflowX, svgPointerEvents: getComputedStyle(svg).pointerEvents, cornerShapeSupported: CSS.supports('corner-shape', 'round'), nodes, edges };
  });
  const headerGeometry = () => page.locator('[data-conversation-tabs]').evaluate(tabs => {
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
    const textRect = node => { const range = document.createRange(); range.selectNodeContents(node); return rect(range); };
    const header = tabs.closest('header'), title = [...header.querySelectorAll('nav span')].find(span => ['QA-工作流对话甲', 'QA-工作流对话乙'].includes(span.textContent));
    const bar = header.querySelector('.wf-conversation-workflow-bar');
    const controls = [...header.querySelectorAll('button')].filter(button => !tabs.contains(button) && !bar?.contains(button));
    return { header: rect(header), title: rect(title), tabs: rect(tabs), tabButtons: [...tabs.querySelectorAll('button')].map(rect),
      trajectoryText: textRect(tabs.querySelectorAll('button')[1]), utilities: controls.map(rect),
      body: rect(document.querySelector('[data-conversation-region="chat"]')), scroll: rect(document.querySelector('[data-conversation-scroll]')) };
  });
  const near = (actual, expected, description, tolerance = .6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${description}: ${actual} / ${expected}`);
  const compareNativeAnchors = (actual, expected, label) => {
    for (const key of ['header', 'tabs', 'body', 'scroll']) for (const axis of ['x', 'y', 'width', 'height']) near(actual[key][axis], expected[key][axis], `${label}.${key}.${axis}`);
    for (const axis of ['x', 'y', 'height']) near(actual.title[axis], expected.title[axis], `${label}.title.${axis}`);
    for (const key of ['tabButtons', 'utilities']) {
      assert.equal(actual[key].length, expected[key].length, `${label}.${key} remain present`);
      actual[key].forEach((box, index) => { for (const axis of ['x', 'y', 'width', 'height']) near(box[axis], expected[key][index][axis], `${label}.${key}.${index}.${axis}`); });
    }
  };
  const assertTextAlignment = (graph, header) => {
    const target = header.trajectoryText.y + header.trajectoryText.height;
    assert.ok(graph.nodes.length, 'alignment requires at least one visible node');
    graph.nodes.forEach(node => near(node.labelTextBox.y + node.labelTextBox.height, target, 'step text bottom equals native trajectory text bottom', 1));
  };
  const assertDetailsAlignment = graph => {
    const tolerance = 1 / 32, centerY = graph.details.y + graph.details.height / 2;
    const measured = metrics.detailsAlignment ??= { screenTolerance: tolerance, graphSamples: 0, circleSamples: 0, ellipsisSamples: 0, noEllipsisGraphs: 0, maxCircleCenterYError: 0, maxEllipsisCenterYError: 0 };
    assert.ok(graph.details.width > 0 && graph.details.height > 0 && graph.nodes.length, 'alignment requires the real visible Details button and step nodes');
    measured.graphSamples++; if (!graph.more.length) measured.noEllipsisGraphs++;
    for (const node of graph.nodes) {
      measured.circleSamples++; measured.maxCircleCenterYError = Math.max(measured.maxCircleCenterYError, Math.abs(centerY - node.center.y));
      near(centerY, node.center.y, 'Details element vertical center equals every step circle center', tolerance);
    }
    for (const more of graph.more) {
      assert.ok(more.box.width > 0 && more.box.height > 0, 'a static ellipsis has a real element box');
      const moreCenterY = more.box.y + more.box.height / 2;
      measured.ellipsisSamples++; measured.maxEllipsisCenterYError = Math.max(measured.maxEllipsisCenterYError, Math.abs(centerY - moreCenterY));
      near(centerY, moreCenterY, `Details element vertical center equals the ${more.side} ellipsis element center`, tolerance);
      if (graph.nav.width >= 100) {
        const edge = more.side === 'before' ? graph.nodes[0] : graph.nodes.at(-1);
        near(Math.abs(more.box.x + more.box.width / 2 - edge.center.x), 34, 'ellipsis stays close to the outer visible circle with symmetric spacing', tolerance);
        if (more.side === 'after') near(graph.details.x - more.box.x - more.box.width, 8, 'Details follows the trailing ellipsis without the former empty end-cell', tolerance);
      }
    }
  };
  const assertUpperReturns = (graph, definition) => {
    assertDetailsAlignment(graph);
    // CSS slot rectangles are quantized to 1/64px while SVG coordinates round to
    // three decimals. Keep screen checks within 1/32px; source units use .001px.
    const crownTolerance = 1 / 32;
    const endpointPrecision = metrics.exactTopEndpoints ??= { screenTolerance: crownTolerance, maxXError: 0, maxYError: 0, sampleCount: 0 };
    assert.equal(graph.svgPointerEvents, 'none'); assert.equal(graph.navOverflowY, 'visible'); assert.equal(graph.svgOverflowX, 'hidden');
    assert.ok(graph.nodes.every(node => node.hitTargetIsButton && node.labelHitTargetIsButton), 'return drawing cannot intercept circle or label clicks');
    for (const edge of graph.edges.filter(edge => edge.kind === 'reject')) {
      const source = graph.nodes.find(node => node.number.text === String(definition.findIndex(step => step.id === edge.source) + 1));
      const target = graph.nodes.find(node => node.number.text === String(definition.findIndex(step => step.id === edge.target) + 1));
      assert.ok(source && target, 'return paths require both real visible endpoints');
      for (const [endpoint, node] of [[edge.start, source], [edge.end, target]]) {
        endpointPrecision.maxXError = Math.max(endpointPrecision.maxXError, Math.abs(endpoint.x - node.center.x));
        endpointPrecision.maxYError = Math.max(endpointPrecision.maxYError, Math.abs(endpoint.y - node.dot.y)); endpointPrecision.sampleCount++;
        assert.ok(Math.abs(Math.hypot(endpoint.x - node.center.x, endpoint.y - node.center.y) - 14) < .1, 'returns meet the actual circle circumference');
        near(endpoint.x, node.center.x, 'return endpoint has the exact circle center X', crownTolerance);
        near(endpoint.y, node.dot.y, 'return endpoint has the exact circle top Y', crownTolerance);
      }
      assert.deepEqual(edge.circleHits, [], 'the entire sampled real return curve avoids every circle interior');
      assert.notEqual(edge.source, edge.target, 'self returns do not receive a special loop or occupy return lanes');
      assert.ok(edge.minY < Math.min(source.dot.y, target.dot.y), 'horizontal return tracks are above the step circles');
      assert.deepEqual(edge.labelHits, [], 'return strokes must avoid every visible label rectangle'); assert.deepEqual(edge.controlHits, [], 'return strokes must avoid native tab and utility controls');
      assert.equal(edge.clippedSamples, 0, 'each admitted return path is visible in full, without clipping at the nav or native header');
      assert.ok(edge.arrow?.samples > 0, 'the actual SVG arrow shape is present and sampled');
      assert.equal(edge.arrow.markerUnits, 'userSpaceOnUse'); assert.equal(edge.arrow.orient, 'auto');
      assert.equal(edge.arrow.markerWidth, 5); assert.equal(edge.arrow.markerHeight, 5); assert.equal(edge.arrow.refX, 5); assert.equal(edge.arrow.refY, 2.5);
      near(edge.arrow.tangent.x, 0, 'the arrow reaches the crown vertically', .001); near(edge.arrow.tangent.y, 1, 'the arrow points down into the exact crown', .001);
      assert.deepEqual(edge.arrow.circleHits, [], 'the complete marker triangle avoids all circle interiors');
      assert.deepEqual(edge.arrow.labelHits, [], 'the complete marker triangle avoids labels'); assert.deepEqual(edge.arrow.controlHits, [], 'the complete marker triangle avoids native controls');
      assert.equal(edge.arrow.clippedSamples, 0, 'the complete marker triangle is visible inside the real SVG and native clipping bounds');
      assert.ok(edge.arrow.maxY <= target.dot.y + .01, 'the arrow remains above the circle except for its tip at the crown');
      assert.ok(edge.minY - graph.svg.y >= .9, 'upper SVG viewport leaves the complete return stroke and arrow head visible');
      assert.ok(edge.maxY <= graph.header.y + graph.header.height + .1, 'returns stay within the native header');
    }
  };
  const detailsDialog = () => page.getByRole('dialog', { name: '工作流详情', exact: true });
  const stepInstruction = () => detailsDialog().locator('details.wf-conversation-details-instruction:not([data-requirement])');
  const stepInstructionSummary = () => stepInstruction().locator(':scope > summary');
  const stepInstructionBody = () => stepInstruction().locator('.wf-conversation-details-requirements dd');
  const openDetails = async () => { await page.locator('.wf-conversation-workflow-details-trigger').click(); await expect(detailsDialog().getByRole('navigation', { name: '工作流程' })).toBeVisible(); };
  const inspectStep = async id => { const button = detailsDialog().locator('[data-step-id=' + JSON.stringify(id) + ']'); await button.click(); await expect(button).toHaveAttribute('aria-current', 'true'); };
  const closeDetails = async () => { await detailsDialog().getByRole('button', { name: '关闭详情', exact: true }).click(); await expect(detailsDialog()).toHaveCount(0); };
  const assertDetailsNodeParity = async () => {
    const actual = await view(a), top = await graphGeometry();
    const details = await detailsDialog().locator('.wf-conversation-details-flow').evaluate(nav => {
      const color = value => { const probe = document.createElement('span'); probe.style.color = value; probe.style.display = 'none'; nav.append(probe); const result = getComputedStyle(probe).color; probe.remove(); return result; };
      return { palette: { completed: 'rgb(255, 255, 255)', current: color('var(--dsw-alias-state-business-primary)'), pending: color('var(--dsw-alias-label-tertiary)') },
        nodes: [...nav.querySelectorAll('button[data-step-id]')].map(button => {
          const dot = button.querySelector('[data-flow-node]'), number = dot.querySelector('.wf-conversation-workflow-step-number'), style = getComputedStyle(dot), digit = getComputedStyle(number), ring = getComputedStyle(dot, '::before'), box = dot.getBoundingClientRect();
          return { id: button.dataset.stepId, status: button.parentElement.className.match(/is-(completed|current|pending)/)?.[1], inspected: button.getAttribute('aria-current') === 'true',
            sharedDotClass: dot.classList.contains('wf-conversation-workflow-dot'), ownStatusClass: dot.className.match(/is-(completed|current|pending)/)?.[1],
            number: number.textContent, dotText: dot.textContent, fill: style.backgroundColor, color: digit.color, fontSize: digit.fontSize, fontWeight: digit.fontWeight, variantNumeric: digit.fontVariantNumeric,
            width: box.width, height: box.height, borderRadius: style.borderRadius, cornerShape: style.getPropertyValue('corner-shape'),
            ring: { content: ring.content, borderWidth: ring.borderTopWidth, borderStyle: ring.borderTopStyle, borderRadius: ring.borderRadius, cornerShape: ring.getPropertyValue('corner-shape'), opacity: ring.opacity, pointerEvents: ring.pointerEvents } };
        }) };
    });
    assert.equal(details.nodes.length, actual.steps.length);
    details.nodes.forEach((node, index) => {
      const runtimeStep = actual.steps[index], topNode = top.nodes.find(item => item.number.text === String(index + 1));
      assert.equal(node.id, runtimeStep.id); assert.equal(node.status, runtimeStep.status, 'inspection selection cannot replace the real execution status');
      assert.equal(node.sharedDotClass, true); assert.equal(node.ownStatusClass, runtimeStep.status); assert.equal(node.number, String(index + 1)); assert.equal(node.dotText, String(index + 1), 'completed details nodes keep their number instead of a checkmark');
      assert.equal(node.fill, details.palette[runtimeStep.status]); assert.equal(node.color, 'rgb(0, 0, 0)'); assert.equal(node.width, 28); assert.equal(node.height, 28); assert.equal(node.borderRadius, '50%');
      assert.equal(node.fontSize, '12px'); assert.equal(node.fontWeight, '600'); assert.ok(node.variantNumeric.includes('tabular-nums'));
      assert.equal(node.ring.content, '""'); assert.equal(node.ring.borderWidth, '1px'); assert.equal(node.ring.borderStyle, 'solid'); assert.equal(node.ring.borderRadius, '50%'); assert.equal(node.ring.opacity, '0.35'); assert.equal(node.ring.pointerEvents, 'none');
      if (top.cornerShapeSupported) { assert.ok(['round','superellipse(1)'].includes(node.cornerShape)); assert.ok(['round','superellipse(1)'].includes(node.ring.cornerShape)); }
      assert.ok(topNode, 'the two-step native fixture exposes every corresponding top circle');
      assert.equal(node.fill, topNode.fill, 'details and actual native top-strip circles use exactly the same state fill'); assert.equal(node.color, topNode.number.color);
      for (const key of Object.keys(node.ring)) assert.equal(node.ring[key], topNode.ring[key], `details and top circle inner ring agree: ${key}`);
    });
    return { currentStepId: actual.currentStepId, ...details };
  };
  const reviewDelivery = async (decision, note) => {
    await openDetails(); await detailsDialog().getByLabel('验收说明', { exact: true }).fill(note);
    const result = page.waitForResponse(response => response.url().endsWith('/digital-workers/api/conversation-workflow/review'), { timeout: 10000 });
    await detailsDialog().getByRole('button', { name: decision === 'accepted' ? '验收通过' : '退回', exact: true }).click();
    const response = await result; assert.ok(response.ok(), await response.text());
    const body = await response.json(); assert.ok(!('state' in body) && !JSON.stringify(body).includes('employeeSnapshot'), 'scoped review must not return the project state or employee model settings');
    await closeDetails(); return body;
  };
  const pick = async name => {
    await picker().getByRole('button').first().click();
    const choose = async () => {
      const response = page.waitForResponse(response => response.url().endsWith('/digital-workers/api/command') && response.request().postDataJSON()?.action === 'conversation.workflow.select', { timeout: 10000 });
      await page.getByRole('option', { name, exact: true }).click(); return response;
    };
    let response = await choose();
    // Finishing a native owner turn changes the store revision before the next
    // mounted UI poll. A real user can explicitly choose again after that CAS
    // refusal; the production controller must never silently retry the write.
    if (response.status() === 409) {
      const failure = await response.json();
      (metrics.explicitCasRetries ??= []).push({ choice: name, status: response.status(), error: failure.error });
      await expect(picker().getByRole('button').first()).toBeEnabled();
      response = await choose();
    }
    assert.ok(response.ok(), await response.text());
    await expect(page.locator('.wf-conversation-workflow-menu')).toHaveCount(0);
  };
  const captureLaneCases = async () => {
    await open('QA-工作流对话乙'); await page.setViewportSize({ width: 1512, height: 1050 }); await page.emulateMedia({ colorScheme: 'dark' });
    await pick('无'); await expect(strip()).toHaveCount(0);
    const nativeReference = await headerGeometry(), before = await state(), beforeCalls = (await calls()).length, cases = [];
    let fixedNodes;
    for (const item of [{ key: 'zero', template: longFlow, count: 8, rejects: 0 }, { key: 'one', template: flow, count: 2, rejects: 1 }, { key: 'three', template: multiReturnFlow, count: 6, rejects: 3 }, { key: 'zero-again', template: longFlow, count: 8, rejects: 0 }]) {
      await pick(item.template.name); await expect(steps()).toHaveCount(item.count);
      await expect(strip().locator('path[data-kind="reject"]')).toHaveCount(item.rejects);
      if (item.template === multiReturnFlow) {
        await expect(steps().first()).not.toHaveAttribute('aria-label', /验收不合格退回/);
        await expect(steps().first()).not.toHaveAttribute('title', /验收不合格退回/);
      }
      await expect.poll(async () => { const graph = await graphGeometry(), header = await headerGeometry(); return Math.max(...graph.nodes.map(node => Math.abs(node.labelTextBox.y + node.labelTextBox.height - header.trajectoryText.y - header.trajectoryText.height))); }).toBeLessThanOrEqual(1);
      await page.mouse.move(300, 300); const graph = await graphGeometry(), header = await headerGeometry();
      assertNumberedGraph(graph, item.template.steps); assertUpperReturns(graph, item.template.steps); assertTextAlignment(graph, header);
      compareNativeAnchors(header, nativeReference, item.key);
      const vertical = graph.nodes.map(node => ({ dotY: node.dot.y, dotHeight: node.dot.height, labelY: node.label.y, labelHeight: node.label.height }));
      fixedNodes ??= vertical[0];
      vertical.forEach(box => { for (const axis of Object.keys(box)) near(box[axis], fixedNodes[axis], `all lane counts hold fixed workflow ${axis}`); });
      cases.push({ key: item.key, nativeReference, graph, header });
      await page.screenshot({ path: resolve(artifacts, `native-return-lanes-${item.key}-dark.png`) });
    }
    assert.deepEqual((await state()).runs, before.runs); assert.equal((await calls()).length, beforeCalls, 'layout inspection cannot invoke a model');
    metrics.laneLayouts = cases;
  };
  await open('QA-工作流对话乙');
  await expect(picker().getByRole('button').first()).toHaveText('工作流：无'); await expect(strip()).toHaveCount(0);
  const beforeInitialNone = await state(), callsBeforeInitialNone = (await calls()).length;
  await pick('无'); await expect(picker().getByRole('button').first()).toHaveText('工作流：无');
  const explicitInitialNone = await view(b), afterInitialNone = await state();
  assert.equal(explicitInitialNone.selection, 'override'); assert.equal(explicitInitialNone.instanceId, null);
  assert.equal(afterInitialNone.conversationWorkflows.defaults.length, 0);
  assert.equal(afterInitialNone.conversationWorkflows.instances.length, 0);
  assert.deepEqual(afterInitialNone.employees, beforeInitialNone.employees); assert.deepEqual(afterInitialNone.runs, beforeInitialNone.runs);
  assert.equal((await calls()).length, callsBeforeInitialNone, 'explicit initial None must not invoke a model');
  await page.screenshot({ path: resolve(artifacts, 'native-initial-explicit-none-dark.png') });
  check('unconfigured-native-project-shows-literal-workflow-none-and-explicit-none-installs-or-runs-nothing');
  await open('QA-工作流对话甲'); await expect(page.getByRole('button', { name: '团队', exact: true })).toHaveCount(0);
  await expect(picker().getByRole('button').first()).toHaveText('工作流：无');
  await picker().getByRole('button').first().click(); const options = page.getByRole('listbox', { name: '项目工作流' }).getByRole('option');
  await expect(options.first()).toHaveText('无');
  await expect(picker().getByRole('button', { name: '项目工作区', exact: true })).toHaveCount(0);
  const triggerBox = await picker().getByRole('button').first().boundingBox(), menuBox = await page.locator('.wf-conversation-workflow-menu').boundingBox();
  assert.ok(menuBox.y + menuBox.height <= triggerBox.y + 1, 'menu must open upward');
  await page.getByRole('option', { name: flow.name, exact: true }).click(); await expect(picker()).toContainText('工作流：' + flow.name);
  await expect(steps()).toHaveCount(2); await expect(steps().nth(0)).toHaveAttribute('aria-current', 'step');
  await expect(strip().locator('.wf-conversation-workflow-more')).toHaveCount(0);
  const selected = await view(a);
  await expect(page.locator('.wf-conversation-workflow-contact')).toHaveText(lead.name + '正在对接');
  await expect(page.locator('.wf-conversation-workflow-contact')).toHaveAttribute('data-visible', 'true');
  const contact = await page.locator('.wf-conversation-workflow-contact').evaluate(n=>{const r=document.createRange();r.selectNodeContents(n);const b=r.getBoundingClientRect();const d=document.querySelector('.wf-conversation-workflow-details-trigger');const dr=document.createRange();dr.selectNodeContents(d);return {left:b.left,detailsLeft:dr.getBoundingClientRect().left,bottom:b.bottom,fontSize:getComputedStyle(n).fontSize,text:n.textContent};});
  const initialHeader = await headerGeometry();assert.ok(Math.abs(contact.bottom-initialHeader.trajectoryText.y-initialHeader.trajectoryText.height)<=1);assert.equal(contact.fontSize,'12px');
  assert.ok(Math.abs(contact.left-contact.detailsLeft)<=.03125, 'contact and Details text share the same left edge');
  metrics.contact = contact;
  assert.equal(selected.owner.name, lead.name); assert.deepEqual(Object.keys(selected.owner).sort(), ['id', 'name']); assert.equal(selected.activeEmployeeIds.length, 2); assert.equal((await state()).runs.length, 0);
  await expect(strip().locator('path[data-kind="reject"][data-source="implementation"][data-target="requirements"]')).toHaveCount(1);
  const returnGeometry = await graphGeometry(), [firstNode, secondNode] = returnGeometry.nodes;
  assert.equal(returnGeometry.nav.height, 30, 'one visible reject lane keeps the same fixed native utility occupancy');
  assert.equal(returnGeometry.svgPointerEvents, 'none'); assert.ok(returnGeometry.nodes.every(node => node.hitTargetIsButton), 'SVG connections cannot intercept real node clicks');
  assert.ok(returnGeometry.nodes.every(node => Math.abs(node.dot.width - 28) < .1 && Math.abs(node.dot.height - 28) < .1));
  assertNumberedGraph(returnGeometry, flow.steps);
  const rejectedEdge = returnGeometry.edges.find(edge => edge.kind === 'reject'), sequenceEdge = returnGeometry.edges.find(edge => edge.kind === 'sequence');
  assert.equal(rejectedEdge.source, 'implementation'); assert.equal(rejectedEdge.target, 'requirements');
  assert.notEqual(rejectedEdge.strokeDasharray, 'none'); assert.ok(rejectedEdge.markerEnd?.startsWith('url('));
  assertUpperReturns(returnGeometry, flow.steps);
  for (const [endpoint, node] of [[rejectedEdge.start, secondNode], [rejectedEdge.end, firstNode]]) assert.ok(Math.abs(Math.hypot(endpoint.x - node.center.x, endpoint.y - node.center.y) - 14) < .1, 'reject endpoints touch their true source and destination circle borders');
  assert.ok(Math.abs(sequenceEdge.start.y - firstNode.center.y) < .1 && Math.abs(sequenceEdge.end.y - secondNode.center.y) < .1, 'sequential connector aligns with both node centers');
  assert.ok(Math.abs(sequenceEdge.start.x - firstNode.center.x - 14) < .1 && Math.abs(sequenceEdge.end.x - secondNode.center.x + 14) < .1);
  metrics.returnGraph = returnGeometry;
  await page.screenshot({ path: resolve(artifacts, 'native-selected-dark.png') }); check('native-input-workflow-upward-menu-none-first-and-frozen-team-installed-without-running');
  check('native-svg-sequence-and-upper-reject-connections-touch-real-circles-avoid-labels-and-native-controls-with-click-through');
  await open('QA-工作流对话乙'); await expect(picker().getByRole('button').first()).toHaveText('工作流：' + flow.name);
  const unified = await view(b), afterFirstWorkflow = await state();
  assert.equal(unified.selection, 'inherit'); assert.equal(unified.instanceId, selected.instanceId);
  assert.ok(!afterFirstWorkflow.conversationWorkflows.selections.some(entry => entry.projectId === workspace.workspaceId && entry.sessionId === b), 'the first workflow choice clears the earlier project-local None override');
  assert.deepEqual(afterFirstWorkflow.runs, afterInitialNone.runs, 'unifying project conversations must not create employee runs');
  assert.equal((await calls()).length, callsBeforeInitialNone, 'the first workflow choice must not invoke a model');
  metrics.initialProjectSelection = { initialNoneSessionId: b, initialNoneOverride: true, firstWorkflowId: flow.id, inheritedInstanceId: unified.instanceId, priorNoneCleared: true, automaticRuns: 0, automaticModelCalls: 0 };
  await page.screenshot({ path: resolve(artifacts, 'native-first-workflow-unifies-prior-none-dark.png') });
  check('first-native-workflow-selection-clears-prior-none-and-unifies-all-project-conversations-without-running');
  await open('QA-工作流对话甲');
  // The native permission picker parks a user-approval notice in nextStep without
  // waking the idle Agent. This metadata must survive, but cannot lock workflow
  // choices while the native composer itself remains ready to send.
  const beforePermission = await state(), callsBeforePermission = (await calls()).length;
  const permission = () => page.getByRole('button', { name: /^访问模式，当前：/ });
  await expect(permission()).toBeEnabled();
  await expect(permission()).not.toHaveAccessibleName('访问模式，当前：完全权限');
  await permission().click(); await page.getByText('完全权限', { exact: true }).click();
  const permissionConfirm = page.getByRole('dialog', { name: '确认启用完全权限？', exact: true });
  await expect(permissionConfirm).toBeVisible();
  await permissionConfirm.getByRole('checkbox', { name: '我已了解风险，并愿意继续', exact: true }).check();
  await permissionConfirm.getByRole('button', { name: '启用完全权限', exact: true }).click();
  await expect(permission()).toHaveAccessibleName('访问模式，当前：完全权限'); await expect(permission()).toBeEnabled();
  const permissionDraft = page.locator('[data-composer-input][contenteditable=true]');
  await permissionDraft.fill('WF_PERMISSION_UNSENT_919：权限切换不应锁定工作流');
  const nativeSend = page.getByRole('button', { name: '发送消息', exact: true });
  await expect(nativeSend).toBeEnabled();
  // Wait for the mounted slots' real polling read, rather than checking an old
  // render immediately after the native policy change settles.
  await page.waitForResponse(response => response.request().method() === 'GET'
    && response.url().includes('/digital-workers/api/conversation-workflow?sessionId=' + encodeURIComponent(a)), { timeout: 10000 });
  await delay(100);
  const afterPermission = await view(a);
  metrics.permissionChange = { nativeSendEnabled: await nativeSend.isEnabled(), workflowBusy: afterPermission.busy,
    pickerDisabled: await picker().getByRole('button').first().isDisabled(), stepDisabled: await steps().first().isDisabled(),
    workflowInstanceId: afterPermission.instanceId, automaticModelCalls: (await calls()).length - callsBeforePermission };
  await page.screenshot({ path: resolve(artifacts, 'native-permission-change-idle-workflow-dark.png') });
  assert.equal(afterPermission.busy, false, 'an idle native permission notice cannot make the conversation workflow busy');
  await expect(picker().getByRole('button').first()).toBeEnabled();
  for (const step of await steps().all()) { await expect(step).toBeEnabled(); await expect(step).toHaveAttribute('aria-disabled', 'false'); }
  await steps().nth(1).click(); await expect(steps().nth(1)).toHaveAttribute('aria-current', 'step');
  await steps().nth(0).click(); await expect(steps().nth(0)).toHaveAttribute('aria-current', 'step');
  await pick(flow.name); await expect(picker()).toContainText('工作流：' + flow.name);
  assert.deepEqual((await state()).runs, beforePermission.runs, 'permission changes and workflow choices cannot create employee runs');
  assert.equal((await calls()).length, callsBeforePermission, 'native permission changes cannot invoke a model');
  await expect(permissionDraft).toHaveText('WF_PERMISSION_UNSENT_919：权限切换不应锁定工作流'); await permissionDraft.fill('');
  check('native-permission-change-keeps-idle-composer-workflow-picker-and-step-navigation-enabled-without-running');
  await openDetails();
  metrics.detailsNodeStates = [{ phase: 'initial-current-and-pending', ...await assertDetailsNodeParity() }];
  await expect(detailsDialog().getByRole('heading', { level: 2 })).toHaveText((await state()).projects.find(project => project.id === workspace.workspaceId).name);
  await expect(detailsDialog().locator(':scope > header button')).toHaveCount(1);
  await expect(detailsDialog().getByRole('tab', { name: '工作流', exact: true })).toHaveAttribute('aria-selected', 'true');
  const beforeProjectWiki = await state(), callsBeforeProjectWiki = (await calls()).length;
  await detailsDialog().getByRole('tab', { name: '项目知识库', exact: true }).click();
  await expect(detailsDialog().getByRole('tab', { name: '项目知识库', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(detailsDialog()).toContainText('团队资料员已停用');
  await expect(detailsDialog().locator('iframe')).toHaveCount(0);
  await detailsDialog().getByRole('tab', { name: '工作流', exact: true }).click();
  assert.deepEqual(await state(), beforeProjectWiki, 'project view tabs must not mutate workflow state');
  assert.equal((await calls()).length, callsBeforeProjectWiki, 'opening a project knowledge view cannot invoke a model');
  check('project-name-header-two-tabs-and-read-only-knowledge-view-use-the-frozen-project-team');
  await expect(detailsDialog()).toContainText('负责人：' + lead.name); await expect(detailsDialog()).toContainText('下级：' + developer.name);
  await expect(stepInstruction()).toHaveJSProperty('open', false); await expect(stepInstructionBody()).toBeHidden();
  await expect(stepInstructionSummary().getByRole('heading', { name: '步骤内容', exact: true })).toBeVisible();
  for (const text of ['交付内容', '验收标准']) await expect(detailsDialog().getByText(text, { exact: true })).toBeVisible();
  for (const [kind, text] of [['outputs','WF_OUTPUT_REQUIREMENTS_917'],['acceptance','WF_ACCEPT_REQUIREMENTS_917']]) { const fold = detailsDialog().locator('details[data-requirement=' + kind + ']'); await expect(fold).toHaveJSProperty('open', false); await expect(fold.getByText(text, {exact:true})).toBeHidden(); await fold.locator('summary').click(); await expect(fold.getByText(text, {exact:true})).toBeVisible(); await fold.locator('summary').click(); }
  await expect(detailsDialog().getByText('退回目标', {exact:true})).toHaveCount(0);
  const instructionBefore = await state(), callsBeforeInstruction = (await calls()).length;
  metrics.instructionCollapse = { order: await stepInstruction().evaluate(fold => {
    const section = fold.parentElement, identity = section.querySelector('.wf-conversation-details-step-heading'), requirements = section.querySelector(':scope > .wf-conversation-details-requirement-folds');
    return { identityBeforeFold: !!(identity.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING), foldBeforeRequirements: !!(fold.compareDocumentPosition(requirements) & Node.DOCUMENT_POSITION_FOLLOWING) };
  }) };
  assert.equal(metrics.instructionCollapse.order.identityBeforeFold, true); assert.equal(metrics.instructionCollapse.order.foldBeforeRequirements, true);
  await stepInstructionSummary().click(); await expect(stepInstructionBody()).toBeVisible(); await expect(stepInstructionBody()).toHaveText(flow.steps[0].instruction);
  await expect(stepInstruction().getByText('步骤说明', { exact: true })).toBeVisible();
  await stepInstructionSummary().focus(); await stepInstructionSummary().press('Enter'); await expect(stepInstructionBody()).toBeHidden();
  await stepInstructionSummary().press('Space'); await expect(stepInstructionBody()).toBeVisible(); await stepInstructionSummary().click(); await expect(stepInstructionBody()).toBeHidden();
  assert.deepEqual(await state(), instructionBefore, 'folding instructions cannot mutate workflow state'); assert.equal((await calls()).length, callsBeforeInstruction, 'folding instructions cannot call a model');
  await stepInstructionSummary().click();
  await inspectStep('implementation');
  await expect(stepInstruction()).toHaveJSProperty('open', false); await expect(stepInstructionBody()).toBeHidden();
  await expect(stepInstructionBody()).toHaveText(flow.steps[1].instruction); await stepInstructionSummary().click(); await expect(stepInstructionBody()).toBeVisible();
  await expect(detailsDialog().getByText('退回目标', { exact: true })).toBeVisible();
  await expect(detailsDialog().getByRole('region', { name: '步骤内容', exact: true }).getByRole('button', { name: '需求确认', exact: true })).toBeVisible();
  await expect(detailsDialog().locator('path[data-reject-from="implementation"][data-reject-to="requirements"]')).toHaveCount(1);
  await expect(detailsDialog().getByRole('button', { name: '设为当前', exact: true })).toBeVisible();
  assert.equal((await view(a)).currentStepId, 'requirements', 'inspecting requirements may not activate the selected step');
  metrics.detailsNodeStates.push({ phase: 'inspected-pending-still-real-current', ...await assertDetailsNodeParity() });
  assert.equal(metrics.detailsNodeStates.at(-1).nodes[1].inspected, true); assert.equal(metrics.detailsNodeStates.at(-1).nodes[0].inspected, false);
  await page.screenshot({ path: resolve(artifacts, 'native-workflow-details-inspect-dark.png') });
  await detailsDialog().getByRole('button', { name: '设为当前', exact: true }).click();
  await expect.poll(async () => (await view(a)).currentStepId).toBe('implementation');
  await expect(page.locator('.wf-conversation-workflow-contact')).toHaveText(developer.name + '正在对接');
  await inspectStep('requirements'); await expect(stepInstruction()).toHaveJSProperty('open', false); await expect(stepInstructionBody()).toBeHidden();
  await stepInstructionSummary().click(); await expect(stepInstructionBody()).toBeVisible(); await expect(stepInstructionBody()).toHaveText(flow.steps[0].instruction);
  Object.assign(metrics.instructionCollapse, { defaultClosed: true, mouseAndKeyboard: true, newStepClosed: true, preservedAlwaysVisibleRequirements: true, foldingBusinessWrites: 0, foldingModelCalls: 0 });
  await detailsDialog().getByRole('button', { name: '设为当前', exact: true }).click();
  await expect.poll(async () => (await view(a)).currentStepId).toBe('requirements'); await closeDetails();
  check('details-show-frozen-owner-hierarchy-three-requirements-and-return-target-without-activating-inspected-step');
  const library = page.getByRole('button', { name: 'graph_horses', exact: true });
  await library.click(); await expect(page.getByRole('navigation', { name: '资源库', exact: true }).getByRole('button')).toHaveCount(3);
  await expect(page.getByRole('navigation', { name: '项目工作区', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '配置团队', exact: true })).toHaveCount(0); await expect(page.locator('.wf-workspace-overlay')).toHaveCount(0);
  check('library-retains-only-three-resource-sections-and-no-project-workspace-or-team-configuration-ui');
  await open('QA-工作流对话乙'); await expect(picker()).toContainText('工作流：' + flow.name); assert.equal((await view(b)).selection, 'inherit');
  await captureLaneCases();
  check('zero-one-three-and-zero-return-lanes-keep-native-none-header-body-anchors-and-fixed-step-text-bottom-aligned-with-trajectory');
  metrics.fixedAlignmentMatrix = [];
  const matrixRuns = structuredClone((await state()).runs), matrixCalls = (await calls()).length;
  for (const locale of ['zh', 'en']) {
    await switchDshLocale(page, locale);
    for (const scheme of ['dark', 'light']) for (const width of [1512, 1024, 768, 660]) {
      await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width, height: 1000 });
      await pick(locale === 'en' ? 'None' : '无'); await expect(strip()).toHaveCount(0);
      const reference = await headerGeometry(), entry = { locale, scheme, width, reference, cases: [] };
      let fixed;
      for (const template of [longFlow, multiReturnFlow, longFlow]) {
        await pick(template.name);
        await expect.poll(async () => { const graph = await graphGeometry(), native = await headerGeometry(); return Math.max(...graph.nodes.map(node => Math.abs(node.labelTextBox.y + node.labelTextBox.height - native.trajectoryText.y - native.trajectoryText.height))); }).toBeLessThanOrEqual(1);
        const graph = await graphGeometry(), native = await headerGeometry();
        assertTextAlignment(graph, native); compareNativeAnchors(native, reference, `${locale}-${scheme}-${width}`); assertUpperReturns(graph, template.steps); assertNumberedGraph(graph, template.steps);
        fixed ??= graph.nodes[0];
        graph.nodes.forEach(node => near(node.dot.y, fixed.dot.y, 'resize and return counts cannot move the fixed node row'));
        entry.cases.push({ name: template.name, graph, header: native });
      }
      metrics.fixedAlignmentMatrix.push(entry);
      await page.screenshot({ path: resolve(artifacts, `native-fixed-text-${locale}-${scheme}-${width}.png`) });
    }
  }
  await switchDshLocale(page, 'zh'); await page.emulateMedia({ colorScheme: 'dark' });
  assert.deepEqual((await state()).runs, matrixRuns); assert.equal((await calls()).length, matrixCalls, 'alignment matrix must not invoke a model or create a delivery');
  check('sixteen-native-language-theme-width-cases-compare-none-zero-three-zero-again-with-identical-native-anchors-and-aligned-text');
  await pick(multiReturnFlow.name);
  await page.setViewportSize({ width: 712, height: 1000 });
  await openDetails(); await inspectStep('return-step-6');
  await detailsDialog().getByRole('button', { name: '设为当前', exact: true }).click(); await expect.poll(async () => (await view(b)).currentStepId).toBe('return-step-6'); await closeDetails();
  const narrowCurrent = strip().locator('.wf-conversation-workflow-step[aria-current="step"]');
  await expect(narrowCurrent).toHaveCount(1); await expect(narrowCurrent.locator('.wf-conversation-workflow-step-number')).toHaveText('6');
  await expect(steps().filter({ hasText: '布局步骤2' })).toHaveCount(0);
  await expect(strip().locator('path[data-kind="reject"]')).toHaveCount(0);
  await expect(narrowCurrent).toHaveAttribute('aria-label', /布局步骤2/);
  const hiddenReturn = await graphGeometry(); assertUpperReturns(hiddenReturn, multiReturnFlow.steps); metrics.hiddenReturn = hiddenReturn;
  const hiddenScroll = await strip().evaluate(node => node.scrollLeft); await strip().hover(); await page.mouse.wheel(1000, 0); assert.equal(await strip().evaluate(node => node.scrollLeft), hiddenScroll);
  await page.mouse.move(300, 300); await page.screenshot({ path: resolve(artifacts, 'native-hidden-return-target-narrow-dark.png') });
  await page.setViewportSize({ width: 1512, height: 1050 });
  check('narrow-native-return-keeps-true-hidden-target-without-fake-ellipsis-edge-horizontal-scroll-or-click-interception');
  await pick(longFlow.name); await expect(picker()).toContainText(longFlow.name);
  assert.equal((await view(b)).selection, 'override'); assert.equal((await view(a)).workflowTemplateId, flow.id, 'a later alternative workflow is local to conversation B');
  metrics.compactLayout = [];
  for (const scheme of ['dark', 'light']) for (const width of [1512, 712]) {
    await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width, height: 1000 });
    await expect(strip().locator('.wf-conversation-workflow-more').first()).toBeVisible();
    await expect(page.locator('.wf-conversation-workflow-details-trigger')).toBeVisible();
    await expect.poll(() => strip().evaluate(node => getComputedStyle(node).overflowX)).toBe('visible');
    const beforeWheel = await strip().evaluate(node => node.scrollLeft);
    await strip().hover(); await page.mouse.wheel(1000, 0); await delay(100);
    const afterWheel = await strip().evaluate(node => node.scrollLeft);
    assert.equal(afterWheel, beforeWheel, 'ellipsis list must not scroll horizontally on a real mouse wheel');
    const geometry = await page.locator('.wf-conversation-workflow-bar').evaluate(bar => {
      const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
      const step = bar.querySelector('.wf-conversation-workflow-step'), dot = step.querySelector('.wf-conversation-workflow-dot'), label = step.querySelector('.wf-conversation-workflow-step-label');
      const barBox = rect(bar);
      const nextNativeControl = [...bar.closest('header').querySelectorAll('button')].filter(button => !bar.contains(button)).map(rect).filter(box => box.width > 0 && box.x >= barBox.x + barBox.width - 1).sort((a, b) => a.x - b.x)[0];
      return { bar: rect(bar), details: rect(bar.querySelector('.wf-conversation-workflow-details-trigger')), dot: rect(dot), label: rect(label),
        dotRadius: getComputedStyle(dot).borderRadius, dotColor: getComputedStyle(dot).backgroundColor, labelFont: getComputedStyle(label).fontSize,
        scrollWidth: bar.querySelector('nav').scrollWidth, clientWidth: bar.querySelector('nav').clientWidth,
        overflowX: getComputedStyle(bar.querySelector('nav')).overflowX, scrollLeft: bar.querySelector('nav').scrollLeft,
        title: rect([...bar.closest('header').querySelectorAll('nav span')].find(span => span.textContent === 'QA-工作流对话乙')),
        nextNativeControl,
        corner: rect(document.querySelector('[data-conversation-header-corner]')),
        tabs: rect(document.querySelector('[data-conversation-tabs]')) };
    });
    assert.ok(Math.abs(geometry.dot.width - 28) < .1 && Math.abs(geometry.dot.height - 28) < .1, 'numbered node must be a compact 28px circle');
    assert.equal(geometry.dotRadius, '50%'); assert.ok(geometry.label.y >= geometry.dot.y + geometry.dot.height - 1, 'step annotation belongs below its circle');
    assert.ok(geometry.bar.height <= 30, 'fixed plugin utility occupancy cannot exceed the native title row'); assert.ok(geometry.bar.x >= 0 && geometry.bar.x + geometry.bar.width <= width + 1);
    assert.ok(geometry.details.x + geometry.details.width <= width + 1, 'details remains visible instead of scrolling behind the edge');
    const nativeControlGap = geometry.nextNativeControl.x - geometry.bar.x - geometry.bar.width;
    assert.ok(nativeControlGap >= 32 && nativeControlGap <= 44, 'utilities contribution leaves approximately 36px before the next native dropdown control');
    assert.equal(geometry.overflowX, 'visible', 'only the fixed visual layer uses native header space; its SVG clips horizontal paint');
    const overlap = Math.max(0, Math.min(geometry.bar.x + geometry.bar.width, geometry.title.x + geometry.title.width) - Math.max(geometry.bar.x, geometry.title.x))
      * Math.max(0, Math.min(geometry.bar.y + geometry.bar.height, geometry.title.y + geometry.title.height) - Math.max(geometry.bar.y, geometry.title.y));
    assert.ok(overlap < 1, 'public action contribution must not cover the original conversation title');
    assertTextAlignment(await graphGeometry(), await headerGeometry());
    const graph = await graphGeometry(); assert.equal(graph.nav.height, 30, 'all workflow variants keep the same compact native utility occupancy');
    assert.equal(graph.edges.filter(edge => edge.kind === 'reject').length, 0);
    assert.equal(graph.edges.filter(edge => edge.kind === 'sequence').length, Math.max(0, graph.nodes.length - 1));
    assert.ok(graph.nodes.every(node => node.hitTargetIsButton));
    assertUpperReturns(graph, longFlow.steps);
    assertNumberedGraph(graph, longFlow.steps);
    metrics.compactLayout.push({ width, scheme, beforeWheel, afterWheel, nativeControlGap, ...geometry, graph });
    await page.screenshot({ path: resolve(artifacts, `native-compact-steps-${width}-${scheme}.png`) });
    await expect(strip().locator('.wf-conversation-workflow-more').first()).not.toHaveJSProperty('tagName', 'BUTTON'); await openDetails(); await expect(detailsDialog().locator('[data-step-id=long-step-1]')).toHaveAttribute('aria-current', 'true');
    await expect(detailsDialog().locator('.wf-conversation-details-flow button')).toHaveCount(12);
    await page.screenshot({ path: resolve(artifacts, `native-compact-details-${width}-${scheme}.png`) }); await closeDetails();
    await page.getByRole('tab', { name: '轨迹', exact: true }).click(); await expect(page.getByRole('tab', { name: '轨迹', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: '对话', exact: true }).click(); await expect(page.getByRole('tab', { name: '对话', exact: true })).toHaveAttribute('aria-selected', 'true');
  }
  await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 1512, height: 1050 });
  check('numbered-double-ring-nodes-readable-in-dark-light-with-labels-below-compact-height-and-ellipsis-fixed-details-at-wide-narrow-widths');
  const windowBefore = await state(), callsBeforeWindow = (await calls()).length;
  let sevenSlotViewport;
  const viewportAttempts = [];
  for (const width of [1440, 1400, 1360, 1320, 1280]) {
    await page.setViewportSize({ width, height: 1050 }); await delay(100);
    const count = await steps().count(); viewportAttempts.push({ width, count });
    if (count === 7) { sevenSlotViewport = width; break; }
  }
  assert.ok(sevenSlotViewport, `the native fixture must expose a real seven-slot viewport: ${JSON.stringify(viewportAttempts)}`);
  await expect(steps().locator('.wf-conversation-workflow-step-number')).toHaveText(['1', '2', '3', '4', '5', '6', '7']);
  const initialWindow = await graphGeometry(); assertNumberedGraph(initialWindow, longFlow.steps);
  const centeredWindows = [{ selected: 1, graph: initialWindow }];
  const sameSlotCenters = (actual, expected, message) => {
    assertDetailsAlignment(actual); assertDetailsAlignment(expected);
    assert.equal(actual.nodes.length, expected.nodes.length);
    for (let index = 0; index < actual.nodes.length; index++) {
      near(actual.nodes[index].center.x, expected.nodes[index].center.x, message, .1);
      near(actual.nodes[index].dot.y, expected.nodes[index].dot.y, 'window selection keeps node row fixed', .1);
      near(actual.nodes[index].label.y, expected.nodes[index].label.y, 'window selection keeps text row fixed', .1);
    }
  };
  const clickNumberedStep = async (number, expectedNumbers, keyboard = false) => {
    const button = steps().filter({ has: page.getByText(String(number), { exact: true }) });
    if (keyboard) { await button.focus(); await button.press('Enter'); } else await button.click();
    await expect(button).toHaveAttribute('aria-current', 'step');
    await expect.poll(async () => (await view(b)).currentStepId).toBe(`long-step-${number}`);
    await expect(steps().locator('.wf-conversation-workflow-step-number')).toHaveText(expectedNumbers.map(String));
    if (keyboard) await expect(button).toBeFocused();
    const graph = await graphGeometry(); assertNumberedGraph(graph, longFlow.steps); centeredWindows.push({ selected: number, graph }); return graph;
  };
  for (const number of [2, 3, 4]) {
    const graph = await clickNumberedStep(number, [1, 2, 3, 4, 5, 6, 7]);
    sameSlotCenters(graph, initialWindow, 'clicking the first four steps leaves all seven nodes at their initial screen positions');
  }
  await page.screenshot({ path: resolve(artifacts, 'native-window-current-fourth-in-place-dark.png') });
  const fifthWindow = await clickNumberedStep(5, [2, 3, 4, 5, 6, 7, 8]);
  sameSlotCenters(fifthWindow, initialWindow, 'the first leading ellipsis does not change slot coordinates');
  assert.ok(Math.abs(fifthWindow.nodes.find(node => node.number.text === '5').center.x - initialWindow.nodes.find(node => node.number.text === '4').center.x) < .1, 'global step five moves to the original central fourth slot');
  await expect(strip().locator('.wf-conversation-workflow-more.is-before')).toBeVisible();
  await page.screenshot({ path: resolve(artifacts, 'native-window-current-fifth-centered-dark.png') });
  const sixthWindow = await clickNumberedStep(6, [3, 4, 5, 6, 7, 8, 9], true); sameSlotCenters(sixthWindow, initialWindow, 'centering subsequent steps keeps every slot stable');
  assert.ok(Math.abs(sixthWindow.nodes.find(node => node.number.text === '6').center.x - initialWindow.nodes.find(node => node.number.text === '4').center.x) < .1, 'global step six stays in the original central fourth slot');
  const tailWindow = await clickNumberedStep(9, [6, 7, 8, 9, 10, 11, 12]);
  sameSlotCenters(tailWindow, initialWindow, 'the trailing ellipsis disappearing cannot reflow the seven node slots');
  await expect(strip().locator('.wf-conversation-workflow-more.is-after')).toHaveCount(0);
  for (const number of [10, 11, 12]) {
    const graph = await clickNumberedStep(number, [6, 7, 8, 9, 10, 11, 12]);
    sameSlotCenters(graph, tailWindow, 'when the tail is fully visible, selecting later steps cannot move any tail node');
  }
  await page.screenshot({ path: resolve(artifacts, 'native-window-tail-clamped-dark.png') });
  await openDetails(); await inspectStep('long-step-1');
  await detailsDialog().getByRole('button', { name: '设为当前', exact: true }).click();
  await expect.poll(async () => (await view(b)).currentStepId).toBe('long-step-1'); await closeDetails();
  await expect(steps().locator('.wf-conversation-workflow-step-number')).toHaveText(['1', '2', '3', '4', '5', '6', '7']);
  const reversedWindow = await graphGeometry(); sameSlotCenters(reversedWindow, initialWindow, 'returning to the first step restores the original node positions');
  const windowAfter = await state();
  assert.deepEqual(windowAfter.workflowTemplates, windowBefore.workflowTemplates); assert.deepEqual(windowAfter.projectTeams, windowBefore.projectTeams);
  assert.deepEqual(windowAfter.employees, windowBefore.employees); assert.deepEqual(windowAfter.runs, windowBefore.runs); assert.equal((await calls()).length, callsBeforeWindow);
  metrics.centeredWindow = { viewportWidth: sevenSlotViewport, viewportAttempts, windows: centeredWindows, reversedWindow, automaticRuns: 0, automaticModelCalls: 0 };
  check('seven-visible-native-window-holds-first-four-centers-from-five-clamps-the-complete-tail-and-reverses-without-coordinate-jumps-or-running');
  await openDetails(); await inspectStep('long-step-12');
  await detailsDialog().getByRole('button', { name: '设为当前', exact: true }).click();
  await expect.poll(async () => (await view(b)).currentStepId).toBe('long-step-12'); await closeDetails();
  await expect(strip().locator('.wf-conversation-workflow-more.is-before')).toBeVisible();
  await expect(steps().last().locator('.wf-conversation-workflow-step-number')).toHaveText('12');
  metrics.shiftedNumbering = await graphGeometry(); assertNumberedGraph(metrics.shiftedNumbering, longFlow.steps); assertDetailsAlignment(metrics.shiftedNumbering);
  assert.ok(Number(metrics.shiftedNumbering.nodes[0].number.text) > 1, 'the shifted visible window keeps its global number instead of restarting at one');
  await page.screenshot({ path: resolve(artifacts, 'native-numbered-steps-global-indices-dark.png') });
  check('numbered-step-circles-retain-global-definition-indices-after-leading-ellipsis-and-current-step-shifts');
  await page.setViewportSize({ width: 1512, height: 1050 });
  await pick('无'); await expect(picker().getByRole('button').first()).toHaveText('工作流：无'); await expect(strip()).toHaveCount(0); assert.equal((await view(b)).selection, 'override');
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(picker().getByRole('button').first()).toHaveText('工作流：无');
  await open('QA-工作流对话甲'); await expect(picker()).toContainText(flow.name);
  const afterLocalChoices = await state();
  assert.deepEqual(afterLocalChoices.conversationWorkflows.defaults, afterFirstWorkflow.conversationWorkflows.defaults, 'later choices cannot replace the first project default');
  assert.deepEqual(afterLocalChoices.runs, afterFirstWorkflow.runs); assert.equal((await calls()).length, callsBeforeInitialNone);
  check('later-alternate-workflow-and-none-are-local-persist-after-refresh-and-preserve-project-default-without-running');
  await steps().nth(1).focus(); await steps().nth(1).press('Enter'); await expect(steps().nth(1)).toHaveAttribute('aria-current', 'step');
  await expect(steps().nth(1)).toBeFocused();
  const changed = await view(a); assert.equal(changed.owner.name, developer.name); assert.equal(changed.activeEmployeeIds.length, 1); assert.deepEqual(changed.steps.map(step => step.status), ['pending', 'current']);
  await steps().nth(0).click(); await expect(steps().nth(0)).toHaveAttribute('aria-current', 'step');
  metrics.colors = await steps().evaluateAll(buttons => buttons.map(button => ({ status: button.className, color: getComputedStyle(button.querySelector('.wf-conversation-workflow-dot')).backgroundColor })));
  assert.notEqual(metrics.colors[0].color, metrics.colors[1].color);
  assert.equal(metrics.colors[0].color, await page.getByRole('tab', { name: '对话', exact: true }).evaluate(node => getComputedStyle(node).color), 'current blue matches the native conversation tab');
  check('top-native-header-steps-click-change-owner-and-roster-without-marking-previous-steps-complete');
  const send = async text => { const editor = page.locator('[data-composer-input][contenteditable=true]'); await expect(editor).toBeVisible(); await editor.fill(text); await editor.press('Enter'); };
  const waitRun = async (count, model) => {
    await expect.poll(async () => (await state()).runs.filter(run => run.conversationWorkflow && !run.parentRunId).length, { timeout: 30000 }).toBe(count);
    await expect.poll(async () => (await state()).runs.filter(run => run.conversationWorkflow && !run.parentRunId).at(-1)?.status, { timeout: 30000 }).toBe('awaiting-review');
    await expect(page.getByText('WF_REPLY:' + model + '。已按当前步骤说明提交可核验的离线验证回答，等待用户验收。', { exact: false }).first()).toBeVisible();
    return (await state()).runs.filter(run => run.conversationWorkflow && !run.parentRunId).at(-1);
  };
  await send('WF_ORDINARY_917：请按本步骤处理需求，不使用@ WF_PLAN_TARGET:' + selected.owner.id); const firstRun = await waitRun(1, 'owner-product');
  assert.equal(firstRun.sessionId, a); assert.equal(firstRun.employeeSnapshot.templateId, lead.id);
  await writeFile(resolve(artifacts, 'captured-native-requests.json'), JSON.stringify(await calls(), null, 2));
  const requests = (await calls()).filter(request => JSON.stringify(request).includes('WF_STEP_REQUIREMENTS_917'));
  assert.equal(requests.length, 2, 'one owner turn may contain the plan tool call and its final answer, without reserving a second run'); assert.equal(requests[0].model, 'owner-product');
  assert.ok(JSON.stringify(requests[0].messages).includes('WF_NATIVE_PREHISTORY_A_917'), 'the same native session keeps pre-workflow history');
  assert.ok(requests[0].messages.some(message => message.role === 'user' && message.source?.kind === 'user-approval'
    && message.content.some(block => block.type === 'text' && block.text.includes('The user changed the approval policy') && block.text.includes('"never ask the user for approval"'))),
  'the next actual owner turn receives the original native permission notice; unlocking workflow choices cannot drop it');
  metrics.permissionChange.noticePreservedInOwnerRequest = true;
  for (const sentinel of ['WF_STEP_REQUIREMENTS_917', 'WF_OUTPUT_REQUIREMENTS_917', 'WF_ACCEPT_REQUIREMENTS_917']) assert.ok(JSON.stringify(requests[0]).includes(sentinel), sentinel);
  const required = (await readFile(resolve(pluginRoot, 'skills/architecture-analysis/SKILL.md'), 'utf8')).replace(/^---[\s\S]*?---\s*/, '').trim().split('\n').find(line => line.trim().length > 12);
  assert.ok(JSON.stringify(requests[0]).includes(required), 'required skill content must reach the actual first request');
  assert.equal((await view(a)).steps[0].status, 'current');
  await page.screenshot({ path: resolve(artifacts, 'native-owner-reply-dark.png') }); check('ordinary-native-message-uses-current-owner-model-step-criteria-and-required-skill-on-same-session-once');
  if (process.env.WORKFORCE_LOCALE_UI === '1') {
    const beforeLocaleChecks = await state(), beforeLocaleCalls = (await calls()).length;
    const { verifyLocaleWorkflow } = await import('./locale-workflow.checks.mjs');
    try { metrics.locale = await verifyLocaleWorkflow({ page, artifacts, switchLocale: locale => switchDshLocale(page, locale) }); }
    finally { await switchDshLocale(page, 'zh'); }
    assert.deepEqual(await state(), beforeLocaleChecks, 'Language checks must preserve all workflow progress, deliveries and employees');
    assert.equal((await calls()).length, beforeLocaleCalls, 'Language checks must not invoke a model');
    check('native-settings-language-roundtrip-preserves-workflow-dialog-draft-and-progress');
  }
  await openDetails(); const plans = detailsDialog().locator('details').filter({ has: page.locator('summary', { hasText: '已规划任务' }) });
  await expect(plans.locator('summary')).toContainText('已规划任务 · 1'); await plans.locator('summary').click();
  await expect(plans).toContainText('QA-实现接口规划'); await expect(plans).toContainText('草稿');
  assert.equal((await state()).workState.tasks.find(task => task.title === 'QA-实现接口规划').status, 'draft');
  await page.screenshot({ path: resolve(artifacts, 'native-workflow-details-planned-task-dark.png') }); await closeDetails();
  check('owner-plan-tool-saves-one-draft-and-its-summary-remains-accessible-in-details-without-project-workbench');
  const beforeAcceptanceAnchors = await headerGeometry(), beforeAcceptanceNodes = await graphGeometry();
  const acceptedDetails = await reviewDelivery('accepted', '已核对受控产物'); assert.equal(acceptedDetails.currentStepId, 'implementation');
  await expect(steps().nth(0)).toHaveClass(/is-completed/); await expect(steps().nth(1)).toHaveClass(/is-current/);
  metrics.acceptedColors = await steps().evaluateAll(buttons => buttons.map(button => getComputedStyle(button.querySelector('.wf-conversation-workflow-dot')).backgroundColor));
  assert.equal(metrics.acceptedColors[0], 'rgb(255, 255, 255)', 'accepted nodes must be filled white');
  assert.notEqual(metrics.acceptedColors[0], metrics.acceptedColors[1]);
  compareNativeAnchors(await headerGeometry(), beforeAcceptanceAnchors, 'accepted-progress');
  const afterAcceptanceNodes = await graphGeometry(); sameSlotCenters(afterAcceptanceNodes, beforeAcceptanceNodes, 'completion does not move workflow slots'); assertTextAlignment(afterAcceptanceNodes, await headerGeometry());
  check('only-real-owner-delivery-review-whitens-completed-step-and-advances-current-blue-without-moving-header');
  metrics.acceptedNodeThemes = [];
  for (const scheme of ['dark', 'light']) {
    const previousTabColor = await page.getByRole('tab', { name: '对话', exact: true }).evaluate(node => getComputedStyle(node).color);
    await page.emulateMedia({ colorScheme: scheme });
    if (scheme === 'light') await expect.poll(() => page.getByRole('tab', { name: '对话', exact: true }).evaluate(node => getComputedStyle(node).color)).not.toBe(previousTabColor);
    const graph = await graphGeometry(); assertNumberedGraph(graph, flow.steps);
    assert.equal(graph.nodes[0].fill, 'rgb(255, 255, 255)');
    assert.equal(graph.nodes[1].fill, await page.getByRole('tab', { name: '对话', exact: true }).evaluate(node => getComputedStyle(node).color), 'current numbered circle keeps the original native blue');
    metrics.acceptedNodeThemes.push({ scheme, nodes: graph.nodes.map(node => ({ status: node.status, fill: node.fill, numberColor: node.number.color, contrast: contrast(node.number.color, node.fill) })) });
    await page.screenshot({ path: resolve(artifacts, `native-numbered-completed-${scheme}.png`) });
    const beforeInspect = await state(), callsBeforeInspect = (await calls()).length;
    await openDetails(); metrics.detailsNodeStates.push({ phase: `accepted-${scheme}`, ...await assertDetailsNodeParity() });
    await inspectStep('requirements'); await expect(detailsDialog().locator('.wf-conversation-details-body')).toHaveAttribute('aria-busy', 'false');
    metrics.detailsNodeStates.push({ phase: `inspected-completed-${scheme}`, ...await assertDetailsNodeParity() });
    assert.equal(metrics.detailsNodeStates.at(-1).nodes[0].inspected, true); assert.equal(metrics.detailsNodeStates.at(-1).currentStepId, 'implementation');
    assert.deepEqual(await state(), beforeInspect, 'inspecting completed details nodes cannot change execution progress'); assert.equal((await calls()).length, callsBeforeInspect, 'inspecting details status cannot invoke a model');
    await page.screenshot({ path: resolve(artifacts, `native-details-status-${scheme}.png`) }); await closeDetails();
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.getByRole('tab', { name: '对话', exact: true }).evaluate(node => getComputedStyle(node).color)).toBe(metrics.colors[0].color);
  check('numbered-double-rings-preserve-gray-white-native-blue-states-and-readable-text-contrast-after-real-acceptance');
  await send('WF_GATE_030：按当前步骤验证开发交付');
  await expect.poll(async () => (await view(a)).busy, { timeout: 10000 }).toBe(true);
  await expect(picker().getByRole('button').first()).toBeDisabled({ timeout: 10000 }); await expect(steps().first()).toBeDisabled();
  await expect(steps().first()).toHaveAttribute('aria-disabled', 'true');
  await expect(picker().locator('[role="status"][data-stage="requesting"]')).toBeVisible({ timeout: 10000 });
  const sharedInstance = (await view(a)).instanceId;
  await open('QA-工作流对话乙');
  await expect(picker().getByRole('button').first()).toBeEnabled();
  await pick('无');
  assert.equal((await view(b)).instanceId, null);
  assert.equal((await view(a)).busy, true, 'switching another conversation cannot cancel the active native turn');
  await pick(flow.name);
  assert.equal((await view(b)).instanceId, sharedInstance);
  assert.equal((await view(b)).progressBusy, true);
  await expect(picker().getByRole('button').first()).toBeEnabled();
  await expect(steps().first()).toBeDisabled();
  await page.screenshot({ path: resolve(artifacts, 'idle-conversation-picker-during-other-run.png') });
  await open('QA-工作流对话甲');
  await expect(picker().getByRole('button').first()).toBeDisabled();
  await writeFile(resolve(temp, 'release-concurrency-030'), 'released');
  check('running-conversation-shows-stage-while-another-chat-can-switch-workflow-with-shared-progress-protected');
  const secondRun = await waitRun(2, 'owner-developer'); assert.equal(secondRun.sessionId, a); assert.equal(secondRun.employeeSnapshot.templateId, developer.id);
  const rejectedDetails = await reviewDelivery('rejected', '受控验证：按退回规则复查需求'); assert.equal(rejectedDetails.currentStepId, 'requirements');
  await expect(steps().nth(0)).toHaveClass(/is-current/); await expect(steps().nth(1)).toHaveClass(/is-pending/);
  const rework = await state(); assert.ok(rework.conversationWorkflows.instances[0].completions[0].invalidatedAt); assert.equal(rework.runs.find(run => run.id === firstRun.id).acceptance.decision, 'accepted');
  check('active-native-turn-locks-selector-and-shared-steps-and-rejected-delivery-returns-with-history-retained');
  for (const width of [1512, 712]) { await page.setViewportSize({ width, height: 1000 }); await expect(strip()).toBeVisible(); const box = await strip().boundingBox(); assert.ok(box.width > 30 && box.x >= 0 && box.x + box.width <= width + 1); await page.screenshot({ path: resolve(artifacts, `native-steps-${width}-dark.png`) }); }
  check('real-nonempty-native-header-step-strip-remains-visible-at-wide-and-narrow-widths');
  await page.setViewportSize({ width: 1512, height: 1000 });
  // Restore B's explicit None after the concurrency check temporarily selected
  // the shared workflow; later navigation assertions rely on that local choice.
  await open('QA-工作流对话乙'); await pick('无'); await expect(strip()).toHaveCount(0);
  await open('QA-工作流对话甲');
  await pick('无'); await expect(strip()).toHaveCount(0);
  const beforeNoneRuns = (await state()).runs.length;
  const containsRequest = (request, sentinel) => (JSON.stringify(request.messages.filter(message => message.source?.kind === 'user').at(-1)?.content) || '').includes(sentinel);
  await send('WF_NONE_RESTORED_917：恢复普通原生对话');
  await expect.poll(async () => (await calls()).filter(request => request.model === 'native-default' && containsRequest(request, 'WF_NONE_RESTORED_917')).length, { timeout: 20000 }).toBe(1);
  const noneRequest = (await calls()).find(request => request.model === 'native-default' && containsRequest(request, 'WF_NONE_RESTORED_917'));
  const currentContext = noneRequest.messages.filter(message => message.source?.kind === 'runtime-context').at(-1);
  assert.ok(!currentContext?.source.sections.some(section => section.name === 'composable-workforce:conversation-workflow'), 'None must remove active workflow context from the current native request');
  assert.ok(!noneRequest.tools?.some(name => name.startsWith('worker_')), 'None must remove workflow business tools');
  // Explicit native model selection is a real user action in this isolated fixture.
  // None preserves the restored native Session choice, without changing deployment defaults.
  await rpc('session/selectModel', { sessionId: a, provider: 'employee-settings-fixture', model: 'owner-developer' });
  await send('WF_NONE_EXPLICIT_917：遵循我明确选择的原生模型');
  await expect.poll(async () => (await calls()).filter(request => request.model === 'owner-developer' && containsRequest(request, 'WF_NONE_EXPLICIT_917')).length, { timeout: 20000 }).toBe(1);
  assert.equal((await state()).runs.length, beforeNoneRuns, 'None must not reserve an employee attempt');
  await writeFile(resolve(artifacts, 'captured-native-requests.json'), JSON.stringify(await calls(), null, 2));
  metrics.noneModelPolicy = { withoutExplicitSelection: noneRequest.model, explicitNativeSelection: 'owner-developer', workflowRunsCreated: 0, activeWorkflowContext: false, businessTools: false };
  check('none-removes-owner-context-tools-and-tracking-and-restores-native-session-and-explicit-model-selection');
  await expect(page.getByRole('button', { name: '任务与交付', exact: true })).toHaveCount(0);
  await expect(page.locator('.wf-native-delivery-entry')).toHaveCount(0);
  assert.equal((await view(a)).instanceId, null, 'None keeps the workflow unselected and no obsolete dock contributes UI');
  check('removed-delivery-dock-has-no-entry-or-polling-and-none-does-not-select-a-workflow');

  // A completed old standalone root is delivery history, not a permanent ban on
  // this native conversation. Its retained plugin Agent must hand back the same
  // Session before the inherited project workflow can process new messages.
  const legacyEmployee = (await command('employee.create', { projectId: workspace.workspaceId, templateId: lead.id, name: 'QA-历史技术负责人' })).result;
  const backgroundLegacy = (await post('/digital-workers/api/run', { projectId: workspace.workspaceId, employeeId: legacyEmployee.id, request: 'WF_LEGACY_NAVIGATION_918：后台恢复不能夺回当前对话' })).run;
  await expect.poll(async () => (await state()).runs.find(run => run.id === backgroundLegacy.id)?.status, { timeout: 30000 }).toBe('awaiting-review');
  const backgroundBefore = (await state()).runs.find(run => run.id === backgroundLegacy.id);
  await rpc('session/rename', { sessionId: backgroundBefore.sessionId, title: 'QA-旧对话导航取消' });
  sessions['QA-旧对话导航取消'] = backgroundBefore.sessionId;
  let resumeStarted, allowResume;
  const resumeStart = new Promise(done => { resumeStarted = done; });
  const resumeGate = new Promise(done => { allowResume = done; });
  const commandRoute = '**/digital-workers/api/command';
  const gateFirstWorkflowView = async sessionId => {
    let started, allow, intercepted = false;
    const seen = new Promise(done => { started = done; });
    const gate = new Promise(done => { allow = done; });
    const pattern = '**/digital-workers/api/conversation-workflow?*';
    const handler = async route => {
      const request = route.request();
      if (!intercepted && request.method() === 'GET' && new URL(request.url()).searchParams.get('sessionId') === sessionId) {
        intercepted = true; started(); await gate;
      }
      await route.continue();
    };
    await page.route(pattern, handler);
    return { seen, allow: () => allow(), dispose: () => page.unroute(pattern, handler) };
  };
  const interceptResume = async route => {
    const request = route.request().postDataJSON();
    if (request?.action === 'conversation.workflow.resume' && request.payload?.sessionId === backgroundBefore.sessionId) {
      resumeStarted(); await resumeGate;
    }
    await route.continue();
  };
  await page.route(commandRoute, interceptResume);
  const backgroundResponse = page.waitForResponse(response => response.url().endsWith('/digital-workers/api/command')
    && response.request().postDataJSON()?.action === 'conversation.workflow.resume'
    && response.request().postDataJSON()?.payload?.sessionId === backgroundBefore.sessionId);
  await open('QA-旧对话导航取消'); await resumeStart;
  await open('QA-工作流对话乙');
  allowResume(); assert.equal((await (await backgroundResponse).json()).result.sessionReopened, true);
  await page.unroute(commandRoute, interceptResume);
  await expect(page.locator(`[data-row-key=${JSON.stringify('session:' + b)}]`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-composer-input][contenteditable=true]')).toBeVisible({ timeout: 20000 });
  await expect(picker()).not.toContainText(flow.name); await expect(strip()).toHaveCount(0);
  assert.deepEqual((await state()).runs.find(run => run.id === backgroundLegacy.id), backgroundBefore);
  check('late-retained-session-handoff-preserves-user-navigation-to-another-conversation');
  const legacy = (await post('/digital-workers/api/run', { projectId: workspace.workspaceId, employeeId: legacyEmployee.id, request: 'WF_LEGACY_STANDALONE_918：保留这份旧交付及待验收状态' })).run;
  await expect.poll(async () => (await state()).runs.find(run => run.id === legacy.id)?.status, { timeout: 30000 }).toBe('awaiting-review');
  const legacyBefore = (await state()).runs.find(run => run.id === legacy.id);
  assert.ok(legacyBefore.sessionId && !legacyBefore.parentRunId && !legacyBefore.conversationWorkflow && !legacyBefore.workflow && !legacyBefore.workTaskId);
  await rpc('session/rename', { sessionId: legacyBefore.sessionId, title: 'QA-旧独立交付' });
  sessions['QA-旧独立交付'] = legacyBefore.sessionId;
  const callsBeforeHandoff = (await calls()).length;
  let currentResumeStarted, allowCurrentResume;
  const currentResumeStart = new Promise(done => { currentResumeStarted = done; });
  const currentResumeGate = new Promise(done => { allowCurrentResume = done; });
  let currentResumeResult;
  const interceptCurrentResume = async route => {
    const request = route.request().postDataJSON();
    if (request?.action === 'conversation.workflow.resume' && request.payload?.sessionId === legacyBefore.sessionId) {
      currentResumeStarted(); await currentResumeGate;
      const response = await route.fetch(); currentResumeResult = await response.json();
      await route.fulfill({ response }); return;
    }
    await route.continue();
  };
  await page.route(commandRoute, interceptCurrentResume);
  const currentViewGate = await gateFirstWorkflowView(legacyBefore.sessionId);
  const resumed = page.waitForResponse(response => response.url().endsWith('/digital-workers/api/command') && response.request().postDataJSON()?.action === 'conversation.workflow.resume');
  await open('QA-旧独立交付'); await currentViewGate.seen;
  const unsentDraft = 'WF_UNSENT_DRAFT_918：恢复会话后保留我尚未发送的草稿';
  await page.locator('[data-composer-input][contenteditable=true]').fill(unsentDraft);
  currentViewGate.allow(); await currentResumeStart;
  await expect(page.locator('[data-composer-input]')).toHaveAttribute('contenteditable', 'false');
  await expect(page.locator('[data-composer-input]')).toHaveText(unsentDraft);
  allowCurrentResume();
  const resumedResponse = await resumed;
  assert.ok(resumedResponse.ok()); assert.equal(currentResumeResult.result.sessionReopened, true);
  metrics.currentResume = { time: Date.now(), pageNavigations: metrics.pageNavigations.length };
  await page.unroute(commandRoute, interceptCurrentResume);
  await currentViewGate.dispose();
  await expect(picker()).toContainText('工作流：' + flow.name);
  await expect(page.locator('[data-composer-input][contenteditable=true]')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-composer-input][contenteditable=true]')).toHaveText(unsentDraft);
  await expect(page.locator('.wf-native-dock')).toHaveCount(0);
  assert.equal((await calls()).length, callsBeforeHandoff, 'Retained-Agent handoff must not make a model request');
  assert.equal((await view(legacyBefore.sessionId)).selection, 'inherit');
  assert.ok(!(await state()).conversationWorkflows.selections.some(selection => selection.sessionId === legacyBefore.sessionId), 'GET handoff must not turn an inherited project default into an override');
  assert.deepEqual((await state()).runs.find(run => run.id === legacy.id), legacyBefore, 'The legacy delivery is preserved byte for byte');
  await page.screenshot({ path: resolve(artifacts, 'legacy-conversation-workflow-ready.png') });
  check('stopped-legacy-root-refreshes-same-native-session-with-unsent-draft-and-inherited-selector-no-stale-dock-or-model-call');
  await send('WF_LEGACY_CONTINUE_918：在本对话交给当前步骤负责人');
  const adopted = await waitRun(3, 'owner-product');
  assert.equal(adopted.sessionId, legacyBefore.sessionId);
  assert.equal(adopted.employeeSnapshot.templateId, lead.id);
  await expect(page.locator('.wf-native-delivery-entry')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'任务与交付',exact:true})).toHaveCount(0);
  assert.deepEqual((await state()).runs.find(run => run.id === legacy.id), legacyBefore);
  await page.screenshot({ path: resolve(artifacts, 'legacy-conversation-new-owner-delivery.png') });
  check('ordinary-message-in-legacy-conversation-uses-current-owner-once-and-keeps-old-delivery-unchanged');
  const beforeLegacyNone = await state();
  await pick('无'); await expect(strip()).toHaveCount(0);
  assert.deepEqual((await state()).runs.find(run => run.id === legacy.id), legacyBefore);
  assert.deepEqual((await state()).runs.find(run => run.id === adopted.id), beforeLegacyNone.runs.find(run => run.id === adopted.id));
  await expect(page.locator('.wf-native-delivery-entry')).toHaveCount(0);
  assert.equal((await view(legacyBefore.sessionId)).instanceId, null);
  await pick(flow.name); await page.locator('.wf-conversation-workflow-details-trigger').click();
  await expect(detailsDialog()).toContainText('WF_STEP_REQUIREMENTS_917');
  await expect(detailsDialog().getByRole('button', { name: '验收通过', exact: true })).toBeEnabled();
  await closeDetails(); await pick('无');
  assert.deepEqual((await state()).runs.find(run => run.id === adopted.id), beforeLegacyNone.runs.find(run => run.id === adopted.id), 'top Details retains secure review without automatic acceptance');
  metrics.legacyConversation = { oldRunId: legacy.id, sessionId: legacyBefore.sessionId, newOwnerRunId: adopted.id, oldDeliveryPreserved: true, inheritedWithoutOverride: true, automaticResumeModelCalls: 0, staleLegacyDockHidden: true, reviewViaTopDetails: true };
  check('explicit-none-in-restored-legacy-conversation-keeps-history-and-review-via-top-details');

  const attachmentLegacy = (await post('/digital-workers/api/run', { projectId: workspace.workspaceId, employeeId: legacyEmployee.id, request: 'WF_LEGACY_ATTACHMENT_918：待恢复的会话不能丢弃未发送附件' })).run;
  await expect.poll(async () => (await state()).runs.find(run => run.id === attachmentLegacy.id)?.status, { timeout: 30000 }).toBe('awaiting-review');
  const attachmentBefore = (await state()).runs.find(run => run.id === attachmentLegacy.id);
  await rpc('session/rename', { sessionId: attachmentBefore.sessionId, title: 'QA-旧对话未发送附件' });
  sessions['QA-旧对话未发送附件'] = attachmentBefore.sessionId;
  let attachmentResumeStarted, allowAttachmentResume;
  const attachmentResumeStart = new Promise(done => { attachmentResumeStarted = done; });
  const attachmentResumeGate = new Promise(done => { allowAttachmentResume = done; });
  const interceptAttachmentResume = async route => {
    const request = route.request().postDataJSON();
    if (request?.action === 'conversation.workflow.resume' && request.payload?.sessionId === attachmentBefore.sessionId) {
      attachmentResumeStarted(); await attachmentResumeGate;
    }
    await route.continue();
  };
  await page.route(commandRoute, interceptAttachmentResume);
  const attachmentViewGate = await gateFirstWorkflowView(attachmentBefore.sessionId);
  await open('QA-旧对话未发送附件'); await attachmentViewGate.seen;
  const attachmentDraft = 'WF_ATTACHMENT_DRAFT_918：我尚未发送的文字也必须保留';
  await page.locator('[data-composer-input][contenteditable=true]').fill(attachmentDraft);
  const attachmentName = 'qa-unsent-attachment.txt';
  await page.locator('[data-composer-card] input[type=file]').setInputFiles({ name: attachmentName, mimeType: 'text/plain', buffer: Buffer.from('Unsent local fixture attachment. No model may receive it.') });
  await expect(page.getByText(attachmentName, { exact: true })).toBeVisible();
  const callsBeforeAttachmentHandoff = (await calls()).length;
  let unexpectedReloads = 0;
  const onUnexpectedReload = frame => { if (frame === page.mainFrame()) unexpectedReloads++; };
  page.on('framenavigated', onUnexpectedReload);
  attachmentViewGate.allow(); await attachmentResumeStart;
  await expect(page.locator('[data-composer-input]')).toHaveAttribute('contenteditable', 'false');
  await expect(page.locator('[data-composer-input]')).toHaveText(attachmentDraft);
  await expect(page.getByText(attachmentName, { exact: true })).toBeVisible();
  allowAttachmentResume();
  await expect(picker().getByRole('alert')).toContainText('请先移除未发送附件');
  await page.unroute(commandRoute, interceptAttachmentResume);
  await attachmentViewGate.dispose();
  await expect(page.getByText(attachmentName, { exact: true })).toBeVisible();
  await picker().getByRole('button', { name: '刷新继续', exact: true }).click();
  await expect(picker().getByRole('alert')).toContainText('请先移除未发送附件');
  assert.equal(unexpectedReloads, 0); page.off('framenavigated', onUnexpectedReload);
  await page.screenshot({ path: resolve(artifacts, 'legacy-unsent-attachment-preserved.png') });
  await page.getByRole('button', { name: new RegExp('(移除|删除|Remove).*' + attachmentName.replaceAll('.', '\\.')) }).click();
  await expect(page.getByText(attachmentName, { exact: true })).toHaveCount(0);
  await picker().getByRole('button', { name: '刷新继续', exact: true }).click();
  await expect(page.locator('[data-composer-input][contenteditable=true]')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-composer-input][contenteditable=true]')).toHaveText(attachmentDraft);
  assert.equal((await calls()).length, callsBeforeAttachmentHandoff);
  assert.deepEqual((await state()).runs.find(run => run.id === attachmentLegacy.id), attachmentBefore);
  metrics.attachmentRecovery = { unsentAttachmentPreserved: true, unsafeRefreshBlocked: true, explicitSafeRetry: true, draftRestored: true, modelCalls: 0 };
  check('retained-handoff-with-unsent-attachment-blocks-refresh-until-user-removes-it-and-safely-retries');
  assert.deepEqual(errors, []); assert.equal(await hostHash(), hostBefore);
  const final = await state(); assert.equal(final.conversationWorkflows.instances.length, 3); assert.equal(final.runs.filter(run => run.conversationWorkflow && !run.parentRunId).length, 3);
  metrics.native = { sessionId: a, alternateSessionId: b, workflowId: flow.id, instanceId: selected.instanceId, runs: final.runs.filter(run => run.conversationWorkflow).map(run => ({ id: run.id, sessionId: run.sessionId, stepId: run.conversationWorkflow.stepId, status: run.status })) };
  metrics.modelCalls = (await calls()).map(request => ({ provider: request.provider, model: request.model, workflowContext: JSON.stringify(request).includes('WF_STEP_') }));
  await stop(); check('official-host-program-unchanged-and-isolated-process-stopped');
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify({ status: 'passed', checks, checkCount: checks.length, metrics, pageErrors: errors }, null, 2));
  console.log(`PASS ${checks.length} native conversation workflow checks`);
  })();
} catch (error) {
  if (page) await writeFile(resolve(artifacts, 'failure-composer.json'), JSON.stringify(await page.locator('[data-composer-card]').evaluateAll(cards => cards.map(card => ({ html: card.outerHTML, inputs: [...card.querySelectorAll('[contenteditable]')].map(input => ({ tag: input.tagName, editable: input.getAttribute('contenteditable'), disabled: input.getAttribute('aria-disabled'), text: input.textContent })) }))), null, 2)).catch(() => {});
  if (page) await page.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {});
  if (page) await writeFile(resolve(artifacts, 'failure-page.txt'), redactWebAuth(await page.locator('body').innerText())).catch(() => {});
  await writeFile(resolve(artifacts, 'failure-report.json'), JSON.stringify({ checks, metrics, errors }, null, 2)).catch(() => {});
  console.error(redactWebAuth(error?.stack || String(error))); console.error(redactWebAuth(log.slice(-12000))); process.exitCode = 1;
} finally { await closeFixtureBrowser({ page, browser, browserServer }); await stop(); await rm(temp, { recursive: true, force: true }); }
