import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry, { isModelInvocable } from '@deepseek-ai/dsh-skill';
import { BUNDLED_EMPLOYEE_SKILLS, loadEmployeeSkills, registerEmployeeSkills, resolveEmployeeSkill } from '../src/harness/skills.js';
import { listEmployeeCapabilities } from '../src/harness/capability-catalog.js';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';

test('all six role presets resolve to registered model-invocable package skills and task-owned helper resources', async t => {
  const skills = await loadEmployeeSkills(resolve('skills'));
  const presets = JSON.parse(await readFile('skills/software-development-presets.json', 'utf8'));
  const ctx = new Context(); await ctx.plugin(SkillRegistry); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(NativeToolExecutor);
  t.after(() => ctx.fiber.dispose());
  const native = { name: 'unrelated-skill', description: 'other installed plugin', content: 'unrelated' };
  ctx.skills.register(native);
  const owner = await ctx.plugin({ name: 'bundled-role-skills-fixture', inject: ['skills'], apply(child: Context) { registerEmployeeSkills(child, skills); } });
  const catalog = await listEmployeeCapabilities(ctx);
  assert.equal(skills.size, Object.keys(BUNDLED_EMPLOYEE_SKILLS).length);
  assert.equal(presets.roles.length, 6);
  for (const role of presets.roles) {
    const ids: string[] = [role.required, ...role.preferred.map((skill: { id: string }) => skill.id)];
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.ok(catalog.skills.some(skill => skill.id === id && skill.source === 'bundled'));
      const nativeSkill = await ctx.skills.get(id); assert.ok(nativeSkill && isModelInvocable(nativeSkill));
      assert.equal(nativeSkill.path, skills.get(id)!.path);
      const rendered = await resolveEmployeeSkill(ctx, skills, id, process.cwd(), new AbortController().signal);
      assert.ok(rendered.includes(skills.get(id)!.content));
    }
  }
  const qa = presets.roles.find((role: { role: string }) => role.role === 'tester');
  assert.ok(qa.preferred.some((skill: { id: string }) => skill.id === 'code-review'));
  const helper = await ctx.skills.get('worktree-cleanup');
  assert.deepEqual(helper?.resourceBase, { kind: 'directory', path: resolve('skills/worktree-cleanup') });
  assert.doesNotMatch(JSON.stringify(catalog), /resourceBase|\/Users\/|SKILL\.md/);
  await owner.dispose();
  assert.deepEqual((await ctx.skills.list()).map(skill => skill.name), [native.name]);
});

test('packaged skill declarations fail closed on a wrong identity, explicit-only invocation or malformed metadata', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'workforce-skill-metadata-')); t.after(() => rm(root, { recursive: true, force: true }));
  await cp(resolve('skills'), root, { recursive: true });
  const path = resolve(root, 'code-review/SKILL.md'), original = await readFile(path, 'utf8');
  for (const raw of [original.replace('name: code-review', 'name: wrong-identity'), original.replace('name: code-review', 'name: code-review\ndisable-model-invocation: true'), original.replace('name: code-review', 'name: [broken')]) {
    await writeFile(path, raw); await assert.rejects(loadEmployeeSkills(root), /技能声明无效|不能自动调用|YAML/);
  }
  await writeFile(path, original); assert.equal((await loadEmployeeSkills(root)).size, Object.keys(BUNDLED_EMPLOYEE_SKILLS).length);
});
