import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionStore from '@deepseek-ai/dsh-session';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { listEmployeeIntegrations } from '../src/harness/integration-catalog.js';
import { listEmployeeCapabilities } from '../src/harness/capability-catalog.js';

function fixture(t: TestContext, services: Record<string, unknown> = {}) {
  const ctx = new Context();
  for (const [name, service] of Object.entries(services)) ctx.provide(name as never, service as never);
  t.after(() => ctx.fiber.dispose());
  return ctx;
}
const mcp = (serverName: string, disabled = false) => ({ options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName, env: { TOKEN: 'SECRET_ENV' }, headers: { Authorization: 'SECRET_HEADER' }, url: 'https://SECRET_URL.invalid', command: '/SECRET_PATH/server' } }, disabled }) as unknown as Entry;
const loader = (...entries: Entry[]) => ({ entries: () => entries.values() });

test('installed plugin catalog excludes missing packages, preserves disabled entries, and projects safe identity fields', async t => {
  const ctx = fixture(t, { pluginManager: { listBundles: async () => [
    { name: 'shipped', availability: 'installation', installed: false, enabled: true, description: 'Shipped', source: '/SECRET_PATH/shipped', version: '1', rows: [{ config: { token: 'SECRET' } }] },
    { name: 'disabled', availability: 'profile', installed: true, enabled: false },
    { name: 'missing', availability: 'missing', installed: true, enabled: true },
    { name: 'uninstalled-catalog-entry', availability: 'missing', installed: false, enabled: false },
    { name: 'broken', availability: 'profile', installed: true, enabled: true, error: { diagnostic: 'SECRET_DIAGNOSTIC' } },
  ] }, loader: loader() });
  const result = await listEmployeeIntegrations(ctx, []);
  assert.deepEqual(result.plugins.map(item => [item.id, item.available]), [['shipped', true], ['disabled', false], ['broken', false]]);
  assert.equal(result.plugins[0]!.description, 'Shipped');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|source|token|diagnostic|rows/);
});

test('MCP identities come from exact configuration, keep disabled and offline servers, and support names containing double underscores', async t => {
  const ctx = fixture(t, { loader: loader(mcp('docs'), mcp('docs__private'), mcp('disabled', true), mcp('offline')) });
  const result = await listEmployeeIntegrations(ctx, ['mcp__docs__private__search', 'mcp__unconfigured__search']);
  assert.deepEqual(result.mcps.map(item => [item.id, item.available]), [['docs', false], ['docs__private', true], ['disabled', false], ['offline', false]]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|headers|env|url|command|unconfigured/);
});

test('default preset MCP declarations are included while other presets are not read and expressions are never evaluated', async t => {
  let reads = 0;
  const ctx = fixture(t, { loader: loader(mcp('host')), agentPresets: {
    defaultId: 'current', readDocument: async (id: string) => {
      assert.equal(id, 'current'); reads++;
      return { content: `- id: preset-server
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: preset__docs
    headers: { Authorization: SECRET_HEADER }
- name: '@deepseek-ai/dsh-mcp-client'
  disabled: true
  config: { serverName: disabled }
- name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: !!js shouldNeverExecute
- name: ignored-plugin
  config: { serverName: not-an-mcp }
` };
    },
  } });
  const result = await listEmployeeIntegrations(ctx, ['mcp__preset__docs__search', 'mcp__another_preset__search']);
  assert.equal(reads, 1);
  assert.deepEqual(result.mcps.map(item => [item.id, item.available]), [['host', false], ['preset__docs', true], ['disabled', false]]);
  assert.match(result.mcpError!, /动态配置/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|shouldNeverExecute|another_preset|not-an-mcp/);
});

test('integration failures remain independent and service absence has safe explicit diagnostics', async t => {
  const ctx = fixture(t, { pluginManager: { listBundles: async () => { throw new Error('SECRET_ENDPOINT'); } }, loader: loader(mcp('docs')) });
  const result = await listEmployeeIntegrations(ctx, ['mcp__docs__search']);
  assert.deepEqual(result.plugins, []);
  assert.equal(result.mcps[0]!.available, true);
  assert.match(result.pluginError!, /插件管理服务/);
  const absent = await listEmployeeIntegrations(fixture(t), []);
  assert.deepEqual(absent.mcps, []);
  assert.match(absent.mcpError!, /不可用/);
  assert.doesNotMatch(JSON.stringify([result, absent]), /SECRET_ENDPOINT/);
});

test('MCP native management targets match real Loader entry identities once and never guess an owner', async t => {
  const ctx = fixture(t);
  ctx.baseUrl = new URL('../', import.meta.url).href;
  await ctx.plugin(Loader);
  await ctx.loader.root.update(['owned', 'user-patch', 'conflict', 'missing-entry-id', 'missing-package'].map(id => ({
    id: `mcp-${id}`, name: '@deepseek-ai/dsh-mcp-client', disabled: true,
    config: { serverName: id, env: { TOKEN: 'SECRET_ENV' }, url: 'https://SECRET_URL.invalid' },
  })));
  const entries = [...ctx.loader.entries()];
  const row = (id: string) => {
    const entry = entries.find(entry => entry.options.id === `mcp-${id}`)!;
    return { rowId: entry.options.id, moduleName: entry.options.name, entryId: entry.id };
  };
  let reads = 0;
  ctx.provide('pluginManager', { listBundles: async () => {
    reads++;
    return [
      { name: 'dsh-plugin-docs', availability: 'profile', enabled: true, rows: [row('owned')] },
      { name: 'dsh-plugin-conflict-a', availability: 'profile', enabled: true, rows: [row('conflict')] },
      { name: 'dsh-plugin-conflict-b', availability: 'profile', enabled: true, rows: [row('conflict')] },
      { name: 'dsh-plugin-no-entry', availability: 'profile', enabled: false, rows: [{ rowId: 'mcp-missing-entry-id', moduleName: '@deepseek-ai/dsh-mcp-client' }] },
      { name: 'dsh-plugin-missing', availability: 'missing', enabled: true, rows: [row('missing-package')] },
    ];
  } } as never);
  const result = await listEmployeeIntegrations(ctx, []);
  assert.equal(reads, 1, 'Plugin inventory is shared by both projections');
  assert.deepEqual(result.mcps.map(item => [item.id, item.managementBundle]), [
    ['owned', 'dsh-plugin-docs'], ['user-patch', undefined], ['conflict', undefined],
    ['missing-entry-id', undefined], ['missing-package', undefined],
  ]);
  assert.equal(result.mcps[0]!.available, false, 'A disabled MCP still opens its owning bundle for management');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|headers|env|url|command|entryId|rowId/);
});

test('a shared MCP server name with user or preset configuration has no guessed bundle management target', async t => {
  const owned = { ...mcp('docs'), id: 'owned-entry' } as unknown as Entry;
  const ctx = fixture(t, {
    loader: loader(owned),
    pluginManager: { listBundles: async () => [{ name: 'dsh-plugin-docs', availability: 'profile', enabled: true,
      rows: [{ rowId: 'owned-row', moduleName: '@deepseek-ai/dsh-mcp-client', entryId: 'owned-entry' }] }] },
    agentPresets: { defaultId: 'default', readDocument: async () => ({ content: `- id: own-docs
  name: '@deepseek-ai/dsh-mcp-client'
  config: { serverName: docs }
` }) },
  });
  const result = await listEmployeeIntegrations(ctx, ['mcp__docs__search']);
  assert.equal(result.mcps[0]!.available, true);
  assert.equal(result.mcps[0]!.managementBundle, undefined);
});

test('default scope governs visible MCP tools and catalog leases release on both success and failed reads', async t => {
  const scope = {};
  let disposed = 0, fail = false;
  const ctx = fixture(t, {
    loader: loader(mcp('docs')),
    agentPresets: { defaultId: 'default', readDocument: async () => ({ content: '[]' }), acquireScope: async () => ({ key: scope, [Symbol.asyncDispose]: async () => { disposed++; } }) },
    skills: { list: async (options: { scope: unknown }) => { assert.equal(options.scope, scope); if (fail) throw new Error('SECRET_FAILURE'); return []; } },
    tools: { schemas: (given: unknown) => { assert.equal(given, scope); return [{ name: 'mcp__docs__search', description: 'Search' }]; } },
  });
  const result = await listEmployeeCapabilities(ctx);
  assert.equal(result.mcps[0]!.available, true);
  assert.equal(disposed, 1);
  fail = true;
  await assert.rejects(listEmployeeCapabilities(ctx), /无法读取 DSH 能力目录/);
  assert.equal(disposed, 2);
});

test('real official Loader and preset trees keep default and other preset MCP declarations separate', async t => {
  const ctx = fixture(t);
  ctx.baseUrl = new URL('../', import.meta.url).href;
  await ctx.plugin(Loader);
  await ctx.loader.root.update([{ id: 'host', name: '@deepseek-ai/dsh-mcp-client', disabled: true, config: { serverName: 'host' } }]);
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentPresets, { default: 'default' });
  const unregisterDefault = await ctx.agentPresets.register({ id: 'default', plugins: [
    { id: 'default-docs', name: '@deepseek-ai/dsh-mcp-client', disabled: true, config: { serverName: 'default__docs' } },
  ] });
  const unregisterOther = await ctx.agentPresets.register({ id: 'other', plugins: [
    { id: 'other-docs', name: '@deepseek-ai/dsh-mcp-client', disabled: true, config: { serverName: 'other' } },
  ] });
  const lease = await ctx.agentPresets.acquireScope();
  try {
    assert.deepEqual([...ctx.loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client').map(entry => entry.options.id), ['host']);
    const result = await listEmployeeIntegrations(ctx, ['mcp__other__search']);
    assert.deepEqual(result.mcps.map(item => [item.id, item.available]), [['host', false], ['default__docs', false]]);
    assert.equal(result.mcpError, undefined);
  } finally { await lease[Symbol.asyncDispose](); await unregisterOther(); await unregisterDefault(); }
});
