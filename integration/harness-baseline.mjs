import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Official release targeted by the plugin; runtime checks do not imply full release acceptance. */
export const harnessVersion = '0.2.2-rc.1';
export const harnessCommit = '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db';

/** Keep development, installation, launch and regression tests on one host. */
export function resolveHarness(root) {
  return resolve(process.env.DSH_SOURCE_PATH || resolve(root, `../deepseek-harness-${harnessVersion}`));
}

/** An official npm installation needs no source checkout. Source fallback is development-only. */
export async function resolveCliInstallation(root) {
  const manifest = resolve(process.env.DSH_INSTALLATION_MANIFEST || resolve(resolveHarness(root), 'apps/cli/package.json'));
  const pkg = JSON.parse(await readFile(manifest, 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh' || pkg.version !== harnessVersion) throw new Error(`需要官方 @deepseek-ai/dsh@${harnessVersion} 的 package.json。`);
  const entry = resolve(dirname(manifest), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh || 'lib/bin.js');
  await access(entry);
  return { manifest, entry };
}
