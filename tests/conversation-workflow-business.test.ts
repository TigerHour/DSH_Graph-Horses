import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { installModelSelection, type AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import FileSystem from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import { WorkforceStore } from '../src/domain/store.js';
import { captureWorkflowTeam } from '../src/domain/workflow-team.js';
import { resolveConversationWorkflow } from '../src/domain/conversation-workflow.js';
import { registerConversationWorkflowRuntime } from '../src/harness/conversation-workflow-runtime.js';
import { WorkforceRuntime, type KnowledgeRuntime, type RuntimeConfig } from '../src/harness/runtime.js';

const text = (value: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } }, { type: 'finish', reason: { kind: 'stop' } },
];
const call = (name: string, args: object): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: ToolCallId(`call-${name}`), name, argumentsDelta: JSON.stringify(args) },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`call-${name}`), name, arguments: JSON.stringify(args) } },
  { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } }, { type: 'finish', reason: { kind: 'tool-calls' } },
];
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(private readonly scripts: Array<(request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>>) { super(); }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request); const script = this.scripts.shift();
    if (!script) throw new Error('fixture script exhausted');
    for (const chunk of await script(request)) yield chunk;
  }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: { after(fn: () => Promise<void>): void }, scripts: ConstructorParameters<typeof ScriptedAdapter>[0], config: Partial<RuntimeConfig> = {}, knowledge?: KnowledgeRuntime) {
  const root = await mkdtemp(join(tmpdir(), 'native-workflow-business-'));
  await writeFile(join(root, 'README.md'), '# Real project material');
  const store = await WorkforceStore.open(join(root, 'state.json'));
  const project = await store.saveProject({ name: 'Native workflow fixture', rootPath: root });
  const original = store.snapshot().templates[0]!;
  const templates = [];
  for (const name of ['product', 'architect', 'developer', 'tester']) {
    const modules = structuredClone(original.modules);
    modules.model = { mode: 'override', provider: 'fixture', model: name };
    modules.capabilities.skills = name === 'architect' ? [{ id: 'fixture-required', name: 'Required role method', description: 'Testable required skill', usage: 'required' }] : [];
    templates.push(await store.saveTemplate({ name, modules, status: 'ready' }));
  }
  const team = await store.saveTeam({ name: 'Software team', members: [
    { memberId: 'product', templateId: templates[0]!.id }, { memberId: 'architect', templateId: templates[1]!.id, reportsTo: 'product' },
    { memberId: 'developer', templateId: templates[2]!.id, reportsTo: 'architect' }, { memberId: 'tester', templateId: templates[3]!.id, reportsTo: 'product' },
  ] });
  const workflow = await store.saveWorkflowTemplate({ name: 'Software delivery', team: captureWorkflowTeam(team, store.snapshot().templates),
    roles: team.members.map(member => ({ id: member.memberId, name: member.memberId, memberId: member.memberId })), steps: [
      { id: 'requirements', name: 'Requirements', roleId: 'product', instruction: 'Clarify product intent', outputs: ['Requirement baseline'], acceptanceCriteria: ['Scope confirmed'] },
      { id: 'architecture', name: 'Architecture', roleId: 'architect', instruction: 'STEP_INSTRUCTION_SENTINEL', outputs: ['STEP_DELIVERY_SENTINEL'], acceptanceCriteria: ['STEP_ACCEPTANCE_SENTINEL'] },
      { id: 'test', name: 'Testing', roleId: 'tester', instruction: 'Test changes', outputs: ['Test report'], acceptanceCriteria: ['Critical checks pass'] },
  ] });
  const ctx = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(NativeToolExecutor); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(FileSystem); await ctx.plugin(WorkingDirectory); await ctx.plugin(FileTools);
  const adapter = new ScriptedAdapter(scripts); ctx.llm.registerAdapter(['fixture'], adapter);
  ctx.systemPrompt.section({ name: 'native-identity', order: 0, text: 'NATIVE_COMPLETE_SYSTEM', complete: true });
  const attached: string[] = [];
  const workspace = { path: root, sessionIds: attached, attachSession: async (sessionId: string) => { attached.push(sessionId); } };
  ctx.provide('workspaceRegistry', { get: (id: string) => id === project.id ? workspace : undefined } as never);
  const runtime = new WorkforceRuntime(ctx, store, new Map([['fixture-required', { id: 'fixture-required', name: 'Required role method', description: 'Required skill', path: '/fixture/SKILL.md', content: 'ROLE_SKILL_SENTINEL' }]]), config, knowledge);
  const nativeHandles: AgentHandle[] = [];
  const createNative = async () => {
    const handle = await ctx.agents.create({ sessionId: SessionId(`native-conversation-${Math.random()}`), meta: { cwd: root },
      agentOptions: { provider: 'fixture', model: 'native-default' },
      setup: agentCtx => { installModelSelection(agentCtx); },
    }); nativeHandles.push(handle); attached.push(handle.agent.id); return handle.agent;
  };
  const native = await createNative();
  await store.selectConversationWorkflow({ projectId: project.id, sessionId: native.id, workflowTemplateId: workflow.id, workflowTemplateVersion: workflow.version,
    templateVersions: Object.fromEntries(store.snapshot().templates.map(template => [template.id, template.version])) }, { expectedRevision: store.snapshot().revision });
  const initial = resolveConversationWorkflow(store.snapshot(), project.id, native.id);
  await store.selectConversationWorkflowStep({ projectId: project.id, sessionId: native.id, stepId: 'architecture', instanceVersion: initial.instanceVersion! }, { expectedRevision: store.snapshot().revision });
  const errors: unknown[] = [];
  const dispose = registerConversationWorkflowRuntime(ctx, {
    tools: runtime.conversationToolDefinitions(),
    selectModel: agent => {
      const view = resolveConversationWorkflow(store.snapshot(), project.id, agent.id);
      if (!view.instanceId || !view.owner) return undefined;
      const configured = view.owner.modules.model;
      return { model: { provider: configured.provider!, model: configured.model! } };
    },
    isDeliverySession: sessionId => runtime.ownsSession(sessionId) || store.snapshot().runs.some(run => run.sessionId === sessionId && (run.parentRunId || !run.conversationWorkflow)),
    prepare: async (agent, key, request, signal, context) => {
      const view = resolveConversationWorkflow(store.snapshot(), project.id, agent.id);
      if (!view.instanceId) return undefined;
      return runtime.openConversationTurn(agent, key, request, view, signal, context?.modelSelection);
    }, onError: error => errors.push(error),
  });
  const view = () => resolveConversationWorkflow(store.snapshot(), project.id, native.id);
  const employee = (name: string) => store.snapshot().employees.find(employee => employee.templateId === templates.find(template => template.name === name)!.id)!;
  const rootRun = () => store.snapshot().runs.filter(run => run.sessionId === native.id && !run.parentRunId).at(-1)!;
  const send = async (request: string) => {
    native.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: request }] }));
    await native.whenIdle();
    const run = rootRun(); if (run) await runtime.wait(run.id);
  };
  t.after(async () => { await dispose(); await runtime.dispose(); await Promise.all(nativeHandles.map(handle => handle.dispose())); await rm(root, { recursive: true, force: true }); });
  return { root, store, project, ctx, adapter, runtime, native, send, view, employee, rootRun, createNative, attached, errors, dispose, workspace };
}

test('a stale inherited Chat workflow cannot reserve an owner or reach a model even when a caller bypasses host routing', async t => {
  const f = await fixture(t, [() => text('must not execute a Chat workflow')]);
  f.workspace.path = join(f.root, 'Chat');
  const before = f.store.snapshot();
  await f.send('ordinary Chat text must not run the inherited workflow');
  assert.equal(f.adapter.requests.length, 0);
  assert.deepEqual(f.store.snapshot(), before);
  assert.match(JSON.stringify(f.native.session.snapshotEvents()), /Chat 工作区不提供工作流服务/);
});

test('ordinary native turns load the owner model, step, skill and C knowledge while retaining one native conversation', async t => {
  let prepared = 0;
  const knowledge: KnowledgeRuntime = {
    spacesForEmployee: () => [{ kind: 'project', projectId: 'fixture', teamId: 'team' }],
    prepareFor: async () => { prepared++; }, overviewFor: async () => 'C_KNOWLEDGE_SENTINEL',
    overviewDocumentsFor: async () => [{ layer: 'C', id: 'concept', library: 'team', version: 1, title: 'Concept', content: 'C_KNOWLEDGE_SENTINEL', entryIds: ['detail'] }],
    readFor: async () => ({ id: 'detail', version: 1, content: 'B_BODY_NOT_EAGERLY_INCLUDED' }), searchFor: async () => [], ingestFor: async () => undefined,
  };
  const f = await fixture(t, [request => {
    assert.equal(request.model, 'architect');
    const content = JSON.stringify(request);
    for (const value of ['NATIVE_COMPLETE_SYSTEM', 'STEP_INSTRUCTION_SENTINEL', 'STEP_DELIVERY_SENTINEL', 'STEP_ACCEPTANCE_SENTINEL', 'ROLE_SKILL_SENTINEL', 'C_KNOWLEDGE_SENTINEL']) assert.match(content, new RegExp(value));
    assert.doesNotMatch(content, /B_BODY_NOT_EAGERLY_INCLUDED/);
    return text('first owner answer');
  }, request => { assert.match(JSON.stringify(request), /first owner answer/); return text('second owner answer'); }], {}, knowledge);
  const nativeId = f.native.id;
  await f.send('ordinary question without any @');
  const first = f.rootRun();
  assert.equal(first.status, 'awaiting-review', first.error); assert.equal(first.sessionId, nativeId);
  assert.deepEqual(first.conversationWorkflow, { instanceId: f.view().instanceId, stepId: 'architecture' });
  assert.equal(f.ctx.agents.list().length, 1); assert.equal(f.runtime.ownsSession(nativeId), false);
  await f.send('follow up on this same topic');
  const second = f.rootRun();
  assert.equal(second.status, 'awaiting-review', second.error);
  assert.equal(second.output, 'second owner answer'); assert.deepEqual(second.usage, { inputTokens: 30, outputTokens: 10, modelCalls: 1, reportedCalls: 1 });
  assert.equal(f.view().currentStepId, 'architecture', 'answers do not automatically pass human acceptance');
  assert.equal(prepared, 2); assert.equal(f.adapter.requests.length, 2);
  assert.equal((f.runtime as unknown as { conversationLeases: Map<string, unknown> }).conversationLeases.size, 0, 'completed leases release their native Agent and knowledge closures');
  const start = f.native.session.snapshotEvents().findLast(event => event.type === 'turn/start')!;
  await assert.rejects(f.runtime.openConversationTurn(f.native, `${nativeId}:${start.seq}`, 'replayed turn', f.view()), /已经结束/);
  assert.equal(f.store.snapshot().runs.length, 2);
});

test('planning saves real WorkService draft tasks and delivery saves reviewable content without automatic execution', async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, [
    () => call('worker_plan_task', { title: 'Implement API', description: 'Implement the agreed endpoint', employeeId: f.employee('developer').id,
      deliverables: ['API implementation'], acceptanceCriteria: ['Endpoint behavior passes'], inputs: ['Approved interface'] }),
    request => { assert.match(JSON.stringify(request), /draft/); return call('worker_deliver', { title: 'Architecture design', content: 'Documented architecture decision and validation.' }); },
    () => text('Plan and design submitted'),
  ]);
  let exposedReadyPlan = false;
  const unsubscribe = f.store.subscribe(() => { if (f.store.snapshot().workState?.tasks.some(task => task.status === 'ready')) exposedReadyPlan = true; });
  try {
    await f.send('plan implementation and produce the design');
    const tasks = f.store.snapshot().workState!.tasks;
    assert.equal(tasks.length, 1); assert.equal(tasks[0]!.status, 'draft'); assert.equal(tasks[0]!.employeeId, f.employee('developer').id);
    assert.equal(tasks[0]!.sourceWorkflow?.stepId, 'architecture'); assert.equal(tasks[0]!.attemptRunIds.length, 0);
    assert.equal(exposedReadyPlan, false);
    assert.ok(f.rootRun().artifacts.some(artifact => artifact.title === 'Architecture design' && artifact.content?.includes('architecture decision')));
    assert.equal(f.rootRun().status, 'awaiting-review', f.rootRun().error); assert.equal(f.store.snapshot().runs.length, 1);
  } finally { unsubscribe(); }
});

test('only descendant delegation executes a child and returns its result without private employee configuration', async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, [
    () => call('worker_delegate', { employeeId: f.employee('tester').id, request: 'Unrelated branch must not activate' }),
    request => { assert.match(JSON.stringify(request), /员工不在当前协作名册/); return call('worker_delegate', { employeeId: f.employee('developer').id, request: 'Implement the agreed API only' }); },
    request => { assert.equal(request.model, 'developer'); return text('Child implementation delivered'); },
    request => {
      const result = request.messages.filter(message => message.role === 'tool').at(-1)!;
      assert.match(JSON.stringify(result), /Child implementation delivered/);
      assert.doesNotMatch(JSON.stringify(result), /employeeSnapshot|responsibilities|allowedTemplateIds/);
      return text('Owner consolidated the implementation');
    },
  ]);
  await f.send('Please coordinate implementation');
  const runs = f.store.snapshot().runs;
  assert.equal(runs.length, 2); assert.equal(runs[1]!.employeeId, f.employee('developer').id);
  assert.equal(runs[1]!.parentRunId, runs[0]!.id); assert.deepEqual(runs[1]!.conversationWorkflow, runs[0]!.conversationWorkflow);
  assert.equal(runs[0]!.sessionId, f.native.id); assert.notEqual(runs[1]!.sessionId, f.native.id);
  assert.equal(runs[0]!.status, 'awaiting-review', JSON.stringify(runs.map(run => ({ name: run.employeeSnapshot.name, status: run.status, error: run.error }))));
  assert.equal(f.view().currentStepId, 'architecture');
});

test('necessary cross-step consultation requires a concrete reason and never copies the native conversation history', async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, [
    () => call('worker_consult', { employeeId: f.employee('tester').id, request: 'What evidence is needed?', reason: 'help' }),
    request => { assert.match(JSON.stringify(request), /至少 8 字/); return call('worker_consult', { employeeId: f.employee('tester').id, request: 'Which endpoint regression evidence is required?', reason: '需要确认后续回归阶段对该接口边界的证据要求' }); },
    request => { assert.equal(request.model, 'tester'); assert.doesNotMatch(JSON.stringify(request), /NATIVE_PRIVATE_HISTORY/); return text('Use boundary and authorization regression cases.'); },
    request => {
      const result = request.messages.filter(message => message.role === 'tool').at(-1)!;
      assert.equal(result.role === 'tool' && result.isError, false);
      assert.doesNotMatch(JSON.stringify(result), /employeeSnapshot|allowedTemplateIds/);
      return text('Included the required regression evidence in the design.');
    },
  ]);
  await f.send('NATIVE_PRIVATE_HISTORY: coordinate only the specific test question');
  assert.equal(f.store.snapshot().runs.length, 2);
  const child = f.store.snapshot().runs.find(run => run.parentRunId)!;
  assert.match(child.request, /必要的跨步骤咨询/); assert.equal(child.employeeId, f.employee('tester').id);
  assert.ok(!f.view().activeEmployeeIds.includes(child.employeeId), 'consulting does not activate an unrelated branch');
  assert.equal(f.rootRun().status, 'awaiting-review', JSON.stringify(f.store.snapshot().runs.map(run => ({ name: run.employeeSnapshot.name, status: run.status, error: run.error }))));
});

test('a frozen employee role serves separate native conversations and an independent task concurrently', async t => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, [async () => { entered.resolve(); await release.promise; return text('owner completed'); }, () => text('independent delivered'), () => text('second conversation delivered')]);
  try {
    const sending = f.send('work in native conversation'); await entered.promise;
    const independent = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee('architect').id, request: 'parallel @ job' });
    assert.equal((await f.runtime.wait(independent.id)).status, 'awaiting-review');
    const another = await f.createNative();
    another.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'parallel native job' }] }));
    await another.whenIdle();
    assert.equal(f.store.snapshot().runs.length, 3); assert.equal(f.adapter.requests.length, 3);
    const end = another.session.snapshotEvents().findLast(event => event.type === 'turn/end');
    assert.equal(end?.type, 'turn/end'); if (end?.type === 'turn/end') assert.equal(end.data.reason.kind, 'completed');
    assert.equal(f.rootRun().status, 'running', 'the original turn stays active while the other two finish');
    release.resolve(); await sending;
  } finally { release.resolve(); }
});

test('paused owner authorization prevents native file writes and stops further owner model requests', async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, [async () => {
    await f.store.updateEmployee(f.employee('architect').id, { status: 'paused' });
    return call('write', { file_path: join(f.root, 'must-not-write.txt'), content: 'DENIED' });
  }]);
  await f.send('write a project result');
  assert.equal(f.rootRun().status, 'failed'); assert.match(f.rootRun().error!, /停用|暂停|启用/);
  assert.equal(f.adapter.requests.length, 1);
  await assert.rejects(readFile(join(f.root, 'must-not-write.txt')), /ENOENT/);
  assert.equal(f.rootRun().artifacts.length, 0);
});

test('runtime cancellation aborts the external native turn without disposing its Agent or completing a step', async t => {
  const entered = deferred();
  const f = await fixture(t, [async request => {
    entered.resolve(); await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
    request.signal!.throwIfAborted(); return text('unreachable');
  }, () => text('new native owner turn works')]);
  const sending = f.send('cancel this owner turn'); await entered.promise;
  await f.runtime.cancel(f.rootRun().id); await sending;
  assert.equal(f.rootRun().status, 'cancelled'); assert.equal(f.ctx.agents.get(f.native.id), f.native);
  assert.equal(f.view().currentStepId, 'architecture');
  await f.send('continue in a fresh turn'); assert.equal(f.rootRun().status, 'awaiting-review', f.rootRun().error);
});

test('an empty completed model response does not become a reviewable owner delivery', async t => {
  const f = await fixture(t, [() => text('')]);
  await f.send('empty response'); assert.equal(f.rootRun().status, 'failed');
  assert.match(f.rootRun().error!, /未提交可验收/); assert.equal(f.view().currentStepId, 'architecture');
});

test('losing official workspace membership prevents the next model step and further delegated work', async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, [() => { f.attached.splice(f.attached.indexOf(f.native.id), 1); return call('worker_deliver', { title: 'A result', content: 'Must stop at next step' }); }]);
  await f.send('workspace membership is revoked during a turn');
  assert.equal(f.rootRun().status, 'failed'); assert.match(f.rootRun().error!, /不属于该项目/);
  assert.equal(f.adapter.requests.length, 1);
});

test('an executing standalone task does not block the same role in a separate native conversation', async t => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, [async () => { entered.resolve(); await release.promise; return text('standalone delivered'); }, () => text('native owner delivered')]);
  try {
    const standalone = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee('architect').id, request: 'already executing independent job' });
    await entered.promise;
    await f.send('parallel native owner job');
    assert.equal(f.store.snapshot().runs.length, 2); assert.equal(f.adapter.requests.length, 2);
    const end = f.native.session.snapshotEvents().findLast(event => event.type === 'turn/end');
    assert.equal(end?.type, 'turn/end'); if (end?.type === 'turn/end') assert.equal(end.data.reason.kind, 'completed');
    assert.equal(f.rootRun().output, 'native owner delivered');
    release.resolve(); assert.equal((await f.runtime.wait(standalone.id)).status, 'awaiting-review');
  } finally { release.resolve(); }
});

test('a 147862-token first response can continue to an answer under the native default context policy', async t => {
  const f = await fixture(t, [() => call('worker_deliver', { title: 'Evidence', content: 'Real task evidence' }).map(chunk => chunk.type === 'usage' ? { type: 'usage' as const, usage: { inputTokens: 147862, outputTokens: 1665, cacheReadTokens: 0, totalTokens: 149527 } } : chunk), () => text('Final user answer')]);
  await f.send('ordinary question in a long native conversation');
  assert.equal(f.adapter.requests.length, 2);
  assert.equal(f.rootRun().status, 'awaiting-review', f.rootRun().error);
  assert.match(f.rootRun().output!, /Final user answer/);
  assert.equal(f.rootRun().usage?.inputTokens, 147892);
});

test('an explicitly configured cumulative budget includes cache tokens and names the actual limit', async t => {
  const f = await fixture(t, [() => call('worker_deliver', { title: 'Partial evidence', content: 'Keep this artifact' }).map(chunk => chunk.type === 'usage' ? { type: 'usage' as const, usage: { inputTokens: 194, cacheReadTokens: 140160, outputTokens: 1330, totalTokens: 141684 } } : chunk)], { maxTreeTokens: 120000 });
  await f.send('explicit budget');
  assert.equal(f.adapter.requests.length, 1);
  assert.equal(f.rootRun().status, 'failed');
  assert.match(f.rootRun().error!, /已配置.*141684 \/ 120000/);
  assert.equal(f.rootRun().artifacts.length, 1);
});

test('an explicitly insufficient budget rejects before spending the first model request', async t => {
  const f = await fixture(t, [() => text('must not be requested')], { maxTreeTokens: 10 });
  await f.send('too little explicitly configured budget');
  assert.equal(f.adapter.requests.length, 0);
  assert.equal(f.rootRun().status, 'failed');
  assert.match(f.rootRun().error!, /请求前.*估算.*预算/);
});

test('an explicit budget cannot silently continue when the provider omits usage', async t => {
  const f = await fixture(t, [() => call('worker_deliver', { title: 'Evidence', content: 'Retain despite missing accounting' }).filter(chunk => chunk.type !== 'usage'), () => text('must not be requested')], { maxTreeTokens: 1_000_000 });
  await f.send('explicitly bounded task with missing usage');
  assert.equal(f.adapter.requests.length, 1);
  assert.match(f.rootRun().error!, /服务商.*用量.*预算/);
  assert.equal(f.rootRun().usage?.reportedCalls, 0);
});

test('only an explicitly configured task budget applies its reserved output limit to native owner requests', async t => {
  for (const maxTreeTokens of [0, 1_000_000]) {
    const f = await fixture(t, [() => text('bounded workflow answer')], { maxTreeTokens });
    await f.send('verify the output reservation');
    assert.equal(f.adapter.requests.length, 1, f.rootRun().error);
    assert.equal(f.adapter.requests[0]!.maxTokens, maxTreeTokens ? 8000 : undefined);
    assert.equal(f.rootRun().status, 'awaiting-review', f.rootRun().error);
  }
});

test('native write and explicit file delivery preserve one real historical project artifact', async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, [
    () => call('write', { file_path: join(f.root, 'architecture.md'), content: 'ACTUAL_NATIVE_FILE_CONTENT' }),
    () => call('worker_deliver', { title: 'Architecture file', path: 'architecture.md' }),
    () => text('File submitted'),
  ]);
  await f.send('produce the architecture file');
  assert.equal(f.rootRun().status, 'awaiting-review', f.rootRun().error);
  const artifacts = f.rootRun().artifacts;
  assert.equal(artifacts.length, 1); assert.equal(artifacts[0]!.path, 'architecture.md');
  assert.equal(artifacts[0]!.title, 'Architecture file'); assert.equal(artifacts[0]!.content, 'ACTUAL_NATIVE_FILE_CONTENT');
  await writeFile(join(f.root, 'architecture.md'), 'LATER_UNRELATED_FILE_VERSION');
  assert.equal(f.rootRun().artifacts[0]!.content, 'ACTUAL_NATIVE_FILE_CONTENT');
});

test('native delivery marks only a real confirmed-items file snapshot as structured unreviewed declarations', async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const declarations = JSON.stringify({ schemaVersion: 1, items: [{ id: 'scope', title: '范围声明', content: '只提交可读快照，不自称用户确认。' }] });
  f = await fixture(t, [
    () => call('write', { file_path: join(f.root, 'scope.confirmed-items.json'), content: declarations }),
    () => call('worker_deliver', { title: '事项声明', path: 'scope.confirmed-items.json' }),
    () => call('write', { file_path: join(f.root, 'ordinary.json'), content: declarations }),
    () => call('worker_deliver', { title: '普通 JSON', path: 'ordinary.json' }),
    () => text('已提交待验收文件'),
  ]);
  await f.send('提交结构化事项声明和普通 JSON，不自行验收');
  const run = f.rootRun();
  assert.equal(run.status, 'awaiting-review', run.error); assert.equal(run.acceptance, undefined);
  const structured = run.artifacts.find(artifact => artifact.path === 'scope.confirmed-items.json')!;
  assert.equal(structured.mediaType, 'application/vnd.composable-workforce.confirmed-items+json');
  assert.equal(structured.content, declarations);
  assert.equal(run.artifacts.find(artifact => artifact.path === 'ordinary.json')!.mediaType, 'text/plain');
  await writeFile(join(f.root, 'scope.confirmed-items.json'), 'LATER_FILE_CONTENT');
  assert.equal(f.rootRun().artifacts.find(artifact => artifact.id === structured.id)!.content, declarations, 'the declaration is the saved authorized snapshot, never a later file read');
});

test('native owner steps obey the shared step budget and retain produced evidence on failure', async t => {
  const f = await fixture(t, [() => call('worker_deliver', { title: 'Partial design', content: 'Reviewable partial evidence' })], { maxSteps: 1 });
  await f.send('bounded native task');
  assert.equal(f.rootRun().status, 'failed'); assert.match(f.rootRun().error!, /达到员工任务步数/);
  assert.equal(f.adapter.requests.length, 1); assert.equal(f.rootRun().artifacts[0]!.content, 'Reviewable partial evidence');
});
