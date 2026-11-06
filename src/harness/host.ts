import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { WorkforceStore } from '../domain/store.js';
import { ARCHITECT_TEMPLATE_ID, SOFTWARE_TEAM_ID } from '../domain/seed.js';
import type { CreateEmployeeInput, CreateProjectEmployeesInput, MutationOptions, ReviewRunInput, SaveEmployeeConfigurationInput, SaveMemoryInput, SaveTeamInput, SaveTemplateInput, UpdateEmployeeInput, WorkforceState } from '../domain/types.js';
import { DEFAULT_RUNTIME_CONFIG, WorkforceRuntime, type RunRequest, type RuntimeConfig } from './runtime.js';
import { loadEmployeeSkills, registerEmployeeSkills } from './skills.js';
import type { CancelProjectTeamsInput, ConfigureProjectTeamInput, SetProjectTeamKnowledgeInput } from '../domain/types.js';
import { WorkflowRepository } from '../workflow/repository.js';
import { WorkflowEngine } from '../workflow/engine.js';
import type { SaveProjectWorkflowInput, StartWorkflowInput, WorkflowCommandInput } from '../workflow/types.js';
import type { SaveWorkflowTemplateInput } from '../domain/types.js';
import type { ExportSelection, ImportOptions, ImportTarget } from '../domain/transfer-types.js';
import { listEmployeeModels } from './model-catalog.js';
import { WorkService } from '../work/service.js';
import { WorkEngine } from '../work/engine.js';
import type { WorkCommandOptions } from '../work/types.js';
import { listEmployeeCapabilities } from './capability-catalog.js';
import { KnowledgeRepository, knowledgeRootFor } from '../knowledge/repository.js';
import { KnowledgeEngine } from '../knowledge/engine.js';
import { createKnowledgeCompiler } from './knowledge-compiler.js';
import type { KnowledgeArchivePolicyRequest, KnowledgeLibraryTarget, KnowledgeRemoveRequest, KnowledgeUploadRequest } from '../knowledge/library-api.js';
import { createWikiRuntime } from '../knowledge/wiki-runtime.js';
import { createEmployeeRoleDrafter } from './employee-role-draft.js';
import type { EmployeeRoleDraftInput } from '../domain/employee-role.js';
import type { ReorderLibraryInput } from '../domain/library-order.js';
import { resolveConversationWorkflow, type SelectConversationWorkflowInput, type SelectConversationWorkflowStepInput } from '../domain/conversation-workflow.js';
import { registerConversationWorkflowRuntime } from './conversation-workflow-runtime.js';
import { isLegacyStandaloneRun } from '../domain/conversation-session.js';
import { isConversationAgentBusy } from './conversation-activity.js';
import { requireConversationWorkflowReview, resolveConversationWorkflowDetails, type ConversationWorkflowReviewInput } from '../domain/conversation-workflow-details.js';
import { conversationWorkflowsEnabled } from './workspace-policy.js';
import { admitTemporaryConversationEmployee, assertNoAdditionalTemporaryEmployeeMention, conversationEmployeeChoices, employeeInfoCard, hasTemporaryEmployeeMentionMarker, parseTemporaryEmployeeMentionMarker, resolveConversationEmployee, resolveEmployeeInfo, resolveTemporaryEmployeeMention, type AdmitTemporaryConversationEmployeeInput, type ConversationEmployeeView, type SelectConversationEmployeeInput, type ClearConversationEmployeeInput } from '../domain/conversation-employee.js';

export const name = 'composable-workforce';
export const inject = ['webServer', 'connection', 'agents', 'tools', 'systemPrompt', 'skills', 'workspaceRegistry', 'sessionController', 'agentPresets', 'llm', 'agentDefaultModel', 'sessionQuery'];
export interface Config extends Partial<RuntimeConfig> {
  statePath?: string;
  skillsDirectory?: string;
  apiPrefix?: string;
  bootstrapProjectPath?: string;
  /** Additional explicit browser origins for a reverse proxy; no wildcard is supported. */
  allowedOrigins?: string[];
  maxBodyBytes?: number;
}

/** Parse only JSON objects at the HTTP boundary; domain methods validate their fields. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求必须是 JSON 对象');
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  return value;
}

/** Ephemeral references authorize only a native user message, never create an employee or a Session. */
export function createTemporaryEmployeeMentionTickets(options: { now?: () => number; token?: () => string; capacity?: number; ttlMs?: number } = {}) {
  type Target = Omit<AdmitTemporaryConversationEmployeeInput, 'turnKey'>;
  type Ticket = { target: Target; expiresAt: number; turnKey?: string };
  const tickets = new Map<string, Ticket>(); const now = options.now ?? Date.now;
  const prune = () => { for (const [token, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(token); };
  const marker = (token: string) => `<graph-horses-employee:${token}>`;
  return {
    issue(target: Target): { marker: string } {
      prune();
      if (tickets.size >= (options.capacity ?? 1024)) throw new Error('待发送的员工引用过多，请稍后重新选择');
      const token = (options.token ?? (() => randomBytes(16).toString('hex')))();
      if (!/^[a-f0-9]{32}$/.test(token) || tickets.has(token)) throw new Error('无法建立员工引用，请重新选择');
      tickets.set(token, { target: structuredClone(target), expiresAt: now() + (options.ttlMs ?? 600_000) });
      return { marker: marker(token) };
    },
    has(sessionId: string, requestText: string): boolean {
      prune();
      return hasTemporaryEmployeeMentionMarker(requestText);
    },
    claim(sessionId: string, turnKey: string, requestText: string): { input: AdmitTemporaryConversationEmployeeInput; requestText: string } | undefined {
      prune();
      const parsed = parseTemporaryEmployeeMentionMarker(requestText);
      if (!parsed) return undefined;
      const matching = tickets.get(parsed.token);
      if (!matching) throw new Error('临时员工引用已失效，请重新选择员工后发送');
      if (matching.target.sessionId !== sessionId) throw new Error('临时员工引用不属于当前对话，请重新选择');
      if (matching.turnKey && matching.turnKey !== turnKey) throw new Error('临时员工引用已用于另一轮，请重新选择员工');
      matching.turnKey = turnKey;
      return { input: { ...structuredClone(matching.target), turnKey }, requestText: parsed.requestText };
    },
    dispose(): void { tickets.clear(); },
  };
}

/** Resolve the same existing instance that read-only temporary admission will reuse. */
export function resolveTemporaryEmployeeModel(state: WorkforceState, input: AdmitTemporaryConversationEmployeeInput) {
  const existing = admitTemporaryConversationEmployee(state, input);
  return existing?.employee?.modules.model ?? state.templates.find(template => template.id === input.templateId)?.modules.model;
}

function json(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

/** Run only after connection.admit: Desktop's authenticated proxy strips Origin.
 * The custom write header requires a browser CORS preflight, which this API never grants.
 * An explicitly supplied Origin or Fetch Metadata must still pass the same-origin fence.
 */
export function assertRequestOrigin(req: Pick<IncomingMessage, 'headers' | 'method'>, allowedOrigins: readonly string[]): void {
  const host = req.headers.host;
  if (!host || !allowedOrigins.some(origin => new URL(origin).host === host)) throw new Error('不允许的请求主机');
  const origin = req.headers.origin;
  if (origin && (!allowedOrigins.includes(origin) || new URL(origin).host !== host)) throw new Error('只允许同源请求');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !origin && req.headers['x-dsh-graph-horses'] !== '1') throw new Error('写操作必须携带同源 Origin 或客户端请求头');
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) throw new Error('不允许跨站请求');
}

async function readBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new Error('只接受 application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error('请求超过大小限制');
    chunks.push(bytes);
  }
  return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

/** Host routes deliberately reuse the existing Harness web server and credentials/model services. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const prefix = config.apiPrefix ?? '/digital-workers/api';
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(prefix) || prefix.endsWith('/')) throw new Error('apiPrefix 必须是不带末尾斜杠的绝对 URL 路径');
  const origins = [`http://127.0.0.1:${ctx.webServer.port}`, `http://localhost:${ctx.webServer.port}`, ...(config.allowedOrigins ?? [])];
  for (const origin of origins) if (new URL(origin).origin !== origin || !['http:', 'https:'].includes(new URL(origin).protocol)) throw new Error('allowedOrigins 必须是完整 HTTP(S) origin');
  // A portable document is limited separately; leave room for its command envelope.
  const bodyLimit = config.maxBodyBytes ?? 2_097_152;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) throw new Error('maxBodyBytes 必须是正整数');
  const store = await WorkforceStore.open(config.statePath ?? resolve(process.env.DSH_HOME || resolve(homedir(), '.dsh'), 'composable-workforce', 'state.json'));
  const skills = await loadEmployeeSkills(config.skillsDirectory ?? fileURLToPath(new URL('../skills/', import.meta.url)));
  registerEmployeeSkills(ctx, skills);
  const wiki = createWikiRuntime();
  const roleDrafter = createEmployeeRoleDrafter(ctx);
  const knowledge = new KnowledgeEngine(store, new KnowledgeRepository(knowledgeRootFor(store.filePath)), createKnowledgeCompiler(ctx, {}, wiki), error => ctx.logger.error(error), wiki);
  const runtime = new WorkforceRuntime(ctx, store, skills, Object.fromEntries(Object.entries(config).filter(([key]) => Object.hasOwn(DEFAULT_RUNTIME_CONFIG, key))), knowledge);
  const mentionTickets = createTemporaryEmployeeMentionTickets();
  const workflows = new WorkflowRepository(store);
  const workflowEngine = new WorkflowEngine(workflows, runtime, error => ctx.logger.error(error), projectId => {
    const workspace = ctx.workspaceRegistry.list().find(item => item.id === projectId);
    return Boolean(workspace && conversationWorkflowsEnabled(workspace));
  });
  const work = new WorkService(store);
  const workEngine = new WorkEngine(work, runtime, error => ctx.logger.error(error));
  // Historical standalone roots are ordinary project conversations again. Only
  // an active standalone attempt or an executor-owned child/task/flow remains a
  // delivery session; an old root record must not hide the selector forever.
  const isDeliverySession = (sessionId: string) => store.snapshot().runs.some(run => run.sessionId === sessionId
    && (run.parentRunId || run.workflow || run.workTaskId
      || (isLegacyStandaloneRun(run) && ['queued', 'running', 'blocked'].includes(run.status))));
  const workspaceForSession = (sessionId: string) => {
    const matches = ctx.workspaceRegistry.list().filter(item => item.sessionIds.includes(SessionId(sessionId)));
    if (matches.length > 1) throw new Error('对话的项目归属不唯一，请先检查原生工作区');
    return matches[0];
  };
  const conversationIsBusy = (sessionId: string) => {
    const agent = ctx.agents.get(SessionId(sessionId));
    return isConversationAgentBusy(agent, !runtime.ownsSession(sessionId));
  };
  const isTemporaryEmployeeRequest = (sessionId: string, requestText: string) => {
    const workspace = workspaceForSession(sessionId);
    if (!workspace || conversationWorkflowsEnabled(workspace)) return false;
    if (mentionTickets.has(sessionId, requestText)) return true;
    try { return Boolean(resolveTemporaryEmployeeMention(store.snapshot(), workspace.id, requestText)); }
    catch { return true; } // Known paused, invalid, or ambiguous roles must fail explicitly in prepare.
  };
  const disposeConversationRuntime = registerConversationWorkflowRuntime(ctx, {
    isDeliverySession,
    tools: runtime.conversationToolDefinitions(),
    selectModel: (agent, turnKey, requestText) => {
      const workspace = workspaceForSession(agent.id);
      if (!workspace) return undefined;
      const state = store.snapshot();
      let configured;
      let consult = false;
      if (conversationWorkflowsEnabled(workspace)) {
        const view = resolveConversationWorkflow(state, workspace.id, agent.id);
        if (!view.instanceId) return undefined;
        if (view.unavailableReason || !view.owner) throw new Error(view.unavailableReason ?? '请先选择当前流程负责人');
        configured = view.owner.modules.model;
      } else {
        const ticket = hasTemporaryEmployeeMentionMarker(requestText) ? mentionTickets.claim(agent.id, turnKey, requestText) : undefined;
        const temporary = ticket?.input ?? resolveTemporaryEmployeeMention(state, workspace.id, requestText);
        if (temporary) {
          const input: AdmitTemporaryConversationEmployeeInput = 'kind' in temporary ? {
            projectId: workspace.id, sessionId: agent.id, turnKey, expectedTargetVersion: temporary.version,
            ...(temporary.kind === 'employee' ? { employeeId: temporary.id } : { templateId: temporary.id }),
          } : temporary;
          configured = resolveTemporaryEmployeeModel(state, input);
          if (!configured) throw new Error('临时员工已失效，请重新选择');
        } else {
          const resident = resolveConversationEmployee(state, workspace.id, agent.id);
          if (!resident.conversationEmployee) return undefined;
          if (resident.unavailableReason || !resident.employee) throw new Error(resident.unavailableReason ?? '常驻员工已不可用');
          configured = resident.employee.modules.model;
          consult = resident.conversationEmployee.mode === 'consult';
        }
      }
      const model = configured.mode === 'inherit' ? ctx.agentDefaultModel.currentSelection() : {
        provider: configured.provider, model: configured.model,
        ...(configured.reasoningEffort ? { reasoningEffort: ReasoningEffortId(configured.reasoningEffort) } : {}),
      };
      if (!model.provider || !model.model) throw new Error('DSH 尚未设置默认模型，请在“模型选择”中选择岗位模型');
      return { model: { ...model, provider: model.provider, model: model.model }, ...(consult ? { toolPolicy: 'consult' as const } : {}) };
    },
    ownsPendingTurn: (agent, requestText) => {
      const workspace = workspaceForSession(agent.id);
      if (!workspace) return false;
      return conversationWorkflowsEnabled(workspace)
        ? Boolean(resolveConversationWorkflow(store.snapshot(), workspace.id, agent.id).instanceId)
        : Boolean(resolveConversationEmployee(store.snapshot(), workspace.id, agent.id).conversationEmployee || (requestText && isTemporaryEmployeeRequest(agent.id, requestText)));
    },
    isTemporaryEmployeeRequest: (agent, requestText) => isTemporaryEmployeeRequest(agent.id, requestText),
    prepare: async (agent, turnKey, requestText, signal, context) => {
      await syncProjects();
      const workspace = workspaceForSession(agent.id);
      if (!workspace) return undefined;
      if (!conversationWorkflowsEnabled(workspace)) {
        const userRequests = context?.userMessages.filter(message => message.source.kind === 'user').map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n')) ?? [requestText];
        const temporaryIndexes = userRequests.flatMap((text, index) => isTemporaryEmployeeRequest(agent.id, text) ? [index] : []);
        if (temporaryIndexes.length > 1) throw new Error('一轮对话只能临时调用一位员工，请分轮发送');
        if (temporaryIndexes.some(index => index > 0)) throw new Error('当前轮已接收消息，请等待本轮结束后再临时调用员工');
        if (temporaryIndexes.length) {
          const firstRequest = userRequests[0]!;
          let input: AdmitTemporaryConversationEmployeeInput;
          if (hasTemporaryEmployeeMentionMarker(firstRequest)) {
            const claimed = mentionTickets.claim(agent.id, turnKey, firstRequest);
            if (!claimed || claimed.input.projectId !== workspace.id) throw new Error('临时员工引用不属于当前工作区，请重新选择');
            assertNoAdditionalTemporaryEmployeeMention(store.snapshot(), workspace.id, claimed.requestText);
            input = claimed.input;
          } else {
            const target = resolveTemporaryEmployeeMention(store.snapshot(), workspace.id, firstRequest)!;
            input = { projectId: workspace.id, sessionId: agent.id, turnKey, expectedTargetVersion: target.version,
              ...(target.kind === 'employee' ? { employeeId: target.id } : { templateId: target.id }) };
          }
          const temporary = await store.admitTemporaryConversationEmployee(input);
          return runtime.openEmployeeConversationTurn(agent, turnKey, parseTemporaryEmployeeMentionMarker(requestText)?.requestText ?? requestText, temporary, signal, context?.modelSelection);
        }
        const resident = resolveConversationEmployee(store.snapshot(), workspace.id, agent.id);
        if (!resident.conversationEmployee) return undefined;
        if (resident.unavailableReason) throw new Error(resident.unavailableReason);
        return runtime.openEmployeeConversationTurn(agent, turnKey, requestText, resident, signal, context?.modelSelection);
      }
      const view = resolveConversationWorkflow(store.snapshot(), workspace.id, agent.id);
      if (!view.instanceId) return undefined;
      if (view.unavailableReason) throw new Error(view.unavailableReason);
      if (!view.currentStepId || !view.owner) throw new Error('此工作流已完成，请选择需要继续的步骤或将工作流设为“无”');
      return runtime.openConversationTurn(agent, turnKey, requestText, view, signal, context?.modelSelection);
    },
    onError: error => ctx.logger.error(error),
  });
  ctx.effect(() => async () => {
    // Each owner must quiesce even if a preceding cleanup fails. In particular,
    // runtime errors must never leave the archive subscription or ledger writer
    // active after the plugin's awaited disposal has finished.
    const failures: unknown[] = [];
    for (const stop of [() => mentionTickets.dispose(), () => roleDrafter.dispose(), disposeConversationRuntime,
      () => workEngine.dispose(), () => workflowEngine.dispose(), () => runtime.dispose(),
      () => knowledge.dispose(), () => wiki.dispose()]) {
      try { await stop(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, '数字员工插件清理失败');
  }, 'digital-workers.runtime');

  // An interrupted external write is not replayed automatically after a process restart.
  for (const run of store.snapshot().runs) if (!run.workflow && !run.workTaskId && (run.status === 'queued' || run.status === 'running')) await store.updateRun(run.id, { status: 'failed', error: '上次宿主运行中断；请检查交付文件后重新提交任务', finishedAt: new Date().toISOString() });

  const syncProjects = async (): Promise<void> => {
    const projects = new Map(store.listProjects().map(project => [project.id, project]));
    for (const workspace of ctx.workspaceRegistry.list()) {
      const project = projects.get(workspace.id);
      if (!project || project.name !== workspace.title || project.rootPath !== workspace.path) await store.saveProject({ id: workspace.id, name: workspace.title, rootPath: workspace.path });
    }
  };
  if (config.bootstrapProjectPath) {
    const workspace = await ctx.workspaceRegistry.create(resolve(config.bootstrapProjectPath));
    const firstSetup = !store.listProjects().some(project => project.id === workspace.id);
    await syncProjects();
    // Bootstrap the requested default software team once. Removing an employee is a project choice,
    // and restarting the local service must not silently add that employee back.
    if (firstSetup && conversationWorkflowsEnabled(workspace) && !store.snapshot().employees.some(employee => employee.projectId === workspace.id && employee.templateId === ARCHITECT_TEMPLATE_ID)) await store.instantiateTeam(workspace.id, SOFTWARE_TEAM_ID);
  } else await syncProjects();
  await knowledge.start();
  await workflowEngine.start();
  await workEngine.start();

  const requireProject = async (projectId: string) => {
    await syncProjects();
    if (!ctx.workspaceRegistry.list().some(workspace => workspace.id === projectId)) throw new Error('项目文件夹已被移除');
  };
  const requireProjectConversation = async (projectId: string, sessionId: string) => {
    await requireProject(projectId);
    const workspace = workspaceForSession(sessionId);
    if (!workspace || workspace.id !== projectId) throw new Error('对话不属于当前项目');
    if (isDeliverySession(sessionId)) throw new Error('交付记录不能切换对话工作流，请返回项目对话');
    if (conversationIsBusy(sessionId)) throw new Error('当前对话正在执行或有待处理消息，请等待本轮结束再切换工作流或步骤');
    return workspace;
  };
  const requireWorkflowProject = async (projectId: string) => {
    await requireProject(projectId);
    const workspace = ctx.workspaceRegistry.list().find(item => item.id === projectId)!;
    if (!conversationWorkflowsEnabled(workspace)) throw new Error('Chat 工作区不提供工作流服务，请通过 @ 调用独立员工');
  };
  const requireConversation = async (projectId: string, sessionId: string) => {
    const workspace = await requireProjectConversation(projectId, sessionId);
    if (!conversationWorkflowsEnabled(workspace)) throw new Error('Chat 工作区不提供工作流服务，请通过 @ 调用独立员工');
  };
  const requireResidentConversation = async (projectId: string, sessionId: string) => {
    const workspace = await requireProjectConversation(projectId, sessionId);
    if (conversationWorkflowsEnabled(workspace)) throw new Error('只有 Chat 工作区支持常驻此对话，请在项目中使用工作流负责人');
  };
  const residentView = (sessionId: string): ConversationEmployeeView => {
    const state = store.snapshot(); const workspace = workspaceForSession(sessionId);
    const enabled = Boolean(workspace && !conversationWorkflowsEnabled(workspace) && !isDeliverySession(sessionId));
    const base = { enabled, busy: conversationIsBusy(sessionId), revision: state.revision, sessionId, projectId: workspace?.id ?? null };
    if (!enabled || !workspace) return { ...base, conversationEmployee: null, choices: [] };
    const resolved = resolveConversationEmployee(state, workspace.id, sessionId);
    return { ...base, conversationEmployee: resolved.conversationEmployee, choices: conversationEmployeeChoices(state, workspace.id),
      ...(resolved.employee ? { employee: employeeInfoCard(resolved.employee) } : {}),
      ...(resolved.unavailableReason ? { unavailableReason: resolved.unavailableReason } : {}) };
  };
  const requireStandaloneRun = (id: string) => {
    if (store.snapshot().runs.find(run => run.id === id)?.conversationWorkflow) throw new Error('请在原生项目对话的工作流详情中验收或取消此交付');
    if (store.snapshot().runs.find(run => run.id === id)?.workflow) throw new Error('请在项目工作流中验收或取消此步骤');
    if (store.snapshot().runs.find(run => run.id === id)?.workTaskId) throw new Error('请在此任务的交付验收入口处理');
    return id;
  };

  // Executor-owned child/task/flow records remain read-only when restored.
  // Completed standalone roots may acquire a native workflow lease instead.
  ctx.on('agent/created', ({ agent }) => {
    if (runtime.ownsSession(agent.id) || !isDeliverySession(agent.id)) return;
    agent.ctx.tools.restrict({ allow: [] });
    agent.ctx.tools.guard(() => '请通过 @ 员工创建新的工作单');
    agent.ctx.on('agent/pre-step', async () => { throw new Error('这是数字员工交付记录，请通过 @ 员工创建新的工作单以继续工作'); });
  });

  const command = async (body: Record<string, unknown>): Promise<unknown> => {
    const action = string(body.action, '操作');
    const payload = record(body.payload ?? {});
    const options = record(body.options ?? {}) as MutationOptions;
    if (action.startsWith('work.')) {
      await requireProject(string(payload.projectId, '项目 ID'));
      return work.command(action, payload, options as WorkCommandOptions);
    }
    switch (action) {
      case 'conversation.employee.select': {
        const projectId = string(payload.projectId, '项目 ID'); const sessionId = string(payload.sessionId, '对话 ID');
        await requireResidentConversation(projectId, sessionId);
        await store.setConversationEmployee(payload as unknown as SelectConversationEmployeeInput, options);
        const sessionReopened = runtime.needsCompletedSessionHandoff(sessionId) ? await runtime.handoffCompletedSession(sessionId) : false;
        return { ...residentView(sessionId), sessionReopened };
      }
      case 'conversation.employee.clear': {
        const projectId = string(payload.projectId, '项目 ID'); const sessionId = string(payload.sessionId, '对话 ID');
        await requireResidentConversation(projectId, sessionId);
        await store.clearConversationEmployee(payload as unknown as ClearConversationEmployeeInput, options);
        const sessionReopened = runtime.needsCompletedSessionHandoff(sessionId) ? await runtime.handoffCompletedSession(sessionId) : false;
        return { ...residentView(sessionId), sessionReopened };
      }
      case 'employee.conversation.resume': {
        await requireProjectConversation(string(payload.projectId, '项目 ID'), string(payload.sessionId, '对话 ID'));
        return { sessionReopened: await runtime.handoffCompletedSession(string(payload.sessionId, '对话 ID')) };
      }
      case 'conversation.workflow.resume': {
        await requireConversation(string(payload.projectId, '项目 ID'), string(payload.sessionId, '对话 ID'));
        return { sessionReopened: await runtime.handoffCompletedSession(string(payload.sessionId, '对话 ID')) };
      }
      case 'conversation.workflow.select': {
        await requireConversation(string(payload.projectId, '项目 ID'), string(payload.sessionId, '对话 ID'));
        const selected = await store.selectConversationWorkflow(payload as unknown as SelectConversationWorkflowInput, options);
        const sessionId = string(payload.sessionId, '对话 ID');
        const sessionReopened = runtime.needsCompletedSessionHandoff(sessionId) ? await runtime.handoffCompletedSession(sessionId) : false;
        return { ...selected, sessionReopened };
      }
      case 'conversation.workflow.step': {
        await requireConversation(string(payload.projectId, '项目 ID'), string(payload.sessionId, '对话 ID'));
        return store.selectConversationWorkflowStep(payload as unknown as SelectConversationWorkflowStepInput, options);
      }
      case 'library.reorder': return store.reorderLibrary(payload as unknown as ReorderLibraryInput, options);
      case 'template.save': return store.saveTemplate(payload as unknown as SaveTemplateInput, options);
      case 'employee.configuration.save': return store.saveEmployeeConfiguration(payload as unknown as SaveEmployeeConfigurationInput, options);
      case 'template.archive': return store.archiveTemplate(string(payload.id, '模板 ID'), options);
      case 'team.save': return store.saveTeam(payload as unknown as SaveTeamInput, options);
      case 'team.delete': return store.deleteTeam(string(payload.id, '团队 ID'), options);
      case 'workflow.template.save': return store.saveWorkflowTemplate(payload as unknown as SaveWorkflowTemplateInput, options);
      case 'workflow.template.delete': return store.deleteWorkflowTemplate(string(payload.id, '工作流模板 ID'), options);
      case 'workflow.template.bind': return store.bindTeamWorkflow(string(payload.teamId, '团队 ID'), string(payload.workflowTemplateId, '工作流模板 ID'), record(payload.bindings) as Record<string, string>, options);
      case 'bundle.export': return store.exportBundle(payload as unknown as ExportSelection);
      case 'settings.bundle.save': return store.saveSettingsBundle(payload.bundle, options);
      case 'bundle.preview': {
        const target = record(payload.target) as unknown as ImportTarget;
        if (target.scope === 'project') await requireProject(string(target.projectId, '目标项目 ID'));
        return store.previewImport(payload.document, target);
      }
      case 'bundle.import': {
        const target = record(payload.target) as unknown as ImportOptions;
        if (target.scope === 'project') await requireProject(string(target.projectId, '目标项目 ID'));
        return store.importBundle(payload.document, target, options);
      }
      case 'team.instantiate': return store.instantiateTeam(string(payload.projectId, '项目 ID'), string(payload.teamId, '团队 ID'), options);
      case 'employee.create': return store.createEmployee(payload as unknown as CreateEmployeeInput, options);
      case 'project.team.cancel': {
        await requireProject(string(payload.projectId, '项目 ID'));
        const result = await store.cancelProjectTeams(payload as unknown as CancelProjectTeamsInput);
        await Promise.all(result.runIds.map(id => runtime.cancel(id)));
        return { cancelled: true };
      }
      case 'project.team.knowledge': {
        await requireProject(string(payload.projectId, '项目 ID'));
        return store.setProjectTeamKnowledge(payload as unknown as SetProjectTeamKnowledgeInput);
      }
      case 'project.team.configure': {
        await syncProjects();
        const projectId = string(payload.projectId, '项目 ID');
        if (!ctx.workspaceRegistry.list().some(workspace => workspace.id === projectId)) throw new Error('该项目文件夹已被移除，请从当前项目菜单重新进入');
        return store.configureProjectTeam(payload as unknown as ConfigureProjectTeamInput);
      }
      case 'project.employees.create': {
        await syncProjects();
        const projectId = string(payload.projectId, '项目 ID');
        if (!ctx.workspaceRegistry.list().some(workspace => workspace.id === projectId)) throw new Error('该项目文件夹尚未注册或已被移除，请从当前项目菜单重新进入');
        return store.createProjectEmployees(payload as unknown as CreateProjectEmployeesInput, options);
      }
      case 'employee.update': return store.updateEmployee(string(payload.id, '员工 ID'), record(payload.input) as UpdateEmployeeInput, options);
      case 'employee.delete': return store.deleteEmployee(string(payload.id, '员工 ID'), options);
      case 'memory.save': return store.saveMemory(payload as unknown as SaveMemoryInput, options);
      case 'memory.delete': return store.deleteMemory(string(payload.id, '记忆 ID'), options);
      case 'workflow.save': await requireWorkflowProject(string(payload.projectId, '项目 ID')); return workflows.saveDefinition(payload as unknown as SaveProjectWorkflowInput);
      case 'workflow.start': await requireWorkflowProject(string(payload.projectId, '项目 ID')); return workflows.start(payload as unknown as StartWorkflowInput);
      case 'workflow.control':
        if (payload.action === 'cancel') await requireProject(string(payload.projectId, '项目 ID'));
        else await requireWorkflowProject(string(payload.projectId, '项目 ID'));
        return workflows.control(payload as unknown as WorkflowCommandInput);
      case 'run.review': return store.reviewRun(requireStandaloneRun(string(payload.id, '工作单 ID')), record(payload.input) as unknown as ReviewRunInput, options);
      case 'run.cancel': await runtime.cancel(requireStandaloneRun(string(payload.id, '工作单 ID'))); return { cancelled: true };
      default: throw new Error(`未知操作：${action}`);
    }
  };

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: prefix, handler: async (req, res) => {
    const admission = ctx.connection.admit(req);
    if ('rejection' in admission) { json(res, admission.rejection, { error: admission.rejection === 401 ? '请先登录 Harness。' : '请求来源未获允许。' }); return; }
    try { assertRequestOrigin(req, origins); } catch (error) { json(res, 403, { error: (error as Error).message }); return; }
    try {
      const url = new URL(req.url!, origins[0]);
      const route = url.pathname.slice(prefix.length);
      if (req.method === 'GET' && route === '/wiki') {
        const html = await readFile(new URL('./llm-wiki/web.html', import.meta.url), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" });
        res.end(html); return;
      }
      if (req.method === 'GET' && route === '/state') { await syncProjects(); json(res, 200, store.snapshot()); return; }
      if (req.method === 'GET' && route === '/models') { json(res, 200, await listEmployeeModels(ctx)); return; }
      if (req.method === 'POST' && route === '/employee-role-draft') {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        const close = () => { if (!res.writableEnded) cancel(); };
        req.once('aborted', cancel); res.once('close', close);
        try {
          const input = await readBody(req, Math.min(bodyLimit, 4096));
          const result = await roleDrafter.generate(input as unknown as EmployeeRoleDraftInput, controller.signal);
          if (!res.destroyed && !res.writableEnded) json(res, 200, result);
        } catch (error) {
          if (!res.destroyed && !res.writableEnded) {
            const failure = error as { status?: number; code?: string };
            json(res, failure.status ?? 400, { error: error instanceof Error ? error.message : 'AI 智填请求失败', ...(failure.code ? { code: failure.code } : {}) });
          }
        } finally { req.off('aborted', cancel); res.off('close', close); }
        return;
      }
      if (req.method === 'GET' && (route === '/knowledge' || route === '/knowledge/wiki')) {
        const target: KnowledgeLibraryTarget = {
          scope: string(url.searchParams.get('scope'), '知识库范围') as KnowledgeLibraryTarget['scope'],
          employeeId: string(url.searchParams.get('employeeId'), '员工 ID'),
          library: string(url.searchParams.get('library'), '知识库类型') as KnowledgeLibraryTarget['library'],
          ...(url.searchParams.has('projectId') ? { projectId: string(url.searchParams.get('projectId'), '项目 ID') } : {}),
          ...(url.searchParams.has('teamId') ? { teamId: string(url.searchParams.get('teamId'), '团队 ID') } : {}),
        };
        if (target.scope === 'project') await requireProject(string(target.projectId, '项目 ID'));
        if (route === '/knowledge/wiki') { json(res, 200, await knowledge.libraryWiki(target)); return; }
        const layer = url.searchParams.get('layer');
        if (layer) {
          if (layer !== 'A' && layer !== 'B') throw new Error('知识层级必须为 A 或 B');
          const version = url.searchParams.has('version') ? Number(url.searchParams.get('version')) : undefined;
          json(res, 200, { document: await knowledge.libraryDocument(target, layer, string(url.searchParams.get('id'), '知识 ID'), version) });
        } else json(res, 200, await knowledge.library(target));
        return;
      }
      if (req.method === 'POST' && route === '/knowledge/upload') {
        const body = await readBody(req, Math.max(bodyLimit, 17_825_792));
        const target = record(body.target) as unknown as KnowledgeLibraryTarget;
        if (target.scope === 'project') await requireProject(string(target.projectId, '项目 ID'));
        json(res, 202, await knowledge.upload({ target, files: body.files, retry: body.retry } as KnowledgeUploadRequest)); return;
      }
      if (req.method === 'POST' && route === '/knowledge/remove') {
        const body = await readBody(req, bodyLimit);
        const target = record(body.target) as unknown as KnowledgeLibraryTarget;
        if (target.scope === 'project') await requireProject(string(target.projectId, '项目 ID'));
        json(res, 200, await knowledge.remove({ target, sourceId: body.sourceId, version: body.version, employeeVersion: body.employeeVersion } as KnowledgeRemoveRequest)); return;
      }
      if (req.method === 'POST' && route === '/knowledge/archive-policy') {
        const body = await readBody(req, bodyLimit);
        const target = record(body.target) as unknown as KnowledgeLibraryTarget;
        if (target.scope === 'project') await requireProject(string(target.projectId, '项目 ID'));
        json(res, 200, await knowledge.updateArchivePolicy({ target, category: body.category, enabled: body.enabled, expectedVersion: body.expectedVersion } as KnowledgeArchivePolicyRequest)); return;
      }
      if (req.method === 'GET' && route === '/capabilities') {
        const projectId = url.searchParams.get('projectId');
        if (projectId) await requireProject(projectId);
        const cwd = projectId ? store.listProjects().find(project => project.id === projectId)?.rootPath : undefined;
        json(res, 200, await listEmployeeCapabilities(ctx, { cwd })); return;
      }
      if (req.method === 'GET' && route === '/session-project') {
        await syncProjects();
        const sessionId = SessionId(string(url.searchParams.get('sessionId'), '会话 ID'));
        const workspace = workspaceForSession(sessionId);
        json(res, 200, { projectId: workspace?.id ?? null, ...(workspace && !conversationWorkflowsEnabled(workspace) ? { standaloneOnly: true } : {}) }); return;
      }
      if (req.method === 'GET' && route === '/conversation-employee') {
        await syncProjects();
        json(res, 200, residentView(string(url.searchParams.get('sessionId'), '对话 ID'))); return;
      }
      if (req.method === 'POST' && route === '/conversation-employee/mention-ticket') {
        const body = await readBody(req, bodyLimit); await syncProjects();
        const sessionId = string(body.sessionId, '对话 ID'); const workspace = workspaceForSession(sessionId);
        if (!workspace || conversationWorkflowsEnabled(workspace) || isDeliverySession(sessionId)) throw new Error('请在 Chat 原生对话中临时调用独立员工');
        if ((body.employeeId === undefined) === (body.templateId === undefined)) throw new Error('请选择一个员工实例或自由职业人');
        const kind = body.employeeId !== undefined ? 'employee' : 'template';
        const id = string(body.employeeId ?? body.templateId, '员工或自由职业人 ID'); const state = store.snapshot();
        const choice = conversationEmployeeChoices(state, workspace.id).find(candidate => candidate.kind === kind && candidate.id === id);
        if (!choice) throw new Error('该员工当前不可用，请刷新后重新选择');
        const targetVersion = kind === 'employee' ? state.employees.find(employee => employee.id === id)!.version : state.templates.find(template => template.id === id)!.version;
        if (body.requestText !== undefined) throw new Error('临时员工引用不接受文本预约，请直接发送原生消息');
        json(res, 200, mentionTickets.issue({ projectId: workspace.id, sessionId, expectedTargetVersion: targetVersion,
          ...(kind === 'employee' ? { employeeId: id } : { templateId: id }) })); return;
      }
      if (req.method === 'GET' && route === '/employee-info') {
        await syncProjects();
        const sessionId = string(url.searchParams.get('sessionId'), '对话 ID'); const workspace = workspaceForSession(sessionId);
        if (!workspace || conversationWorkflowsEnabled(workspace) || isDeliverySession(sessionId)) throw new Error('请在 Chat 原生对话中查看独立员工资料');
        const input = { ...(url.searchParams.has('employeeId') ? { employeeId: string(url.searchParams.get('employeeId'), '员工 ID') } : {}),
          ...(url.searchParams.has('templateId') ? { templateId: string(url.searchParams.get('templateId'), '自由职业人 ID') } : {}) };
        json(res, 200, resolveEmployeeInfo(store.snapshot(), workspace.id, input)); return;
      }
      if (req.method === 'GET' && route === '/conversation-workflow') {
        await syncProjects();
        const sessionId = string(url.searchParams.get('sessionId'), '对话 ID');
        const workspace = workspaceForSession(sessionId);
        const state = store.snapshot();
        const sessionHandoffRequired = runtime.needsCompletedSessionHandoff(sessionId);
        const employeeSessionOwned = (runtime.ownsSession(sessionId) || sessionHandoffRequired) && state.runs.some(run => run.sessionId === sessionId && isLegacyStandaloneRun(run));
        if (!workspace || isDeliverySession(sessionId)) {
          json(res, 200, { sessionId, projectId: null, selection: 'inherit', instanceId: null, steps: [], choices: [], revision: state.revision,
            employeeSessionOwned, ...(workspace && !conversationWorkflowsEnabled(workspace) ? { workflowEnabled: false } : {}) }); return;
        }
        if (!conversationWorkflowsEnabled(workspace)) {
          json(res, 200, { sessionId, projectId: workspace.id, selection: 'inherit', instanceId: null,
            workflowEnabled: false, steps: [], choices: [], activeEmployeeIds: [], relatedOwnerIds: [], revision: state.revision,
            busy: conversationIsBusy(sessionId), sessionHandoffRequired, employeeSessionOwned }); return;
        }
        const view = resolveConversationWorkflow(state, workspace.id, sessionId);
        const busy = conversationIsBusy(sessionId);
        const progressBusy = Boolean(view.instanceId && state.runs.some(run => run.conversationWorkflow?.instanceId === view.instanceId && ['queued', 'running', 'blocked'].includes(run.status)));
        const activeRun = state.runs.findLast(run => run.sessionId === sessionId && ['queued', 'running', 'blocked'].includes(run.status));
        const labels = { 'preparing-model': '准备岗位模型', 'preparing-knowledge': '读取已有知识', 'preparing-skills': '载入岗位技能', requesting: '等待模型响应', streaming: '模型正在生成', tools: '正在调用工具' };
        json(res, 200, { ...view, workflowEnabled: true, ...(view.owner ? { owner: { id: view.owner.id, name: view.owner.name } } : {}), revision: state.revision, busy, progressBusy,
          ...(activeRun?.activity ? { activity: { ...activeRun.activity, label: labels[activeRun.activity.stage] } } : {}),
          sessionHandoffRequired, employeeSessionOwned,
          steps: view.steps.map(step => ({ ...step, employeeName: state.employees.find(employee => employee.id === step.employeeId)?.name })) }); return;
      }
      if (req.method === 'GET' && route === '/conversation-workflow/details') {
        await syncProjects();
        const sessionId = string(url.searchParams.get('sessionId'), '对话 ID');
        const workspace = workspaceForSession(sessionId); const state = store.snapshot();
        if (!workspace || isDeliverySession(sessionId) || !conversationWorkflowsEnabled(workspace)) {
          json(res, 200, { projectId: null, sessionId, revision: state.revision, instanceId: null, steps: [], history: [], historyTotal: 0, tasks: [], tasksTotal: 0 }); return;
        }
        const view = resolveConversationWorkflow(state, workspace.id, sessionId);
        const busy = conversationIsBusy(sessionId)
          || Boolean(view.instanceId && state.runs.some(run => run.conversationWorkflow?.instanceId === view.instanceId && ['queued', 'running', 'blocked'].includes(run.status)));
        json(res, 200, resolveConversationWorkflowDetails(state, workspace.id, sessionId, { busy,
          ...(url.searchParams.has('stepId') ? { stepId: string(url.searchParams.get('stepId'), '步骤 ID') } : {}),
          ...(url.searchParams.has('runVersion') ? { runVersion: Number(url.searchParams.get('runVersion')) } : {}),
          ...(url.searchParams.has('runId') ? { runId: string(url.searchParams.get('runId'), '交付 ID') } : {}) })); return;
      }
      if (req.method === 'POST' && route === '/conversation-workflow/review') {
        const input = await readBody(req, bodyLimit) as unknown as ConversationWorkflowReviewInput;
        await requireConversation(string(input.projectId, '项目 ID'), string(input.sessionId, '对话 ID'));
        const state = store.snapshot();
        const run = requireConversationWorkflowReview(state, input, conversationIsBusy(input.sessionId));
        await store.reviewRun(run.id, { decision: input.decision, reviewer: '用户', note: input.note ?? '' },
          { expectedRevision: input.expectedRevision, expectedVersion: input.runVersion });
        json(res, 200, resolveConversationWorkflowDetails(store.snapshot(), input.projectId, input.sessionId)); return;
      }
      if (req.method === 'POST' && route === '/command') {
        const result = await command(await readBody(req, bodyLimit));
        json(res, 200, { result: result ?? null, state: store.snapshot() }); return;
      }
      if (req.method === 'POST' && route === '/run') {
        const body = await readBody(req, bodyLimit);
        await syncProjects();
        const projectId = string(body.projectId, '项目 ID');
        const request = string(body.request, '任务');
        if (body.parentRunId !== undefined) throw new Error('用户入口不能指定父工作单');
        await requireProject(projectId);
        const workspace = ctx.workspaceRegistry.list().find(item => item.id === projectId)!;
        const sourceSessionId = body.sourceSessionId === undefined ? undefined : string(body.sourceSessionId, '来源会话 ID');
        if (sourceSessionId && workspaceForSession(sourceSessionId)?.id !== projectId) throw new Error('来源对话不属于当前项目');
        if ((body.employeeId === undefined) === (body.templateId === undefined)) throw new Error('请选择一个员工实例或自由职业人');
        let employeeId: string;
        if (body.templateId !== undefined) {
          if (conversationWorkflowsEnabled(workspace) || !sourceSessionId) throw new Error('只有 Chat 对话可直接 @ 自由职业人');
          employeeId = (await store.ensureStandaloneEmployee({ projectId, templateId: string(body.templateId, '自由职业人 ID') })).id;
        } else {
          employeeId = string(body.employeeId, '员工 ID');
          const employee = store.snapshot().employees.find(item => item.id === employeeId && item.projectId === projectId);
          if (!conversationWorkflowsEnabled(workspace) && (!employee || employee.teamInstanceId || employee.managerId)) throw new Error('Chat 只调用独立员工，请从自由职业人库选择');
        }
        const input: RunRequest = { projectId, employeeId, request, ...(sourceSessionId ? { sourceSessionId } : {}) };
        const run = await runtime.start(input);
        json(res, 202, { run }); return;
      }
      json(res, 404, { error: '接口不存在' });
    } catch (error) {
      const code = (error as { code?: string }).code;
      json(res, code === 'CONFLICT' || code === 'STORE_BUSY' ? 409 : 400, { error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) });
    }
  } }), 'digital-workers.http');
}
