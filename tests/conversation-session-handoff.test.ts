import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { installModelSelection, type AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { WorkforceStore } from '../src/domain/store.js';
import { WorkforceRuntime } from '../src/harness/runtime.js';

const text = (value: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }, { type: 'finish', reason: { kind: 'stop' } },
];
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(private readonly scripts: Array<(request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>>) { super(); }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (!script) throw new Error('fixture script exhausted');
    for (const chunk of await script(request)) yield chunk;
  }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t: { after(fn: () => Promise<void>): void }, scripts: ConstructorParameters<typeof ScriptedAdapter>[0], durable = true, bareAgent = false) {
  const root = await mkdtemp(join(tmpdir(), 'native-session-handoff-'));
  const store = await WorkforceStore.open(join(root, 'state.json'));
  const project = await store.saveProject({ name: 'Historical delivery fixture', rootPath: root });
  let employee = await store.createEmployee({ projectId: project.id, templateId: store.snapshot().templates[0]!.id });
  const modules = structuredClone(employee.modules);
  modules.model = { mode: 'override', provider: 'fixture', model: 'employee' };
  modules.capabilities.skills = [];
  employee = await store.updateEmployee(employee.id, { modules });
  const ctx = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(NativeToolExecutor); await ctx.plugin(AgentRegistry);
  if (durable) await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.systemPrompt.section({ name: 'native-complete', order: 0, complete: true, text: 'NATIVE_HANDOFF_SYSTEM' });
  const adapter = new ScriptedAdapter(scripts); ctx.llm.registerAdapter(['fixture'], adapter);
  const attached: string[] = [];
  const workspace = { sessionIds: attached, attachSession: async (id: string) => { attached.push(id); } };
  ctx.provide('workspaceRegistry', { get: (id: string) => id === project.id ? workspace : undefined } as never);
  const nativeHandles: AgentHandle[] = [];
  let resumes = 0;
  let resumeError: string | undefined;
  // This controller facade drives the real public AgentRegistry.resume API and real JSONL writer handoff.
  // The complete public SessionController/preset path is exercised by the official archive UI acceptance.
  ctx.provide('sessionController', { resolveAgent: async (id: ReturnType<typeof SessionId>) => {
    resumes++;
    if (resumeError) {
      if (bareAgent) throw Object.assign(new Error(resumeError), { code: 'gateway/internal' });
      return { error: { code: 'gateway/internal', message: resumeError } };
    }
    const existing = ctx.agents.get(id);
    if (existing) return bareAgent ? existing : { agent: existing };
    const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'native' },
      setup: agentCtx => { installModelSelection(agentCtx); },
    });
    nativeHandles.push(handle);
    return bareAgent ? handle.agent : { agent: handle.agent };
  } } as never);
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'native' }) } as never);
  const runtime = new WorkforceRuntime(ctx, store, new Map());
  const start = async () => {
    const run = await runtime.start({ projectId: project.id, employeeId: employee.id, request: 'HISTORICAL_USER_REQUEST' });
    return runtime.wait(run.id);
  };
  t.after(async () => {
    await runtime.dispose();
    await Promise.all(nativeHandles.map(handle => handle.dispose()));
    await rm(root, { recursive: true, force: true });
  });
  const persisted = async (id: string) => {
    await ctx.sessionPersistence.flush();
    const handle = await ctx.sessionPersistence.open(SessionId(id), 'read');
    try { return await handle.read(); } finally { await handle.close(); }
  };
  return { ctx, runtime, store, project, employee, adapter, start, persisted, attached, resumes: () => resumes,
    failResume: (message?: string) => { resumeError = message; } };
}

test('completed standalone Agent hands the same durable session to native routing, preserving all history and old runs', async t => {
  const f = await fixture(t, [() => text('HISTORICAL_EMPLOYEE_REPLY'), request => {
    assert.equal(request.model, 'native');
    const system = JSON.stringify(request.messages.filter(message => message.role === 'system'));
    assert.match(system, /NATIVE_HANDOFF_SYSTEM/);
    assert.doesNotMatch(system, /当前可委派员工名册|你的员工 ID/);
    assert.equal(request.tools?.some(tool => tool.name.startsWith('worker_')) ?? false, false);
    assert.match(JSON.stringify(request.messages), /HISTORICAL_USER_REQUEST|HISTORICAL_EMPLOYEE_REPLY/);
    return text('NATIVE_REPLY_AFTER_HANDOFF');
  }]);
  const run = await f.start(); assert.equal(run.status, 'awaiting-review', run.error);
  const id = run.sessionId!;
  const originalAgent = f.ctx.agents.get(SessionId(id))!;
  const oldRuns = f.store.snapshot().runs;
  const before = await f.persisted(id);
  assert.equal(f.runtime.needsCompletedSessionHandoff(id), true);
  assert.equal(f.runtime.ownsSession(id), true);
  const first = f.runtime.handoffCompletedSession(id);
  assert.equal(f.runtime.handoffCompletedSession(id), first, 'concurrent calls share the whole disposal/resume operation');
  assert.equal(await first, true);
  assert.equal(f.resumes(), 1);
  assert.equal(f.runtime.needsCompletedSessionHandoff(id), false);
  assert.equal(f.runtime.ownsSession(id), false);
  const native = f.ctx.agents.get(SessionId(id))!;
  assert.notEqual(native, originalAgent);
  assert.equal(native.id, id);
  assert.ok(f.attached.includes(id));
  assert.deepEqual(f.store.snapshot().runs, oldRuns);
  const after = await f.persisted(id);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  native.followup(createUserMessage({ content: [{ type: 'text', text: 'NEW_NATIVE_USER_REQUEST' }], source: { kind: 'user' } }));
  await native.whenIdle();
  assert.equal(f.adapter.requests.length, 2, 'no replay or extra model request during handoff');
  assert.match(JSON.stringify((await f.persisted(id)).events), /NATIVE_REPLY_AFTER_HANDOFF/);
  assert.deepEqual(f.store.snapshot().runs, oldRuns, 'unselected native turn creates no employee run');
  assert.equal(await f.runtime.handoffCompletedSession(id), false);
  await f.runtime.dispose();
  assert.equal(f.ctx.agents.get(SessionId(id)), native, 'plugin disposal cannot dispose the resumed native Agent');
});

test('resume failure keeps durable history and explicit retry after the owned handle was released', async t => {
  const f = await fixture(t, [() => text('ORIGINAL_DURABLE_REPLY')]);
  const run = await f.start(); const id = run.sessionId!;
  const before = await f.persisted(id); const oldRuns = f.store.snapshot().runs;
  f.failResume('fixture preset temporarily unavailable');
  await assert.rejects(f.runtime.handoffCompletedSession(id), /已保存并释放.*gateway\/internal.*preset temporarily unavailable.*重试/);
  assert.equal(f.ctx.agents.get(SessionId(id)), undefined);
  assert.equal(f.runtime.ownsSession(id), false);
  assert.equal(f.runtime.needsCompletedSessionHandoff(id), true);
  assert.deepEqual((await f.persisted(id)).events, before.events);
  assert.deepEqual(f.store.snapshot().runs, oldRuns);
  f.failResume();
  assert.equal(await f.runtime.handoffCompletedSession(id), true);
  assert.equal(f.resumes(), 2);
  assert.equal(f.runtime.needsCompletedSessionHandoff(id), false);
  assert.equal(f.adapter.requests.length, 1);
});

test('published controller implementation returning bare Agent or throwing RemoteError also hands off safely', async t => {
  const f = await fixture(t, [() => text('PUBLISHED_API_HISTORY')], true, true);
  const run = await f.start(); const id = run.sessionId!;
  f.failResume('published API failure');
  await assert.rejects(f.runtime.handoffCompletedSession(id), /gateway\/internal: published API failure/);
  assert.equal(f.runtime.needsCompletedSessionHandoff(id), true);
  f.failResume();
  assert.equal(await f.runtime.handoffCompletedSession(id), true);
  assert.equal(f.ctx.agents.get(SessionId(id))!.id, id);
  assert.equal(f.runtime.ownsSession(id), false);
  assert.equal(f.resumes(), 2);
});

test('active delivery rejects handoff without cancelling its model, then permits handoff after completion', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, [async () => { entered.resolve(); await release.promise; return text('COMPLETED_AFTER_RELEASE'); }]);
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: 'Pending real model turn' });
  await entered.promise;
  const id = f.store.snapshot().runs.find(item => item.id === run.id)!.sessionId!;
  assert.equal(f.runtime.needsCompletedSessionHandoff(id), false);
  await assert.rejects(f.runtime.handoffCompletedSession(id), /尚未停止|仍在运行/);
  assert.equal(f.ctx.agents.get(SessionId(id))!.status, 'running');
  assert.equal(f.resumes(), 0);
  release.resolve();
  assert.equal((await f.runtime.wait(run.id)).status, 'awaiting-review');
  assert.equal(await f.runtime.handoffCompletedSession(id), true);
});

test('opening during the terminal persistence notification waits for the owned execution to retain its handle', async t => {
  const f = await fixture(t, [() => text('FINALIZATION_WINDOW_REPLY')]);
  let handoff: Promise<boolean> | undefined;
  const unsubscribe = f.store.subscribe(() => {
    const finished = f.store.snapshot().runs.find(run => run.status === 'awaiting-review' && run.sessionId);
    if (!finished || handoff) return;
    assert.equal(f.runtime.needsCompletedSessionHandoff(finished.sessionId!), true);
    handoff = f.runtime.handoffCompletedSession(finished.sessionId!);
  });
  const run = await f.start();
  unsubscribe();
  assert.ok(handoff);
  assert.equal(await handoff, true);
  assert.equal(f.resumes(), 1);
  assert.equal(f.runtime.ownsSession(run.sessionId!), false);
  assert.ok(f.ctx.agents.get(SessionId(run.sessionId!)));
});

test('queued inbox work and absent persistence do not destroy the retained Agent', async t => {
  const f = await fixture(t, [() => text('ORIGINAL_REPLY')], false);
  const run = await f.start(); const id = run.sessionId!;
  const agent = f.ctx.agents.get(SessionId(id))!;
  const message = createUserMessage({ content: [{ type: 'text', text: 'QUEUED_INPUT' }], source: { kind: 'user' } });
  agent.inbox.append('next-turn', message);
  assert.equal(f.runtime.needsCompletedSessionHandoff(id), false);
  await assert.rejects(f.runtime.handoffCompletedSession(id), /待处理消息/);
  assert.equal(agent.inbox.nextTurn.length, 1);
  agent.inbox.splice('next-turn', 0, 1, []);
  await assert.rejects(f.runtime.handoffCompletedSession(id), /缺少官方会话持久化/);
  assert.equal(f.ctx.agents.get(SessionId(id)), agent);
  assert.equal(f.runtime.ownsSession(id), true);
  assert.equal(f.resumes(), 0);
});

test('an idle retained Agent keeps a real approval-policy notice instead of disposing it during native handoff', async t => {
  const f = await fixture(t, [() => text('RETAINED_POLICY_REPLY')]);
  const run = await f.start(); const id = run.sessionId!;
  const agent = f.ctx.agents.get(SessionId(id))!;
  await f.ctx.plugin(ApprovalService, { policy: 'ask' });
  f.ctx.approval.setPolicy(agent, 'never');
  assert.equal(agent.status, 'idle', 'the official policy notification does not wake the model driver');
  assert.equal(agent.inbox.nextTurn.length, 0);
  assert.equal(agent.inbox.nextStep.length, 1);
  assert.equal(agent.inbox.nextStep[0]!.source.kind, 'user-approval');
  assert.equal(f.ctx.approval.effectivePolicy(agent.session), 'never');
  const pending = structuredClone(agent.inbox.nextStep);
  const before = await f.persisted(id);
  assert.equal(f.runtime.needsCompletedSessionHandoff(id), false, 'the retained capability must not discard queued context through disposal');
  await assert.rejects(f.runtime.handoffCompletedSession(id), /待处理消息/);
  assert.equal(f.ctx.agents.get(SessionId(id)), agent);
  assert.equal(f.runtime.ownsSession(id), true);
  assert.equal(f.resumes(), 0);
  assert.deepEqual(agent.inbox.nextStep, pending);
  assert.equal(f.ctx.approval.effectivePolicy(agent.session), 'never');
  assert.deepEqual((await f.persisted(id)).events, before.events, 'rejected handoff cannot log a discarded policy notice or revert its durable policy');
  assert.equal(f.adapter.requests.length, 1, 'checking handoff cannot wake or replay the completed model turn');
});

test('generated children and structured execution records are never adopted as ordinary conversations', async t => {
  const f = await fixture(t, [() => text('PROTECTED_HISTORY')]);
  const run = await f.start(); const id = run.sessionId!;
  // Negative persisted-record fixtures target the protection boundary; no generated child is executed.
  const original = f.store.snapshot.bind(f.store);
  for (const links of [{ parentRunId: 'parent' }, { workflow: { workflowRunId: 'workflow', stepId: 'step' } }, { workTaskId: 'task' }, { conversationWorkflow: { instanceId: 'flow', stepId: 'step' } }]) {
    f.store.snapshot = () => ({ ...original(), runs: original().runs.map(item => item.id === run.id ? { ...item, ...links } : item) }) as ReturnType<typeof original>;
    assert.equal(f.runtime.needsCompletedSessionHandoff(id), false);
    await assert.rejects(f.runtime.handoffCompletedSession(id), /子任务、工作流或任务工作台/);
    assert.ok(f.ctx.agents.get(SessionId(id)));
    assert.equal(f.resumes(), 0);
  }
  f.store.snapshot = original;
  assert.equal(await f.runtime.handoffCompletedSession(id), true);
});
