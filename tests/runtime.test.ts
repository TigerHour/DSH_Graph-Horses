import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { ReasoningEffortId, ToolCallId, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import FileSystem from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import { WorkforceStore } from '../src/domain/store.js';
import { ARCHITECT_TEMPLATE_ID, createArchitectModules } from '../src/domain/seed.js';
import { WorkforceRuntime, matchesPath, resolveProjectPath } from '../src/harness/runtime.js';
import { assertRequestOrigin } from '../src/harness/host.js';
import { WorkflowRepository } from '../src/workflow/repository.js';
import { WorkflowEngine } from '../src/workflow/engine.js';

/** A scripted adapter exists only in tests; the production runtime has no response fallback. */
class ScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  constructor(private steps: Array<(request: GenerateOptions) => Promise<StreamChunk[]> | StreamChunk[]>) { super(); }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const next = this.steps.shift();
    if (!next) throw new Error('test script exhausted');
    for (const chunk of await next(request)) yield chunk;
  }
}
const text = (value: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const call = (name: string, args: object): StreamChunk[] => {
  const id = ToolCallId('fixture-call');
  const argument = JSON.stringify(args);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argument },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argument } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
};

async function fixture(adapter: ScriptedAdapter, config: ConstructorParameters<typeof WorkforceRuntime>[3] = {}, knowledge?: ConstructorParameters<typeof WorkforceRuntime>[4]) {
  const root = await mkdtemp(resolve(tmpdir(), 'workforce-runtime-'));
  const projectRoot = resolve(root, 'project');
  await mkdir(projectRoot);
  await writeFile(resolve(projectRoot, 'README.md'), '# Runtime fixture');
  const store = await WorkforceStore.open(resolve(root, 'state.json'));
  const project = await store.saveProject({ id: 'workspace-fixture', name: 'Fixture', rootPath: projectRoot });
  let employee = await store.createEmployee({ projectId: project.id, templateId: ARCHITECT_TEMPLATE_ID });
  const modules = structuredClone(employee.modules);
  modules.model = { mode: 'override', provider: 'fixture', model: 'fixture-model' };
  modules.capabilities.skills = [];
  employee = await store.updateEmployee(employee.id, { modules });
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime); await ctx.plugin(NativeToolExecutor);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(['fixture'], adapter);
  const attached: string[] = [];
  // Workspace persistence is independently tested in Harness; keep the real agent/tool loop here.
  const workspace = { sessionIds: attached, attachSession: async (id: string) => { attached.push(id); } };
  ctx.provide('workspaceRegistry', { get: (id: string) => id === project.id ? workspace : undefined } as never);
  const runtime = new WorkforceRuntime(ctx, store, new Map(), config, knowledge);
  return { root, projectRoot, store, project, employee, ctx, runtime, attached, workspace };
}

test('team knowledge injects C only and reads referenced B through the existing memory tool', async () => {
  const adapter = new ScriptedAdapter([
    request => {
      const prompt = JSON.stringify(request);
      assert.match(prompt, /C_OVERVIEW_SENTINEL/);
      assert.doesNotMatch(prompt, /PRIVATE_MEMORY_BODY|RAW_CONFIG_BODY/);
      return call('worker_memory_search', { knowledgeId: 'entry', layer: 'B', library: 'employee', version: 1 });
    },
    request => { assert.match(JSON.stringify(request), /B_DETAIL_SENTINEL/); return text('已依据详细知识核查'); },
  ]);
  const knowledge = {
    spacesForEmployee: () => [{ kind: 'project' as const, projectId: 'workspace-fixture', teamId: 'team', memberId: 'member' }],
    overviewFor: async () => 'C_OVERVIEW_SENTINEL；B entry，快照版本1，library employee',
    prepareFor: async () => undefined,
    ingestFor: async () => undefined,
    searchFor: async () => [],
    readFor: async () => ({ id: 'entry', content: 'B_DETAIL_SENTINEL' }),
  };
  const f = await fixture(adapter, {}, knowledge);
  await f.store.saveMemory({ projectId: f.project.id, scope: 'employee', employeeId: f.employee.id, title: '已确认记忆', content: 'PRIVATE_MEMORY_BODY', source: { kind: 'user-confirmed', reference: 'user' } });
  const modules = structuredClone(f.employee.modules);
  modules.knowledge.sources = [{ id: 'raw', title: '配置资料', kind: 'text', value: 'RAW_CONFIG_BODY' }];
  f.employee = await f.store.updateEmployee(f.employee.id, { modules });
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '读取关联详细知识' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'awaiting-review', result.error);
  await f.runtime.dispose();
});

test('disabled librarian excludes old memory and memory tools while current task materials still work', async () => {
  const adapter = new ScriptedAdapter([request => {
    const payload = JSON.stringify(request);
    assert.doesNotMatch(payload, /OLD_MEMORY_SENTINEL|C_DISABLED_SENTINEL/);
    assert.match(payload, /EXPLICIT_TASK_MATERIAL/);
    assert.ok(!request.tools?.some(tool => tool.name.startsWith('worker_memory_')));
    return text('根据本次资料完成任务');
  }]);
  const knowledge = {
    spacesForEmployee: () => [{ kind: 'project' as const, projectId: 'workspace-fixture', teamId: 'team' }],
    overviewFor: async () => 'C_DISABLED_SENTINEL', prepareFor: async () => undefined,
    ingestFor: async () => undefined, searchFor: async () => [], readFor: async () => undefined,
  };
  const f = await fixture(adapter, {}, knowledge);
  const team = await f.store.saveTeam({ name: 'Disabled memory team', knowledgeEnabled: false, members: [{ memberId: 'lead', templateId: ARCHITECT_TEMPLATE_ID }] });
  await f.store.configureProjectTeam({ projectId: f.project.id, teamId: team.id, teamVersion: team.version, templateVersions: { [ARCHITECT_TEMPLATE_ID]: f.employee.templateVersion } });
  await f.store.saveMemory({ projectId: f.project.id, scope: 'employee', employeeId: f.employee.id, title: 'Old', content: 'OLD_MEMORY_SENTINEL', source: { kind: 'user-confirmed', reference: 'User' } });
  const modules = structuredClone(f.employee.modules);
  modules.knowledge.sources = [{ id: 'current', title: '本次资料', kind: 'text', value: 'EXPLICIT_TASK_MATERIAL' }];
  await f.store.updateEmployee(f.employee.id, { modules });
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '使用本次资料' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'awaiting-review', result.error);
  assert.equal(f.store.listMemories(f.project.id, f.employee.id).length, 1);
  await f.runtime.dispose();
});

test('turning off a librarian after C was injected stops subsequent model requests', async () => {
  let disable: () => Promise<unknown> = async () => undefined;
  const adapter = new ScriptedAdapter([async () => { await disable(); return call('worker_read_file', { path: 'README.md' }); }]);
  const knowledge = {
    spacesForEmployee: () => [{ kind: 'project' as const, projectId: 'workspace-fixture', teamId: 'team' }],
    overviewFor: async () => 'Previously injected team knowledge', prepareFor: async () => undefined,
    ingestFor: async () => undefined, searchFor: async () => [], readFor: async () => undefined,
  };
  const f = await fixture(adapter, {}, knowledge);
  const team = await f.store.saveTeam({ name: 'Team', members: [{ memberId: 'lead', templateId: ARCHITECT_TEMPLATE_ID }] });
  const installed = await f.store.configureProjectTeam({ projectId: f.project.id, teamId: team.id, teamVersion: team.version, templateVersions: { [ARCHITECT_TEMPLATE_ID]: f.employee.templateVersion } });
  disable = () => f.store.setProjectTeamKnowledge({ projectId: f.project.id, teamId: installed.id, version: installed.version ?? 1, enabled: false });
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '使用团队知识' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /记忆已关闭|资料管理员已关闭/);
  assert.equal(adapter.requests.length, 1);
  await f.runtime.dispose();
});

test('A activation requires a reason and returns only the exact requested source window', async () => {
  const raw = ['OUTSIDE_A_SENTINEL', ...Array.from({ length: 45 }, (_, index) => `原始资料第${index}行`), 'timeout = 12; // seconds', '禁止将单位改成毫秒；流式导出除外。', ...Array.from({ length: 45 }, () => '无关原文。')].join('\n');
  const adapter = new ScriptedAdapter([
    () => call('worker_memory_search', { knowledgeId: 'memory:confirmed-fact', layer: 'A', library: 'employee', version: 4, startLine: 47, endLine: 48 }),
    request => { assert.match(JSON.stringify(request), /A 原文读取必须说明 reason/); return call('worker_memory_search', { knowledgeId: 'memory:confirmed-fact', layer: 'A', library: 'employee', version: 4, reason: 'exact-detail', startLine: 47, endLine: 48 }); },
    request => {
      const packets = request.messages.flatMap(message => message.role === 'tool' ? message.content.flatMap(block => {
        if (block.type !== 'text') return [];
        try { const value = JSON.parse(block.text); return value.kind === 'workforce-knowledge-context' ? [value] : []; } catch { return []; }
      }) : []);
      const a = packets.find(packet => packet.layer === 'A');
      assert.ok(a); assert.equal(a.reason, 'exact-detail');
      assert.equal(a.pieces[0].version, 4); assert.equal(a.pieces[0].startLine, 47); assert.equal(a.pieces[0].endLine, 48);
      assert.match(a.pieces[0].text, /timeout = 12; \/\/ seconds/); assert.match(a.pieces[0].text, /流式导出除外/);
      assert.doesNotMatch(JSON.stringify(a), /OUTSIDE_A_SENTINEL/);
      assert.ok(Buffer.byteLength(JSON.stringify(a)) <= 2_000);
      return text('原文采用12秒，流式导出除外。');
    },
  ]);
  let reads = 0;
  const knowledge = {
    spacesForEmployee: () => [{ kind: 'project' as const, projectId: 'workspace-fixture', teamId: 'team' }],
    overviewFor: async () => '需要精确值时回查 A original@4', prepareFor: async () => undefined,
    ingestFor: async () => undefined, searchFor: async () => [],
    readFor: async () => { reads++; return { id: 'memory:confirmed-fact', title: '原始接口', text: raw, content: raw, version: 4, library: 'employee', verified: false }; },
  };
  const f = await fixture(adapter, {}, knowledge);
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '核验超时单位与例外' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'awaiting-review', result.error); assert.equal(reads, 1);
  await f.runtime.dispose();
});

test('multi-step worker reads obey cumulative B and ABC limits on the real model surface', async () => {
  const steps = Array.from({ length: 5 }, (_, index) => () => call('worker_memory_search', { knowledgeId: `detail-${index}`, layer: 'B', library: 'team', version: 1 }));
  const adapter = new ScriptedAdapter([...steps, request => {
    const packets = request.messages.flatMap(message => message.role === 'tool' ? message.content.flatMap(block => {
      if (block.type !== 'text') return [];
      try { const value = JSON.parse(block.text); return value.kind?.startsWith('workforce-knowledge-') ? [value] : []; } catch { return []; }
    }) : []);
    assert.ok(packets.some(packet => packet.contentOmitted || (packet.truncated && !packet.pieces?.length)), `older tool bodies should be compacted before the next provider request: ${JSON.stringify(packets.map(packet => ({ kind: packet.kind, id: packet.directory?.[0]?.id, pieces: packet.pieces?.length, tokens: packet.tokenEstimate })))}`);
    const total = packets.reduce((sum, packet) => sum + Buffer.byteLength(JSON.stringify(packet)), 0);
    assert.ok(total <= 8_000); assert.match(JSON.stringify(packets), /LATEST_DETAIL_SENTINEL/);
    return text('依据当前保留的版本化证据完成。');
  }]);
  const knowledge = {
    spacesForEmployee: () => [{ kind: 'project' as const, projectId: 'workspace-fixture', teamId: 'team' }],
    overviewFor: async () => '任务相关主题入口', prepareFor: async () => undefined, ingestFor: async () => undefined, searchFor: async () => [],
    readFor: async (_employee: unknown, _layer: unknown, id: string) => ({ id, title: id, content: `${id === 'detail-4' ? 'LATEST_DETAIL_SENTINEL' : 'DETAIL'}\n${'保持证据原文和条件；\n'.repeat(130)}`, version: 1, library: 'team' }),
  };
  const f = await fixture(adapter, {}, knowledge);
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '核查五份主题知识' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'awaiting-review', result.error);
  await f.runtime.dispose();
});

test('withdrawn memory already summarized in C stops further model calls until a fresh task', async () => {
  let withdraw: () => Promise<void> = async () => undefined;
  const adapter = new ScriptedAdapter([async () => { await withdraw(); return call('worker_memory_search', { query: 'withdrawn' }); }]);
  const knowledge = {
    spacesForEmployee: () => [{ kind: 'project' as const, projectId: 'workspace-fixture', teamId: 'team', memberId: 'member' }],
    overviewFor: async () => 'C summary based on the current private memory', prepareFor: async () => undefined,
    ingestFor: async () => undefined, searchFor: async () => [], readFor: async () => undefined,
  };
  const f = await fixture(adapter, {}, knowledge);
  const memory = await f.store.saveMemory({ projectId: f.project.id, scope: 'employee', employeeId: f.employee.id, title: 'Withdrawn', content: 'Source to withdraw', source: { kind: 'user-confirmed', reference: 'User' } });
  withdraw = () => f.store.deleteMemory(memory.id);
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: 'Use current knowledge' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /来源或读取权限已撤回/);
  assert.equal(adapter.requests.length, 1);
  await f.runtime.dispose();
});

test('path grants intersect and reject traversal and symlink escapes', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'workforce-path-'));
  await mkdir(resolve(root, 'docs'));
  await writeFile(resolve(root, 'docs/file.md'), 'allowed');
  const grant = createArchitectModules().permissions;
  grant.readPaths = ['docs/**'];
  grant.writePaths = ['docs/**'];
  assert(matchesPath('docs/nested/a.md', 'docs/**'));
  assert(!matchesPath('docs/nested/a.md', 'docs/*.md'));
  assert(matchesPath('README.md', '**/*.md'));
  await resolveProjectPath(root, 'docs/file.md', [grant], 'read');
  await assert.rejects(resolveProjectPath(root, '../secret', [grant], 'read'), /项目范围/);
  await symlink(tmpdir(), resolve(root, 'docs/alias'));
  await assert.rejects(resolveProjectPath(root, 'docs/alias/secret', [grant], 'write'), /符号链接/);
  await assert.rejects(resolveProjectPath(root, 'docs/file.md', [grant, { ...grant, readPaths: [] }], 'read'), /授权/);
});

test('HTTP routes require exact same-origin writes and reject rebinding hosts', () => {
  const allowed = ['http://localhost:1234'];
  assertRequestOrigin({ method: 'POST', headers: { host: 'localhost:1234', origin: allowed[0] } }, allowed);
  assert.throws(() => assertRequestOrigin({ method: 'POST', headers: { host: 'localhost:1234' } }, allowed), /Origin/);
  assert.throws(() => assertRequestOrigin({ method: 'POST', headers: { host: 'localhost:1234', origin: 'https://evil.example' } }, allowed), /同源/);
  assert.throws(() => assertRequestOrigin({ method: 'GET', headers: { host: 'evil.example:1234' } }, allowed), /主机/);
});

test('Desktop proxy writes require the custom header and keep origin, metadata and host fences', () => {
  const allowed = ['http://localhost:1234'];
  const desktop = { host: 'localhost:1234', 'x-dsh-graph-horses': '1' };
  assertRequestOrigin({ method: 'POST', headers: desktop }, allowed);
  assert.throws(() => assertRequestOrigin({ method: 'POST', headers: { ...desktop, 'x-dsh-graph-horses': '0' } }, allowed), /Origin/);
  assert.throws(() => assertRequestOrigin({ method: 'POST', headers: { ...desktop, origin: 'https://evil.example' } }, allowed), /同源/);
  assert.throws(() => assertRequestOrigin({ method: 'POST', headers: { ...desktop, 'sec-fetch-site': 'cross-site' } }, allowed), /跨站/);
  assert.throws(() => assertRequestOrigin({ method: 'POST', headers: { ...desktop, host: 'evil.example:1234' } }, allowed), /主机/);
});

test('real Harness loop runs isolated sessions, includes project memory, and awaits review', async () => {
  const adapter = new ScriptedAdapter([() => text('架构方案已交付'), () => text('后续答复')]);
  const f = await fixture(adapter);
  f.ctx.systemPrompt.context({ name: 'unrelated-host-memory', order: 0, text: 'UNRELATED_HOST_CONTEXT_SENTINEL' });
  await f.store.saveMemory({ projectId: f.project.id, scope: 'employee', employeeId: f.employee.id, title: '命名约定', content: '接口字段使用 snake_case；模板符号 {{literal}} 必须原样保留。', source: { kind: 'user-confirmed', reference: 'test user' } });
  const first = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '分析架构' });
  const result = await f.runtime.wait(first.id);
  assert.equal(result.status, 'awaiting-review', result.error);
  assert.equal(result.output, '架构方案已交付');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 8, modelCalls: 1, reportedCalls: 1 });
  assert.equal(f.attached[0], result.sessionId);
  assert.notEqual(result.sessionId, f.employee.id);
  assert.match(JSON.stringify(adapter.requests[0]), /snake_case/);
  assert.match(JSON.stringify(adapter.requests[0]), /UNRELATED_HOST_CONTEXT_SENTINEL/, 'native runtime policy/context is preserved');
  assert.match(JSON.stringify(adapter.requests[0]), /\{\{literal\}\}/);
  assert.equal(adapter.requests[0]!.provider, 'fixture');
  assert.equal(adapter.requests[0]!.maxTokens, 8_000, 'provider output cap must match the reserved window allowance');
  assert(adapter.requests[0]!.tools?.every(tool => tool.name.startsWith('worker_') || tool.name === 'skill'));
  const accepted = await f.store.reviewRun(result.id, { decision: 'accepted', reviewer: 'test user' });
  assert.equal(accepted.status, 'succeeded');
  const second = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '继续讨论' });
  const next = await f.runtime.wait(second.id);
  assert.notEqual(next.sessionId, result.sessionId);
  assert.equal(next.employeeId, result.employeeId);
  await f.runtime.dispose();
});

test('native writes register project artifacts and retain native overwrite behavior', async () => {
  const adapter = new ScriptedAdapter([
    () => call('write', { file_path: 'docs/architecture/proposal.md', content: '# Verified artifact' }),
    () => call('write', { file_path: 'docs/architecture/proposal.md', content: 'overwritten' }),
    () => text('已提交修订后的方案。'),
  ]);
  const f = await fixture(adapter);
  await f.ctx.plugin(FileSystem); await f.ctx.plugin(WorkingDirectory); await f.ctx.plugin(FileTools);
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '写出方案' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'awaiting-review', result.error);
  assert.equal(result.artifacts.length, 1);
  assert.equal(await readFile(resolve(f.projectRoot, 'docs/architecture/proposal.md'), 'utf8'), 'overwritten');
  assert.equal(result.artifacts[0]!.content, 'overwritten');
  await f.runtime.dispose();
});

test('legacy employee tool permissions do not revoke native read capabilities', async () => {
  let revoke: () => Promise<unknown> = async () => undefined;
  const adapter = new ScriptedAdapter([
    async () => { await revoke(); return call('read', { file_path: 'README.md' }); },
    () => text('通过原生工具读取完成。'),
  ]);
  const f = await fixture(adapter);
  await f.ctx.plugin(FileSystem); await f.ctx.plugin(WorkingDirectory); await f.ctx.plugin(FileTools);
  revoke = async () => {
    const modules = structuredClone(f.employee.modules);
    modules.permissions.allowedTools = modules.permissions.allowedTools.filter(name => name !== 'worker_read_file');
    return f.store.updateEmployee(f.employee.id, { modules });
  };
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '读取项目' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'awaiting-review', result.error);
  assert.match(JSON.stringify(adapter.requests[1]), /# Runtime fixture/);
  await f.runtime.dispose();
});

test('unconfigured or failed providers produce a failed run without simulated content', async () => {
  const f = await fixture(new ScriptedAdapter([() => { throw new Error('provider unavailable'); }]));
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '运行失败情况' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /provider unavailable/);
  assert.equal(result.output, '');
  await f.runtime.dispose();
});

test('the runtime stops repeated model-tool loops at its configured step budget', async () => {
  const adapter = new ScriptedAdapter([() => call('worker_list_files', {}), () => call('worker_list_files', {}), () => text('should not run')]);
  const f = await fixture(adapter, { maxSteps: 2 });
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '检查循环限制' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /步数上限/);
  assert.equal(adapter.requests.length, 2);
  await f.runtime.dispose();
});

test('delegation creates a child work order and real child session using the project roster', async () => {
  let childId = '';
  const adapter = new ScriptedAdapter([
    () => call('worker_delegate', { employeeId: childId, request: '评审模块边界并回报结论' }),
    () => text('子员工评审：模块边界清晰。'),
    () => text('技术负责人已核验评审结论，提交验收。'),
  ]);
  const f = await fixture(adapter);
  const modules = structuredClone(f.employee.modules);
  modules.collaboration.allowedTemplateIds = [ARCHITECT_TEMPLATE_ID];
  await f.store.updateEmployee(f.employee.id, { modules });
  const employee = await f.store.createEmployee({ projectId: f.project.id, templateId: ARCHITECT_TEMPLATE_ID, name: '评审协作者', managerId: f.employee.id });
  childId = employee.id;
  const childModules = structuredClone(modules);
  childModules.collaboration.canDelegate = false;
  childModules.collaboration.allowedTemplateIds = [];
  await f.store.updateEmployee(childId, { modules: childModules });
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '请委派评审协作者审核架构' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'awaiting-review', result.error);
  const child = f.store.snapshot().runs.find(item => item.parentRunId === run.id)!;
  assert(child);
  assert.equal(child.status, 'awaiting-review', child.error);
  assert.equal(child.employeeId, childId);
  assert.notEqual(child.sessionId, result.sessionId);
  assert.match(JSON.stringify(adapter.requests[0]), new RegExp(childId));
  assert.match(JSON.stringify(adapter.requests[2]), /子员工评审/);
  await f.runtime.dispose();
});

test('delegated knowledge remains dependent on the child team librarian before the parent next turn', async () => {
  let childId = ''; let disable: () => Promise<unknown> = async () => undefined;
  const adapter = new ScriptedAdapter([
    () => call('worker_delegate', { employeeId: childId, request: '根据团队知识评审' }),
    async request => { assert.match(JSON.stringify(request), /CHILD_TEAM_KNOWLEDGE/); await disable(); return text('依据子团队知识整理的评审结果'); },
  ]);
  const knowledge = {
    spacesForEmployee: (employee: { id: string }) => employee.id === childId ? [{ kind: 'project' as const, projectId: 'workspace-fixture', teamId: 'child-team' }] : [],
    overviewFor: async () => 'CHILD_TEAM_KNOWLEDGE', prepareFor: async () => undefined,
    ingestFor: async () => undefined, searchFor: async () => [], readFor: async () => undefined,
  };
  const f = await fixture(adapter, {}, knowledge);
  const helper = await f.store.saveTemplate({ name: '跨团队协作者', status: 'ready', modules: f.employee.modules });
  const team = await f.store.saveTeam({ name: '协作者团队', members: [{ memberId: 'lead', templateId: helper.id }] });
  const installed = await f.store.configureProjectTeam({ projectId: f.project.id, teamId: team.id, teamVersion: team.version, templateVersions: { [helper.id]: helper.version } });
  childId = installed.members[0]!.employeeId;
  const modules = structuredClone(f.employee.modules); modules.collaboration.allowedTemplateIds = [helper.id];
  await f.store.updateEmployee(f.employee.id, { modules });
  disable = () => f.store.setProjectTeamKnowledge({ projectId: f.project.id, teamId: installed.id, enabled: false, version: installed.version ?? 1 });
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '请跨团队委派评审' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /资料管理员已关闭/);
  assert.equal(adapter.requests.length, 2);
  await f.runtime.dispose();
});

test('cancellation stops the active provider and persists a cancelled work order', async () => {
  let entered: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const adapter = new ScriptedAdapter([request => new Promise<StreamChunk[]>((_resolve, reject) => {
    entered();
    const cancelled = () => reject(new Error('cancelled by test'));
    if (request.signal?.aborted) cancelled();
    else request.signal?.addEventListener('abort', cancelled, { once: true });
  })]);
  const f = await fixture(adapter);
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '等待用户取消' });
  await ready;
  f.runtime.cancel(run.id);
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(f.ctx.agents.list().length, 1, 'cancelled delivery history remains visible');
  await f.runtime.dispose();
  assert.equal(f.ctx.agents.list().length, 0);
});

test('pending DSH default catalog reads stop promptly on cancellation and disposal', async t => {
  for (const action of ['cancel', 'dispose'] as const) await t.test(action, async () => {
    let entered: () => void = () => undefined;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let release: () => void = () => undefined;
    const catalog = new Promise(resolve => { release = () => resolve({ default: { provider: 'fixture', model: 'default-model' }, groups: [], failures: [] }); });
    const adapter = new ScriptedAdapter([() => text('取消后不应发起模型请求')]);
    const f = await fixture(adapter);
    f.ctx.provide('sessionController', { modelCatalog: () => { entered(); return catalog; } } as never);
    const modules = structuredClone(f.employee.modules);
    modules.model = { mode: 'inherit' };
    await f.store.updateEmployee(f.employee.id, { modules });
    const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '等待挂起的默认模型目录' });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await ready;
      const completion = action === 'cancel' ? f.runtime.cancel(run.id).then(() => f.runtime.wait(run.id)) : f.runtime.dispose();
      await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error(`${action} waited for an unfinished DSH catalog read`)), 1000); }),
      ]);
      const result = await f.runtime.wait(run.id);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.sessionId, undefined);
      assert.equal(adapter.requests.length, 0);
      assert.equal(f.ctx.agents.list().length, 0);
      assert.deepEqual(f.attached, []);
    } finally {
      if (deadline) clearTimeout(deadline);
      release();
      await f.runtime.dispose();
    }
  });
});

test('source session membership is checked even when no live agent can be found', async () => {
  const f = await fixture(new ScriptedAdapter([() => text('来自本项目历史会话的新工作')]));
  await assert.rejects(f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '请求', sourceSessionId: 'unknown-cold-session' }), /来源会话必须属于当前项目/);
  assert.equal(f.store.snapshot().runs.length, 0);
  f.attached.push('known-cold-session');
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '请求', sourceSessionId: 'known-cold-session' });
  assert.equal((await f.runtime.wait(run.id)).status, 'awaiting-review');
  await f.runtime.dispose();
});

test('default mode follows the live DSH default instead of the source conversation', async t => {
  for (const withSource of [false, true]) await t.test(withSource ? 'with a source conversation' : 'without a source conversation', async () => {
    class ReasoningAdapter extends ScriptedAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: '高' }] } };
      }
    }
    const adapter = new ReasoningAdapter([() => text('使用 DSH 默认模型交付'), () => text('使用更新后的默认模型交付')]);
    const f = await fixture(adapter);
    let defaultReads = 0;
    let currentModel = 'default-model';
    f.ctx.provide('sessionController', { modelCatalog: async () => {
      defaultReads++;
      return { default: { provider: 'fixture', model: currentModel, reasoningEffort: 'high' }, groups: [], failures: [] };
    } } as never);
    const modules = structuredClone(f.employee.modules);
    modules.model = { mode: 'inherit', provider: 'old-provider', model: 'old-model', reasoningEffort: 'old-effort' };
    await f.store.updateEmployee(f.employee.id, { modules });
    const source = withSource ? await f.ctx.agents.create({ sessionId: SessionId('model-source-session'), meta: { cwd: f.projectRoot }, agentOptions: { provider: 'fixture', model: 'source-model' } }) : undefined;
    if (source) f.attached.push(source.agent.id);
    try {
      const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '使用默认模型运行人员', ...(source ? { sourceSessionId: source.agent.id } : {}) });
      const result = await f.runtime.wait(run.id);
      assert.equal(result.status, 'awaiting-review', result.error);
      assert.equal(adapter.requests[0]!.provider, 'fixture');
      assert.equal(adapter.requests[0]!.model, 'default-model');
      assert.equal(adapter.requests[0]!.reasoningEffort, 'high');
      currentModel = 'updated-default';
      const second = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '按更新后的默认模型运行' });
      assert.equal((await f.runtime.wait(second.id)).status, 'awaiting-review');
      assert.equal(adapter.requests[1]!.model, 'updated-default');
      assert.equal(defaultReads, 2, 'each new run reads the current DSH default');
      assert.deepEqual(f.store.snapshot().employees.find(employee => employee.id === f.employee.id)!.modules.model, modules.model, 'using the default does not rewrite existing employee data');
      if (source) assert.equal(source.agent.options.model, 'source-model');
    } finally {
      await f.runtime.dispose();
      await source?.dispose();
    }
  });
});

test('missing DSH default fails safely rather than choosing the first available model', async () => {
  const adapter = new ScriptedAdapter([() => text('不应发起模型请求')]);
  const f = await fixture(adapter);
  let catalogReads = 0;
  f.ctx.provide('sessionController', { modelCatalog: async () => {
    catalogReads++;
    return { groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'first-model', name: 'First' }] }], failures: [] };
  } } as never);
  const modules = structuredClone(f.employee.modules);
  modules.model = { mode: 'inherit' };
  await f.store.updateEmployee(f.employee.id, { modules });
  try {
    const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '检查无默认模型的运行' });
    const result = await f.runtime.wait(run.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /默认.*模型|模型.*默认/);
    assert.equal(result.sessionId, undefined);
    assert.equal(adapter.requests.length, 0);
    assert.equal(catalogReads, 1);
    assert.deepEqual(f.store.snapshot().employees.find(employee => employee.id === f.employee.id)!.modules.model, { mode: 'inherit' });
  } finally {
    await f.runtime.dispose();
  }
});

test('an employee uses its selected model and reasoning effort independently of the source and DSH default', async () => {
  class ReasoningAdapter extends ScriptedAdapter {
    override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: '高' }] } };
    }
  }
  const adapter = new ReasoningAdapter([() => text('使用人员选定模型交付')]);
  const f = await fixture(adapter);
  let defaultReads = 0;
  f.ctx.provide('sessionController', { modelCatalog: async () => { defaultReads++; return { default: { provider: 'fixture', model: 'default-model' }, groups: [], failures: [] }; } } as never);
  const modules = structuredClone(f.employee.modules);
  modules.model = { mode: 'override', provider: 'fixture', model: 'employee-model', reasoningEffort: 'high' };
  await f.store.updateEmployee(f.employee.id, { modules });
  const source = await f.ctx.agents.create({ sessionId: SessionId('model-source-session'), meta: { cwd: f.projectRoot }, agentOptions: { provider: 'fixture', model: 'source-model' } });
  f.attached.push(source.agent.id);
  try {
    const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '按人员配置运行', sourceSessionId: source.agent.id });
    const result = await f.runtime.wait(run.id);
    assert.equal(result.status, 'awaiting-review', result.error);
    assert.equal(adapter.requests.length, 1);
    assert.equal(adapter.requests[0]!.provider, 'fixture');
    assert.equal(adapter.requests[0]!.model, 'employee-model');
    assert.equal(adapter.requests[0]!.reasoningEffort, 'high');
    assert.equal(defaultReads, 0);
    assert.equal(source.agent.options.model, 'source-model');
  } finally {
    await f.runtime.dispose();
    await source.dispose();
  }
});

test('cancelling a queued job persists immediately without waiting for the earlier employee job', async () => {
  let entered: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const adapter = new ScriptedAdapter([request => new Promise<StreamChunk[]>((_resolve, reject) => {
    entered();
    request.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  })]);
  const f = await fixture(adapter);
  const first = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '第一个尚未结束的任务' });
  await ready;
  const queued = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '不应该执行的排队任务' });
  await f.runtime.cancel(queued.id);
  assert.equal(f.store.snapshot().runs.find(run => run.id === queued.id)!.status, 'cancelled');
  assert.equal(f.store.snapshot().runs.find(run => run.id === first.id)!.status, 'running');
  await f.runtime.cancel(first.id);
  assert.equal((await f.runtime.wait(queued.id)).status, 'cancelled');
  assert.equal(adapter.requests.length, 1);
  await f.runtime.dispose();
});

test('session IDs become visible only after native creation and workspace attachment complete', async () => {
  const adapter = new ScriptedAdapter([() => text('原生会话已可导航')]);
  const f = await fixture(adapter);
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const attaching = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalAttach = f.workspace.attachSession;
  f.workspace.attachSession = async id => {
    assert(f.ctx.agents.list().some(agent => agent.id === id), 'native agent must exist before attaching');
    entered();
    await gate;
    await originalAttach(id);
  };
  const originalUpdate = f.store.updateRun.bind(f.store);
  f.store.updateRun = async (id, patch, options) => {
    if (patch.sessionId) {
      assert(f.attached.includes(patch.sessionId), 'session must already be a workspace member when published');
      assert(f.ctx.agents.list().some(agent => agent.id === patch.sessionId), 'published native session must exist');
    }
    return originalUpdate(id, patch, options);
  };
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '创建可导航的员工会话' });
  await attaching;
  const duringAttach = f.store.snapshot().runs.find(item => item.id === run.id)!;
  assert.equal(duringAttach.status, 'running');
  assert.equal(duringAttach.sessionId, undefined);
  assert.equal(adapter.requests.length, 0);
  release();
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'awaiting-review', result.error);
  assert(f.attached.includes(result.sessionId!));
  await f.runtime.dispose();
});

test('workspace attachment failures never publish an unusable session ID or start the model', async () => {
  const adapter = new ScriptedAdapter([() => text('must never execute')]);
  const f = await fixture(adapter);
  f.workspace.attachSession = async () => { throw new Error('workspace attach failed'); };
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '验证附加失败' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /workspace attach failed/);
  assert.equal(result.sessionId, undefined);
  assert.equal(adapter.requests.length, 0);
  assert.equal(f.ctx.agents.list().length, 0);
  await f.runtime.dispose();
});

test('completed sessions remain visible and refuse untracked followups until plugin disposal', async () => {
  const adapter = new ScriptedAdapter([() => text('已完成，等待验收')]);
  const f = await fixture(adapter);
  const removed: string[] = [];
  f.ctx.on('session/disposed', session => { removed.push(session.id); });
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '交付并保留历史' });
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'awaiting-review');
  const agent = f.ctx.agents.list().find(agent => agent.id === result.sessionId)!;
  assert(agent, 'completed native session must remain available to the sidebar');
  assert(f.ctx.sessions.list().some(session => session.id === result.sessionId));
  assert.deepEqual(removed, []);
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '尝试绕过工作单直接继续' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  assert.equal(adapter.requests.length, 1, 'a native followup must not start another model request');
  assert.match(JSON.stringify(agent.session.snapshotEvents().at(-1)), /通过 @ 员工创建新的工作单/);
  assert.equal(f.store.snapshot().runs.find(item => item.id === run.id)!.output, result.output);
  await f.runtime.dispose();
  assert.deepEqual(removed, [result.sessionId]);
  assert.equal(f.ctx.agents.list().length, 0);
});

test('cancelling while workspace attachment is pending never wakes the idle agent afterward', async () => {
  const adapter = new ScriptedAdapter([() => text('must not execute after cancellation')]);
  const f = await fixture(adapter);
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const attaching = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalAttach = f.workspace.attachSession;
  f.workspace.attachSession = async id => { entered(); await gate; await originalAttach(id); };
  const run = await f.runtime.start({ projectId: f.project.id, employeeId: f.employee.id, request: '在会话附加期间取消' });
  await attaching;
  await f.runtime.cancel(run.id);
  release();
  const result = await f.runtime.wait(run.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.sessionId, undefined);
  assert.equal(adapter.requests.length, 0);
  assert.equal(f.ctx.agents.list().length, 0);
  await f.runtime.dispose();
});

async function workflowFixture(adapter: ScriptedAdapter, timeoutMs = 600_000) {
  const f = await fixture(adapter);
  const template = await f.store.saveTemplate({ name: 'Workflow worker', status: 'ready', modules: f.employee.modules });
  const team = await f.store.saveTeam({ name: 'Workflow team', members: [{ memberId: 'first', templateId: template.id }, { memberId: 'second', templateId: template.id }], workflows: [{ id: 'flow', name: 'Verified delivery', steps: [{ id: 'first', name: 'Plan', memberId: 'first', instruction: 'Provide a plan', timeoutMs }, { id: 'second', name: 'Review', memberId: 'second', instruction: 'Review the accepted plan', timeoutMs }] }] });
  const installed = await f.store.configureProjectTeam({ projectId: f.project.id, teamId: team.id, teamVersion: team.version, templateVersions: { [template.id]: template.version } });
  const repository = new WorkflowRepository(f.store);
  const errors: unknown[] = [];
  const engine = new WorkflowEngine(repository, f.runtime, error => errors.push(error));
  await engine.start();
  const flow = await repository.start({ projectId: f.project.id, projectTeamId: installed.id, workflowId: installed.workflows[0]!.id, workflowVersion: 1, requestId: 'fixture-workflow', request: 'Create and review a plan' });
  await engine.idle();
  const current = () => f.store.snapshot().workflowRuns!.find(item => item.id === flow.id)!;
  const waitCurrent = async () => { const id = current().steps.find(step => step.status !== 'accepted')!.attempts.at(-1)!.runId; const result = await f.runtime.wait(id); await engine.idle(); return result; };
  const control = async (action: 'review' | 'cancel', runId?: string) => { await repository.control({ projectId: f.project.id, id: flow.id, action, runId, decision: action === 'review' ? 'accepted' : undefined, commandId: `command-${current().version}`, expectedVersion: current().version }); await engine.idle(); };
  return { ...f, engine, repository, errors, current, waitCurrent, control };
}

test('workflow engine executes real Harness sessions exactly once per reserved attempt and waits for human review', async t => {
  const adapter = new ScriptedAdapter([() => text('ACCEPTED_PLAN_SENTINEL'), () => text('Review delivered')]);
  const f = await workflowFixture(adapter);
  t.after(async () => { await f.engine.dispose(); await f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); });
  const first = await f.waitCurrent();
  assert.equal(first.status, 'awaiting-review', first.error);
  await Promise.all([f.runtime.startReserved(first.id), f.runtime.startReserved(first.id)]);
  assert.equal(adapter.requests.length, 1);
  assert.equal(f.current().status, 'awaiting-review');
  await f.control('review', first.id);
  const second = await f.waitCurrent();
  assert.equal(second.status, 'awaiting-review', second.error);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.match(JSON.stringify(adapter.requests[1]), /ACCEPTED_PLAN_SENTINEL/);
  await f.control('review', second.id);
  assert.equal(f.current().status, 'succeeded'); assert.equal(adapter.requests.length, 2); assert.deepEqual(f.errors, []);
});

test('workflow step deadline aborts the real provider, blocks the flow, and never starts the next employee', async t => {
  let providerAborted = false;
  const adapter = new ScriptedAdapter([request => new Promise((_resolve, reject) => {
    const abort = () => { providerAborted = true; reject(new Error('provider aborted')); };
    if (request.signal?.aborted) abort(); else request.signal?.addEventListener('abort', abort, { once: true });
  })]);
  // The step deadline includes native preparation and durable activity writes.
  // Leave startup headroom under the parallel suite so this tests provider abort,
  // rather than the separately valid case where preparation uses the whole limit.
  const f = await workflowFixture(adapter, 2_000);
  t.after(async () => { await f.engine.dispose(); await f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); });
  const result = await f.waitCurrent();
  assert.equal(result.status, 'failed'); assert.match(result.error!, /时间上限/);
  assert.equal(f.current().status, 'blocked'); assert.equal(adapter.requests.length, 1);
  assert.equal(providerAborted, true, 'the deadline must abort an already-started provider');
  assert.equal(f.current().steps[1]!.attempts.length, 0); assert.deepEqual(f.errors, []);
});

test('cancelling a workflow aborts its active Harness attempt and does not dispatch a successor', async t => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const adapter = new ScriptedAdapter([request => new Promise((_resolve, reject) => { entered(); request.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); })]);
  const f = await workflowFixture(adapter);
  t.after(async () => { await f.engine.dispose(); await f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); });
  await ready;
  const runId = f.current().steps[0]!.attempts[0]!.runId;
  await f.control('cancel');
  const result = await f.runtime.wait(runId); await f.engine.idle();
  assert.equal(result.status, 'cancelled'); assert.equal(f.current().status, 'cancelled');
  assert.equal(f.current().steps[1]!.attempts.length, 0); assert.deepEqual(f.errors, []);
});
