/* 用 mock ctx 跑 /rp-soul 路由与 section 合成，逐条断言（不是只打印）。
 * 退出码 0 + PASS N 项断言 = 通过；任何一条不成立就抛错、退出码非 0。 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, has, hasNot, done } from './_check.mjs';

const home = mkdtempSync(join(tmpdir(), 'soulhome-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'rp-soul'), { recursive: true });
writeFileSync(
  join(home, 'rp-soul', 'preset.md'),
  [
    '<!-- soul-part: 身份 -->',
    '你是暗夜侦探。',
    '',
    '说话简短、冷静。',
    '',
    '<!-- soul-part: 口吻 -->',
    '口吻：第一人称，不超过三句。',
    '',
    '<!-- soul-part: 占位 -->',
    '这个块有 {{user}} 占位符',
    '',
    '<!-- soul-part: 草稿 -->',
    '这一块是草稿，不该进提示词。',
    '',
  ].join('\n'),
  'utf8'
);

const mod = await import(new URL('../lib/index.js', import.meta.url).href);

// ---- mock ctx ----
const routes = [];
const sectionDefs = new Map();
const contextDefs = new Map();
const tools = [];
const ctx = {
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  inject(deps, cb) {
    const mkctx = () => ({
      effect: ctx.effect,
      inject: (d, c) => ctx.inject(d, c),
      get webServer() { return { register(def) { routes.push(def); return () => {}; } }; },
      get connection() { return { requestRejection() { return undefined; } }; },
      get tools() { return { register(def) { tools.push(def); return () => {}; } }; },
    });
    cb(mkctx());
  },
  systemPrompt: {
    getSectionOrder(name) {
      if (name === 'DEPLOYMENT_PERSONA_PREFIX') return 100;
      if (name === 'DEPLOYMENT_PERSONA_SUFFIX') return 10300;
      return 0;
    },
    getContextOrder(name) { return name === 'WEB_SURFACE' ? 210 : undefined; },
    section(def) { sectionDefs.set(def.name, def); return () => {}; },
    context(def) { contextDefs.set(def.name, def); return () => {}; },
  },
};
mod.apply(ctx, { maxBytes: 65536 });

// ---- 1. section ----
ok(sectionDefs.has('soul-persona'), '1. soul-persona section 已注册');
ok(!sectionDefs.has('soul-engine'), '1. soul-engine 不再是 section（系统提示词必须恒定）');
ok(contextDefs.has('soul-engine'), '1. soul-engine 注册为动态 runtime context');
eq(sectionDefs.get('soul-persona').order, 10301, '1. 人设排在 persona-suffix 之后，在最末');
eq(contextDefs.get('soul-engine').order, 220, '1. 账本落在动态上下文末尾（WEB_SURFACE 之后）');
eq(tools.length, 3, '1. 注册了 3 个工具');
eq(tools.map((t) => t.name).sort().join(','), 'soul_admin,soul_commit,soul_state', '1. 三个工具名');
const text = sectionDefs.get('soul-persona').text();
has(text, '你是暗夜侦探', '1. 合成文本含第一块');
has(text, '第一人称', '1. 合成文本含第二块');
hasNot(text, '<!-- soul-part:', '1. 标记本身不进提示词');
ok(text.indexOf('暗夜侦探') < text.indexOf('第一人称'), '1. 顺序 = 块在文件里的顺序');

// ---- 2. 路由 ----
eq(routes.length, 1, '2. 只注册一条前缀路由');
eq(routes[0].kind, 'prefix', '2. 路由 kind');
eq(routes[0].path, '/rp-soul', '2. 路由 path');

// ---- handler 调用器 ----
async function call(method, url, body) {
  const route = routes[0];
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code, hdrs) { this.statusCode = code; if (hdrs) Object.assign(this.headers, hdrs); return this; },
    end(chunk) { if (chunk) this.body += chunk; if (this._done) this._done(); },
  };
  const req = {
    method, url,
    headers: { host: 'localhost' },
    on(ev, cb) {
      if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (ev === 'end') cb();
      return this;
    },
  };
  const p = new Promise((r) => { res._done = r; });
  await route.handler(req, res);
  await p;
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { /* 非 JSON 响应 */ }
  return { status: res.statusCode, headers: res.headers, parsed, raw: res.body };
}

// ---- 3. GET /state ----
const st = await call('GET', '/rp-soul/state');
eq(st.status, 200, '3. GET /state 200');
eq(st.headers['cache-control'], 'no-store', '3. /state 不许缓存');
eq(st.parsed.config.files, undefined, '3. /state 不再回 files（多文件那套删了）');
eq(st.parsed.library, undefined, '3. /state 不再回 library');
eq(st.parsed.preset.rel, 'rp-soul/preset.md', '3. /state 回预设路径');
eq(st.parsed.preset.exists, true, '3. /state 说预设存在');
ok(Array.isArray(st.parsed.preset.blocks) && st.parsed.preset.blocks.length === 4, '3. 预设拆出 4 块');
ok(st.parsed.composed.chars > 0, '3. /state 回合成预览字数');

// ---- 4. 逐块读写预设 ----
const pg = await call('GET', '/rp-soul/preset');
eq(pg.status, 200, '4. GET /preset 200');
const blocks = pg.parsed.blocks;
const off = blocks.map((b) => (b.name === '草稿' ? { ...b, enabled: false } : b));
const w = await call('PUT', '/rp-soul/preset', { blocks: off });
eq(w.status, 200, '4. PUT /preset 200');
hasNot(sectionDefs.get('soul-persona').text(), '草稿', '4. 勾掉的块立刻不再注入（无需重启）');
ok(readFileSync(join(home, 'rp-soul', 'preset.md'), 'utf8').includes('soul-part-off: 草稿'), '4. 勾掉的标记写回磁盘');

// 改名 + 改正文
const renamed = off.map((b) => (b.name === '口吻' ? { ...b, name: '语气', text: '口吻：第二人称。' } : b));
await call('PUT', '/rp-soul/preset', { blocks: renamed });
has(sectionDefs.get('soul-persona').text(), '第二人称', '4. 改正文立刻生效');
ok(JSON.parse(JSON.stringify((await call('GET', '/rp-soul/preset')).parsed.blocks)).some((b) => b.name === '语气'), '4. 改名写回');

// ---- 5. 导出与导入 ----
const exp = await call('GET', '/rp-soul/preset?export=rimtalk');
eq(exp.status, 200, '5. GET /preset?export=rimtalk 200');
eq(exp.parsed.json.version, 1, '5. 导出的是 RimTalk preset.json');
ok(Array.isArray(exp.parsed.json.entries) && exp.parsed.json.entries.length === 4, '5. entries 数与块数一致');

const imported = await call('POST', '/rp-soul/preset', {
  import: { version: 1, name: '别人的预设', entries: [
    { name: '开场', content: '你是雨夜的守灯人。', role: 'System', enabled: true },
    { name: '口气', content: '说话很轻。', role: 'System', enabled: true },
  ] },
});
eq(imported.status, 200, '5. 导入 RimTalk JSON 200');
has(sectionDefs.get('soul-persona').text(), '雨夜的守灯人', '5. 导入的内容立刻生效');
eq(imported.parsed.blocks.length, 2, '5. 导入后是两块');

// 坏输入
const bad = await call('POST', '/rp-soul/preset', { import: { foo: 1 } });
eq(bad.status, 400, '5. 不像 RimTalk 预设就 400');
const empty = await call('POST', '/rp-soul/preset', {});
eq(empty.status, 400, '5. 什么都没给就 400');

// ---- 7. 自定义 separator 立即生效 ----
const c = await call('POST', '/rp-soul/config', { separator: '\n---\n', maxBytes: 4096 });
eq(c.status, 200, '7. POST /config 200');
has(sectionDefs.get('soul-persona').text(), '\n---\n', '7. 自定义 separator 生效');

// ---- 8. 插值关闭 ----
eq(sectionDefs.get('soul-persona').interpolate, false, '8. section 声明 interpolate:false（渲染时不做 {{变量}} 插值）');
await call('POST', '/rp-soul/preset', {
  blocks: [{ name: '占位', enabled: true, text: '这个块有 {{user}} 占位符' }],
});
const esc = sectionDefs.get('soul-persona').text();
has(esc, '{{user}}', '8. 原文 {{user}} 原样保留（由 interpolate:false 保证不炸）');
hasNot(esc, String.fromCharCode(0x200b), '8. 不再塞零宽字符');

// ---- 9. 总开关 ----
await call('POST', '/rp-soul/config', { enabled: false });
eq(sectionDefs.get('soul-persona').text(), '', '9. enabled=false 时合成文本为空串');

// ---- 10. 异常输入 ----
const badCfg = await call('POST', '/rp-soul/config', { maxBytes: -1 });
ok(badCfg.status === 200 || badCfg.status === 400, '10. 非法 maxBytes 不崩（200 夹紧 或 400）');
await call('POST', '/rp-soul/config', { enabled: true, maxBytes: 8192 });

// ---- 11. 引擎人设独立文件 ----
const pf0 = await call('GET', '/rp-soul/engine/persona-file');
eq(pf0.status, 200, '11. GET /engine/persona-file 200');
eq(pf0.parsed.rel, 'rp-soul/persona.md', '11. 人设文件固定叫 rp-soul/persona.md');
eq(pf0.parsed.exists, false, '11. 还没建时 exists=false');
eq(pf0.parsed.source, 'empty', '11. 散文里也没有前置块时 source=empty');

// 预设里带前置块 → 表单初值从预设的正文里来（source=legacy），此时还没落盘
await call('POST', '/rp-soul/preset', {
  blocks: [
    { name: '前置', enabled: true, text: [
      '---',
      'id: legacy_hero',
      'title: 旧世界',
      'mood_base: 60',
      'places:',
      '  - {id: room, name: 房间, privacy: private}',
      'cast:',
      '  - {id: hero, name: 英雄, gender: female, age: 20, tier: major, voices: {surface: 冷, inner: 热}}',
      '---',
      '',
      '这是散文正文。',
      '',
    ].join('\n') },
  ],
});
const pf1 = await call('GET', '/rp-soul/engine/persona-file');
eq(pf1.parsed.source, 'legacy', '11. 前置块在预设正文里时表单以 legacy 迁移');
eq(pf1.parsed.front.id, 'legacy_hero', '11. legacy 初值能读到 id');
eq(pf1.parsed.legacyRel, 'rp-soul/preset.md', '11. legacy 来源文件可追溯');
has(pf1.parsed.preview, 'mood_base:', '11. legacy 也能给出 YAML 预览');

const injected = sectionDefs.get('soul-persona').text();
has(injected, '这是散文正文', '11. 提示词里保留散文');
hasNot(injected, 'legacy_hero', '11. 提示词里不再出现前置块字段');

// 表单保存 → 落盘成独立文件，之后一律以文件为准
const saved = await call('PUT', '/rp-soul/engine/persona-file', {
  front: {
    id: 'new_world',
    title: '新世界',
    mood_base: 66,
    places: [{ id: 'hall', name: '大厅', privacy: 'public' }],
    cast: [{
      id: 'ace', name: '艾斯', gender: 'male', age: 24, tier: 'major',
      voices: { surface: '敷衍', inner: '很在意' },
    }],
  },
});
eq(saved.status, 200, '11. PUT 保存 200');
eq(saved.parsed.exists, true, '11. 保存后文件存在');
eq(saved.parsed.source, 'file', '11. 保存后来源变 file');
eq(saved.parsed.front.mood_base, 66, '11. 写回的字段完整');
ok(saved.parsed.front.places[0].id === 'hall', '11. 嵌套地点写回正确');
ok(saved.parsed.front.cast[0].voices.surface === '敷衍', '11. 嵌套角色语态写回正确');

const pf2 = await call('GET', '/rp-soul/engine/persona-file');
eq(pf2.parsed.front.id, 'new_world', '11. 重读拿到刚存的 id');

const badFront = await call('PUT', '/rp-soul/engine/persona-file', { front: [1, 2] });
eq(badFront.status, 400, '11. front 不是对象时 400');

// 文件优先：改了预设正文里的前置块，persona.md 仍然赢
await call('POST', '/rp-soul/preset', {
  text: ['---', 'id: should_be_ignored', 'places: []', 'cast: []', '---', '', '散文变了。', ''].join('\n'),
});
const pf3 = await call('GET', '/rp-soul/engine/persona-file');
eq(pf3.parsed.front.id, 'new_world', '11. persona.md 存在时预设前置块被忽略');

// ---- 12. 唤醒页的三条接口 ----
// 这里没有桌面宿主，所以唤醒线没挂载：验的是「没挂载时不崩、字段照样能存」，
// 真正的唤醒逻辑与送达在 test/wake.mjs 里单独验。
const wr = await call('GET', '/rp-soul/wake');
eq(wr.status, 200, '12. GET /wake 200');
eq(wr.parsed.mounted, false, '12. 没宿主时 mounted=false');
ok(wr.parsed.config && typeof wr.parsed.config === 'object', '12. /wake 回配置');
eq(Array.isArray(wr.parsed.sessions), true, '12. /wake 回会话数组');
eq(wr.parsed.sessions.length, 0, '12. 没宿主时会话清单为空');
eq(wr.parsed.config.dailyLimit, 12, '12. 每日次数默认 12');
eq(wr.parsed.config.dailyTokens, 300000, '12. 每日 token 默认 300000');
eq(wr.parsed.config.quiet, '00:00-08:00', '12. 安静时段默认 00:00-08:00');
eq(wr.parsed.config.missYou, 6, '12. 想你阈值默认 6 小时');
eq(wr.parsed.config.routine, true, '12. 作息换段默认开');
eq(wr.parsed.config.enabled, false, '12. 唤醒默认关');

const wp = await call('POST', '/rp-soul/wake', { wakeDailyLimit: 7, wakeQuiet: '01:00-06:00', wakeEnabled: true, wakeMissYou: 9 });
eq(wp.status, 200, '12. POST /wake 200');
const storedWake = JSON.parse(readFileSync(join(home, 'rp-soul', 'config.json'), 'utf8'));
eq(storedWake.wakeDailyLimit, 7, '12. POST /wake 写进 store');
eq(storedWake.wakeQuiet, '01:00-06:00', '12. POST /wake 写安静时段');
eq(storedWake.wakeEnabled, true, '12. POST /wake 写开关');
eq(storedWake.wakeMissYou, 9, '12. POST /wake 写想你阈值');

const wpBad = await call('POST', '/rp-soul/wake', { wakeQuiet: '乱填', wakeDailyLimit: -5 });
const storedBad = JSON.parse(readFileSync(join(home, 'rp-soul', 'config.json'), 'utf8'));
eq(storedBad.wakeQuiet, '00:00-08:00', '12. 乱的安静时段回落默认值');
eq(storedBad.wakeDailyLimit, 0, '12. 负数次数夹到 0');

const wr2 = await call('GET', '/rp-soul/wake');
eq(wr2.parsed.config.sessionId, '', '12. 会话 id 默认空');

const wn = await call('POST', '/rp-soul/wake/now', {});
eq(wn.status, 200, '12. POST /wake/now 200');
eq(wn.parsed.ok, false, '12. 没挂载时叫不醒（ok=false）');
has(String(wn.parsed.error), '没挂载', '12. 没挂载时给出原因');

// /config 也认唤醒字段（设置页的零散开关走同一条 POST）
const wc = await call('POST', '/rp-soul/config', { wakeRoutine: false, wakeSessionId: '  s_zz  ' });
eq(wc.status, 200, '12. POST /config 认唤醒字段');
const storedCfg = JSON.parse(readFileSync(join(home, 'rp-soul', 'config.json'), 'utf8'));
eq(storedCfg.wakeRoutine, false, '12. /config 能关作息换段');
eq(storedCfg.wakeSessionId, 's_zz', '12. /config 能定会话（去掉首尾空格）');

done('routes');
