import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as SkillTool from '@deepseek-ai/dsh-tool-skill';

const cwd = process.cwd();
class Offline extends LlmAdapter {
  requests = [];
  async *stream(request) {
    this.requests.push(request);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'OFFLINE_RESPONSE' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OFFLINE_RESPONSE' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const tool = name => ({ name, description: 'Offline non-mutating probe', parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'OK' });
const ctx = new Context(), adapter = new Offline(), handles = [];
const report = { safety: 'Pure in-memory official Context/Agent/Session, offline adapter, synthetic tools/skills, no user profile/credentials/network.', versions: {}, native: [], ptc: {} };
for (const pkg of ['dsh-agent', 'dsh-agent-loop', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-tool-executor-ptc', 'dsh-tool-skill', 'dsh-system-prompt']) {
  report.versions[pkg] = (await import(`@deepseek-ai/${pkg}/package.json`, { with: { type: 'json' } })).default.version;
  assert.equal(report.versions[pkg], '0.2.2-rc.1', `${pkg} must come from the target official SDK`);
}
try {
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime]) await ctx.plugin(plugin);
  await ctx.plugin(NativeToolExecutor);
  await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: cwd });
  await ctx.plugin(SandboxedFileSystem);
  await ctx.plugin(WorkingDirectory, { defaultDirectory: cwd });
  await ctx.plugin(SkillRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(SkillTool);
  ctx.llm.registerAdapter(['offline-resident-probe'], adapter);
  ctx.tools.register(tool('probe_native_read'));
  ctx.skills.register({ name: 'probe-native-skill', description: 'Native summary sentinel', source: 'custom', content: 'SYNTHETIC_SKILL_BODY' });
  ctx.systemPrompt.section({ name: 'probe-native-system', order: -1000, text: 'NATIVE_SYSTEM_PRESERVED' });
  ctx.systemPrompt.context({ name: 'probe-policy', order: 0, required: true, text: 'NATIVE_POLICY_PRESERVED' });
  const streams = [];
  ctx.on('agent/assistant-stream', ({ agent, frame }) => streams.push({ id: agent.id, type: frame.type }));
  const create = async (id, setup) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd }, agentOptions: { provider: 'offline-resident-probe', model: 'offline' }, setup });
    handles.push(handle); return handle.agent;
  };
  const a = await create('synthetic-resident-probe-a');
  const b = await create('synthetic-resident-probe-b');
  const send = async (agent, phase) => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: phase }] }));
    await agent.whenIdle();
    const request = adapter.requests.at(-1);
    assert.equal(request.sessionId, agent.id);
    assert.ok(Object.isFrozen(request), 'loop request is public read-only/frozen');
    const catalogs = request.messages.filter(message => message.source?.kind === 'skill-catalog');
    const row = { phase, sessionId: agent.id, tools: request.tools?.map(tool => tool.name) ?? [],
      requestBytes: Buffer.byteLength(JSON.stringify(request)), toolSchemaBytes: Buffer.byteLength(JSON.stringify(request.tools ?? [])), modelContentBytes: Buffer.byteLength(JSON.stringify(request.messages.map(({ role, content }) => ({ role, content })))), messageCount: request.messages.length,
      catalogCountInModelHistory: catalogs.length, catalogs: catalogs.map(message => ({ entries: message.source.entries, textBytes: Buffer.byteLength(JSON.stringify(message.content)) })),
      nativeSystemPreserved: JSON.stringify(request.messages).includes('NATIVE_SYSTEM_PRESERVED'),
      nativePolicyPreserved: JSON.stringify(request.messages).includes('NATIVE_POLICY_PRESERVED'), streamFrames: streams.filter(frame => frame.id === agent.id).length };
    assert.ok(row.nativeSystemPreserved); assert.ok(row.nativePolicyPreserved);
    report.native.push(row); return request;
  };
  const a1 = await send(a, 'execute-before-consult');
  assert.deepEqual(a1.tools.map(tool => tool.name), ['probe_native_read', 'skill']);
  const release = a.ctx.tools.restrict({ allow: [] });
  assert.equal(ctx.tools.get('skill', a), undefined);
  assert.ok(ctx.tools.get('skill', b), 'other native session tools are unaffected');
  const a2 = await send(a, 'consult-after-execute');
  assert.equal(a2.tools?.length ?? 0, 0);
  assert.ok(a2.messages.some(message => message.source?.kind === 'skill-catalog' && message.source.entries.length === 0), 'official skill plugin publishes empty catalog update');
  await send(a, 'consult-second-turn');
  const aEventsBeforeResume = a.session.snapshotEvents();
  release();
  assert.ok(ctx.tools.get('skill', a));
  const a4 = await send(a, 'execute-after-consult');
  assert.deepEqual(a4.tools.map(tool => tool.name), ['probe_native_read', 'skill']);
  assert.ok(a.session.snapshotEvents().length > aEventsBeforeResume.length);
  await send(b, 'unaffected-other-session');
  let freshRelease;
  const c = await create('synthetic-resident-probe-c', agentCtx => { freshRelease = agentCtx.tools.restrict({ allow: [] }); });
  const c1 = await send(c, 'consult-first-turn');
  assert.equal(c1.tools?.length ?? 0, 0);
  assert.equal(c1.messages.filter(message => message.source?.kind === 'skill-catalog').length, 0, 'fresh consult omits catalog completely');
  await send(c, 'consult-second-fresh-turn');
  freshRelease();
  await send(c, 'execute-after-fresh-consult');
  const scoped = a.ctx.tools.register(tool('probe-own-layer'));
  const ownRelease = a.ctx.tools.restrict({ allow: [] });
  assert.deepEqual(ctx.tools.schemas(a).map(tool => tool.name), ['probe-own-layer'], 'own scoped tools are exempt from inherited restriction');
  report.ownLayerExemption = ctx.tools.schemas(a).map(tool => tool.name);
  ownRelease(); scoped();
  // PTC is checked in a separate official Context below; no current-agent presentation is changed.
  report.assertions = 'PASS: native consultation has no tool declarations and no first-turn catalog; Session identity/history/stream, restored capabilities, other-Session isolation and own-layer exemption are preserved. PTC transport and execution policy are reported separately.';
} finally {
  for (const handle of handles.reverse()) await handle.dispose();
  await ctx.fiber.dispose();
}
const ptc = new Context();
try {
  await ptc.plugin(SystemPrompt);
  let ptcExecuted = 0;
  ptc.provide('ptcRuntime', {
    language: 'typescript', isolation: 'synthetic-in-memory', programFormat: 'function-body', retainsState: false,
    executionInstructions: 'Synthetic PTC instructions', timeout: { defaultMs: 1000, maxMs: 1000 },
    resolve: request => ({ ...request, cwd: request.cwd ?? cwd, timeoutMs: request.timeoutMs ?? 1000 }),
    run: async request => {
      ptcExecuted++;
      assert.equal(request.program, 'SYNTHETIC_RESTORED', 'consultation must never reach the runtime');
      return { value: 'RESTORED_EXECUTION', logs: [] };
    },
    release: async () => {},
  });
  await ptc.plugin(ToolRuntime);
  await ptc.plugin(PtcToolExecutor);
  await ptc.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: cwd });
  await ptc.plugin(SandboxedFileSystem);
  await ptc.plugin(WorkingDirectory, { defaultDirectory: cwd });
  await ptc.plugin(LlmRuntime); await ptc.plugin(SessionStore); await ptc.plugin(SessionProjectionRegistry); await ptc.plugin(AgentRegistry); await ptc.plugin(AgentLoop, { agents: [] });
  ptc.tools.register(tool('probe_ptc_native'));
  const ptcAdapter = new class extends LlmAdapter {
    requests = [];
    async *stream(request) {
      this.requests.push(request);
      if (this.requests.length === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: 'synthetic-ptc-call', name: 'run_code', argumentsDelta: '{"code":"throw new Error(\"MUST_NOT_RUN\")","description":"Synthetic prohibited call"}' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'synthetic-ptc-call', name: 'run_code', arguments: '{"code":"throw new Error(\"MUST_NOT_RUN\")","description":"Synthetic prohibited call"}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'OFFLINE_PTC_RESPONSE' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OFFLINE_PTC_RESPONSE' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }();
  ptc.llm.registerAdapter(['offline-resident-probe'], ptcAdapter);
  const handle = await ptc.agents.create({ sessionId: SessionId('synthetic-ptc-probe'), agentOptions: { provider: 'offline-resident-probe', model: 'offline' } });
  const agent = handle.agent;
  const lift = agent.ctx.tools.restrict({ allow: [] });
  report.ptc.restrictedSchemas = ptc.tools.schemas(agent).map(tool => tool.name);
  assert.deepEqual(report.ptc.restrictedSchemas, [], 'registry schemas contain capabilities only; the executor owns reserved transport');
  const beforeConsult = await agent.ctx.systemPrompt.assemble({ scope: agent });
  report.ptc.restrictedExecutorSchemas = beforeConsult.tools.map(tool => tool.name);
  assert.deepEqual(report.ptc.restrictedExecutorSchemas, ['run_code'], 'PTC transport remains despite an empty capability registry');
  const guard = agent.ctx.tools.guard(() => 'CONSULT_NO_EXECUTION');
  // The production integration owns restrictions and guards, not the host's
  // executor. PTC retains its reserved declaration even with no capabilities;
  // consultation denies every execution without replacing an unknown provider.
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'CONSULT_WITH_OLD_TOOL_CALL_PROBE' }] }));
  await agent.whenIdle();
  assert.equal(ptcExecuted, 0);
  assert.equal(ptcAdapter.requests.length, 2, 'malicious call is denied then ordinary streamed answer completes');
  assert.ok(ptcAdapter.requests.every(request => JSON.stringify(request.tools?.map(tool => tool.name)) === JSON.stringify(['run_code'])), 'PTC transport remains declared without replacing the host executor');
  assert.ok(JSON.stringify(ptcAdapter.requests[1].messages).includes('CONSULT_NO_EXECUTION'));
  assert.deepEqual(agent.session.requestHeader().tools.map(tool => tool.name), ['run_code'], 'the native request header preserves the actual PTC declaration');
  report.ptc.guardedAssembledSchemas = (ptcAdapter.requests[0].tools ?? []).map(tool => tool.name);
  report.ptc.toolSchemaBytes = Buffer.byteLength(JSON.stringify(ptcAdapter.requests[0].tools ?? []));
  report.ptc.loggedHeaderToolCount = (agent.session.requestHeader().tools?.length ?? 0);
  report.ptc.maliciousOldCallDenied = true;
  const denied = await ptc.tools.execute({
    calls: [{ type: 'tool-call', id: 'new-consult-ptc-call', name: 'run_code', arguments: JSON.stringify({ code: 'MUST_NOT_RUN', description: 'Synthetic new prohibited call' }) }],
    signal: new AbortController().signal, agent,
  });
  assert.equal(denied.results[0].result.isError, true);
  assert.ok(denied.results[0].result.error.message.includes('CONSULT_NO_EXECUTION'));
  assert.equal(ptcExecuted, 0, 'both stale and newly generated PTC calls are denied before runtime execution');
  report.ptc.newCallDenied = true;
  report.ptc.consultationExecutions = ptcExecuted;
  guard(); lift();
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'EXECUTE_AFTER_CONSULT' }] }));
  await agent.whenIdle();
  assert.deepEqual(ptcAdapter.requests.at(-1).tools.map(tool => tool.name), ['run_code']);
  report.ptc.restoredSchemas = ptcAdapter.requests.at(-1).tools.map(tool => tool.name);
  report.ptc.restoredSchemaBytes = Buffer.byteLength(JSON.stringify(ptcAdapter.requests.at(-1).tools));
  const restored = await ptc.tools.execute({
    calls: [{ type: 'tool-call', id: 'restored-ptc-call', name: 'run_code', arguments: JSON.stringify({ code: 'SYNTHETIC_RESTORED', description: 'Verify restored execution' }) }],
    signal: new AbortController().signal, agent,
  });
  assert.equal(restored.results[0].result.isError, false, JSON.stringify(restored));
  assert.equal(restored.results[0].result.value.result, 'RESTORED_EXECUTION');
  assert.equal(ptcExecuted, 1, 'execution is restored only after consultation restrictions and guard are released');
  report.ptc.restoredExecutions = ptcExecuted;
  report.ptc.conclusion = 'Public per-agent restrictions remove inherited capabilities and catalog discovery; the host-owned PTC executor retains run_code and its actual request header. A monotonic scoped guard denies stale or newly requested programs before execution. Releasing both policies restores the unchanged executor and actual execution in the same Agent/Session.';
  await handle.dispose();
} finally { await ptc.fiber.dispose(); }
await mkdir(new URL('../artifacts/resident-chat/native-api/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/resident-chat/native-api/results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
