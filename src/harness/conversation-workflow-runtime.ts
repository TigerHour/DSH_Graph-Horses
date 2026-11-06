import type { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent';
import { boundContextSummary, createUserMessage, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-query';
import type { PromptAssembly, PromptPresentation } from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition, ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { hasTemporaryEmployeeMentionMarker, stripTemporaryEmployeeMentionMarker } from '../domain/conversation-employee.js';
import { pendingWorkflowTask, retainedWorkflowRole, retireWorkflowContexts, workflowContextDefinition, WORKFLOW_ROLE_CONTEXT, type WorkflowContextDefinition } from './native-workflow-context.js';

/** Business ownership for one turn of an existing native conversation. */
export interface NativeWorkflowLease {
  id: string;
  prompt: string;
  /** Stable identity/config scope. No request, run id, timestamp or transient status. */
  contextKey?: string;
  /** Variable step/C knowledge, appended separately from the stable role definition. */
  taskContext?: string;
  model: ModelSelection;
  /** An explicit task-budget reservation; undefined preserves the native output setting. */
  maxTokens?: number;
  tools?: readonly ToolDefinition[];
  /** Explicit consultation: no new tool schemas/catalog, and no tool execution. */
  toolPolicy?: 'consult';
  beforeStep?: (step: NativeConversationStep) => Promise<void>;
  guard?: (execution: ToolExecution) => string | undefined;
  afterTool?: (execution: ToolDispatchExecution, result: ToolExecutionResult) => Promise<void>;
  finish?: (events: readonly SessionEvent[]) => Promise<void>;
  dispose?: () => void | Promise<void>;
  /** Read-only progress observation; the native stream is never intercepted or rewritten. */
  onStreamChunk?: (chunk: StreamChunk) => void;
}

export interface NativeConversationStep {
  agent: Agent;
  messages: UserMessage[];
  turn: number;
  step: number;
  signal: AbortSignal;
  assembly?: PromptAssembly;
}

export interface ConversationWorkflowRuntimeDependencies {
  /** Undefined means the native conversation continues without an employee owner. */
  prepare(agent: Agent, turnKey: string, requestText: string, signal?: AbortSignal, context?: { userMessages: readonly UserMessage[]; modelSelection?: Readonly<ModelSelection> }): Promise<NativeWorkflowLease | undefined>;
  /** Read synchronously before native step preparation captures its route. */
  selectModel?: (agent: Agent, turnKey: string, requestText: string) => { model: ModelSelection; toolPolicy?: 'consult' } | undefined;
  /** Stable public contracts; their conditional registrations delegate only to the active lease. */
  tools?: readonly ToolDefinition[];
  /** Generated delivery records retain their own runtime and must never be adopted. */
  isDeliverySession(sessionId: string): boolean;
  /** Synchronous read-only classification allows unload to cancel real pending owners promptly. */
  ownsPendingTurn?: (agent: Agent, requestText?: string) => boolean;
  /** Read-only recognition of an explicit pending temporary target, excluding resident defaults. */
  isTemporaryEmployeeRequest?: (agent: Agent, requestText: string) => boolean;
  /** Public full-event observation seam; production uses the injected Session controller. */
  readEvents?: (agent: Agent, signal?: AbortSignal) => Promise<readonly SessionEvent[]>;
  onError?: (error: unknown) => void;
}

interface TurnState {
  agent: Agent;
  turn: number;
  startSeq: number;
  key: string;
  incoming: UserMessage[];
  prepared: boolean;
  preparing?: Promise<void>;
  lease?: NativeWorkflowLease;
  toolDisposers: Array<() => void>;
  reassembling: boolean;
  ended: boolean;
  settling?: Promise<void>;
  assembly?: PromptAssembly;
  ownsPending?: boolean;
  pendingOwnerChange?: boolean;
  roleDefinition?: WorkflowContextDefinition;
  taskDefinition?: WorkflowContextDefinition;
  selection?: Readonly<ModelSelection>;
  nativeSelection?: Readonly<ModelSelection>;
  toolPolicy?: 'consult';
  selectionError?: unknown;
  selected: boolean;
}

interface AgentState { current?: TurnState; settlement: Promise<void> }

function userText(messages: readonly UserMessage[]): string {
  return messages.filter(message => message.source.kind === 'user')
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    .join('\n\n');
}

function modelNotice(agent: Agent, model: ModelSelection): UserMessage | undefined {
  const previous = agent.session.requestHeader()?.config;
  if (!previous || (previous.provider === model.provider && previous.model === model.model)) return undefined;
  const from = previous.provider === model.provider ? previous.model : `${previous.provider}/${previous.model}`;
  const to = previous.provider === model.provider ? model.model : `${model.provider}/${model.model}`;
  return createUserMessage({
    content: [{ type: 'text', text: `[model changed: assistant turns above this point were generated by ${from}; the session continues with ${to}]` }],
    source: { kind: 'model-selection', form: 'notice', summary: boundContextSummary(`${from} → ${to}`) },
  });
}

/**
 * Official Agent/prompt/tool waterfalls adapt the current conversation in place.
 * No prompt is resubmitted, no Session is created, and native presets, attachments,
 * history, sandbox and approval policies stay owned by Harness.
 *
 * The native loop captures its model after claiming input, then resolves
 * conditional tools before prompt assembly. Select synchronously at that claim;
 * stable scoped tool registrations await one frozen lease in their conditions.
 * A guarded public reassembly reads each step's authoritative executor schemas
 * for budgeting without changing the executor-owned tool declarations.
 */
export function registerConversationWorkflowRuntime(ctx: Context, deps: ConversationWorkflowRuntimeDependencies): () => Promise<void> {
  // Cordis may dispose sibling service providers concurrently with this
  // adapter. Keep the public handles needed to finish owned cleanup.
  const agentRegistry = ctx.agents;
  const sessionQuery = ctx.get('sessionQuery');
  const agents = new Map<string, AgentState>();
  const hooks: Array<() => void> = [];
  const observed = new Map<string, { events: Map<number, SessionEvent>; primed: boolean; priming?: Promise<void> }>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let selectingModel = false;
  const registeredTools = new Map<Agent, { definitions: Map<string, ToolDefinition>; disposers: Array<() => void> }>();
  const sameModel = (left: Readonly<ModelSelection> | undefined, right: Readonly<ModelSelection> | undefined) =>
    left?.provider === right?.provider && left?.model === right?.model && left?.reasoningEffort === right?.reasoningEffort;
  const select = (agent: Agent, selection: Readonly<ModelSelection>) => {
    selectingModel = true;
    try { agent.model.select(selection); } finally { selectingModel = false; }
  };

  const report = (error: unknown) => {
    try { if (deps.onError) deps.onError(error); else ctx.logger.error(error); }
    catch { /* A reporting failure must not strand lease cleanup. */ }
  };
  const observation = (sessionId: string) => {
    let value = observed.get(sessionId);
    if (!value) { value = { events: new Map(), primed: false }; observed.set(sessionId, value); }
    return value;
  };
  const primeEvents = async (agent: Agent, signal?: AbortSignal, refresh = false): Promise<void> => {
    const value = observation(agent.id);
    if (value.priming) await value.priming;
    if (value.primed && !refresh) return;
    const read = deps.readEvents ?? (sessionQuery ? async (target: Agent, abort?: AbortSignal) => {
      const observed = await sessionQuery.observeSession(target.id, { signal: abort, projectionMode: 'none' });
      try { return [...observed.events]; } finally { observed[Symbol.dispose](); }
    } : undefined);
    // Service-less in-memory compositions observe only their own event feed.
    // The production plugin already requires the public Session controller.
    if (!read) { value.primed = true; return; }
    value.priming = (async () => {
      const baseline = await read(agent, signal);
      // Event subscriptions are installed before the query; do not overwrite
      // newer observations that arrived while this immutable cut was awaited.
      for (const event of baseline) if (!value.events.has(event.seq)) value.events.set(event.seq, event);
      value.primed = true;
    })();
    try { await value.priming; } finally { value.priming = undefined; }
  };
  const retire = (agent: Agent, role?: WorkflowContextDefinition, task?: WorkflowContextDefinition) => retireWorkflowContexts(agent.session, [...observation(agent.id).events.values()], role, task);
  const agentState = (agent: Agent): AgentState => {
    let state = agents.get(agent.id);
    if (!state) { state = { settlement: Promise.resolve() }; agents.set(agent.id, state); }
    return state;
  };
  const releaseTools = (turn: TurnState) => {
    for (const dispose of turn.toolDisposers.splice(0).reverse()) {
      try { dispose(); } catch (error) { report(error); }
    }
  };
  const eventsFor = (turn: TurnState): SessionEvent[] => {
    const result: SessionEvent[] = [];
    for (const event of turn.agent.session.snapshotEvents()) {
      if (event.seq < turn.startSeq) continue;
      result.push(event);
      if (event.type === 'turn/end' && event.data.turn === turn.turn) break;
    }
    return result;
  };
  const settle = (turn: TurnState): Promise<void> => {
    if (turn.settling) return turn.settling;
    turn.ended = true;
    releaseTools(turn);
    const owner = agentState(turn.agent);
    const previous = owner.settlement;
    const events = eventsFor(turn);
    turn.settling = previous.then(async () => {
      // Teardown may start while prepare is still observing cancellation.
      await turn.preparing?.catch(() => undefined);
      if (turn.selection && turn.nativeSelection && owner.current === turn) select(turn.agent, turn.nativeSelection);
      const lease = turn.lease;
      try { await lease?.finish?.(events); }
      finally {
        try { await lease?.dispose?.(); }
        finally { turn.lease = undefined; turn.assembly = undefined; turn.incoming = []; }
      }
    }).catch(report);
    owner.settlement = turn.settling;
    return turn.settling;
  };
  const turnFor = (agent: Agent): TurnState | undefined => {
    if (closed || deps.isDeliverySession(agent.id)) return undefined;
    const events = agent.session.snapshotEvents();
    const start = events.findLast(event => event.type === 'turn/start');
    if (!start || start.type !== 'turn/start'
      || events.some(event => event.seq > start.seq && event.type === 'turn/end' && event.data.turn === start.data.turn)) return undefined;
    const owner = agentState(agent);
    if (owner.current?.startSeq === start.seq) return owner.current.ended ? undefined : owner.current;
    if (owner.current && !owner.current.ended) void settle(owner.current);
    const previousNativeSelection = owner.current?.lease ? owner.current.nativeSelection : undefined;
    const turn: TurnState = {
      nativeSelection: previousNativeSelection,
      agent, turn: start.data.turn, startSeq: start.seq, key: `${agent.id}:${start.seq}`,
      incoming: [], prepared: false, toolDisposers: [], reassembling: false, ended: false, selected: false,
    };
    owner.current = turn;
    return turn;
  };
  const active = (agent: Agent | undefined): TurnState | undefined => {
    const turn = agent && agents.get(agent.id)?.current;
    return turn && !turn.ended ? turn : undefined;
  };
  const prepare = (turn: TurnState, signal?: AbortSignal): Promise<void> => {
    if (turn.preparing) return turn.preparing;
    turn.preparing = (async () => {
      const pendingMessages = turn.incoming.length ? turn.incoming : turn.agent.session.snapshotEvents()
        .filter(event => event.seq >= turn.startSeq && event.type === 'user/message')
        .map(event => event.data as UserMessage);
      turn.ownsPending = pendingMessages.some(message => message.source.kind === 'user' && deps.isTemporaryEmployeeRequest?.(turn.agent, userText([message])))
        || deps.ownsPendingTurn?.(turn.agent, userText(pendingMessages));
      await agentState(turn.agent).settlement;
      if (turn.selectionError) throw turn.selectionError;
      signal?.throwIfAborted();
      await primeEvents(turn.agent, signal);
      signal?.throwIfAborted();
      if (turn.ended || (closed && turn.ownsPending === true)) throw new Error('工作流对话服务已关闭');
      if (closed && turn.ownsPending === false) {
        retire(turn.agent);
        turn.prepared = true; return;
      }
      // Inbox claims precede assembly; logged user/message is a resume fallback.
      const messages = turn.incoming.length ? turn.incoming : turn.agent.session.snapshotEvents()
        .filter(event => event.seq >= turn.startSeq && event.type === 'user/message')
        .map(event => event.data as UserMessage);
      turn.lease = await deps.prepare(turn.agent, turn.key, userText(messages), signal, { userMessages: messages.filter(message => message.source.kind === 'user'), modelSelection: turn.selection });
      // None is still the native sender even if uninstall raced an async
      // project lookup. It must reach the original sink without cancellation.
      if (!turn.lease && closed) {
        retire(turn.agent);
        turn.prepared = true; return;
      }
      signal?.throwIfAborted();
      if (closed || turn.ended) throw new Error('工作流对话服务已关闭');
      const lease = turn.lease;
      if (lease && !turn.selection) throw new Error('岗位模型尚未在原生步骤准备前选定，请重新发送');
      if (lease && turn.selection && !sameModel(lease.model, turn.selection)) throw new Error('岗位模型在本轮准备期间发生变化，请重新发送');
      turn.roleDefinition = lease && workflowContextDefinition(lease.prompt, lease.contextKey);
      turn.taskDefinition = lease?.taskContext ? workflowContextDefinition(lease.taskContext, turn.roleDefinition?.version) : undefined;
      retire(turn.agent, turn.roleDefinition, turn.taskDefinition);
      for (const definition of lease?.tools ?? []) {
        const registered = registeredTools.get(turn.agent)?.definitions.get(definition.name);
        if (!registered && definition.name === 'skill' && turn.agent.ctx.tools.get('skill', turn.agent)) continue;
        if (!registered || turn.agent.ctx.tools.get(definition.name, turn.agent) !== registered) throw new Error(`工作流工具与现有工具重名或未声明：${definition.name}`);
      }
      turn.prepared = true;
    })();
    return turn.preparing;
  };
  const present = (presentation: PromptPresentation, turn: TurnState): PromptPresentation => turn.lease ? {
    ...presentation, variables: { ...presentation.variables, provider: turn.lease.model.provider, model: turn.lease.model.model },
  } : presentation;
  const registerTools = (agent: Agent) => {
    if (registeredTools.has(agent) || deps.isDeliverySession(agent.id)) return;
    const owned = { definitions: new Map<string, ToolDefinition>(), disposers: [] as Array<() => void> };
    registeredTools.set(agent, owned);
    for (const contract of deps.tools ?? []) {
      // A native skill implementation owns its name; no fallback is needed.
      if (contract.name === 'skill' && agent.ctx.tools.get('skill', agent)) continue;
      if (agent.ctx.tools.get(contract.name, agent)) continue;
      const definition: ToolDefinition = { ...contract, execute: (args, execution) => {
        const turn = active(execution.agent);
        const actual = turn?.lease?.tools?.find(tool => tool.name === contract.name);
        if (closed || !turn || !actual || turn.lease?.toolPolicy === 'consult') throw new Error('该步骤的工具授权已结束');
        return actual.execute(args, execution);
      } };
      owned.disposers.push(agent.ctx.tools.register(definition, { when: async ({ agent: target, signal }) => {
        const turn = turnFor(target);
        if (!turn) return false;
        await prepare(turn, signal);
        return !closed && !turn.ended && turn.lease?.toolPolicy !== 'consult' && Boolean(turn.lease?.tools?.some(tool => tool.name === contract.name));
      } }));
      owned.definitions.set(contract.name, definition);
    }
  };
  try { for (const agent of agentRegistry.list()) registerTools(agent); } catch (error) { report(error); }
  hooks.push(ctx.on('agent/created', ({ agent }) => { registerTools(agent); }));

  hooks.push(ctx.systemPrompt.context({ name: WORKFLOW_ROLE_CONTEXT, order: 650, required: true, interpolate: false,
    text: context => context.agent ? retainedWorkflowRole(context.agent.session, active(context.agent)?.roleDefinition) : '',
  }));
  hooks.push(ctx.on('agent/inbox/claimed', ({ agent, message, turn: number }) => {
    registerTools(agent);
    const turn = turnFor(agent);
    if (turn && turn.turn === number) {
      if (!turn.prepared) {
        turn.incoming.push(message);
        if (!turn.selected && message.source.kind === 'user') {
          turn.selected = true;
          try {
            const selected = deps.selectModel?.(agent, turn.key, userText([message]));
            if (selected) {
              turn.nativeSelection ??= agent.model.current();
              turn.selection = selected.model; turn.toolPolicy = selected.toolPolicy;
              select(agent, selected.model);
              if (selected.toolPolicy === 'consult') turn.toolDisposers.push(agent.ctx.tools.restrict({ allow: [] }));
            } else if (turn.nativeSelection) select(agent, turn.nativeSelection);
          } catch (error) { turn.selectionError = error; }
        }
      }
      else if (message.source.kind === 'user') {
        const text = userText([message]);
        if (hasTemporaryEmployeeMentionMarker(text) || deps.isTemporaryEmployeeRequest?.(agent, text)) turn.pendingOwnerChange = true;
      }
    }
  }));
  hooks.push(ctx.on('system-prompt/assemble', async (_presentation, context, next) => {
    if (!context.agent) return next();
    const turn = turnFor(context.agent);
    if (!turn) return next();
    if (turn.reassembling) return present(await next(), turn);
    await prepare(turn, context.signal);
    if (turn.lease) {
      turn.reassembling = true;
      try {
        // The official executor owns tools. Read the authoritative completed
        // assembly with the same step-owned admission; transform only text.
        const assembly = await ctx.systemPrompt.assemble(context);
        turn.assembly = assembly;
        return present({ sections: assembly.sections, contexts: assembly.contexts, variables: assembly.variables }, turn);
      } finally { turn.reassembling = false; }
    }
    return present(await next(), turn);
  }, { prepend: true }));
  hooks.push(ctx.on('agent/pre-step', async (payload, next) => {
    const turn = active(payload.agent);
    if (turn?.pendingOwnerChange) throw new Error('当前轮次负责人已确定，请等待本轮结束后重新 @ 员工');
    if (!turn?.lease) return next();
    const task = pendingWorkflowTask(payload.agent.session, turn.roleDefinition, turn.taskDefinition);
    await turn.lease.beforeStep?.({ ...payload, messages: task ? [...payload.messages, task] : payload.messages, assembly: turn.assembly });
    payload.signal.throwIfAborted();
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    // The native selector still owns its setting, but its automatic notice must
    // describe the actual workflow model rather than an unused selector route.
    const messages = decision.messages.filter(message => message.source.kind !== 'model-selection').map(message => message.source.kind !== 'user' ? message : {
      ...message, content: message.content.map(block => block.type === 'text' ? { ...block, text: stripTemporaryEmployeeMentionMarker(block.text) } : block),
    });
    // Native automatic compaction can remove a retained task snapshot inside
    // next(). Recheck after that maintenance instead of sending a dangling C ref.
    const admittedTask = pendingWorkflowTask(payload.agent.session, turn.roleDefinition, turn.taskDefinition);
    if (admittedTask) messages.push(task ?? admittedTask);
    if (messages.length || (payload.step !== 1 && payload.messages.length === 0)) {
      const notice = modelNotice(payload.agent, turn.lease.model);
      if (notice) messages.push(notice);
    }
    return { ...decision, messages };
  }, { prepend: true }));
  // Existing budget hook is limited to controls; the step's selected route
  // and reasoning effort remain byte-for-byte owned by Agent.model.
  hooks.push(ctx.on('agent/request', async ({ agent }, next) => {
    const native = await next();
    const cap = active(agent)?.lease?.maxTokens;
    return cap === undefined ? native : { ...native, maxTokens: Math.min(native.maxTokens ?? cap, cap) };
  }, { prepend: true }));
  hooks.push(ctx.tools.guard(execution => active(execution.agent)?.lease?.toolPolicy === 'consult' ? '轻咨询不执行工具；请在常驻菜单切换到工具执行' : active(execution.agent)?.lease?.guard?.(execution)));
  hooks.push(ctx.on('tools/execute', async (execution, next) => {
    const lease = active(execution.agent)?.lease;
    const result = await next();
    await lease?.afterTool?.(execution, result);
    return result;
  }));
  hooks.push(ctx.on('session/event', (session, event) => {
    observation(session.id).events.set(event.seq, event);
    const turn = agents.get(session.id)?.current;
    if (turn && turn.selection && event.type === 'model/selection' && !selectingModel) {
      turn.nativeSelection = event.data;
      // Session publication is observe-only and forbids reentrant append.
      queueMicrotask(() => { if (!closed && !turn.ended && turn.selection) select(turn.agent, turn.selection); });
    }
    if (turn && event.type === 'turn/end' && event.data.turn === turn.turn) void settle(turn);
  }));
  hooks.push(ctx.on('session/disposed', session => { observed.delete(session.id); }));
  hooks.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type !== 'chunk') return;
    try { active(agent)?.lease?.onStreamChunk?.(frame.chunk); }
    catch (error) { report(error); }
  }));
  hooks.push(ctx.on('agent/disposed', ({ agent }) => {
    const owned = registeredTools.get(agent);
    for (const dispose of owned?.disposers ?? []) dispose();
    registeredTools.delete(agent);
    const owner = agents.get(agent.id);
    if (owner?.current && !owner.current.ended) void settle(owner.current);
    void owner?.settlement.finally(() => { if (agents.get(agent.id) === owner) agents.delete(agent.id); });
  }));

  return () => closing ??= (async () => {
    closed = true;
    const owned = [...agents.values()].flatMap(owner => owner.current && !owner.current.ended
      && (owner.current.lease || (!owner.current.prepared && owner.current.preparing)) ? [owner.current] : []);
    // Cancel only turns this adapter owns; plain native conversations are untouched.
    for (const turn of owned) if (turn.lease || turn.ownsPending === true) turn.agent.cancel({ kind: 'user' });
    for (const dispose of hooks.splice(0).reverse()) { try { dispose(); } catch (error) { report(error); } }
    await Promise.all(owned.map(async turn => {
      await turn.preparing?.catch(() => undefined);
      if (!turn.lease) return;
      turn.agent.cancel({ kind: 'user' });
      await turn.agent.whenIdle().catch(report);
      await settle(turn);
    }));
    await Promise.all([...agents.values()].map(owner => owner.settlement));
    // Restored idle agents can contain an older plugin snapshot without ever
    // having opened a turn under this registration. Inspect the public live
    // registry too; never start/load a persisted session or touch active senders.
    for (const agent of agentRegistry.list()) {
      if (agent.status !== 'idle' || deps.isDeliverySession(agent.id)) continue;
      await primeEvents(agent, undefined, true);
      // Reading may yield to another native sender; never mutate an active or
      // replaced Agent merely because it was idle before that observation.
      if (agentRegistry.get(agent.id) === agent && agent.status === 'idle' && !deps.isDeliverySession(agent.id)) retire(agent);
    }
    for (const owned of registeredTools.values()) for (const dispose of owned.disposers.reverse()) { try { dispose(); } catch (error) { report(error); } }
    registeredTools.clear();
    observed.clear();
    agents.clear();
  })();
}
