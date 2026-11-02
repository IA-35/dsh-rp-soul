/* 工具 schema ↔ 引擎 schema 对齐测试：soul_commit 描述里给模型的枚举
 * 必须和 Python 引擎真正接受的一模一样，否则模型照着描述写反而被驳回
 * （之前 content_tags 举例写的 kiss / confession，引擎根本不认）。 */
import { readFileSync } from 'node:fs';
import { eq, ok, done } from './_check.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTENT_TAGS, ACTION_MODES, OP_FIELDS } from '../lib/engine-bridge.js';

const structure = readFileSync(new URL('../engine/rp_soul_engine/domain/structure.py', import.meta.url), 'utf8');

// TAGS = ( ("id", "kind", "标签", "说明"), ... )：取每行第一个字符串
const tagsBlock = structure.match(/^TAGS = \(([\s\S]*?)^\)/m);
ok(tagsBlock !== null, '1. structure.py 里找得到 TAGS');
const engineTags = [...tagsBlock[1].matchAll(/^\s*\("([a-z_]+)",/gm)].map((m) => m[1]);
eq([...CONTENT_TAGS], engineTags, '1. CONTENT_TAGS 与引擎 TAGS 逐项一致（含顺序）');

const modesLine = structure.match(/^ACTION_MODES = \(([^)]*)\)/m);
ok(modesLine !== null, '2. structure.py 里找得到 ACTION_MODES');
const engineModes = [...modesLine[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
eq([...ACTION_MODES], engineModes, '2. ACTION_MODES 与引擎一致');

// 3. 工具说明里每个 op 的字段，必须是引擎真认的那些（必填 / 可选也要对上）。
// 模型照着说明写，说明错一个字段名，交账就被驳回一次。
const engineDir = fileURLToPath(new URL('../engine/', import.meta.url));
const dumped = execFileSync('python', ['-c', [
  'import json',
  'from rp_soul_engine.domain import ops, ops_time',
  'out = {}',
  'for name, spec in ops.SPECS.items():',
  '    fields = {k: f for k, f in spec.fields.items() if k != "op"}',
  '    out[name] = {"required": sorted(k for k, f in fields.items() if f.required), "optional": sorted(k for k, f in fields.items() if not f.required)}',
  'print(json.dumps(out))',
].join('\n')], { cwd: engineDir, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
const engineOps = JSON.parse(dumped);
eq(Object.keys(OP_FIELDS).sort(), Object.keys(engineOps).sort(), '3. op 名字和引擎一致');
for (const [name, want] of Object.entries(engineOps)) {
  eq([...(OP_FIELDS[name]?.required ?? [])].sort(), want.required, '3. ' + name + ' 的必填字段和引擎一致');
  eq([...(OP_FIELDS[name]?.optional ?? [])].sort(), want.optional, '3. ' + name + ' 的可选字段和引擎一致');
}

done('schema-sync');
