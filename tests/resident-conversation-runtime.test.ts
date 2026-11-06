import { resolveTemporaryEmployeeModel } from '../src/harness/host.js';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { installModelSelection, type AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import FileSystem from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import SkillRegistry, { type SkillCandidate } from '@deepseek-ai/dsh-skill';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as SkillTool from '@deepseek-ai/dsh-tool-skill';
import { WorkforceStore } from '../src/domain/store.js';
import { resolveConversationEmployee, type ConversationEmployeeMode } from '../src/domain/conversation-employee.js';
import { registerConversationWorkflowRuntime } from '../src/harness/conversation-workflow-runtime.js';
import { WorkforceRuntime, type KnowledgeRuntime } from '../src/harness/runtime.js';
import { loadEmployeeSkills } from '../src/harness/skills.js';

class OfflineAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  beforeStream?: (request: GenerateOptions) => Promise<void>;
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 1_048_576 }, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], default: ReasoningEffortId('high') } };
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    await this.beforeStream?.(request);
    const answer = `OFFLINE_RESIDENT_ANSWER_${this.requests.length}`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: answer };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const visible = (request: GenerateOptions) => JSON.stringify({ system: request.system, messages: request.messages.map(({ role, content }) => ({ role, content })) });
const pluginContexts = (request: GenerateOptions) => request.messages.flatMap(message => {
  const source = message.source as { kind: string; sections?: Array<{ name: string; text: string }> };
  return source?.kind === 'runtime-context' ? source.sections ?? [] : [];
}).filter(section => /composable-workforce|digital-worker/.test(section.name));
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'resident-native-runtime-'));
  const projectRoot = join(directory, 'Chat'); await mkdir(projectRoot);
  await writeFile(join(projectRoot, 'README.md'), 'RESIDENT_PROJECT_FILE_EVIDENCE');
  const store = await WorkforceStore.open(join(directory, 'state.json'));
  const project = await store.saveProject({ id: 'resident-fixture', name: 'Chat', rootPath: projectRoot });
  const skills = await loadEmployeeSkills(resolve('skills'));
  for (const id of ['employee-template-product', 'employee-template-architect']) {
    const template = store.snapshot().templates.find(entry => entry.id === id)!; assert.ok(template);
    await store.saveTemplate({ ...template, modules: { ...template.modules, model: { mode: 'override', provider: 'resident-fixture', model: id, reasoningEffort: 'high' } } });
  }
  const counters = { skillDiscoveryCalls: 0, skillBodies: 0, knowledgePrepare: 0, knowledgeOverview: 0, knowledgeIngest: 0 };
  const knowledge: KnowledgeRuntime = {
    spacesForEmployee: () => [{ kind: 'project', projectId: project.id, teamId: 'resident-fixture-team' }],
    prepareFor: async () => { counters.knowledgePrepare++; },
    overviewFor: async () => { counters.knowledgeOverview++; return 'RESIDENT_C_KNOWLEDGE_SENTINEL'; },
    overviewDocumentsFor: async () => { counters.knowledgeOverview++; return [{ layer: 'C', id: 'resident-concept', library: 'team', version: 1, title: 'Confirmed concept', content: 'RESIDENT_C_KNOWLEDGE_SENTINEL' }]; },
    ingestFor: async () => { counters.knowledgeIngest++; }, searchFor: async () => [], readFor: async () => undefined,
  };
  const ctx = new Context(), adapter = new OfflineAdapter();
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, NativeToolExecutor, FileSystem, WorkingDirectory, SkillRegistry, AgentRegistry]) await ctx.plugin(plugin);
  await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(FileTools); await ctx.plugin(SkillTool);
  ctx.llm.registerAdapter(['resident-fixture'], adapter);
  ctx.systemPrompt.section({ name: 'resident-native-system', order: -1000, text: 'NATIVE_SYSTEM_IDENTITY_SENTINEL' });
  ctx.systemPrompt.context({ name: 'resident-native-policy', order: 0, required: true, text: 'NATIVE_REQUIRED_POLICY_SENTINEL' });
  const provider = 'resident-production-bundled-fixture';
  ctx.skills.registerProvider(() => ({ name: provider,
    list: async () => { counters.skillDiscoveryCalls++; return [...skills.values()].map((skill): SkillCandidate => ({ name: skill.id, description: skill.description, source: 'bundled', provider,
      invocation: { modelInvocable: true, userInvocable: true }, rank: 600, locator: skill.id })); },
    get: async candidate => { counters.skillBodies++; const skill = skills.get(candidate.name)!;
      return { ...candidate, content: `RESIDENT_REQUIRED_SKILL_BODY_SENTINEL\n${skill.content}` }; },
  }));
  const handles: AgentHandle[] = [], attached: string[] = [], errors: unknown[] = [], streams: Array<{ id: string; type: string }> = [];
  const workspace = { path: projectRoot, sessionIds: attached, attachSession: async (id: string) => { attached.push(id); } };
  ctx.provide('workspaceRegistry', { get: (id: string) => id === project.id ? workspace : undefined } as never);
  const runtime = new WorkforceRuntime(ctx, store, skills, {}, knowledge);
  const temporaryTargets = new Map<string, { templateId: string; expectedTargetVersion: number }>();
  let eventReads = 0;
  const dispose = registerConversationWorkflowRuntime(ctx, {
    isDeliverySession: () => false,
    tools: runtime.conversationToolDefinitions(),
    selectModel: (agent, turnKey) => {
      const temporary = temporaryTargets.get(agent.id);
      const resident = resolveConversationEmployee(store.snapshot(), project.id, agent.id);
      const configured = temporary ? resolveTemporaryEmployeeModel(store.snapshot(), { ...temporary, projectId: project.id, sessionId: agent.id, turnKey }) : resident.employee?.modules.model;
      if (!configured) return undefined;
      return { model: { provider: configured.provider!, model: configured.model!, ...(configured.reasoningEffort ? { reasoningEffort: ReasoningEffortId(configured.reasoningEffort) } : {}) },
        ...(!temporary && resident.conversationEmployee?.mode === 'consult' ? { toolPolicy: 'consult' as const } : {}) };
    },
    prepare: async (agent, key, request, signal, context) => {
      const temporary = temporaryTargets.get(agent.id);
      if (temporary) {
        temporaryTargets.delete(agent.id);
        const view = await store.admitTemporaryConversationEmployee({ projectId: project.id, sessionId: agent.id, turnKey: key, ...temporary });
        return runtime.openEmployeeConversationTurn(agent, key, request, view, signal, context?.modelSelection);
      }
      const view = resolveConversationEmployee(store.snapshot(), project.id, agent.id);
      return view.conversationEmployee ? runtime.openEmployeeConversationTurn(agent, key, request, view, signal, context?.modelSelection) : Promise.resolve(undefined);
    },
    readEvents: async agent => { eventReads++; return agent.session.snapshotEvents(); },
    onError: error => errors.push(error),
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => streams.push({ id: agent.id, type: frame.type }));
  const createNative = async (name: string) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(name), meta: { cwd: projectRoot },
      agentOptions: { provider: 'resident-fixture', model: 'native-user-selected', reasoningEffort: ReasoningEffortId('high') },
      setup: agentCtx => { installModelSelection(agentCtx); },
    }); handles.push(handle); attached.push(handle.agent.id); return handle.agent;
  };
  const native = await createNative('resident-same-native-session');
  const set = async (templateId: string, mode: ConversationEmployeeMode, agent = native) => {
    const view = resolveConversationEmployee(store.snapshot(), project.id, agent.id);
    return store.setConversationEmployee({ projectId: project.id, sessionId: agent.id, templateId, mode },
      { expectedRevision: store.snapshot().revision, expectedVersion: view.conversationEmployee?.version ?? 0 });
  };
  const clear = async () => {
    const view = resolveConversationEmployee(store.snapshot(), project.id, native.id);
    return store.clearConversationEmployee({ projectId: project.id, sessionId: native.id },
      { expectedRevision: store.snapshot().revision, expectedVersion: view.conversationEmployee?.version ?? 0 });
  };
  const send = async (message: string, agent = native) => {
    const before = adapter.requests.filter(request => request.sessionId === agent.id).length;
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: message }] }));
    await agent.whenIdle();
    const run = store.snapshot().runs.filter(run => run.sessionId === agent.id && !run.parentRunId).at(-1);
    if (run) await runtime.wait(run.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(adapter.requests.filter(request => request.sessionId === agent.id).length, before + 1, JSON.stringify(errors.map(error => String(error))));
    const request = adapter.requests.findLast(request => request.sessionId === agent.id)!;
    assert.equal(request.sessionId, agent.id); assert.ok(Object.isFrozen(request));
    assert.match(visible(request), /NATIVE_SYSTEM_IDENTITY_SENTINEL/); assert.match(visible(request), /NATIVE_REQUIRED_POLICY_SENTINEL/);
    return request;
  };
  const reserveTemporary = (templateId: string, agent = native) => {
    temporaryTargets.set(agent.id, { templateId, expectedTargetVersion: store.snapshot().templates.find(template => template.id === templateId)!.version });
  };
  const invokeTemporary = async (templateId: string, message: string, agent = native) => { reserveTemporary(templateId, agent); return send(message, agent); };
  t.after(async () => { await dispose(); await runtime.dispose(); for (const handle of handles) await handle.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { store, project, ctx, adapter, runtime, native, createNative, set, clear, send, invokeTemporary, reserveTemporary, counters, errors, streams, directory, eventReads: () => eventReads };
}

test('explicit resident consult and execute keep native history/stream, restore tools, switch employee, and unbind locally', async t => {
  const f = await fixture(t);
  assert.equal(resolveConversationEmployee(f.store.snapshot(), f.project.id, f.native.id).conversationEmployee, null);
  await f.set('employee-template-product', 'consult');
  const first = await f.send('你是谁');
  assert.equal(first.tools?.length ?? 0, 0);
  assert.equal(first.model, 'employee-template-product', 'explicit employee model is retained');
  assert.equal(first.reasoningEffort, ReasoningEffortId('high'), 'consult preserves the explicitly configured employee reasoning');
  assert.equal(first.messages.filter(message => message.source?.kind === 'skill-catalog').length, 0);
  assert.deepEqual(f.counters, { skillDiscoveryCalls: 0, skillBodies: 0, knowledgePrepare: 0, knowledgeOverview: 0, knowledgeIngest: 0 });
  assert.doesNotMatch(visible(first), /RESIDENT_REQUIRED_SKILL_BODY_SENTINEL|RESIDENT_C_KNOWLEDGE_SENTINEL/);
  const second = await f.send('再介绍一次你的职责');
  assert.match(visible(second), /OFFLINE_RESIDENT_ANSWER_1/);
  assert.equal(second.tools?.length ?? 0, 0); assert.equal(f.counters.skillBodies, 0);
  const mission = f.store.snapshot().templates.find(template => template.id === 'employee-template-product')!.modules.responsibilities.mission;
  assert.equal(visible(second).split(mission).length - 1, 1, 'stable resident role is retained once across turns');
  assert.ok(f.streams.filter(frame => frame.id === f.native.id && frame.type === 'start').length >= 2);
  const unrelated = await f.createNative('resident-unaffected-native-session');
  const ordinary = await f.send('普通原生助手问题', unrelated);
  assert.ok(ordinary.tools?.some(tool => tool.name === 'read')); assert.ok(ordinary.tools?.some(tool => tool.name === 'skill'));
  assert.equal(ordinary.model, 'native-user-selected');
  assert.equal(pluginContexts(ordinary).length, 0, 'other conversation has no employee context');
  await f.set('employee-template-product', 'execute');
  const execute = await f.send('请分析并准备需求验收清单');
  assert.ok(execute.tools?.some(tool => tool.name === 'read')); assert.ok(execute.tools?.some(tool => tool.name === 'skill'));
  assert.ok(execute.tools?.some(tool => tool.name === 'worker_memory_search'));
  assert.match(visible(execute), /RESIDENT_REQUIRED_SKILL_BODY_SENTINEL/); assert.match(visible(execute), /RESIDENT_C_KNOWLEDGE_SENTINEL/);
  assert.ok(f.counters.skillBodies > 0); assert.ok(f.counters.knowledgePrepare > 0);
  const counts = { ...f.counters };
  await f.set('employee-template-architect', 'consult');
  const switched = await f.send('现在由谁回答');
  assert.equal(switched.model, 'employee-template-architect'); assert.equal(switched.tools?.length ?? 0, 0);
  assert.equal(f.counters.skillBodies, counts.skillBodies); assert.equal(f.counters.knowledgePrepare, counts.knowledgePrepare);
  await f.clear();
  const afterUnbind = await f.send('继续普通原生对话');
  assert.equal(resolveConversationEmployee(f.store.snapshot(), f.project.id, f.native.id).conversationEmployee, null);
  assert.ok(afterUnbind.tools?.some(tool => tool.name === 'read'));
  assert.match(visible(afterUnbind), /OFFLINE_RESIDENT_ANSWER_1/);
  assert.equal(f.ctx.agents.get(SessionId(f.native.id)), f.native, 'no replacement Agent or Session');
  assert.equal(f.store.snapshot().runs.filter(run => run.conversationEmployee).length, 4, 'only resident business turns create resident attempts');
  assert.deepEqual(f.errors, []);
});

test('complete software seed consultation request composition is measured without paid calls or production histories', async t => {
  const consult = await fixture(t);
  await consult.set('employee-template-product', 'consult');
  const light = await consult.send('你是谁');
  const execute = await fixture(t);
  await execute.set('employee-template-product', 'execute');
  const full = await execute.send('你是谁');
  const summarize = (request: GenerateOptions, counters: typeof consult.counters) => ({
    provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort,
    toolNames: request.tools?.map(tool => tool.name) ?? [],
    toolSchemaBytes: Buffer.byteLength(JSON.stringify(request.tools ?? [])),
    sentCatalogMessages: request.messages.filter(message => message.source?.kind === 'skill-catalog').length,
    modelContentBytes: Buffer.byteLength(visible(request)),
    fullEnvelopeBytes: Buffer.byteLength(JSON.stringify(request)),
    employeeContexts: pluginContexts(request).map(section => ({ name: section.name, bytes: Buffer.byteLength(section.text), sha256: digest(section.text) })),
    messageComposition: request.messages.map(message => ({ role: message.role, source: message.source?.kind ?? 'none', bytes: Buffer.byteLength(JSON.stringify(message.content)) })),
    operations: { ...counters },
  });
  const comparison = { safety: 'Official in-memory rc.3 Agent/Session and filesystem/skill plugins; complete production product-role seed and bundled Skills, isolated temporary Chat directories, offline response Adapter. No user Session, credentials, external model or cache usage claims.',
    unit: 'UTF-8 serialized bytes; not tokenizer count. Native fixture includes official filesystem and skill tools; it is not a full desktop native 32-tool snapshot.',
    consult: summarize(light, consult.counters), execute: summarize(full, execute.counters) };
  assert.equal(comparison.consult.toolNames.length, 0);
  assert.equal(comparison.consult.sentCatalogMessages, 0);
  assert.equal(comparison.execute.sentCatalogMessages, 1, 'native discovery and required-skill lookup emit exactly one complete catalog to this first execution request');
  assert.ok(comparison.execute.toolNames.length > 0);
  assert.ok(comparison.consult.modelContentBytes < comparison.execute.modelContentBytes);
  assert.equal(comparison.consult.operations.skillBodies, 0);
  assert.equal(comparison.consult.operations.knowledgePrepare, 0);
  assert.ok(comparison.execute.operations.skillBodies > 0);
  const output = resolve('artifacts/resident-chat/native-api'); await mkdir(output, { recursive: true });
  await writeFile(join(output, 'complete-seed-comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
});


test('temporary employee overrides the resident for one native turn and restores its role without changing the binding', async t => {
  const f = await fixture(t);
  await f.set('employee-template-architect', 'execute');
  const binding = resolveConversationEmployee(f.store.snapshot(), f.project.id, f.native.id).conversationEmployee;
  await f.send('由常驻架构师回答');
  const temporary = await f.invokeTemporary('employee-template-product', '由临时产品负责人回答');
  assert.equal(temporary.model, 'employee-template-product');
  assert.deepEqual(resolveConversationEmployee(f.store.snapshot(), f.project.id, f.native.id).conversationEmployee, binding);
  const attempt = f.store.snapshot().runs.filter(run => run.sessionId === f.native.id).at(-1)!;
  assert.equal(attempt.conversationEmployee?.invocation, 'temporary');
  assert.equal(attempt.conversationEmployee?.sessionId, f.native.id);
  assert.equal('bindingVersion' in attempt.conversationEmployee!, false, 'temporary authority has no persistent binding version');
  const restored = await f.send('下一轮恢复常驻架构师');
  assert.equal(restored.model, 'employee-template-architect');
  const productMission = f.store.snapshot().templates.find(template => template.id === 'employee-template-product')!.modules.responsibilities.mission;
  assert.doesNotMatch(pluginContexts(restored).map(section => section.text).join('\n'), new RegExp(productMission));
  assert.match(visible(restored), /OFFLINE_RESIDENT_ANSWER_1/);
  assert.match(visible(restored), /OFFLINE_RESIDENT_ANSWER_2/);
  assert.equal(f.ctx.agents.list().length, 1, 'temporary mention creates no additional Agent or Session');
  assert.equal(f.eventReads(), 1, 'native history is initially observed once and then follows native events');
  assert.equal(f.streams.filter(frame => frame.id === f.native.id && frame.type === 'start').length, 3);
  assert.deepEqual(f.errors, []);
});

test('unbound temporary employee returns to native scope, keeps repeated role definitions stable, and never affects another conversation', async t => {
  const f = await fixture(t);
  const first = await f.invokeTemporary('employee-template-product', '第一次临时处理');
  const second = await f.invokeTemporary('employee-template-product', '第二次临时处理');
  const mission = f.store.snapshot().templates.find(template => template.id === 'employee-template-product')!.modules.responsibilities.mission;
  assert.equal(visible(second).split(mission).length - 1, visible(first).split(mission).length - 1, 'consecutive same-role temporary turns reuse the full native definition without duplicating role or skill descriptions');
  assert.equal(pluginContexts(second).filter(section => section.text.includes(mission)).length, 1);
  assert.ok(first.tools?.some(tool => tool.name === 'worker_memory_search'));
  const unrelated = await f.createNative('temporary-unrelated-session');
  const other = await f.send('另一个对话没有临时员工', unrelated);
  assert.equal(pluginContexts(other).length, 0);
  assert.equal(other.tools?.some(tool => tool.name === 'worker_memory_search'), false);
  const native = await f.send('下一轮普通原生助手');
  assert.equal(pluginContexts(native).length, 0, 'no active employee definition survives the temporary turn');
  assert.ok(native.tools?.some(tool => tool.name === 'read'));
  assert.equal(native.tools?.some(tool => tool.name === 'worker_memory_search'), false);
  assert.equal(resolveConversationEmployee(f.store.snapshot(), f.project.id, f.native.id).conversationEmployee, null);
  assert.equal(f.store.snapshot().runs.filter(run => run.conversationEmployee?.invocation === 'temporary').length, 2);
  assert.equal(f.ctx.agents.list().length, 2, 'only the two explicitly created native conversations exist');
  assert.equal(f.eventReads(), 2, 'each native conversation is observed once rather than replayed per turn');
  assert.match(visible(native), /OFFLINE_RESIDENT_ANSWER_1/);
  assert.match(visible(native), /OFFLINE_RESIDENT_ANSWER_2/);
  assert.deepEqual(f.errors, []);
});


test('the same employee reuses its stable execution definition across temporary and explicit residency', async t => {
  const f = await fixture(t);
  const temporary = await f.invokeTemporary('employee-template-product', '临时处理当前问题');
  await f.set('employee-template-product', 'execute');
  const resident = await f.send('现在明确常驻后继续');
  const mission = f.store.snapshot().templates.find(template => template.id === 'employee-template-product')!.modules.responsibilities.mission;
  assert.equal(visible(resident).split(mission).length - 1, visible(temporary).split(mission).length - 1);
  assert.equal(pluginContexts(resident).filter(section => section.text.includes(mission)).length, 1);
  assert.equal(f.eventReads(), 1);
  assert.equal(f.ctx.agents.list().length, 1);
});

test('a temporary employee streaming in one native conversation cannot expose its context or tools in another', async t => {
  const f = await fixture(t);
  let entered!: () => void, complete!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { complete = resolve; });
  f.adapter.beforeStream = async request => { if (request.sessionId === f.native.id) { entered(); await gate; } };
  const sending = f.invokeTemporary('employee-template-product', '当前临时员工正在回答');
  await started;
  try {
    const other = await f.createNative('temporary-concurrent-native-session');
    const request = await f.send('另一个对话立即使用原生助手', other);
    assert.equal(pluginContexts(request).length, 0);
    assert.equal(request.tools?.some(tool => tool.name === 'worker_memory_search'), false);
    assert.ok(request.tools?.some(tool => tool.name === 'read'));
  } finally { complete(); await sending; }
  assert.equal(f.ctx.agents.list().length, 2);
  assert.deepEqual(f.errors, []);
});


test('a drafted template mention reuses a later customized standalone instance and selects that instance model before native preparation', async t => {
  const f = await fixture(t);
  const templateId = 'employee-template-product';
  f.reserveTemporary(templateId);
  const other = await f.createNative('other-chat-creates-instance-after-draft');
  await f.set(templateId, 'execute', other);
  const existing = resolveConversationEmployee(f.store.snapshot(), f.project.id, other.id).employee!;
  await f.store.updateEmployee(existing.id, { modules: { ...existing.modules, model: { mode: 'override', provider: 'resident-fixture', model: 'custom-instance-model', reasoningEffort: 'high' } } });
  const request = await f.send('send the still-valid drafted template reference');
  assert.equal(request.model, 'custom-instance-model');
  assert.equal(request.reasoningEffort, ReasoningEffortId('high'));
  assert.equal(f.store.snapshot().employees.filter(employee => employee.projectId === f.project.id && employee.templateId === templateId && !employee.teamInstanceId).length, 1);
  const run = f.store.snapshot().runs.find(run => run.sessionId === f.native.id)!;
  assert.equal(run.employeeSnapshot.modules.model.model, 'custom-instance-model');
  assert.equal(run.employeeId, existing.id);
  assert.equal(resolveConversationEmployee(f.store.snapshot(), f.project.id, f.native.id).conversationEmployee, null);
});
