import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import PermissionPresets from '@deepseek-ai/dsh-permission-presets';
import { readNativeEmployeeContext, applyNativeEmployeeContext } from '../src/harness/employee-preset.js';

async function fixture() {
  const ctx = new Context();
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections);
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: '/tmp/native-context-fixture' });
  ctx.provide('shell', { sandboxMode: 'workspace-write' } as never);
  ctx.provide('approval', { config: { policy: 'ask' } } as never);
  const agents = new Map<string, Agent>();
  ctx.provide('agents', { get: (id: string) => agents.get(id), list: () => [...agents.values()] } as never);
  await ctx.plugin(PermissionPresets, { presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  } });
  const agent = (id: string) => ({ ctx, session: Session.create(SessionId(id)) }) as Agent;
  return { ctx, agents, agent };
}

test('source read-only policy is copied to a new work order without changing its source', async t => {
  const f = await fixture(); t.after(() => f.ctx.fiber.dispose());
  const source = f.agent('native-source'), target = f.agent('native-target');
  f.ctx.permissionPresets.set(source.session, 'read-only');
  f.agents.set(source.session.id, source);
  const before = JSON.stringify(source.session.snapshotEvents());
  const native = await readNativeEmployeeContext(f.ctx, source.session.id, new AbortController().signal);
  await applyNativeEmployeeContext(f.ctx, f.ctx, target, native);
  assert.equal(f.ctx.permissionPresets.current(target.session), 'read-only');
  assert.equal(f.ctx.sandboxPolicy.resolve({ session: target.session }).mode, 'read-only');
  assert.equal(JSON.stringify(source.session.snapshotEvents()), before);
});

test('native Auto identity and ask policy survive inheritance instead of becoming full access', async t => {
  const f = await fixture(); t.after(() => f.ctx.fiber.dispose());
  let admissions = 0; f.ctx.permissionPresets.registerAuto(() => { admissions++; });
  const source = f.agent('auto-source'), target = f.agent('auto-target');
  f.ctx.permissionPresets.set(source.session, 'auto'); f.agents.set(source.session.id, source);
  await applyNativeEmployeeContext(f.ctx, f.ctx, target, await readNativeEmployeeContext(f.ctx, source.session.id, new AbortController().signal));
  assert.equal(f.ctx.permissionPresets.current(target.session), 'auto');
  assert.equal(f.ctx.sandboxPolicy.resolve({ session: target.session }).mode, 'danger-full-access');
  assert.equal(target.session.snapshotEvents().filter(event => event.type === 'approval/policy').at(-1)?.data.policy, 'ask');
  assert.equal(admissions, 2);
});

test('cold policy reads use and close a read handle without restoring a conversation', async t => {
  const f = await fixture(); t.after(() => f.ctx.fiber.dispose());
  const source = f.agent('cold-source'), target = f.agent('cold-target');
  f.ctx.permissionPresets.set(source.session, 'read-only');
  let opened = 0, closed = 0;
  f.ctx.provide('sessionPersistence', { open: async (id: string, access: string) => {
    opened++; assert.equal(id, source.session.id); assert.equal(access, 'read');
    return { header: source.session.header, read: async () => ({ events: source.session.snapshotEvents() }), close: async () => { closed++; } };
  } } as never);
  const native = await readNativeEmployeeContext(f.ctx, source.session.id, new AbortController().signal);
  await applyNativeEmployeeContext(f.ctx, f.ctx, target, native);
  assert.equal(f.ctx.permissionPresets.current(target.session), 'read-only');
  assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(f.agents.size, 0);
});

test('a failed cold read still closes its read handle and refuses fallback widening', async t => {
  const f = await fixture(); t.after(() => f.ctx.fiber.dispose());
  let closed = 0;
  f.ctx.provide('sessionPersistence', { open: async () => ({
    header: f.agent('broken').session.header,
    read: async () => { throw new Error('READ_FAILED'); }, close: async () => { closed++; },
  }) } as never);
  await assert.rejects(readNativeEmployeeContext(f.ctx, 'broken', new AbortController().signal), /READ_FAILED/);
  assert.equal(closed, 1);
});
