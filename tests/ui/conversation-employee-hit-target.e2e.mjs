/** Coordinate-only hit-target diagnostics against an isolated official Harness profile. */
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
const artifacts = resolve(process.env.WORKFORCE_HIT_UI_ARTIFACTS || resolve(root, 'artifacts/employee-hit-target'));
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
  const chatPath = resolve(temp, 'Chat'); await mkdir(chatPath); const workspace = (await rpc('workspace/create', { path: chatPath })).workspace;
  const sessionId = (await rpc('session/create', { workspaceId: workspace.workspaceId })).sessionId;
  const view = () => get('/digital-workers/api/conversation-employee?sessionId=' + encodeURIComponent(sessionId));
  await rpc('session/prompt', { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'HIT_TARGET_BASELINE' }] });
  await expect.poll(async () => (await readFile(callsPath, 'utf8').catch(() => '')).includes('HIT_TARGET_BASELINE')).toBe(true);
  await rpc('session/rename', { sessionId, title: 'QA-员工命中区域' });
  browserServer = await chromium.launchServer({ headless: true, host: '127.0.0.1', ...(process.env.WORKFORCE_BROWSER_CHANNEL === 'bundled' ? {} : { channel: process.env.WORKFORCE_BROWSER_CHANNEL || 'chrome' }) });
  browser = await chromium.connect(browserServer.wsEndpoint());
  const matrix = [], geometries = [], failures = [];
  for (const scale of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, deviceScaleFactor: scale, colorScheme: 'dark', locale: 'zh-CN' });
    page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    const split = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base, httpOnly: true, sameSite: 'Strict' }]);
    await page.goto(base, { waitUntil: 'domcontentloaded' }); const welcome = page.getByRole('button', { name: '继续', exact: true }); if (await welcome.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)) await welcome.click();
    const later = page.getByRole('button', { name: '稍后配置', exact: true }); if (await later.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) await later.click();
    const folder = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'Chat' }).first(); if (await folder.getAttribute('aria-expanded') !== 'true') await folder.click();
    await page.locator(`[data-row-key=${JSON.stringify('session:' + sessionId)}]`).click();
    const trigger = page.locator('.wf-conversation-employee-trigger'), menu = page.locator('.wf-conversation-employee-menu'); await expect(trigger).toBeVisible();
    await page.evaluate(() => {
      window.__employeeHitTrace = [];
      const describe = node => node instanceof Element ? { tag: node.tagName, cls: String(node.className), role: node.getAttribute('role'), text: node.closest('[role="option"]')?.textContent?.trim() || node.textContent?.trim().slice(0, 60) } : undefined;
      for (const type of ['pointerdown','mousedown','focusout','blur','mouseup','click']) document.addEventListener(type, event => { if (event.target instanceof Element && (event.target.closest('.wf-conversation-employee,.wf-conversation-employee-seat,.wf-conversation-employee-trigger,.wf-conversation-employee-popup') || event.type === 'focusout')) window.__employeeHitTrace.push({ type, target: describe(event.target), related: describe(event.relatedTarget), x: event.clientX, y: event.clientY }); }, true);
    });
    const at = async (x, y) => page.evaluate(({ x, y }) => {
      const node = document.elementFromPoint(x, y), trigger = document.querySelector('.wf-conversation-employee-trigger');
      return { x, y, tag: node?.tagName, cls: node?.getAttribute('class'), text: node?.closest('[role="option"]')?.textContent?.trim(), isTrigger: !!node && !!trigger?.contains(node), isOption: !!node?.closest('[role="option"]') };
    }, { x, y });
    const trace = () => page.evaluate(() => { const result = window.__employeeHitTrace; window.__employeeHitTrace = []; return result; });
    const afterPaint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const close = async () => { if (await menu.count()) { await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); } };
    const triggerPoint = async kind => {
      const box = await trigger.boundingBox(), text = await trigger.locator('span').boundingBox(), arrow = await trigger.locator('svg').boundingBox();
      const points = { text: [text.x + text.width / 2, text.y + text.height / 2], arrow: [arrow.x + arrow.width / 2, arrow.y + arrow.height / 2], left: [box.x + 2, box.y + box.height / 2], right: [box.x + box.width - 2, box.y + box.height / 2], top: [box.x + box.width / 2, box.y + 2], bottom: [box.x + box.width / 2, box.y + box.height - 2] };
      return points[kind];
    };
    const open = async () => { if (!await menu.count()) { const [x, y] = await triggerPoint('text'); await page.mouse.click(x, y); await expect(menu).toBeVisible({ timeout: 2000 }); } };
    for (const viewport of [{ width: 1512, height: 1050 }, { width: 1024, height: 768 }, { width: 768, height: 600 }, { width: 1512, height: 240 }]) {
      await close(); await page.setViewportSize(viewport); await afterPaint();
      const geometry = await trigger.evaluate(node => {
        const rect = element => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
        const ancestors = []; for (let current = node; current; current = current.parentElement) { const css = getComputedStyle(current); ancestors.push({ tag: current.tagName, cls: String(current.className).slice(0, 120), rect: rect(current), appRegion: css.getPropertyValue('-webkit-app-region'), pointerEvents: css.pointerEvents, zIndex: css.zIndex, containerType: css.containerType, overflowX: css.overflowX, overflowY: css.overflowY }); if (current.tagName === 'HEADER') break; }
        const seat = document.querySelector('.wf-conversation-employee-seat'), header = seat?.closest('header') ?? node.closest('header');
        const own = rect(node), overlaps = [...header.querySelectorAll('button,[role="tab"]')].filter(other => !other.closest('.wf-conversation-employee,.wf-conversation-employee-seat')).map(other => ({ text: other.textContent?.trim(), rect: rect(other) })).filter(other => other.rect.width > 0 && other.rect.height > 0 && other.rect.x < own.x + own.width && other.rect.x + other.rect.width > own.x && other.rect.y < own.y + own.height && other.rect.y + other.rect.height > own.y);
        return { platform: document.documentElement.dataset.platform, aligned: node.closest('.wf-conversation-employee')?.dataset.contactAligned, ancestors, seatRect: seat ? rect(seat) : undefined, headerRect: rect(header), triggerOutsideHeader: !node.closest('header'), nativeControlOverlaps: overlaps };
      }); geometries.push({ scale, viewport, ...geometry });
      for (const kind of ['text','arrow','left','right','top','bottom']) {
        await close(); const [x, y] = await triggerPoint(kind), before = await at(x, y); await page.mouse.move(x, y); await afterPaint(); const moved = await at(x, y); await trace(); await page.mouse.click(x, y); await afterPaint();
        const opened = await menu.isVisible().catch(() => false), events = await trace(); const result = { scale, viewport, type: 'trigger', kind, before, moved, opened, events }; matrix.push(result); if (!opened || !before.isTrigger || !moved.isTrigger) failures.push(result);
      }
      await close();
      await open();
      const portalContract = await menu.evaluate(node => {
        const popup = node.closest('.wf-conversation-employee-popup'), trigger = document.querySelector('.wf-conversation-employee-trigger'), triggerContainer = trigger.closest('.wf-conversation-employee'), seat = document.querySelector('.wf-conversation-employee-seat');
        return { seatInHeader: !!seat?.closest('header'), triggerOutsideHeader: !trigger.closest('header'), popupOutsideHeader: !popup.closest('header'), triggerPosition: getComputedStyle(triggerContainer).position, triggerContainerHeight: triggerContainer.getBoundingClientRect().height, popupPosition: getComputedStyle(popup).position, triggerRegion: getComputedStyle(triggerContainer).getPropertyValue('-webkit-app-region'), popupRegion: getComputedStyle(popup).getPropertyValue('-webkit-app-region'), headerBottom: seat?.closest('header').getBoundingClientRect().bottom, popupTop: popup.getBoundingClientRect().top };
      });
      const portalResult = { scale, viewport, type: 'portal', ...portalContract }; matrix.push(portalResult);
      if (!portalContract.seatInHeader || !portalContract.triggerOutsideHeader || !portalContract.popupOutsideHeader || portalContract.triggerPosition !== 'fixed' || portalContract.triggerContainerHeight !== 24 || portalContract.popupPosition !== 'fixed' || portalContract.triggerRegion !== 'no-drag' || portalContract.popupRegion !== 'no-drag' || portalContract.popupTop < portalContract.headerBottom + 3.5) failures.push(portalResult);
      await close();
      // Choose three default rows across their text, centre and inset edges.
      for (const name of ['技术负责人（架构师）','产品负责人','运维负责人']) {
        for (const kind of ['text','left','right','top','bottom']) {
          await open(); const option = menu.getByRole('option', { name, exact: true });
          if (!await option.count()) { await close(); continue; }
          // Scroll with a real wheel over the list, never locator.scrollIntoViewIfNeeded.
          const listBox = await menu.locator('[role="listbox"]').boundingBox(); await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + Math.min(listBox.height - 3, 24));
          if (name === '运维负责人') await page.mouse.wheel(0, 500); else await page.mouse.wheel(0, -500); await afterPaint();
          const box = await option.boundingBox(), text = await option.locator('span').boundingBox();
          const visibleTop = Math.max(box.y, listBox.y), visibleBottom = Math.min(box.y + box.height, listBox.y + listBox.height);
          if (visibleBottom - visibleTop < 4) { await close(); continue; }
          const point = kind === 'text' ? [text.x + Math.min(30, text.width / 2), (visibleTop + visibleBottom) / 2] : kind === 'left' ? [box.x + 2, (visibleTop + visibleBottom) / 2] : kind === 'right' ? [box.x + box.width - 2, (visibleTop + visibleBottom) / 2] : [box.x + Math.min(box.width / 2, 80), kind === 'top' ? visibleTop + 2 : visibleBottom - 2];
          const [x, y] = point, before = await at(x, y); await page.mouse.move(x, y); await afterPaint(); const moved = await at(x, y); await trace(); await page.mouse.click(x, y);
          await expect.poll(async () => (await view()).employee?.name ?? '', { timeout: 2000 }).toBe(name).catch(() => {});
          const actual = (await view()).employee?.name ?? '', closed = await menu.count() === 0, events = await trace();
          const result = { scale, viewport, type: 'row', name, kind, point, before, moved, actual, closed, events }; matrix.push(result); if (actual !== name || !closed || before.text !== name || moved.text !== name) failures.push(result);
          await close();
          // Reset through the same coordinate path so every row choice changes state.
          await open(); const resetList = await menu.locator('[role="listbox"]').boundingBox(); await page.mouse.move(resetList.x + 8, resetList.y + 8); await page.mouse.wheel(0, -1000); await afterPaint(); const none = await menu.getByRole('option', { name: '无', exact: true }).boundingBox(); await page.mouse.move(none.x + 12, none.y + none.height / 2); await page.mouse.click(none.x + 12, none.y + none.height / 2); await expect.poll(async () => (await view()).conversationEmployee, { timeout: 3000 }).toBe(null).catch(() => {}); await close();
        }
      }
      await open();
      const hoverBefore = await menu.locator('[role="listbox"]').evaluate(list => {
        const bounds = list.getBoundingClientRect();
        const option = [...list.querySelectorAll('[role="option"]')].find(option => { const box = option.getBoundingClientRect(); return box.top < bounds.bottom - 2 && box.bottom > bounds.bottom + 1; });
        if (!option || list.scrollHeight <= list.clientHeight) return undefined;
        return { x: bounds.left + 20, y: bounds.bottom - 3, name: option.textContent.trim(), top: option.getBoundingClientRect().top, listTop: list.scrollTop, documentTop: document.documentElement.scrollTop, menuTop: list.closest('.wf-conversation-employee-popup').getBoundingClientRect().top };
      });
      if (hoverBefore) {
        await page.mouse.move(hoverBefore.x, hoverBefore.y); await afterPaint();
        const hoverAfter = await menu.locator('[role="listbox"]').evaluate(list => ({ listTop: list.scrollTop, documentTop: document.documentElement.scrollTop, menuTop: list.closest('.wf-conversation-employee-popup').getBoundingClientRect().top }));
        const hoverResult = { scale, viewport, type: 'partial-row-hover', before: hoverBefore, after: hoverAfter }; matrix.push(hoverResult);
        if (Math.abs(hoverAfter.listTop - hoverBefore.listTop) > .5 || hoverAfter.documentTop !== hoverBefore.documentTop || Math.abs(hoverAfter.menuTop - hoverBefore.menuTop) > .5) failures.push(hoverResult);
        await page.keyboard.press('End'); await afterPaint();
        const keyboardAfter = await menu.locator('[role="listbox"]').evaluate(list => ({ listTop: list.scrollTop, documentTop: document.documentElement.scrollTop, activeId: list.getAttribute('aria-activedescendant'), lastId: list.querySelector('[role="option"]:last-child')?.id }));
        const keyboardResult = { scale, viewport, type: 'keyboard-local-scroll', before: hoverAfter, after: keyboardAfter }; matrix.push(keyboardResult);
        if (keyboardAfter.listTop <= 0 || keyboardAfter.activeId !== keyboardAfter.lastId || keyboardAfter.documentTop !== hoverAfter.documentTop) failures.push(keyboardResult);
      }
      await close();
      await open(); await page.screenshot({ path: resolve(artifacts, `scale-${scale}-${viewport.width}x${viewport.height}.png`) }); await close();
    }
    await context.close();
  }
  assert.equal(await hostHash(), hostBefore);
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify({ status: failures.length ? 'reproduced' : 'passed', sdk, archive: archive ? sha(await readFile(archive)) : undefined, hostUnchanged: true, pageErrors, geometries, matrix, failures, count: matrix.length, externalModelCalls: 0 }, null, 2));
  console.log(`HIT_TARGET ${matrix.length} coordinate cases; ${failures.length} mismatches`);
  assert.equal(failures.length, 0, `${failures.length} coordinate/portal/scroll failures; see ${resolve(artifacts, 'report.json')}`);
} catch (error) {
  await mkdir(artifacts, { recursive: true }); await page?.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {}); await writeFile(resolve(artifacts, 'failure-report.json'), JSON.stringify({ error: String(error), hostLog: redactWebAuth(log).slice(-6000), pageErrors }, null, 2)); throw error;
 } finally {
  if (child?.exitCode === null) { child.kill('SIGTERM'); for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) await delay(100); if (child.exitCode === null) child.kill('SIGKILL'); }
  await closeFixtureBrowser({ page, browser, browserServer });
  await rm(temp, { recursive: true, force: true });
}
