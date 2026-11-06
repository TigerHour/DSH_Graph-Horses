import { build } from 'esbuild';
import ts from 'typescript';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const revision = 'e08cfce65aad8b76b13546a081c1a8d4422b70c3';
const origin = 'https://github.com/nashsu/llm_wiki';
const upstreamFiles = ['wiki-graph.ts', 'graph-relevance.ts', 'wiki-graph-analysis.ts', 'graph-insights.ts', 'frontmatter.ts', 'path-utils.ts', 'ingest.ts', 'wiki-graph-analysis.worker.ts'];

async function dependencyLicenses(root, component, output, inputs) {
  await rm(resolve(output, 'licenses'), { recursive: true, force: true });
  const manifests = new Map();
  for (const input of inputs) {
    const fullPath = resolve(root, input);
    const marker = fullPath.lastIndexOf('/node_modules/');
    if (marker === -1) continue;
    const rest = fullPath.slice(marker + '/node_modules/'.length).split('/');
    const packageName = rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
    const packageRoot = fullPath.slice(0, marker + '/node_modules/'.length) + packageName;
    if (manifests.has(packageRoot)) continue;
    const metadata = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    const notices = [];
    for (const file of (await readdir(packageRoot)).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file)).sort()) {
      const bytes = await readFile(resolve(packageRoot, file));
      const destination = `${packageName.replace(/[^a-zA-Z0-9._-]/g, '_')}@${metadata.version}-${file}`;
      for (const folder of [resolve(component, 'dependency-licenses'), resolve(output, 'licenses')]) {
        await mkdir(folder, { recursive: true });
        await writeFile(resolve(folder, destination), bytes);
      }
      notices.push({ file: destination, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    if (!notices.length) throw new Error(`Bundled dependency license file missing: ${packageName}`);
    manifests.set(packageRoot, { name: metadata.name, version: metadata.version, license: metadata.license ?? null, notices });
  }
  const manifest = JSON.stringify([...manifests.values()].sort((left, right) => left.name.localeCompare(right.name)), null, 2) + '\n';
  await writeFile(resolve(component, 'dependency-licenses/manifest.json'), manifest);
  await writeFile(resolve(output, 'licenses/manifest.json'), manifest);
}

export async function buildLlmWiki(root, options = {}) {
  const component = resolve(root, 'third_party/llm-wiki');
  const output = resolve(root, 'lib/llm-wiki');
  await mkdir(output, { recursive: true });
  await mkdir(resolve(component, 'generated'), { recursive: true });
  const input = await readFile(resolve(component, 'upstream/lib/ingest.ts'), 'utf8');
  const ast = ts.createSourceFile('ingest.ts', input, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const required = new Set(['WIKI_INDEX_PROMPT_MAX_CHARS', 'ENTITY_ANALYSIS_RULES', 'ANALYSIS_OUTPUT_LIMITS', 'buildAnalysisPrompt', 'boundWikiIndexForPrompt']);
  const extracted = [];
  for (const statement of ast.statements) {
    let name = ts.isFunctionDeclaration(statement) ? statement.name?.text : undefined;
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
      const candidate = statement.declarationList.declarations[0].name;
      if (ts.isIdentifier(candidate)) name = candidate.text;
    }
    if (name && required.delete(name)) extracted.push(statement.getText(ast));
  }
  if (required.size) throw new Error(`Pinned LLM Wiki prompt declarations missing: ${[...required].join(', ')}`);
  const bridge = '// GPL-3.0. Generated from the pinned upstream ingest.ts; source declarations are unchanged.\n'
    + '// Adaptation: output-language preferences use the hosting project Chinese policy instead of Tauri stores.\n'
    + 'function languageRule(_sourceContent = ""): string { return "Write the final analysis in Simplified Chinese. Preserve original proper nouns, code identifiers, citations, and technical terms."; }\n\n'
    + extracted.join('\n\n') + '\n';
  await writeFile(resolve(component, 'generated/analysis-prompt.ts'), bridge);
  const hashes = {};
  for (const file of upstreamFiles) hashes[`upstream/lib/${file}`] = createHash('sha256').update(await readFile(resolve(component, 'upstream/lib', file))).digest('hex');
  hashes.LICENSE = createHash('sha256').update(await readFile(resolve(component, 'LICENSE'))).digest('hex');
  const lockPath = resolve(component, 'UPSTREAM.json');
  let lock;
  try { lock = JSON.parse(await readFile(lockPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (lock && (lock.revision !== revision || JSON.stringify(lock.files) !== JSON.stringify(hashes))) throw new Error('Pinned LLM Wiki source integrity check failed');
  if (!lock) await writeFile(lockPath, JSON.stringify({ name: 'llm_wiki', version: '0.6.13', origin, revision, license: 'GPL-3.0', files: hashes }, null, 2) + '\n');
  const engineBuild = await build({
    entryPoints: [resolve(component, 'engine.ts')], outfile: resolve(output, 'engine.cjs'),
    absWorkingDir: root,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true,
    logOverride: { 'empty-import-meta': 'silent' },
    metafile: true,
    alias: {
      '@/commands/fs': resolve(component, 'adapters/virtual-fs.ts'),
      '@/stores/wiki-store': resolve(component, 'adapters/virtual-fs.ts'),
      '@/lib/path-utils': resolve(component, 'upstream/lib/path-utils.ts'),
      '@/lib/frontmatter': resolve(component, 'upstream/lib/frontmatter.ts'),
    },
    banner: { js: `/* LLM Wiki shared component, GPL-3.0. Upstream ${origin}@${revision}. Corresponding source: third_party/llm-wiki/. */` },
  });
  const bundledInputs = new Set(Object.keys(engineBuild.metafile.inputs));
  if (options.web !== false) {
    await readFile(resolve(component, 'web/main.tsx'));
    const web = await build({ entryPoints: [resolve(component, 'web/main.tsx')], outfile: resolve(output, 'wiki.js'), absWorkingDir: root, bundle: true, platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', write: false, metafile: true, define: { 'process.env.NODE_ENV': '"production"' } });
    for (const input of Object.keys(web.metafile.inputs)) bundledInputs.add(input);
    const js = web.outputFiles.find(file => file.path.endsWith('.js'))?.text || '';
    const css = web.outputFiles.find(file => file.path.endsWith('.css'))?.text || '';
    await writeFile(resolve(output, 'web.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Wiki</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`);
  }
  await dependencyLicenses(root, component, output, bundledInputs);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildLlmWiki(resolve(dirname(fileURLToPath(import.meta.url)), '..'), { web: !process.argv.includes('--engine-only') });
  console.log('Built the separately licensed shared LLM Wiki component.');
}
