import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { installModelSelection, type AgentHandle, type ModelSelection } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createAssistantMessage, createToolResultMessage, createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { Session, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SessionQueryEngine from '@deepseek-ai/dsh-session-query';
import SystemPrompt, { joinContextSections } from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { registerConversationWorkflowRuntime, type ConversationWorkflowRuntimeDependencies, type NativeWorkflowLease } from '../src/harness/conversation-workflow-runtime.js';
import { createContextPacket } from '../src/knowledge/context.js';
import { retireWorkflowContexts, workflowContextDefinition } from '../src/harness/native-workflow-context.js';

const text = (value: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const call = (name: string, args = '{}'): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: ToolCallId(`call-${name}`), name, argumentsDelta: args },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`call-${name}`), name, arguments: args } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
];
class FixtureSessionQuery extends SessionQueryEngine {
  observations = 0;
  override async observeSession(...args: Parameters<SessionQueryEngine['observeSession']>) { this.observations++; return super.observeSession(...args); }
  async searchSessions(): Promise<never> { throw new Error('Search is not used by the context fixture'); }
  async searchEvents(): Promise<never> { throw new Error('Search is not used by the context fixture'); }
}
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(private readonly scripts: Array<(request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>>, private readonly inHistory = false) { super(); }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] },
      ...(this.inHistory ? { systemPromptUpdate: 'in-history' as const, toolUpdate: 'in-history' as const } : {}) };
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (!script) throw new Error('fixture script exhausted');
    for (const chunk of await script(request)) yield chunk;
  }
}
const tool = (name = 'workflow_fixture', execute = async () => 'fixture tool result'): ToolDefinition => ({
  name, description: 'Lease scoped fixture tool', parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }, execute,
});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function fixture(scripts: ConstructorParameters<typeof ScriptedAdapter>[0], deps: ConversationWorkflowRuntimeDependencies, options: { existing?: boolean; toolsMode?: 'native' | 'ptc'; inHistory?: boolean; nativeMaxTokens?: number; beforeRegister?: (agent: AgentHandle['agent'], ctx: Context) => void } = {}) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(FixtureSessionQuery);
  await ctx.plugin(SystemPrompt);
  let ptcExecutions = 0;
  if (options.toolsMode === 'ptc') ctx.provide('ptcRuntime', {
    language: 'typescript', isolation: 'process', programFormat: 'function-body', retainsState: false, executionInstructions: 'Fixture PTC runtime.',
    resolve: (request: { cwd?: string; timeoutMs?: number }) => ({ ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 1000 }),
    run: async () => { ptcExecutions++; return { value: 'FIXTURE_PROGRAM_EXECUTED', logs: [] }; }, release: async () => {},
    sandboxMode: 'workspace-write', timeout: { defaultMs: 1000, maxMs: 1000 },
  } as never);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(options.toolsMode === 'ptc' ? PtcToolExecutor : NativeToolExecutor);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new ScriptedAdapter(scripts, options.inHistory);
  ctx.llm.registerAdapter(['fixture'], adapter);
  ctx.systemPrompt.section({ name: 'native-complete', order: -1000, text: 'NATIVE_COMPLETE_SYSTEM', complete: options.toolsMode !== 'ptc' });
  ctx.systemPrompt.context({ name: 'native-policy', order: 0, required: true, text: 'NATIVE_PERMISSION_CONTEXT' });
  let handle: AgentHandle;
  const selection = { get current() { return handle.agent.model.current(); }, set current(value: Readonly<ModelSelection> | undefined) { if (value) handle.agent.model.select(value); } };
  const create = async () => {
    handle = await ctx.agents.create({ sessionId: SessionId(`native-workflow-${Math.random()}`),
      meta: { cwd: process.cwd() }, agentOptions: { provider: 'fixture', model: 'native-model', ...(options.nativeMaxTokens === undefined ? {} : { maxTokens: options.nativeMaxTokens }) },
      setup: agentCtx => { installModelSelection(agentCtx); },
    });
  };
  if (options.existing) { await create(); options.beforeRegister?.(handle!.agent, ctx); }
  const dispose = registerConversationWorkflowRuntime(ctx, {
    selectModel: () => ({ model: { provider: 'fixture', model: 'owner-one' } }),
    tools: ['workflow_fixture', 'partial_lease_tool', 'worker_memory_search', 'worker_memory_write'].map(name => tool(name)),
    readEvents: async (agent, signal) => {
      const observation = await ctx.sessionQuery.observeSession(agent.id, { signal, projectionMode: 'none' });
      try { return observation.events; } finally { observation[Symbol.dispose](); }
    }, ...deps,
  });
  if (!options.existing) await create();
  const send = async (request: string) => {
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: request }] }));
    await handle.agent.whenIdle();
    // The durable turn/end listener starts asynchronous business settlement.
    await new Promise(resolve => setImmediate(resolve));
  };
  return { ctx, adapter, selection, agent: handle!.agent, send, dispose, ptcExecutions: () => ptcExecutions,
    cleanup: async () => { await dispose(); await handle.dispose(); },
  };
}
const lease = (id = 'owner-one', extra: Partial<NativeWorkflowLease> = {}): NativeWorkflowLease => ({
  id, prompt: `WORKFLOW_OWNER_CONTEXT:${id}`, model: { provider: 'fixture', model: id }, ...extra,
});

for (const toolsMode of ['native', 'ptc'] as const) test(`light consultation denies old and new calls while preserving the native executor (${toolsMode})`, async () => {
  let consult = true, executed = 0;
  const f = await fixture([
    async request => {
      assert.equal(request.tools?.length ?? 0, toolsMode === 'ptc' ? 1 : 0);
      const name = toolsMode === 'ptc' ? 'run_code' : 'native_fixture';
      const args = toolsMode === 'ptc' ? JSON.stringify({ code: 'MUST_NOT_RUN', description: 'Prohibited consultation program' }) : '{}';
      const denied = await f.ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId('new-consultation-call'), name, arguments: args }], signal: new AbortController().signal, agent: f.agent });
      assert.equal(denied.results[0]?.result.isError, true);
      assert.match(JSON.stringify(denied), /轻咨询/);
      return call(name, args);
    },
    request => { assert.match(JSON.stringify(request), /轻咨询/); return text('consult done'); },
    request => { assert.ok(request.tools?.length); return text('native restored'); },
  ], { isDeliverySession: () => false, selectModel: () => consult ? { model: { provider: 'fixture', model: 'consult' }, toolPolicy: 'consult' } : undefined, prepare: async () => consult ? lease('consult', { toolPolicy: 'consult' }) : undefined }, { toolsMode });
  const remove = f.ctx.tools.register(tool('native_fixture', async () => { executed++; return 'SHOULD_NOT_EXECUTE'; }));
  try {
    await f.send('CONSULT_ORIGINAL');
    assert.equal(executed, 0, 'even an unsolicited or historical tool call is rejected');
    assert.equal(f.ptcExecutions(), 0, 'host PTC runtime is never reached by old or new consultation calls');
    assert.equal(f.adapter.requests.length, 2);
    assert.ok(f.agent.ctx.tools.get('native_fixture', f.agent), 'restriction released at turn end');
    consult = false;
    await f.send('NATIVE_FOLLOWUP');
    assert.equal(f.adapter.requests.length, 3);
    assert.equal(f.ctx.agents.list().length, 1, 'same native conversation');
    assert.match(JSON.stringify(f.adapter.requests[2]), /CONSULT_ORIGINAL/);
  } finally { remove(); await f.cleanup(); }
});

test('first native request has frozen owner context and tools while complete native prompt and history stay intact', async () => {
  const prepared: Array<{ key: string; request: string }> = [];
  const results: SessionEvent[][] = [];
  let toolCalls = 0;
  let beforeSteps = 0;
  let afterTools = 0;
  let disposed = 0;
  const f = await fixture([
    request => {
      assert.equal(request.model, 'owner-one');
      assert.match(JSON.stringify(request), /NATIVE_COMPLETE_SYSTEM/);
      assert.match(JSON.stringify(request), /NATIVE_PERMISSION_CONTEXT/);
      assert.match(JSON.stringify(request), /WORKFLOW_OWNER_CONTEXT:owner-one/);
      assert.ok(request.tools?.some(item => item.name === 'workflow_fixture'), 'tool must be present on the first request');
      return call('workflow_fixture');
    },
    request => { assert.match(JSON.stringify(request), /fixture tool result/); return text('done'); },
  ], {
    isDeliverySession: () => false,
    prepare: async (_agent, key, request) => {
      prepared.push({ key, request });
      return lease('owner-one', { tools: [tool(undefined, async () => { toolCalls++; return 'fixture tool result'; })],
        beforeStep: async () => { beforeSteps++; }, afterTool: async () => { afterTools++; },
        finish: async events => { results.push([...events]); }, dispose: () => { disposed++; },
      });
    },
  });
  try {
    const originalId = f.agent.id;
    await f.send('USER_ORIGINAL_REQUEST');
    assert.equal(f.agent.id, originalId);
    assert.equal(f.ctx.agents.list().length, 1, 'no second agent or session is created');
    assert.deepEqual(prepared.map(value => value.request), ['USER_ORIGINAL_REQUEST']);
    assert.equal(prepared.length, 1, 'reassembly and model continuation must not repeat prepare');
    assert.equal(f.adapter.requests.length, 2, JSON.stringify(f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')));
    assert.equal(toolCalls, 1); assert.equal(afterTools, 1); assert.equal(beforeSteps, 2);
    assert.equal(disposed, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]![0]!.type, 'turn/start');
    assert.equal(results[0]!.at(-1)!.type, 'turn/end');
    assert.equal(f.agent.ctx.tools.executable('workflow_fixture', f.agent), undefined, 'lease tool disappears on turn end');
    assert.ok(f.agent.session.snapshotEvents().some(event => event.type === 'assistant/message'));
  } finally { await f.cleanup(); }
});

test('changing selection mid-turn keeps the owner frozen and None restores native selector on the next turn', async () => {
  let selected: string | undefined = 'first';
  let prepared = 0;
  const f = await fixture([
    request => { assert.equal(request.model, 'first'); selected = 'second'; return call('workflow_fixture'); },
    request => { assert.equal(request.model, 'first'); return text('first done'); },
    request => {
      assert.equal(request.model, 'second');
      const notices = request.messages.filter(message => message.role === 'user' && message.source.kind === 'model-selection');
      assert.match(JSON.stringify(notices), /first → second/);
      assert.doesNotMatch(JSON.stringify(notices), /first → native-model/);
      return text('second done');
    },
    request => {
      assert.equal(request.model, 'native-updated');
      assert.ok(!request.tools?.some(item => item.name === 'workflow_fixture'));
      // Historical owner context remains in the log, but no current runtime
      // snapshot silently reactivates it after None.
      const contexts = request.messages.filter(message => message.role === 'user' && message.source.kind === 'runtime-context');
      assert.doesNotMatch(JSON.stringify(contexts.at(-1)), /WORKFLOW_OWNER_CONTEXT/);
      return text('native done');
    },
  ], {
    isDeliverySession: () => false,
    selectModel: () => selected ? { model: { provider: 'fixture', model: selected } } : undefined,
    prepare: async () => { prepared++; return selected ? lease(selected, { tools: [tool()] }) : undefined; },
  });
  try {
    await f.send('first request'); await f.send('second request');
    selected = undefined;
    f.selection.current = { provider: 'fixture', model: 'native-updated' };
    await f.send('plain request');
    assert.equal(prepared, 3);
    assert.equal(f.adapter.requests.length, 4);
  } finally { await f.cleanup(); }
});

test('already live native agents are supported and each finish receives only its own turn', async () => {
  const windows: SessionEvent[][] = [];
  const keys: string[] = [];
  const f = await fixture([() => text('one'), () => text('two')], {
    isDeliverySession: () => false,
    prepare: async (_agent, key) => { keys.push(key); return lease(undefined, { finish: async events => { windows.push([...events]); } }); },
  }, { existing: true });
  try {
    await f.send('turn one'); await f.send('turn two');
    assert.equal(windows.length, 2); assert.notEqual(keys[0], keys[1]);
    assert.equal(windows[0]!.filter(event => event.type === 'turn/start').length, 1);
    assert.equal(windows[1]!.filter(event => event.type === 'turn/start').length, 1);
    assert.ok(windows[1]!.every(event => event.seq > windows[0]!.at(-1)!.seq));
    assert.doesNotMatch(JSON.stringify(windows[1]), /turn one/);
  } finally { await f.cleanup(); }
});

test('business settlement completes before a queued turn prepares a new lease', async () => {
  const finishing = deferred();
  const finishEntered = deferred();
  const order: string[] = [];
  const f = await fixture([() => text('one'), () => text('two')], {
    isDeliverySession: () => false,
    prepare: async (_agent, _key, request) => {
      order.push(`prepare:${request}`);
      return lease(undefined, { finish: async () => {
        if (request === 'one') { finishEntered.resolve(); await finishing.promise; order.push('settled:one'); }
      } });
    },
  });
  try {
    const one = f.send('one'); await finishEntered.promise;
    const two = f.send('two');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['prepare:one']);
    finishing.resolve(); await Promise.all([one, two]);
    assert.deepEqual(order, ['prepare:one', 'settled:one', 'prepare:two']);
  } finally { finishing.resolve(); await f.cleanup(); }
});

test('delivery sessions and diagnostics never prepare or adopt a conversation', async () => {
  let prepared = 0;
  const f = await fixture([request => { assert.equal(request.model, 'native-model'); return text('native'); }], {
    isDeliverySession: () => true, prepare: async () => { prepared++; return lease(); },
  });
  try {
    await f.ctx.systemPrompt.assemble({});
    await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent });
    await f.send('existing delivery must keep its owner');
    assert.equal(prepared, 0);
  } finally { await f.cleanup(); }
});

test('a preparation failure ends the native turn without silently sending through the native model', async () => {
  let prepared = 0;
  const f = await fixture([], { isDeliverySession: () => false, prepare: async () => { prepared++; throw new Error('step owner is unavailable'); } });
  try {
    await f.send('do not downgrade');
    assert.equal(prepared, 1); assert.equal(f.adapter.requests.length, 0);
    const end = f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end');
    assert.equal(end?.type, 'turn/end');
    if (end?.type === 'turn/end') { assert.equal(end.data.reason.kind, 'error'); assert.match(JSON.stringify(end.data), /step owner is unavailable/); }
  } finally { await f.cleanup(); }
});

test('failed step authorization still finishes and releases the lease exactly once', async () => {
  let finished = 0; let disposed = 0;
  const f = await fixture([], { isDeliverySession: () => false, prepare: async () => lease(undefined, {
    tools: [tool()], beforeStep: async () => { throw new Error('step authority revoked'); },
    finish: async () => { finished++; }, dispose: () => { disposed++; },
  }) });
  try {
    await f.send('revoked');
    assert.equal(f.adapter.requests.length, 0); assert.equal(finished, 1); assert.equal(disposed, 1);
    assert.equal(f.agent.ctx.tools.executable('workflow_fixture', f.agent), undefined);
  } finally { await f.cleanup(); }
});

test('native monotonic guards remain authoritative and lease guards can only further deny', async () => {
  let calls = 0;
  const f = await fixture([
    () => call('workflow_fixture'),
    request => { assert.match(JSON.stringify(request), /NATIVE_POLICY_DENIAL/); return text('denied'); },
    () => call('workflow_fixture'),
    request => { assert.match(JSON.stringify(request), /LEASE_POLICY_DENIAL/); return text('denied'); },
  ], { isDeliverySession: () => false, prepare: async () => lease(undefined, {
    tools: [tool(undefined, async () => { calls++; return 'never'; })],
    guard: () => mode === 'lease' ? 'LEASE_POLICY_DENIAL' : undefined,
  }) });
  let mode = 'native';
  const removeGuard = f.agent.ctx.tools.guard(() => mode === 'native' ? 'NATIVE_POLICY_DENIAL' : undefined);
  try {
    await f.send('native policy'); mode = 'lease'; await f.send('lease policy');
    assert.equal(calls, 0);
  } finally { removeGuard(); await f.cleanup(); }
});

test('unloading cancels an owned turn, removes scoped tools, and preserves the host Agent for later native use', async () => {
  const entered = deferred();
  let finished = 0; let disposed = 0;
  const f = await fixture([
    async request => {
      entered.resolve();
      await new Promise<void>(resolve => { request.signal!.addEventListener('abort', () => resolve(), { once: true }); });
      request.signal!.throwIfAborted();
      return text('unreachable');
    },
    request => { assert.equal(request.model, 'native-model'); return text('native after unload'); },
  ], { isDeliverySession: () => false, prepare: async () => lease(undefined, {
    tools: [tool()], finish: async () => { finished++; }, dispose: () => { disposed++; },
  }) });
  try {
    const sending = f.send('owned turn'); await entered.promise;
    await f.dispose(); await sending;
    assert.equal(finished, 1); assert.equal(disposed, 1);
    assert.equal(f.ctx.agents.get(f.agent.id), f.agent);
    assert.equal(f.agent.ctx.tools.executable('workflow_fixture', f.agent), undefined);
    await f.send('plain after unload');
    assert.equal(f.adapter.requests.length, 2);
  } finally { await f.cleanup(); }
});

test('unloading a plain native turn does not cancel it', async () => {
  const entered = deferred(); const release = deferred();
  const f = await fixture([async request => {
    entered.resolve(); await release.promise;
    assert.equal(request.signal?.aborted, false); return text('ordinary native completion');
  }], { isDeliverySession: () => false, selectModel: () => undefined, prepare: async () => undefined });
  try {
    const sending = f.send('plain native turn'); await entered.promise;
    const closing = f.dispose();
    release.resolve(); await Promise.all([sending, closing]);
    const end = f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end');
    if (end?.type === 'turn/end') assert.equal(end.data.reason.kind, 'completed');
  } finally { release.resolve(); await f.cleanup(); }
});

test('first PTC request retains the official run_code projection and includes the new lease tool SDK', async () => {
  let prepared = 0;
  const f = await fixture([request => {
    assert.deepEqual(request.tools?.map(item => item.name), ['run_code']);
    assert.match(JSON.stringify(request), /workflow_fixture/);
    assert.match(JSON.stringify(request), /WORKFLOW_OWNER_CONTEXT/);
    return text('schema inspection done');
  }], { isDeliverySession: () => false, prepare: async () => { prepared++; return lease(undefined, { tools: [tool()] }); } }, { toolsMode: 'ptc' });
  try {
    await f.send('PTC schema');
    assert.equal(prepared, 1); assert.equal(f.adapter.requests.length, 1);
  } finally { await f.cleanup(); }
});

test('lease model clears inherited reasoning effort and None restores the current native effort', async () => {
  let selected = true;
  const f = await fixture([
    request => { assert.equal(request.reasoningEffort, undefined); return text('owner provider default'); },
    request => { assert.equal(request.reasoningEffort, 'high'); return text('native high'); },
  ], { isDeliverySession: () => false, selectModel: () => selected ? { model: { provider: 'fixture', model: 'owner-one' } } : undefined, prepare: async () => selected ? lease() : undefined });
  try {
    f.selection.current = { provider: 'fixture', model: 'native-model', reasoningEffort: ReasoningEffortId('high') };
    await f.send('owner'); selected = false; await f.send('native');
    assert.equal(f.adapter.requests.length, 2);
  } finally { await f.cleanup(); }
});

test('an explicit lease output reservation caps the actual request without raising a smaller native cap', async () => {
  for (const nativeMaxTokens of [undefined, 256_000, 512]) {
    const f = await fixture([() => text('bounded answer')], { isDeliverySession: () => false,
      prepare: async () => lease('owner-one', { maxTokens: 8000 }),
    }, { nativeMaxTokens });
    try {
      await f.send('bounded output');
      assert.equal(f.adapter.requests.length, 1);
      assert.equal(f.adapter.requests[0]!.maxTokens, Math.min(nativeMaxTokens ?? 8000, 8000));
    } finally { await f.cleanup(); }
  }
});

test('a lease without an explicit output budget preserves the native request cap', async () => {
  const f = await fixture([() => text('native cap preserved')], { isDeliverySession: () => false,
    prepare: async () => lease('owner-one'),
  }, { nativeMaxTokens: 256_000 });
  try {
    await f.send('ordinary native output');
    assert.equal(f.adapter.requests.length, 1); assert.equal(f.adapter.requests[0]!.maxTokens, 256_000);
  } finally { await f.cleanup(); }
});

test('cancelling asynchronous preparation releases a returned lease without any model request', async () => {
  const entered = deferred(); const complete = deferred();
  let finished = 0; let disposed = 0;
  const f = await fixture([], { isDeliverySession: () => false, prepare: async (_agent, _key, _request, signal) => {
    entered.resolve(); await complete.promise; assert.equal(signal?.aborted, true);
    return lease(undefined, { tools: [tool()], finish: async () => { finished++; }, dispose: () => { disposed++; } });
  } });
  try {
    const sending = f.send('cancel preparation'); await entered.promise;
    f.agent.cancel({ kind: 'user' }); complete.resolve(); await sending;
    assert.equal(f.adapter.requests.length, 0); assert.equal(finished, 1); assert.equal(disposed, 1);
    assert.equal(f.agent.ctx.tools.executable('workflow_fixture', f.agent), undefined);
  } finally { complete.resolve(); await f.cleanup(); }
});

test('a tool registration conflict preserves the native tool and releases earlier partial registrations', async () => {
  let finished = 0; let disposed = 0;
  const f = await fixture([], { isDeliverySession: () => false, prepare: async () => lease(undefined, {
    tools: [tool('partial_lease_tool'), tool('existing_native_tool')],
    finish: async () => { finished++; }, dispose: () => { disposed++; },
  }) });
  const removeNativeTool = f.agent.ctx.tools.register(tool('existing_native_tool'));
  try {
    await f.send('conflicting tool');
    assert.equal(f.adapter.requests.length, 0); assert.equal(finished, 1); assert.equal(disposed, 1);
    assert.equal(f.agent.ctx.tools.executable('partial_lease_tool', f.agent), undefined);
    assert.ok(f.agent.ctx.tools.get('existing_native_tool', f.agent));
  } finally { removeNativeTool(); await f.cleanup(); }
});

test('a failing finish callback reports once, disposes its lease, and permits the next native turn', async () => {
  const errors: unknown[] = [];
  let selected = true; let disposed = 0;
  const f = await fixture([() => text('one'), () => text('native')], {
    isDeliverySession: () => false, onError: error => errors.push(error),
    selectModel: () => selected ? { model: { provider: 'fixture', model: 'owner-one' } } : undefined,
    prepare: async () => selected ? lease(undefined, { finish: async () => { throw new Error('business settlement failed'); }, dispose: () => { disposed++; } }) : undefined,
  });
  try {
    await f.send('finish failure'); selected = false; await f.send('native still usable');
    assert.equal(errors.length, 1); assert.equal(disposed, 1); assert.equal(f.adapter.requests.length, 2);
    assert.equal(f.adapter.requests[1]!.model, 'native-model');
  } finally { await f.cleanup(); }
});

test('unload during deferred None lookup preserves the original native submission', async () => {
  const entered = deferred(); const release = deferred();
  const f = await fixture([request => { assert.equal(request.signal?.aborted, false); assert.equal(request.model, 'native-model'); return text('plain submission preserved'); }], {
    isDeliverySession: () => false, ownsPendingTurn: () => false,
    selectModel: () => undefined,
    prepare: async () => { entered.resolve(); await release.promise; return undefined; },
  });
  try {
    const sending = f.send('ordinary text while None'); await entered.promise;
    const closing = f.dispose(); release.resolve(); await Promise.all([sending, closing]);
    assert.equal(f.adapter.requests.length, 1);
    const end = f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end');
    if (end?.type === 'turn/end') assert.equal(end.data.reason.kind, 'completed');
  } finally { release.resolve(); await f.cleanup(); }
});

test('unload cancels a synchronously identified pending workflow owner before a slow prepare completes', async () => {
  const entered = deferred();
  const f = await fixture([], { isDeliverySession: () => false, ownsPendingTurn: () => true,
    prepare: async (_agent, _key, _request, signal) => {
      entered.resolve(); await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      signal!.throwIfAborted(); return undefined;
    },
  });
  try {
    const sending = f.send('pending owned preparation'); await entered.promise;
    await f.dispose(); await sending;
    assert.equal(f.adapter.requests.length, 0);
    const end = f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end');
    if (end?.type === 'turn/end') assert.equal(end.data.reason.kind, 'aborted');
  } finally { await f.cleanup(); }
});

test('None awaiting the previous owner settlement survives unload before its prepare callback begins', async () => {
  const finishEntered = deferred(); const releaseFinish = deferred();
  let selected = true; let prepares = 0;
  const f = await fixture([() => text('owned'), request => {
    assert.equal(request.signal?.aborted, false); assert.equal(request.model, 'native-model'); return text('plain after owner settlement');
  }], { isDeliverySession: () => false, ownsPendingTurn: () => selected,
    selectModel: () => selected ? { model: { provider: 'fixture', model: 'owner-one' } } : undefined, prepare: async () => { prepares++; return selected ? lease(undefined, { finish: async () => { finishEntered.resolve(); await releaseFinish.promise; } }) : undefined; },
  });
  try {
    const first = f.send('owned turn'); await finishEntered.promise;
    selected = false;
    const second = f.send('plain turn waiting on prior settlement');
    await new Promise(resolve => setImmediate(resolve));
    const closing = f.dispose(); releaseFinish.resolve(); await Promise.all([first, second, closing]);
    assert.equal(prepares, 1, 'the classified None path goes directly to the existing native sink');
    assert.equal(f.adapter.requests.length, 2);
    assert.doesNotMatch(visibleText(f.adapter.requests[1]!), /WORKFLOW_OWNER_CONTEXT/, 'the plain request must not retain employee instructions after unload');
    const end = f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end');
    if (end?.type === 'turn/end') assert.equal(end.data.reason.kind, 'completed');
  } finally { releaseFinish.resolve(); await f.cleanup(); }
});

const visibleText = (request: GenerateOptions): string => request.messages.flatMap(message => message.content
  .flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n');
const wireMessages = (request: GenerateOptions) => request.messages.map(message => ({ role: message.role, content: message.content }));
const persistedRoundtrip = (session: Session, events: readonly SessionEvent[]): Session => {
  const rows = JSON.parse(JSON.stringify([
    sessionFormatCatalog.encodeCurrentHeader({ ...session.header, delegationDepth: session.header.delegationDepth ?? 0 } as unknown as SessionFormatHeader, session.inheritedEventCount),
    ...events.map(event => sessionFormatCatalog.encodeCurrentEvent(event as unknown as SessionFormatEvent)),
  ])) as unknown[];
  const restore = sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' });
  for (const row of rows.slice(1)) restore.decodeRow(row);
  const artifact = restore.finish();
  return Session.fromRestore(session.id, artifact.events as unknown as readonly SessionEvent[], artifact.header as unknown as SessionHeader,
    SessionLogOffset(artifact.inheritedEventCount), 'detached');
};

test('unchanged employee and knowledge definitions appear once and retain the preceding native request prefix', async () => {
  const roleBody = 'STABLE_EMPLOYEE_DEFINITION '.repeat(80);
  const taskBody = 'STABLE_KNOWLEDGE_DEFINITION '.repeat(60);
  let policy = 'INITIAL_NATIVE_APPROVAL_POLICY';
  const f = await fixture([() => text('answer one'), () => text('answer two'), () => text('answer three')], {
    isDeliverySession: () => false, prepare: async () => lease('owner-one', {
      prompt: roleBody, taskContext: taskBody, contextKey: 'employee-version-one', tools: [tool()],
    }),
  }, { inHistory: true });
  try {
    f.ctx.systemPrompt.context({ name: 'changing-native-approval', order: 10, required: true, text: () => policy });
    await f.send('question one'); policy = 'CHANGED_NATIVE_APPROVAL_POLICY'; await f.send('question two'); await f.send('question three');
    assert.equal(f.adapter.requests.length, 3);
    for (const request of f.adapter.requests) {
      assert.equal(visibleText(request).split(roleBody).length - 1, 1, 'one retained full employee definition');
      assert.equal(visibleText(request).split(taskBody).length - 1, 1, 'one retained full knowledge definition');
      assert.ok(request.tools?.some(item => item.name === 'workflow_fixture'));
    }
    const [first, second, third] = f.adapter.requests;
    assert.deepEqual(wireMessages(second!).slice(0, first!.messages.length), wireMessages(first!), 'second request only appends after the original cached prefix');
    assert.deepEqual(wireMessages(third!).slice(0, second!.messages.length), wireMessages(second!), 'third request preserves the full prior prefix');
    assert.deepEqual(first!.tools, second!.tools); assert.deepEqual(second!.tools, third!.tools);
    assert.match(visibleText(second!), /CHANGED_NATIVE_APPROVAL_POLICY/);
  } finally { await f.cleanup(); }
});

test('native compaction dropping the retained role and task definitions rehydrates their full text once', async () => {
  const roleBody = 'ROLE_REHYDRATED_AFTER_NATIVE_COMPACTION';
  const taskBody = 'KNOWLEDGE_REHYDRATED_AFTER_NATIVE_COMPACTION';
  const f = await fixture([() => text('answer before compact'), () => text('answer after compact')], {
    isDeliverySession: () => false, prepare: async () => lease('owner-one', { prompt: roleBody, taskContext: taskBody }),
  }, { inHistory: true });
  try {
    await f.send('before compact');
    for (const seq of [...f.agent.session.surface.nodes]) {
      const event = f.agent.session.eventAt(seq);
      if (event?.type !== 'user/message' || !event.data.content.some(block => block.type === 'text' && (block.text.includes(roleBody) || block.text.includes(taskBody)))) continue;
      f.agent.session.append('compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: 0 });
      f.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'NATIVE_COMPACT_SUMMARY' }] }), {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
      });
    }
    await f.send('after compact');
    assert.equal(f.adapter.requests.length, 2);
    assert.equal(visibleText(f.adapter.requests[1]!).split(roleBody).length - 1, 1);
    assert.equal(visibleText(f.adapter.requests[1]!).split(taskBody).length - 1, 1);
    assert.match(visibleText(f.adapter.requests[1]!), /NATIVE_COMPACT_SUMMARY/);
  } finally { await f.cleanup(); }
});

test('native automatic compaction inside the pre-step waterfall cannot drop the current task snapshot', async () => {
  const roleBody = 'ROLE_AFTER_AUTOMATIC_PRESSURE';
  const taskBody = 'TASK_AFTER_AUTOMATIC_PRESSURE';
  const f = await fixture([() => text('first answer'), () => text('second answer')], {
    isDeliverySession: () => false, prepare: async () => lease('owner-one', { prompt: roleBody, taskContext: taskBody }),
  }, { inHistory: true });
  try {
    f.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.turn === 2) for (const seq of [...f.agent.session.surface.nodes]) {
        const event = f.agent.session.eventAt(seq);
        if (event?.type !== 'user/message' || !event.data.content.some(block => block.type === 'text' && (block.text.includes(roleBody) || block.text.includes(taskBody)))) continue;
        f.agent.session.append('compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: 0 });
        f.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'AUTOMATIC_NATIVE_SUMMARY' }] }), {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
        });
      }
      return next();
    });
    await f.send('first'); await f.send('second');
    assert.equal(f.adapter.requests.length, 2);
    assert.equal(visibleText(f.adapter.requests[1]!).split(roleBody).length - 1, 1);
    assert.equal(visibleText(f.adapter.requests[1]!).split(taskBody).length - 1, 1);
  } finally { await f.cleanup(); }
});

test('switching owner or choosing None retires only plugin context while retaining native policy, user history and replayable audit', async () => {
  let selected: string | undefined = 'FIRST_OWNER';
  const f = await fixture([() => text('first answer'), request => {
    assert.doesNotMatch(visibleText(request), /PRIVATE_FIRST_OWNER|PRIVATE_FIRST_KNOWLEDGE/);
    assert.match(visibleText(request), /PRIVATE_SECOND_OWNER|PRIVATE_SECOND_KNOWLEDGE/);
    return text('second answer');
  }, request => {
    assert.doesNotMatch(visibleText(request), /PRIVATE_(FIRST|SECOND)_(OWNER|KNOWLEDGE)/);
    assert.match(visibleText(request), /NATIVE_PERMISSION_CONTEXT|original user question|first answer|second answer/);
    return text('native answer');
  }], { isDeliverySession: () => false, selectModel: () => selected ? { model: { provider: 'fixture', model: 'same-model' } } : undefined, prepare: async () => selected ? lease('same-model', {
    prompt: selected === 'FIRST_OWNER' ? 'PRIVATE_FIRST_OWNER' : 'PRIVATE_SECOND_OWNER',
    taskContext: selected === 'FIRST_OWNER' ? 'PRIVATE_FIRST_KNOWLEDGE' : 'PRIVATE_SECOND_KNOWLEDGE', contextKey: selected,
  }) : undefined }, { inHistory: true });
  try {
    await f.send('original user question');
    const firstContext = f.agent.session.snapshotEvents().find(event => event.type === 'user/message'
      && JSON.stringify(event.data.content).includes('PRIVATE_FIRST_OWNER'))!;
    const original = JSON.stringify(firstContext);
    selected = 'SECOND_OWNER'; await f.send('second user question'); selected = undefined; await f.send('native question');
    assert.equal(f.adapter.requests.length, 3);
    assert.doesNotMatch(visibleText(f.adapter.requests[1]!), /PRIVATE_FIRST_OWNER|PRIVATE_FIRST_KNOWLEDGE/);
    assert.match(visibleText(f.adapter.requests[1]!), /PRIVATE_SECOND_OWNER/);
    assert.match(visibleText(f.adapter.requests[1]!), /PRIVATE_SECOND_KNOWLEDGE/);
    assert.doesNotMatch(visibleText(f.adapter.requests[2]!), /PRIVATE_(FIRST|SECOND)_(OWNER|KNOWLEDGE)/);
    for (const body of ['NATIVE_PERMISSION_CONTEXT', 'original user question', 'first answer', 'second answer']) assert.ok(visibleText(f.adapter.requests[2]!).includes(body));
    assert.equal(JSON.stringify(firstContext), original, 'the original audit record stays immutable');
    const events = f.agent.session.snapshotEvents();
    assert.ok(events.some(event => event.type === 'compaction/prune'));
    const replay = Session.create(SessionId('workflow-context-replay'), events);
    assert.deepEqual(replay.deriveMessages(), f.agent.session.deriveMessages(), 'official Session replays without plugin-only interpreters');
  } finally { await f.cleanup(); }
});

test('a changed knowledge snapshot does not rewrite the separate stable employee definition', async () => {
  let data = 'FIRST_KNOWLEDGE_VERSION';
  const f = await fixture([() => text('first answer'), request => {
    assert.doesNotMatch(visibleText(request), /FIRST_KNOWLEDGE_VERSION/);
    assert.match(visibleText(request), /SECOND_KNOWLEDGE_VERSION/);
    return text('second answer');
  }], { isDeliverySession: () => false, prepare: async () => lease('owner-one', {
    prompt: 'UNCHANGED_ROLE_BODY', contextKey: 'same-employee', taskContext: data,
  }) });
  try {
    await f.send('first');
    const roleContext = f.agent.session.snapshotEvents().find(event => event.type === 'user/message'
      && JSON.stringify(event.data.content).includes('UNCHANGED_ROLE_BODY'))!;
    data = 'SECOND_KNOWLEDGE_VERSION'; await f.send('second');
    assert.equal(f.adapter.requests.length, 2);
    assert.doesNotMatch(visibleText(f.adapter.requests[1]!), /FIRST_KNOWLEDGE_VERSION/);
    assert.match(visibleText(f.adapter.requests[1]!), /SECOND_KNOWLEDGE_VERSION/);
    assert.ok(f.agent.session.surface.nodes.includes(roleContext.seq), 'role node is preserved when only data changes');
  } finally { await f.cleanup(); }
});

test('idle unload removes retained employee definitions and legacy combined snapshots without removing native policy', async () => {
  const f = await fixture([() => text('owned answer'), request => {
    assert.doesNotMatch(visibleText(request), /RETIRED_EMPLOYEE_BODY|RETIRED_KNOWLEDGE_BODY|LEGACY_EMPLOYEE_BODY/);
    assert.match(visibleText(request), /LEGACY_NATIVE_POLICY|NATIVE_PERMISSION_CONTEXT/);
    return text('native after unload');
  }], { isDeliverySession: () => false, prepare: async () => lease('owner-one', {
    prompt: 'RETIRED_EMPLOYEE_BODY', taskContext: 'RETIRED_KNOWLEDGE_BODY',
  }) });
  try {
    const sections = [{ name: 'legacy-native-policy', text: 'LEGACY_NATIVE_POLICY' },
      { name: 'composable-workforce:conversation-workflow', text: 'LEGACY_EMPLOYEE_BODY' }];
    f.agent.session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot', sections },
      content: [{ type: 'text', text: joinContextSections(sections) }] }), { surfaceOp: 'append' });
    await f.send('owned'); await f.dispose(); await f.send('native');
    assert.equal(f.adapter.requests.length, 2);
    assert.doesNotMatch(visibleText(f.adapter.requests[1]!), /RETIRED_EMPLOYEE_BODY|RETIRED_KNOWLEDGE_BODY|LEGACY_EMPLOYEE_BODY/);
    assert.match(visibleText(f.adapter.requests[1]!), /LEGACY_NATIVE_POLICY/);
  } finally { await f.cleanup(); }
});

test('unload retires restored idle native context even when this plugin never observed a turn', async () => {
  let prepared = 0;
  const restored = [{ name: 'native-restored-policy', text: 'RESTORED_NATIVE_POLICY' },
    { name: 'composable-workforce:conversation-workflow', text: 'UNTRACKED_RESTORED_EMPLOYEE' }];
  const f = await fixture([request => {
    assert.doesNotMatch(visibleText(request), /UNTRACKED_RESTORED_EMPLOYEE/);
    assert.match(visibleText(request), /RESTORED_NATIVE_POLICY/);
    return text('native after restored idle unload');
  }], { isDeliverySession: () => false, selectModel: () => undefined, prepare: async () => { prepared++; return undefined; } }, {
    existing: true, beforeRegister: agent => { agent.session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot', sections: restored },
      content: [{ type: 'text', text: joinContextSections(restored) }] }), { surfaceOp: 'append' }); },
  });
  try {
    assert.equal(f.agent.status, 'idle'); await f.dispose();
    assert.equal(prepared, 0, 'unload cannot start an employee or model turn to discover its context');
    await f.send('native question');
    assert.equal(f.adapter.requests.length, 1);
    assert.doesNotMatch(visibleText(f.adapter.requests[0]!), /UNTRACKED_RESTORED_EMPLOYEE/);
    assert.match(visibleText(f.adapter.requests[0]!), /RESTORED_NATIVE_POLICY/);
  } finally { await f.cleanup(); }
});

test('restored standalone identity retires on new owner, None and unload while native policy and audit remain intact', async () => {
  for (const boundary of ['new-owner', 'none', 'unload', 'delivery'] as const) {
    const restored = [{ name: 'native-restored-policy', text: 'RETAINED_NATIVE_POLICY' },
      { name: 'digital-worker:identity', text: 'OLD_STANDALONE_IDENTITY_AND_C_KNOWLEDGE' }];
    let prepares = 0;
    const f = await fixture([() => text('native response after handoff')], {
      isDeliverySession: () => boundary === 'delivery', selectModel: () => boundary === 'new-owner' ? { model: { provider: 'fixture', model: 'new-owner' } } : undefined, prepare: async () => {
        prepares++; return boundary === 'new-owner' ? lease('new-owner', { prompt: 'NEW_EMPLOYEE_BODY' }) : undefined;
      },
    }, { existing: true, beforeRegister: agent => {
      agent.session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot', sections: restored },
        content: [{ type: 'text', text: joinContextSections(restored) }] }), { surfaceOp: 'append' });
      agent.session.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: 'ORIGINAL_NATIVE_USER_TEXT' }] }), { surfaceOp: 'append' });
      agent.session.append('assistant/message', { turn: 0, step: 0, stream: [], message: createAssistantMessage({
        source: { kind: 'model', provider: 'fixture', model: 'native-model' }, content: [{ type: 'text', text: 'ORIGINAL_NATIVE_ANSWER' }],
      }) }, { surfaceOp: 'append' });
    } });
    try {
      const originalEvents = f.agent.session.snapshotEvents();
      if (boundary === 'unload') await f.dispose();
      await f.send('ordinary native continuation');
      assert.equal(f.adapter.requests.length, 1);
      const request = visibleText(f.adapter.requests[0]!);
      if (boundary === 'delivery') assert.match(request, /OLD_STANDALONE_IDENTITY_AND_C_KNOWLEDGE/);
      else assert.doesNotMatch(request, /OLD_STANDALONE_IDENTITY_AND_C_KNOWLEDGE/, boundary);
      assert.match(request, /RETAINED_NATIVE_POLICY/);
      assert.match(request, /ORIGINAL_NATIVE_USER_TEXT/); assert.match(request, /ORIGINAL_NATIVE_ANSWER/);
      if (boundary === 'new-owner') assert.match(request, /NEW_EMPLOYEE_BODY/);
      assert.equal(prepares, ['unload', 'delivery'].includes(boundary) ? 0 : 1);
      assert.deepEqual(f.agent.session.snapshotEvents().slice(0, originalEvents.length), originalEvents, 'immutable original history remains available for audit');
    } finally { await f.cleanup(); }
  }
});

test('async public context observation merges events received during the read and is not repeated on unchanged turns', async () => {
  const entered = deferred(); const release = deferred(); let reads = 0;
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture([() => text('first answer'), () => text('second answer')], {
    isDeliverySession: () => false, selectModel: () => ({ model: { provider: 'fixture', model: 'same-model' } }), prepare: async () => lease('same-model', { prompt: 'CURRENT_EMPLOYEE' }),
    readEvents: async (agent, signal) => {
      reads++;
      const observation = await f.ctx.sessionQuery.observeSession(agent.id, { signal, projectionMode: 'none' });
      const baseline = observation.events; observation[Symbol.dispose]();
      entered.resolve(); await release.promise; return baseline;
    },
  });
  try {
    const sending = f.send('first question'); await entered.promise;
    const raced = [{ name: 'composable-workforce:conversation-workflow', text: 'RACED_OLD_EMPLOYEE_CONTEXT' }];
    f.agent.session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot', sections: raced },
      content: [{ type: 'text', text: joinContextSections(raced) }] }), { surfaceOp: 'append' });
    release.resolve(); await sending;
    assert.equal(f.adapter.requests.length, 1);
    assert.doesNotMatch(visibleText(f.adapter.requests[0]!), /RACED_OLD_EMPLOYEE_CONTEXT/);
    await f.send('unchanged second question');
    assert.equal(reads, 1, 'steady state uses the event feed instead of rereading all native history');
  } finally { release.resolve(); await f.cleanup(); }
});

test('production context priming uses the injected public Session query without loading or resuming an Agent', async () => {
  let inspections = 0;
  const f = await fixture([() => text('native response')], {
    readEvents: undefined, isDeliverySession: () => false, selectModel: () => undefined, prepare: async () => undefined,
  }, { existing: true, beforeRegister: (agent, ctx) => {
    const restored = [{ name: 'composable-workforce:conversation-workflow', text: 'RESTORED_SCOPE_BEFORE_REGISTRATION' }];
    agent.session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot', sections: restored },
      content: [{ type: 'text', text: joinContextSections(restored) }] }), { surfaceOp: 'append' });
  } });
  try {
    await f.send('ordinary native question');
    assert.equal((f.ctx.sessionQuery as FixtureSessionQuery).observations, 1); assert.equal(f.adapter.requests.length, 1);
    assert.doesNotMatch(visibleText(f.adapter.requests[0]!), /RESTORED_SCOPE_BEFORE_REGISTRATION/);
  } finally { await f.cleanup(); }
});

test('restored memory results pair repeated call IDs by turn and step without leaking an earlier employee or retiring native results', async () => {
  for (const repeat of ['different-turn', 'different-step'] as const) {
    const callId = ToolCallId('provider-reused-call-id');
    const current = workflowContextDefinition('CURRENT_EMPLOYEE', 'current')!;
    const f = await fixture([() => text('continued current employee')], {
      isDeliverySession: () => false, selectModel: () => ({ model: { provider: 'fixture', model: 'same-model' } }), prepare: async () => lease('same-model', { prompt: 'CURRENT_EMPLOYEE', contextKey: 'current' }),
    }, { existing: true, beforeRegister: agent => {
      const owner = (text: string, scope: string) => {
        const definition = workflowContextDefinition(text, scope)!;
        const sections = [{ name: 'native-restored-policy', text: 'ORIGINAL_NATIVE_POLICY' },
          { name: 'composable-workforce:conversation-workflow', text: `<workforce_role_definition version="${definition.version}">\n${definition.text}\n</workforce_role_definition>` }];
        agent.session.append('user/message', createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot', sections },
          content: [{ type: 'text', text: joinContextSections(sections) }] }), { surfaceOp: 'append' });
      };
      const invocation = (turn: number, step: number, name: string, body: string) => {
        agent.session.append('assistant/message', { turn, step, stream: [], message: createAssistantMessage({
          source: { kind: 'model', provider: 'fixture', model: 'same-model' },
          content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
        }) }, { surfaceOp: 'append' });
        agent.session.append('tool/call', { turn, step, callId, name, arguments: '{}' });
        agent.session.append('tool/result', { turn, step, message: createToolResultMessage({ callId, isError: false,
          content: [{ type: 'text', text: body }] }) }, { surfaceOp: 'append' });
      };
      owner('PREVIOUS_EMPLOYEE', 'previous');
      agent.session.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: 'ORIGINAL_USER_REQUEST' }] }), { surfaceOp: 'append' });
      invocation(1, 1, 'worker_memory_search', 'PREVIOUS_PRIVATE_A_AND_B_BODY');
      invocation(1, 2, 'native_lookup', 'ORIGINAL_NATIVE_TOOL_BODY');
      owner('CURRENT_EMPLOYEE', 'current');
      invocation(repeat === 'different-turn' ? 2 : 1, repeat === 'different-turn' ? 1 : 3,
        'worker_memory_search', 'CURRENT_PRIVATE_A_AND_B_BODY');
      agent.session.append('assistant/message', { turn: 2, step: 4, stream: [], message: createAssistantMessage({
        source: { kind: 'model', provider: 'fixture', model: 'same-model' }, content: [{ type: 'text', text: 'ORIGINAL_NATIVE_ANSWER' }],
      }) }, { surfaceOp: 'append' });
    } });
    try {
      const originalEvents = f.agent.session.snapshotEvents();
      await f.send('continue with the current employee');
      assert.equal(f.adapter.requests.length, 1);
      const request = f.adapter.requests[0]!;
      const content = visibleText(request);
      assert.doesNotMatch(content, /PREVIOUS_PRIVATE_A_AND_B_BODY/, repeat);
      assert.match(content, /CURRENT_PRIVATE_A_AND_B_BODY/);
      assert.match(content, /ORIGINAL_NATIVE_POLICY/); assert.match(content, /ORIGINAL_USER_REQUEST/);
      assert.match(content, /ORIGINAL_NATIVE_ANSWER/);
      assert.match(content, /ORIGINAL_NATIVE_TOOL_BODY/);
      const retired = request.messages.filter(message => message.role === 'tool' && JSON.stringify(message.content).includes('workforce-retired-memory-result'));
      assert.equal(retired.length, 1, 'only the earlier employee memory result retires');
      if (retired[0]?.role === 'tool') assert.equal(retired[0].toolCallId, callId);
      assert.match(content, new RegExp(current.version));
      assert.deepEqual(f.agent.session.snapshotEvents().slice(0, originalEvents.length), originalEvents, 'original call/result content and coordinates remain in the immutable audit log');
    } finally { await f.cleanup(); }
  }
});

test('switching employee retires private A/B tool bodies while unchanged turns retain them and native results stay intact', async () => {
  for (const layer of ['A', 'B'] as const) {
    let selected = 'FIRST_EMPLOYEE';
    const packet = createContextPacket([{ layer, id: 'private-evidence', library: 'employee', version: 1,
      title: 'Private evidence', content: `PRIVATE_${layer}_RETRIEVAL_BODY` }], { maxTokens: 1000, ...(layer === 'A' ? { reason: 'verify' as const } : {}) });
    const f = await fixture([() => call('worker_memory_search'), () => call('native_lookup'), () => text('Public delivered answer'),
      () => text('Same owner answer'), () => text('New owner answer')], {
      isDeliverySession: () => false, selectModel: () => ({ model: { provider: 'fixture', model: 'same-model' } }), prepare: async () => lease('same-model', { prompt: selected, contextKey: selected,
        taskContext: 'UNCHANGED_KNOWLEDGE_ENTRY', tools: [tool('worker_memory_search', async () => JSON.stringify(packet))] }),
    });
    try {
      f.ctx.tools.register(tool('native_lookup', async () => 'NATIVE_LOOKUP_RESULT'));
      await f.send('first question');
      const original = f.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && JSON.stringify(event.data.message.content).includes(`PRIVATE_${layer}_RETRIEVAL_BODY`))!;
      const archived = JSON.stringify(original);
      await f.send('same owner question');
      assert.match(visibleText(f.adapter.requests[3]!), new RegExp(`PRIVATE_${layer}_RETRIEVAL_BODY`));
      selected = 'SECOND_EMPLOYEE'; await f.send('new owner question');
      const final = f.adapter.requests.at(-1)!;
      assert.doesNotMatch(visibleText(final), new RegExp(`PRIVATE_${layer}_RETRIEVAL_BODY`));
      assert.match(visibleText(final), /NATIVE_LOOKUP_RESULT|Public delivered answer/);
      const retired = final.messages.find(message => message.role === 'tool' && JSON.stringify(message.content).includes('workforce-retired-memory-result'));
      assert.ok(retired && original.type === 'tool/result');
      if (retired.role === 'tool') assert.equal(retired.toolCallId, original.data.message.toolCallId);
      assert.equal(JSON.stringify(original), archived, 'original private evidence remains in the immutable audit log');
    } finally { await f.cleanup(); }
  }
});

test('knowledge replacement and None retire owned memory results inside the next real turn without reinterpreting other tool payloads', async () => {
  for (const boundary of ['knowledge-change', 'none'] as const) {
    let enabled = true; let knowledge = 'KNOWLEDGE_VERSION_ONE';
    const f = await fixture([() => call('worker_memory_write'), () => text('Delivered answer'), () => text('After boundary')], {
      isDeliverySession: () => false, selectModel: () => enabled ? { model: { provider: 'fixture', model: 'same-model' } } : undefined, prepare: async () => enabled ? lease('same-model', { prompt: 'SAME_EMPLOYEE', contextKey: 'same-employee',
        taskContext: knowledge, tools: [tool('worker_memory_write', async () => JSON.stringify({ id: 'memory-one', content: 'PRIVATE_MEMORY_WRITE_RESULT' }))] }) : undefined,
    });
    try {
      await f.send('before boundary');
      if (boundary === 'knowledge-change') knowledge = 'KNOWLEDGE_VERSION_TWO';
      else enabled = false;
      await f.send('after boundary');
      assert.equal(f.adapter.requests.length, 3);
      assert.doesNotMatch(visibleText(f.adapter.requests.at(-1)!), /PRIVATE_MEMORY_WRITE_RESULT/);
      assert.match(visibleText(f.adapter.requests.at(-1)!), /Delivered answer/);
    } finally { await f.cleanup(); }
  }
});

test('memory retirement survives official V4 persistence restore for real-turn None, idle None and closed-turn unload', async () => {
  for (const boundary of ['none', 'idle-none', 'unload'] as const) {
    let enabled = true;
    const f = await fixture([() => call('worker_memory_search'), () => text('ORIGINAL_DELIVERED_ANSWER'), () => text('native continuation')], {
      isDeliverySession: () => false, selectModel: () => enabled ? { model: { provider: 'fixture', model: 'same-model' } } : undefined, prepare: async () => enabled ? lease('same-model', { prompt: 'RETIRING_EMPLOYEE',
        taskContext: 'RETIRING_C_KNOWLEDGE', tools: [tool('worker_memory_search', async () => 'RETAINED_PRIVATE_MEMORY_RESULT')] }) : undefined,
    });
    try {
      await f.send('ORIGINAL_USER_REQUEST');
      const originalEvents = f.agent.session.snapshotEvents();
      assert.doesNotThrow(() => persistedRoundtrip(f.agent.session, originalEvents), 'the original real completed native turn is valid');
      if (boundary === 'unload') await f.dispose();
      else if (boundary === 'idle-none') { enabled = false; retireWorkflowContexts(f.agent.session, originalEvents); }
      else { enabled = false; await f.send('native after None'); }
      const events = f.agent.session.snapshotEvents();
      const restored = persistedRoundtrip(f.agent.session, events);
      const content = JSON.stringify(restored.deriveMessages());
      assert.match(content, /ORIGINAL_USER_REQUEST/); assert.match(content, /ORIGINAL_DELIVERED_ANSWER/);
      assert.doesNotMatch(content, /RETIRING_EMPLOYEE|RETIRING_C_KNOWLEDGE/);
      if (boundary === 'none') assert.doesNotMatch(content, /RETAINED_PRIVATE_MEMORY_RESULT/);
      else assert.match(content, /RETAINED_PRIVATE_MEMORY_RESULT/, 'closed-turn tool history is retained because official V4 forbids tool/result replacement outside a real turn');
      assert.deepEqual(events.slice(0, originalEvents.length), originalEvents, 'neither restore nor retirement changes original audit entries');
      if (boundary === 'idle-none') {
        await f.send('continue after the idle selection');
        const next = persistedRoundtrip(f.agent.session, f.agent.session.snapshotEvents());
        assert.doesNotMatch(JSON.stringify(next.deriveMessages()), /RETAINED_PRIVATE_MEMORY_RESULT/, 'the next real turn safely retires deferred results before requesting the native model');
        assert.doesNotMatch(visibleText(f.adapter.requests.at(-1)!), /RETAINED_PRIVATE_MEMORY_RESULT/);
      }
    } finally { await f.cleanup(); }
  }
});

test('stream observation receives native chunks unchanged and an observer failure cannot interrupt delivery', async () => {
  const observed: StreamChunk[] = []; const errors: unknown[] = [];
  const script = text('native streaming body');
  const f = await fixture([() => script], { isDeliverySession: () => false, onError: error => { errors.push(error); },
    prepare: async () => lease('owner-one', { onStreamChunk: chunk => { observed.push(chunk); if (chunk.type === 'text-delta') throw new Error('observer fixture'); } }),
  });
  try {
    await f.send('stream');
    assert.deepEqual(observed, script); assert.equal(errors.length, 1);
    const message = f.agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message');
    assert.ok(message && message.type === 'assistant/message' && JSON.stringify(message.data.message.content).includes('native streaming body'));
  } finally { await f.cleanup(); }
});

test('official DeepSeek wire serialization preserves the native prefix and formats task data without cache-control inventions', async () => {
  let selected = true;
  const f = await fixture([() => text('first wire answer'), () => text('second wire answer'), () => text('native wire answer')], {
    isDeliverySession: () => false, selectModel: () => selected ? { model: { provider: 'fixture', model: 'owner-one' } } : undefined, prepare: async () => selected ? lease('owner-one', {
      prompt: 'WIRE_EMPLOYEE_DEFINITION', taskContext: 'WIRE_TASK_DATA', contextKey: 'wire-stable-owner', tools: [tool()],
    }) : undefined,
  }, { inHistory: true });
  const captured: Array<Record<string, any>> = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    captured.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(418, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'LOCAL_CONTEXT_WIRE_CAPTURE_ONLY' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await f.send('wire question one'); await f.send('wire question two'); selected = false; await f.send('plain wire question');
    assert.equal(f.adapter.requests.length, 3);
    const port = (server.address() as { port: number }).port;
    const options = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${port}/capture`, models: ['owner-one', 'native-model'].map(id => ({
      id, systemPromptUpdate: 'in-history' as const, toolUpdate: 'in-history' as const,
    })) });
    const adapter = new DeepSeekAdapter({ options: () => options, resolveAuth: async () => ({ headers: {} }),
      resolveUserId: () => 'local-context-wire-no-account', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    });
    for (const request of f.adapter.requests) await assert.rejects(async () => {
      for await (const _chunk of adapter.stream({ ...request, provider: 'loopback-only', signal: AbortSignal.timeout(5000) })) { /* capture endpoint never generates tokens */ }
    }, /LOCAL_CONTEXT_WIRE_CAPTURE_ONLY/);
    assert.equal(captured.length, 3);
    const [first, second, none] = captured;
    assert.equal(first!.system, second!.system); assert.deepEqual(first!.tools, second!.tools);
    assert.deepEqual(second!.messages.slice(0, first!.messages.length), first!.messages);
    for (const body of captured) {
      assert.equal(JSON.stringify(body).includes('cache_control'), false);
      assert.equal(JSON.stringify(body).includes('composable-workforce-task-context'), false, 'source attribution stays in the audit log, not the model wire payload');
    }
    assert.equal(JSON.stringify(second!.messages).split('WIRE_EMPLOYEE_DEFINITION').length - 1, 1);
    assert.equal(JSON.stringify(second!.messages).split('WIRE_TASK_DATA').length - 1, 1);
    assert.doesNotMatch(JSON.stringify(none!.messages), /WIRE_EMPLOYEE_DEFINITION|WIRE_TASK_DATA/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test('a temporary mention ticket is projected out before native admission while message identities and text blocks remain native', async () => {
  const marker = `<graph-horses-employee:${'a'.repeat(32)}>`;
  let originalId: string | undefined, preparedOriginal = false;
  const f = await fixture([request => {
    const user = request.messages.find(message => message.role === 'user' && message.id === originalId)!;
    assert.ok(user); assert.equal(user.id, originalId); assert.equal(user.source?.kind, 'user');
    assert.deepEqual(user.content, [{ type: 'text', text: ' 请处理当前附件' }, { type: 'text', text: 'SECOND_NATIVE_TEXT_BLOCK' }]);
    assert.equal(JSON.stringify(request.messages).includes(marker), false);
    return text('same native answer');
  }], { isDeliverySession: () => false, selectModel: () => ({ model: { provider: 'fixture', model: 'same-model' } }), prepare: async (_agent, _key, request, _signal, context) => {
    assert.match(request, /graph-horses-employee/);
    assert.equal(context?.userMessages.length, 1);
    assert.equal(context?.userMessages[0]?.id, originalId);
    preparedOriginal = context?.userMessages[0]?.content.some(block => block.type === 'text' && block.text.includes(marker)) === true;
    return lease('same-model');
  } });
  try {
    const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `${marker} 请处理当前附件` }, { type: 'text', text: 'SECOND_NATIVE_TEXT_BLOCK' }] });
    originalId = input.id;
    f.agent.followup(input); await f.agent.whenIdle();
    assert.ok(preparedOriginal, 'ticket validation sees the original native input exactly once');
    assert.equal(f.adapter.requests.length, 1); assert.equal(f.ctx.agents.list().length, 1);
    assert.equal(JSON.stringify(f.agent.session.deriveMessages()).includes(marker), false, 'the accepted native history contains no reusable ticket');
  } finally { await f.cleanup(); }
});

for (const kind of ['marker', 'reserved-text'] as const) test(`a new temporary owner cannot join the middle of a frozen native owner turn (${kind})`, async () => {
  const entered = deferred(), complete = deferred();
  const marker = `<graph-horses-employee:${'b'.repeat(32)}>`;
  const late = kind === 'marker' ? `${marker} DIFFERENT_EMPLOYEE_REQUEST` : '@reserved-employee DIFFERENT_EMPLOYEE_REQUEST';
  const f = await fixture([async () => { entered.resolve(); await complete.promise; return call('workflow_fixture'); }], {
    isDeliverySession: () => false,
    isTemporaryEmployeeRequest: (_agent, request) => kind === 'reserved-text' && request === late,
    selectModel: () => ({ model: { provider: 'fixture', model: 'same-model' } }), prepare: async () => lease('same-model', { tools: [tool()] }),
  });
  try {
    const sending = f.send('ORIGINAL_OWNER_REQUEST'); await entered.promise;
    f.agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: late }] }));
    complete.resolve(); await sending;
    assert.equal(f.adapter.requests.length, 1, 'the new owner request reaches no model under the previous owner');
    assert.match(JSON.stringify(f.agent.session.snapshotEvents()), /当前轮次负责人已确定/);
    assert.equal(JSON.stringify(f.agent.session.deriveMessages()).includes('DIFFERENT_EMPLOYEE_REQUEST'), false);
  } finally { complete.resolve(); await f.cleanup(); }
});

test('unload recognizes a reserved temporary request per message before asynchronous preparation and cancels only that pending owner', async () => {
  const entered = deferred(), complete = deferred(); let cancelledBeforePrepareReturns = false;
  const f = await fixture([], {
    isDeliverySession: () => false, ownsPendingTurn: () => false,
    isTemporaryEmployeeRequest: (_agent, request) => request === 'RESERVED_NATIVE_TEXT',
    prepare: async (_agent, _key, _request, signal) => {
      entered.resolve(); await complete.promise; cancelledBeforePrepareReturns = signal?.aborted === true;
      return lease('same-model');
    },
  });
  try {
    const sending = f.send('RESERVED_NATIVE_TEXT'); await entered.promise;
    const unloading = f.dispose();
    complete.resolve(); await unloading; await sending;
    assert.ok(cancelledBeforePrepareReturns);
    assert.equal(f.adapter.requests.length, 0);
  } finally { complete.resolve(); await f.cleanup(); }
});


test('a queued owner change captures its route before a previous asynchronous settlement and None restores the native choice', async () => {
  const settling = deferred(), release = deferred();
  let selected: string | undefined = 'first-owner';
  const models: string[] = [];
  const f = await fixture([
    request => { models.push(request.model); return text('first done'); },
    request => { models.push(request.model); return call('workflow_fixture'); },
    request => { models.push(request.model); return text('second done'); },
    request => { models.push(request.model); return text('native done'); },
  ], {
    isDeliverySession: () => false,
    selectModel: () => selected ? { model: { provider: 'fixture', model: selected } } : undefined,
    prepare: async () => selected ? lease(selected, { tools: [tool()], finish: async () => {
      if (selected === 'first-owner') { settling.resolve(); await release.promise; }
    } }) : undefined,
  });
  try {
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] }));
    await settling.promise;
    selected = 'second-owner';
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] }));
    release.resolve(); await f.agent.whenIdle(); await new Promise(resolve => setImmediate(resolve));
    selected = undefined;
    await f.send('native');
    assert.deepEqual(models, ['first-owner', 'second-owner', 'second-owner', 'native-model']);
    assert.equal(f.selection.current?.model, 'native-model');
  } finally { release.resolve(); await f.cleanup(); }
});

test('each owner step budgets the current official conditional tool admission instead of the first assembly', async () => {
  let available = false;
  const admitted: string[][] = [];
  const f = await fixture([
    () => { available = true; return call('workflow_fixture'); },
    () => text('conditional tools refreshed'),
  ], {
    isDeliverySession: () => false,
    prepare: async () => lease(undefined, { tools: [tool()], beforeStep: async step => { admitted.push(step.assembly!.tools.map(tool => tool.name)); } }),
  }, { existing: true, beforeRegister: (_agent, ctx) => { ctx.tools.register(tool('native_later'), { when: () => available }); } });
  try {
    await f.send('resolve tools per native step');
    assert.equal(f.adapter.requests.length, 2);
    assert.equal(admitted[0]!.includes('native_later'), false);
    assert.equal(admitted[1]!.includes('native_later'), true);
    assert.deepEqual(admitted, f.adapter.requests.map(request => request.tools!.map(tool => tool.name)));
  } finally { await f.cleanup(); }
});


test('a native model selection made during an owned turn waits until None while all owner steps keep the captured route', async () => {
  let owned = true;
  const f = await fixture([
    () => { f.agent.model.select({ provider: 'fixture', model: 'native-updated', reasoningEffort: ReasoningEffortId('high') }); return call('workflow_fixture'); },
    request => { assert.equal(request.model, 'owner-one'); assert.equal(request.reasoningEffort, undefined); return text('owner finished'); },
    request => { assert.equal(request.model, 'native-updated'); assert.equal(request.reasoningEffort, ReasoningEffortId('high')); return text('native selection restored'); },
  ], {
    isDeliverySession: () => false,
    selectModel: () => owned ? { model: { provider: 'fixture', model: 'owner-one' } } : undefined,
    prepare: async () => owned ? lease(undefined, { tools: [tool()] }) : undefined,
  });
  try {
    await f.send('owned turn');
    assert.equal(f.adapter.requests.length, 2);
    assert.equal(f.selection.current?.model, 'native-updated');
    owned = false; await f.send('None uses the pending native selection');
    assert.equal(f.adapter.requests.length, 3);
    assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error').length, 0);
  } finally { await f.cleanup(); }
});
