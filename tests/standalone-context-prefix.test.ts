import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import PermissionPresets from '@deepseek-ai/dsh-permission-presets';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as SkillTool from '@deepseek-ai/dsh-tool-skill';
import { WorkforceStore } from '../src/domain/store.js';
import { ARCHITECT_TEMPLATE_ID } from '../src/domain/seed.js';
import { WorkforceRuntime, type KnowledgeRuntime } from '../src/harness/runtime.js';

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Offline fixture answer' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Offline fixture answer' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const visible = (request: GenerateOptions) => JSON.stringify({ system: request.system,
  messages: request.messages.map(message => ({ role: message.role, content: message.content })) });
const occurrences = (text: string, marker: string) => text.split(marker).length - 1;
function contextSections(request: GenerateOptions) {
  return request.messages.flatMap(message => {
    const source = message.source as unknown as { kind: string; sections?: Array<{ name: string; text: string }> };
    return source.kind === 'runtime-context' ? source.sections ?? [] : [];
  });
}

async function fixture(t: TestContext, knowledge?: KnowledgeRuntime) {
  const root = await mkdtemp(resolve(tmpdir(), 'standalone-prefix-'));
  const projectRoot = resolve(root, 'project'); await mkdir(projectRoot);
  await writeFile(resolve(projectRoot, 'README.md'), 'NATIVE_FILE_SENTINEL');
  const store = await WorkforceStore.open(resolve(root, 'state.json'));
  const project = await store.saveProject({ id: 'prefix-project', name: 'Prefix', rootPath: projectRoot });
  let employee = await store.createEmployee({ projectId: project.id, templateId: ARCHITECT_TEMPLATE_ID });
  const modules = structuredClone(employee.modules);
  modules.model = { mode: 'override', provider: 'prefix-fixture', model: 'prefix-model' };
  modules.responsibilities.mission = 'STABLE_ROLE_SENTINEL';
  modules.capabilities.skills = [{ id: 'prefix-required', name: 'Required fixture', description: 'Stable method', usage: 'required' }];
  modules.knowledge.sources = [];
  employee = await store.updateEmployee(employee.id, { modules });

  const ctx = new Context(), adapter = new RecordingAdapter();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(NativeToolExecutor);
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: projectRoot });
  await ctx.plugin(SandboxedFileSystem);
  ctx.provide('shell', { sandboxMode: 'workspace-write' } as never);
  await ctx.plugin(ApprovalService); await ctx.plugin(PermissionPresets, { presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  } });
  await ctx.plugin(WorkingDirectory); await ctx.plugin(SkillRegistry); await ctx.plugin(FileTools);
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(SkillTool);
  ctx.llm.registerAdapter(['prefix-fixture'], adapter);
  ctx.skills.register({ name: 'prefix-required', description: 'Stable method', content: 'STABLE_REQUIRED_SKILL_BODY', source: 'custom' });
  ctx.systemPrompt.section({ name: 'native-prefix-fixture', order: -1000, text: 'NATIVE_SYSTEM_SENTINEL' });
  ctx.systemPrompt.context({ name: 'native-policy-fixture', order: 0, text: 'NATIVE_POLICY_SENTINEL', required: true });
  const sessions: string[] = [];
  ctx.provide('workspaceRegistry', { get: (id: string) => id === project.id
    ? { sessionIds: sessions, attachSession: async (id: string) => { sessions.push(id); } } : undefined } as never);
  const source = await ctx.agents.create({ sessionId: SessionId('prefix-source'), meta: { cwd: projectRoot }, agentOptions: { provider: 'prefix-fixture', model: 'source-model' } });
  sessions.push(source.agent.id);
  ctx.permissionPresets.set(source.agent.session, 'read-only');
  const sourceBefore = JSON.stringify(source.agent.session.snapshotEvents());
  const runtime = new WorkforceRuntime(ctx, store, new Map(), {}, knowledge);
  t.after(async () => { await runtime.dispose(); await source.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const run = async () => {
    const admitted = await runtime.start({ projectId: project.id, employeeId: employee.id, sourceSessionId: source.agent.id, request: 'Explain the current source' });
    const result = await runtime.wait(admitted.id);
    assert.equal(result.status, 'awaiting-review', result.error);
    const agent = ctx.agents.get(SessionId(result.sessionId!)); assert.ok(agent);
    assert.equal(ctx.permissionPresets.current(agent.session), 'read-only');
    assert.equal(ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only');
    assert.equal(agent.session.snapshotEvents().findLast(event => event.type === 'approval/policy')?.data.policy, 'ask');
    assert.equal(JSON.stringify(source.agent.session.snapshotEvents()), sourceBefore, 'reading policy never rewrites the source conversation');
    const request = adapter.requests.at(-1)!;
    for (const name of ['read', 'write', 'edit', 'skill', 'worker_memory_search']) assert.ok(request.tools?.some(tool => tool.name === name), `native/employee tool ${name} remains available under the native policy`);
    assert.match(visible(request), /NATIVE_SYSTEM_SENTINEL/); assert.match(visible(request), /NATIVE_POLICY_SENTINEL/);
    return request;
  };
  return { projectRoot, store, employee, modules, adapter, run };
}

test('standalone C updates retain the complete role and required-skill prefix while current knowledge appears once', async t => {
  let overview = 'CURRENT_C_ONE_SENTINEL';
  const knowledge: KnowledgeRuntime = {
    spacesForEmployee: () => [{ kind: 'project', projectId: 'prefix-project', teamId: 'prefix-team' }],
    overviewFor: async () => overview, prepareFor: async () => undefined, ingestFor: async () => undefined,
    searchFor: async () => [], readFor: async () => undefined,
  };
  const f = await fixture(t, knowledge);
  const first = await f.run(); overview = 'CURRENT_C_TWO_SENTINEL'; const second = await f.run();
  const definitions = [first, second].map(request => contextSections(request).find(section => section.name === 'digital-worker:identity')!);
  assert.ok(definitions.every(Boolean));
  for (const definition of definitions) {
    assert.match(definition.text, /STABLE_ROLE_SENTINEL/);
    assert.match(definition.text, /STABLE_REQUIRED_SKILL_BODY/);
    assert.match(definition.text, /A 仅在以下条件激活/);
    assert.match(definition.text, /完成后给出交付摘要/);
    assert.doesNotMatch(definition.text, /CURRENT_C_(?:ONE|TWO)_SENTINEL/, 'changing C is data after the stable role and loaded Skill');
  }
  assert.equal(definitions[0]!.text, definitions[1]!.text, 'C changes do not rewrite the full role/required-skill definition');
  for (const [index, request] of [first, second].entries()) {
    const current = index ? 'CURRENT_C_TWO_SENTINEL' : 'CURRENT_C_ONE_SENTINEL';
    const previous = index ? 'CURRENT_C_ONE_SENTINEL' : 'CURRENT_C_TWO_SENTINEL';
    const task = contextSections(request).find(section => section.name === 'composable-workforce:task-context'); assert.ok(task);
    assert.match(task.text, new RegExp(current));
    assert.equal(occurrences(visible(request), current), 1);
    assert.equal(occurrences(visible(request), 'STABLE_REQUIRED_SKILL_BODY'), 1);
    assert.doesNotMatch(visible(request), new RegExp(previous));
    assert.ok(visible(request).indexOf('STABLE_REQUIRED_SKILL_BODY') < visible(request).indexOf(current));
  }
  const prefix = (request: GenerateOptions) => {
    const task = contextSections(request).find(section => section.name === 'composable-workforce:task-context')!;
    const text = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n');
    const position = text.indexOf(task.text); assert.ok(position >= 0); return text.slice(0, position);
  };
  assert.equal(prefix(first), prefix(second), 'the model-visible stable prefix stays byte-for-byte equal before the data section');
  assert.deepEqual(first.tools, second.tools, 'C changes preserve the full native tool schemas');
  assert.equal(f.adapter.requests.length, 2, 'no preparation or cache-warming model call is introduced');
});

test('standalone project-file updates stay after required Skills without dropping or duplicating source evidence', async t => {
  const f = await fixture(t);
  f.modules.knowledge.sources = [{ id: 'fixture-file', title: 'Current evidence', kind: 'project-file', value: 'README.md' }];
  await f.store.updateEmployee(f.employee.id, { modules: f.modules });
  const first = await f.run();
  await writeFile(resolve(f.projectRoot, 'README.md'), 'UPDATED_FILE_SENTINEL {{literal}}');
  const second = await f.run();
  const firstDefinition = contextSections(first).find(section => section.name === 'digital-worker:identity')!;
  const secondDefinition = contextSections(second).find(section => section.name === 'digital-worker:identity')!;
  assert.equal(firstDefinition.text, secondDefinition.text, 'changing a referenced file does not alter the role/required-skill prefix');
  assert.match(firstDefinition.text, /STABLE_REQUIRED_SKILL_BODY/);
  assert.doesNotMatch(firstDefinition.text, /NATIVE_FILE_SENTINEL|UPDATED_FILE_SENTINEL/);
  assert.equal(occurrences(visible(first), 'NATIVE_FILE_SENTINEL'), 1);
  assert.equal(occurrences(visible(second), 'UPDATED_FILE_SENTINEL'), 1);
  assert.doesNotMatch(visible(second), /NATIVE_FILE_SENTINEL/);
  assert.match(visible(second), /\{\{literal\}\}/, 'source data is not interpolated as a prompt template');
  assert.ok(visible(second).indexOf('STABLE_REQUIRED_SKILL_BODY') < visible(second).indexOf('UPDATED_FILE_SENTINEL'));
  assert.deepEqual(first.tools, second.tools);
});
