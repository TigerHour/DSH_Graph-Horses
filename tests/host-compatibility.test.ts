import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { checkHost, requiredPublicInterfaces } from '../integration/check-host.mjs';
import { harnessVersion } from '../integration/harness-baseline.mjs';

test('host preflight accepts the official global panel API without patched workspace slots', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'workforce-host-contract-'));
  const web = resolve(root, 'node_modules/@deepseek-ai/dsh-web-app');
  try {
    await mkdir(web, { recursive: true });
    await writeFile(resolve(web, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app', exports: { './package.json': './package.json' } }));
    for (const [name, interfaces] of Object.entries(requiredPublicInterfaces)) {
      const path = resolve(root, 'node_modules', name);
      await mkdir(path, { recursive: true });
      await writeFile(resolve(path, 'package.json'), JSON.stringify({ name, version: harnessVersion, exports: { './package.json': './package.json', './client': './client.js' } }));
      await writeFile(resolve(path, 'client.js'), interfaces.join('\n'));
    }
    assert.deepEqual((await checkHost(resolve(root, 'package.json'))).interfaces, requiredPublicInterfaces);
    const sidebar = resolve(root, 'node_modules/@deepseek-ai/dsh-client-ui-sidebar');
    await writeFile(resolve(sidebar, 'client.js'), '/* missing official panel entry */');
    await assert.rejects(checkHost(resolve(root, 'package.json')), /缺少已声明的官方公开接口/);
    await writeFile(resolve(sidebar, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-sidebar', version: '0.1.1-rc.2', exports: { './package.json': './package.json', './client': './client.js' } }));
    await assert.rejects(checkHost(resolve(root, 'package.json')), /尚未验证此 Harness 版本/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
