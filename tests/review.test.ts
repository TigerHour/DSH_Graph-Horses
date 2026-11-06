import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { WorkforceStore } from '../src/domain/store.js';
import { ARCHITECT_TEMPLATE_ID } from '../src/domain/seed.js';
import { WorkforceRuntime } from '../src/harness/runtime.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function answer(value: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } }, { type: 'finish', reason: { kind: 'stop' } }];
}
function delegate(employeeId: string): StreamChunk[] {
  const id = ToolCallId(`review-${employeeId}`); const argumentsText = JSON.stringify({ employeeId, request: 'CHILD_TASK' });
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id, name: 'worker_delegate', argumentsDelta: argumentsText }, { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'worker_delegate', arguments: argumentsText } }, { type: 'finish', reason: { kind: 'tool-calls' } }];
}
class ReviewAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(private readonly respond: (request: GenerateOptions) => Promise<StreamChunk[]> | StreamChunk[]) { super(); }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request); for (const chunk of await this.respond(request)) yield chunk;
  }
}
async function fixture(t: { after: (cleanup: () => Promise<void>) => void }, adapter: ReviewAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'workforce-review-')); const store = await WorkforceStore.open(join(root, 'state.json'));
  const project = await store.saveProject({ id: 'review-project', name: '审查项目', rootPath: root });
  let employee = await store.createEmployee({ projectId: project.id, templateId: ARCHITECT_TEMPLATE_ID });
  const modules = structuredClone(employee.modules); modules.model = { mode: 'override', provider: 'review', model: 'review' }; modules.capabilities.skills = []; modules.collaboration.allowedTemplateIds = [ARCHITECT_TEMPLATE_ID];
  employee = await store.updateEmployee(employee.id, { modules });
  const ctx = new Context();
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, NativeToolExecutor, AgentRegistry]) await ctx.plugin(plugin);
  await ctx.plugin(AgentLoop, { agents: [] }); ctx.llm.registerAdapter(['review'], adapter);
  ctx.provide('workspaceRegistry', { get: () => ({ sessionIds: [], attachSession: async () => undefined }) } as never);
  const runtime = new WorkforceRuntime(ctx, store, new Map(), { maxRunMs: 1000 });
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  return { store, project, employee, runtime };
}

test('queued employee runs respect memory permission revoked after their configuration snapshot', async t => {
  const started = deferred(); const release = deferred();
  const adapter = new ReviewAdapter(async request => {
    if (JSON.stringify(request).includes('FIRST_TASK')) { started.resolve(); await release.promise; }
    return answer('已处理本次任务');
  });
  const f = await fixture(t, adapter);
  await f.store.saveMemory({ projectId: f.project.id, scope: 'project', title: '项目保密事实', content: 'REVOKED_MEMORY_SENTINEL', source: { kind: 'user-confirmed', reference: '测试用户确认' } });
  const first = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: 'FIRST_TASK' });
  await started.promise;
  const second = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: 'SECOND_TASK' });
  const modules = structuredClone(f.employee.modules); modules.knowledge.projectMemory = false;
  await f.store.updateEmployee(f.employee.id, { modules }); release.resolve();
  await f.runtime.wait(first.id); const result = await f.runtime.wait(second.id);
  assert.equal(result.status, 'awaiting-review', result.error);
  const firstRequest = adapter.requests.find(request => JSON.stringify(request).includes('FIRST_TASK'));
  const secondRequest = adapter.requests.find(request => JSON.stringify(request).includes('SECOND_TASK'));
  assert.match(JSON.stringify(firstRequest), /REVOKED_MEMORY_SENTINEL/);
  assert.ok(secondRequest, '第二个任务应正常开始');
  assert.doesNotMatch(JSON.stringify(secondRequest), /REVOKED_MEMORY_SENTINEL/);
});

test('simultaneously busy employees cannot form a cross-task synchronous delegation wait cycle', async t => {
  const bothStarted = deferred(); let started = 0;
  let employeeA = ''; let employeeB = ''; const turns = new Map<string, number>();
  const adapter = new ReviewAdapter(async request => {
    const serialized = JSON.stringify(request); const root = serialized.includes('ROOT_A') ? 'a' : serialized.includes('ROOT_B') ? 'b' : undefined;
    if (!root) return answer('已完成子任务');
    const turn = turns.get(root) ?? 0; turns.set(root, turn + 1);
    if (turn > 0) return answer('协作者忙碌，本员工自行完成');
    if (++started === 2) bothStarted.resolve(); await bothStarted.promise;
    return delegate(root === 'a' ? employeeB : employeeA);
  });
  const f = await fixture(t, adapter); employeeA = f.employee.id;
  let other = await f.store.createEmployee({ projectId: f.project.id, templateId: ARCHITECT_TEMPLATE_ID });
  other = await f.store.updateEmployee(other.id, { modules: f.employee.modules }); employeeB = other.id;
  const first = await f.runtime.start({ projectId: f.project.id, employeeId: employeeA, request: 'ROOT_A' });
  const second = await f.runtime.start({ projectId: f.project.id, employeeId: employeeB, request: 'ROOT_B' });
  const result = await Promise.all([f.runtime.wait(first.id), f.runtime.wait(second.id)]);
  assert.ok(result.every(run => run.status === 'awaiting-review'), JSON.stringify(result.map(run => ({ status: run.status, error: run.error }))));
  assert.equal(f.store.snapshot().runs.length, 2, '忙碌的委派目标应直接拒绝，不能创建相互等待的排队子任务');
});

test('manager prompt exposes stable IDs only for project employees it may delegate to', async t => {
  const adapter = new ReviewAdapter(() => answer('已读取可协作员工列表'));
  const f = await fixture(t, adapter);
  const allowed = await f.store.createEmployee({ projectId: f.project.id, templateId: ARCHITECT_TEMPLATE_ID, name: '可委派架构同事' });
  const forbiddenTemplate = await f.store.saveTemplate({ name: '未授权岗位', status: 'ready', modules: f.employee.modules });
  const forbidden = await f.store.createEmployee({ projectId: f.project.id, templateId: forbiddenTemplate.id, name: '不可委派员工' });
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '安排已授权同事协助分析' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'awaiting-review', result.error);
  const prompt = JSON.stringify(adapter.requests[0]);
  assert.ok(prompt.includes(allowed.id), '委派工具需要的项目员工 ID 必须可由模型发现');
  assert.ok(prompt.includes(allowed.name));
  assert.ok(!prompt.includes(forbidden.id), '不注入未获委派授权的员工名册');
});
