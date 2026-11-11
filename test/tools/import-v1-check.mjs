/* 在旧库的副本上试导入，逐项核对。只读旧库，新库建在临时目录里，不碰你正在用的数据。
 * 用法：node test/tools/import-v1-check.mjs <旧 engine.db 的路径>
 */
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../../lib/engine/index.js';

const source = process.argv[2];
if (!source) {
  process.stderr.write('用法：node test/tools/import-v1-check.mjs <旧 engine.db>\n');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'import-v1-'));
const copy = join(dir, 'engine-copy.db');
copyFileSync(source, copy);
const engine = createEngine({ dataDir: dir });
const out = engine.importV1(copy);
if (!out.ok) {
  process.stdout.write('导入失败：' + out.reason + '\n');
  process.exit(1);
}
const lines = ['旧局 ' + out.sessionId + ' → ' + dir, ''];
for (const row of out.check) {
  lines.push((row.ok ? '  对上 ' : '  不对 ') + row.item);
  if (!row.ok) lines.push('      旧：' + JSON.stringify(row.old), '      新：' + JSON.stringify(row.now));
  else lines.push('      ' + JSON.stringify(row.now).slice(0, 200));
}
if (out.notes.length > 0) lines.push('', '没带过来的：', ...out.notes.map((n) => '  - ' + n));
const view = engine.context();
const memory = engine.panel('memory');
lines.push('', '快照：', ...view.lines.map((l) => '  ' + l));
lines.push('', '记忆：' + JSON.stringify(memory.counts) + '，流水 ' + engine.log(2000).length + ' 条，日记天数 ' + JSON.stringify(out.diaryDays));
process.stdout.write(lines.join('\n') + '\n');
engine.close();
process.exit(out.check.every((r) => r.ok) ? 0 : 1);
