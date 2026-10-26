/* 用假的 __ModuleLoader__ + 迷你 React 运行时跑 lib/client.js，逐条断言。
 * 验的是：bundle 注册契约、factory 的 require 边界、settings.section 的注册参数、
 * 组件三个渲染态（loading / error / ready）、以及"点按钮真的发出正确 HTTP 请求"。
 * 这层跑在 vm 沙箱里，不能替代真浏览器，但能挡住绝大多数低级错误。 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { eq, ok, has, hasNot, done } from './_check.mjs';

// ───────────────────────── 1. 装载 bundle ─────────────────────────
let registered = null;
const win = {
  __ModuleLoader__: { load(def) { registered = def; } },
  confirm: () => true,
};

// 迷你 React：hooks 带真实状态存储，可重渲染
const hookState = [];
let hookIndex = 0;
let pendingEffects = [];
const hookDeps = [];
// 子组件（函数组件）用独立的 hook 槽：key = 组件名 + 在树里的位置，跨渲染保留。
// 根组件仍然用上面那组扁平数组，保证前面各段的断言行为不变。
const childHooks = new Map();
let currentOwner = null;
function ownerSlot() {
  if (currentOwner === null) return null;
  let box = childHooks.get(currentOwner);
  if (!box) {
    box = { state: [], deps: [], idx: 0 };
    childHooks.set(currentOwner, box);
  }
  return box;
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
  },
  useState(init) {
    const box = ownerSlot();
    const i = box === null ? hookIndex++ : box.idx++;
    const store = box === null ? hookState : box.state;
    if (!(i in store)) store[i] = typeof init === 'function' ? init() : init;
    return [store[i], (next) => { store[i] = typeof next === 'function' ? next(store[i]) : next; }];
  },
  useEffect(fn, deps) {
    const box = ownerSlot();
    const i = box === null ? hookIndex++ : box.idx++;
    const store = box === null ? hookDeps : box.deps;
    const prev = store[i];
    const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, k) => d !== prev[k]);
    if (changed) { store[i] = deps; pendingEffects.push(fn); }
  },
  useCallback(fn) { const box = ownerSlot(); if (box === null) hookIndex++; else box.idx++; return fn; },
  useMemo(fn) { const box = ownerSlot(); if (box === null) hookIndex++; else box.idx++; return fn(); },
  useRef(init) {
    const box = ownerSlot();
    const i = box === null ? hookIndex++ : box.idx++;
    const store = box === null ? hookState : box.state;
    if (!(i in store)) store[i] = { current: init };
    return store[i];
  },
};

// fetch 打桩：记录每次调用，按路由回放
const calls = [];
let statePayload = null;
const responses = new Map();

function jsonResponse(obj, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(obj) };
}
const fakeFetch = async (url, init = {}) => {
  const method = (init.method || 'GET').toUpperCase();
  calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
  const key = method + ' ' + url.split('?')[0];
  const handler = responses.get(key);
  if (handler) return handler(init);
  if (key === 'GET /rp-soul/state') return jsonResponse(statePayload);
  throw new Error('未打桩的请求: ' + key);
};

const sandbox = { window: win, console, fetch: fakeFetch, setTimeout, clearTimeout, JSON, Math, Number, Array, Object, String, isFinite, encodeURIComponent };
sandbox.globalThis = sandbox;
const ctxVm = vm.createContext(sandbox);
const clientUrl = new URL('../lib/client.js', import.meta.url);
vm.runInContext(readFileSync(clientUrl, 'utf8'), ctxVm, { filename: 'lib/client.js' });

// ---- 1. 注册 ----
ok(registered !== null, '1. bundle 调用了 __ModuleLoader__.load');
eq(registered.id, 'dsh-rp-soul', '1. bundle id 必须等于包名');
eq(typeof registered.factory, 'function', '1. factory 是函数');

// ---- 2. factory 的 require 边界 ----
const ALLOWED = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']);
const asked = [];
const requireFn = (spec) => {
  asked.push(spec);
  if (!ALLOWED.has(spec)) throw new Error('未声明的 require: ' + spec);
  if (spec === 'react') return React;
  if (spec === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement, Fragment: 'Fragment' };
  return {};
};
const clientMod = registered.factory(requireFn);
ok(asked.every((s) => ALLOWED.has(s)), '2. 只 require 宿主允许的模块：' + asked.join(', '));
eq(typeof clientMod.apply, 'function', '2. 导出 apply');
eq(Array.isArray(clientMod.inject), true, '2. 导出 inject 数组');

// ---- 3. settings.section 注册参数 ----
let slotOptions = null;
let slotComponent = null;
let injectName = null;
clientMod.apply({
  slots: {
    inject(name, factory) { injectName = name; return factory(); },
    register(options, Component) { slotOptions = options; slotComponent = Component; return () => {}; },
  },
});
eq(injectName, 'settings.section', '3. inject 的 slot 名');
eq(slotOptions.name, 'settings.section', '3. register 的 name');
eq(slotOptions.id, 'soul-persona', '3. register 的 id');
eq(typeof slotOptions.order, 'number', '3. order 是数字');
ok(slotOptions.order > 0 && slotOptions.order < 1000, '3. order 在合理区间 (' + slotOptions.order + ')');
eq(typeof slotOptions.label, 'function', '3. label 是 thunk（支持语言切换）');
eq(slotOptions.label(), '角色人设', '3. label 文案');
eq(typeof slotComponent, 'function', '3. 组件是函数（不是 class）');

// ───────────────────────── 迷你渲染器 ─────────────────────────
// 默认不展开函数组件（前面各段的行为原样保留）；第 11 段打开它来渲页签面板。
let expandComponents = false;
function expandTree(node, path) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map((n, i) => expandTree(n, path + '.' + i));
  if (typeof node !== 'object' || node.type === undefined) return node;
  if (typeof node.type === 'function') {
    const key = (node.type.name || 'anon') + '@' + path;
    const prev = currentOwner;
    currentOwner = key;
    const box = ownerSlot();
    box.idx = 0;
    let out;
    try { out = node.type(node.props || {}); } finally { currentOwner = prev; }
    return expandTree(out, path);
  }
  return { type: node.type, props: node.props, children: (node.children || []).map((c, i) => expandTree(c, path + '.' + i)) };
}

async function renderOnce() {
  hookIndex = 0;
  pendingEffects = [];
  let tree = slotComponent({ close: () => {} });
  if (expandComponents) tree = expandTree(tree, 'root');
  const effects = pendingEffects.slice();
  pendingEffects = [];
  // 注意：不调用 cleanup —— cleanup 会把 alive.current 置 false，
  // 之后所有 await 回来的赋值都会被 if(!alive.current) return 吞掉，测试就永远等不到 ready。
  for (const fn of effects) fn();
  // 让 effect 里的 await fetch 有机会跑完
  for (let i = 0; i < 12; i++) await Promise.resolve();
  return tree;
}
async function renderUntil(pred, max = 8) {
  let tree = null;
  for (let i = 0; i < max; i++) {
    tree = await renderOnce();
    if (pred(tree)) return tree;
  }
  return tree;
}

// 树查询工具
function walk(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push({ text: String(node) }); return out; }
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
  return out;
}
function textOf(node) {
  return walk(node).filter((n) => n.text !== undefined).map((n) => n.text).join('');
}
function findAll(node, pred) {
  return walk(node).filter((n) => n.type !== undefined && pred(n));
}
function findButton(tree, label) {
  return findAll(tree, (n) => n.type === 'button' && textOf(n).includes(label))[0];
}
function findInput(tree, type) {
  return findAll(tree, (n) => n.type === 'input' && n.props.type === type)[0];
}
function findRow(tree, label) {
  return findAll(tree, (n) => n.type === 'div' && typeof n.props.onClick === 'function' && textOf(n).includes(label))[0];
}

// ---- 4. loading 态（state 请求挂起）----
let resolveState = null;
responses.set('GET /rp-soul/state', () => new Promise((res) => {
  resolveState = () => res(jsonResponse({
    config: { files: [], separator: '\n\n', annotate: false, enabled: true, maxBytes: 65536 },
    files: [], library: [], composed: null, storePath: 'rp-soul/config.json',
  }));
}));
const loadingTree = await renderUntil((t) => textOf(t).includes('正在读取角色预设'));
has(textOf(loadingTree), '正在读取角色预设', '4. loading 态有提示文案');
eq(loadingTree.props['data-plugin'], 'soul-persona', '4. loading 态带 data-plugin');
ok(loadingTree.props['data-render-state'] !== 'ready', '4. loading 态不是 ready');

// ---- 5. ready 态 ----
statePayload = {
  config: { files: ['SOUL.md', 'TONE.md'], separator: '\n\n', annotate: false, enabled: true, maxBytes: 65536 },
  files: [
    { rel: 'SOUL.md', exists: true, bytes: 24 },
    { rel: 'TONE.md', exists: false, bytes: 0 },
  ],
  library: ['SOUL.md', 'TONE.md', 'rp-soul/parts/禁忌.md'],
  composed: { chars: 40, bytes: 60, preview: '身份 + 口吻的预览' },
  storePath: 'rp-soul/config.json',
};
responses.delete('GET /rp-soul/state');
calls.length = 0;
const readyTree = await renderUntil((t) => t.props['data-render-state'] === 'ready');
eq(readyTree.props['data-render-state'], 'ready', '5. 拿到 state 后进入 ready 态');
const readyText = textOf(readyTree);
has(readyText, '角色人设', '5. 标题');
has(readyText, '2 个文件', '5. 文件数徽标');
has(readyText, 'SOUL.md', '5. 清单列出 SOUL.md');
has(readyText, 'TONE.md', '5. 清单列出 TONE.md');
has(readyText, '缺失', '5. 不存在的文件标「缺失」');
has(readyText, 'rp-soul/config.json', '5. 显示 store 路径');
ok(calls.some((c) => c.method === 'GET' && c.url === '/rp-soul/state'), '5. 确实请求了 /state');

// ---- 6. 「启用」勾选框 → POST /config ----
responses.set('POST /rp-soul/config', () => jsonResponse({ ok: true }));
calls.length = 0;
const enableBox = findAll(readyTree, (n) => n.type === 'input' && n.props.type === 'checkbox')[0];
ok(enableBox !== undefined, '6. 找到「启用」勾选框');
enableBox.props.onChange({ target: { checked: false } });
for (let i = 0; i < 12; i++) await Promise.resolve();
const cfgCall = calls.find((c) => c.method === 'POST' && c.url === '/rp-soul/config');
ok(cfgCall !== undefined, '6. 勾选框触发 POST /config');
eq(cfgCall.body, { enabled: false }, '6. 请求体只带 enabled');

// ---- 7. 点文件名 → GET /file；编辑后保存 → PUT /file ----
responses.set('GET /rp-soul/file', () => jsonResponse({ rel: 'SOUL.md', text: '旧文本', exists: true }));
responses.set('PUT /rp-soul/file', () => jsonResponse({ ok: true }));
calls.length = 0;
const row = findAll(readyTree, (n) => n.type === 'div' && typeof n.props.onClick === 'function' && textOf(n).includes('SOUL.md'))[0];
ok(row !== undefined, '7. 找到清单里的 SOUL.md 行');
row.props.onClick();
for (let i = 0; i < 12; i++) await Promise.resolve();
ok(calls.some((c) => c.method === 'GET' && c.url.startsWith('/rp-soul/file')), '7. 点行触发 GET /file');
ok(calls.some((c) => c.url.includes('rel=SOUL.md')), '7. GET 带正确 rel 参数');

const editingTree = await renderUntil((t) => findAll(t, (n) => n.type === 'textarea').length > 0);
const textarea = findAll(editingTree, (n) => n.type === 'textarea')[0];
ok(textarea !== undefined, '7. 选中文件后出现编辑器 textarea');
eq(textarea.props.value, '旧文本', '7. 编辑器内容 = 服务端返回的文本');

calls.length = 0;
textarea.props.onChange({ target: { value: '新文本' } });
const typedEdited = await renderOnce();
const saveBtn = findButton(typedEdited, '保存');
ok(saveBtn !== undefined, '7. dirty 后「保存」按钮存在');
eq(saveBtn.props.disabled, false, '7. dirty 后保存按钮可用');
saveBtn.props.onClick();
for (let i = 0; i < 12; i++) await Promise.resolve();
const putCall = calls.find((c) => c.method === 'PUT' && c.url === '/rp-soul/file');
ok(putCall !== undefined, '7. 点保存发出 PUT /file');
eq(putCall.body.rel, 'SOUL.md', '7. PUT body.rel');
eq(putCall.body.text, '新文本', '7. PUT body.text 是改后的文本');

// ---- 8. 新建文件 → POST /new ----
responses.set('POST /rp-soul/new', () => jsonResponse({ ok: true, rel: 'rp-soul/parts/语气.md' }));
const baseTree = await renderUntil((t) => t.props['data-render-state'] === 'ready');
const nameInput = findAll(baseTree, (n) => n.type === 'input' && typeof n.props.placeholder === 'string' && n.props.placeholder.includes('新文件名'))[0];
ok(nameInput !== undefined, '8. 找到「新文件名」输入框');
calls.length = 0;
nameInput.props.onChange({ target: { value: '语气' } });
const typedName = await renderOnce();
const createBtn = findButton(typedName, '新建');
ok(createBtn !== undefined, '8. 输入名字后「新建」按钮存在');
eq(createBtn.props.disabled, false, '8. 输入名字后「新建」可用');
createBtn.props.onClick();
for (let i = 0; i < 12; i++) await Promise.resolve();
const newCall = calls.find((c) => c.method === 'POST' && c.url === '/rp-soul/new');
ok(newCall !== undefined, '8. 点新建发出 POST /new');
eq(newCall.body.name, '语气', '8. POST /new body.name');

// ---- 9. /state 失败 → 错误态（不是白屏）----
// 先把前面几个小节残留的微任务灌完 —— 否则旧请求的回调会在我们清空 hookState
// 之后才 setSnap，把 ready 态又写回来，导致这里误判。
for (let i = 0; i < 40; i++) await Promise.resolve();
responses.set('GET /rp-soul/state', () => jsonResponse({ error: '读取磁盘失败' }, 500));
hookState.length = 0;
hookDeps.length = 0;
const errTree = await renderUntil((t) => textOf(t).includes('读取配置失败'));
has(textOf(errTree), '读取配置失败', '9. /state 500 时显示错误文案');
has(textOf(errTree), '读取磁盘失败', '9. 错误文案带上宿主返回的原因');
ok(findButton(errTree, '重试') !== undefined, '9. 错误态有「重试」按钮');
ok(errTree.props['data-render-state'] !== 'ready', '9. 错误态不是 ready');

// ---- 10. 分隔符输入框：显示转义形式，失焦写回真实字符 ----
const BS = String.fromCharCode(92);
const LF = String.fromCharCode(10);
hookState.length = 0;
hookDeps.length = 0;
responses.delete('GET /rp-soul/state');
responses.set('POST /rp-soul/config', () => jsonResponse({ ok: true }));
const sepTree = await renderUntil((t) => t.props['data-render-state'] === 'ready');
const sepField = findAll(sepTree, (n) => n.type === 'input' && n.props.value === BS + 'n' + BS + 'n')[0];
ok(sepField !== undefined, '10. 两个换行显示为转义形式');
calls.length = 0;
sepField.props.onBlur({ target: { value: BS + 'n' + BS + 'n' + BS + 'n' } });
for (let i = 0; i < 12; i++) await Promise.resolve();
const sepCall = calls.find((c) => c.method === 'POST' && c.url === '/rp-soul/config');
ok(sepCall !== undefined, '10. 失焦触发 POST /config');
eq(sepCall.body.separator, LF + LF + LF, '10. 三个转义换行 → 三个真实换行');
ok(sepCall.body.separator.indexOf(BS) === -1, '10. 写回的字符串里没有残留反斜杠');

calls.length = 0;
sepField.props.onBlur({ target: { value: '' } });
for (let i = 0; i < 12; i++) await Promise.resolve();
const emptyCall = calls.find((c) => c.method === 'POST' && c.url === '/rp-soul/config');
eq(emptyCall.body.separator, '', '10. 留空 → 空分隔符');

// ---- 引擎卡：client.js 必须引用 /engine 系列路由，且不出现裸 fetch ----
const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
has(clientSrc, '"/engine"', '引擎卡读 /engine');
has(clientSrc, '"/engine/persona"', '引擎人设页有校验入口');
hasNot(clientSrc, '校验人设', '引擎卡不再重复一个校验人设按钮');
has(clientSrc, '"/engine/mood', '引擎卡有心情面板入口');
has(clientSrc, '"/engine/thought"', '引擎卡有删情绪入口');
has(clientSrc, 'EngineCard', '引擎卡组件存在');
has(clientSrc, 'check.details', '校验结果读 details');
hasNot(clientSrc, 'check.problems', '不再读旧的 problems 字段');
hasNot(clientSrc, 'fetch("http', '客户端不直连绝对地址');

// ---- 11. 页签：人设提示词 / 情绪 / 自主行动记录 ----
// 这一层验的是「三个页签真的能切换、每个页签读自己的路由、渲染出该有的字段」。
// 引擎路由全部打桩，不让真实引擎参与。
hookState.length = 0;
hookDeps.length = 0;
childHooks.clear();
expandComponents = true;
responses.set('GET /rp-soul/state', () => jsonResponse(statePayload));
responses.set('GET /rp-soul/engine', () => jsonResponse({
  health: { enabled: true, present: true, python: { ok: true, version: [3, 12, 8] }, dataDir: 'C:/x/rp-soul/engine', ready: true },
  persona: { title: '雨夜诊所', personaId: 'rain_clinic', bytes: 1024, files: ['SOUL.md'], front: { id: 'rain_clinic', title: '雨夜诊所', cast: [{}], places: [{}, {}] }, error: null },
  sessionsFile: 'C:/x/rp-soul/engine-sessions.json',
  sessions: [{ key: 'shared', session_id: 's_test01', turn: 3 }],
  session: { key: 'shared', session_id: 's_test01', revision: 7, turn: 3, persona_title: '雨夜诊所' },
}));
responses.set('GET /rp-soul/engine/moods', () => jsonResponse({
  ok: true,
  session_id: 's_test01',
  revision: 9,
  turn: 3,
  persona_title: '雨夜诊所',
  clock_label: '第一天 21:30',
  place: 'clinic',
  thresholds: { open: 75, closed: 55, break: 30 },
  npcs: [
    {
      id: 'lin_wan', name: '林晚', tier: 'major', role: '夜班护士', present: true, conditions: ['感冒'],
      value: 42, band: 'closed', base: 55,
      thoughts: [
        { id: 'th1', label: '他记得我不喝冰的', delta: 6, peak_delta: 8, kind: 'memory', decay: 'slow', since_turn: 1, remaining_minutes: null },
        { id: 'th2', label: '雨太大了', delta: -4, peak_delta: -4, kind: 'situational', decay: 'fast', since_turn: 3, remaining_minutes: 45 },
      ],
      trust: 12, tension: 3, stage: 'stranger', stage_label: '陌生', can_act: false,
    },
  ],
  deletions: [{ turn: 2, npc_id: 'lin_wan', thought_id: 'th0', label: '手上的疤', delta: -3, reason: '设置页手动删除', created_at: '2026-10-25T10:00:00' }],
}));
responses.set('GET /rp-soul/engine/activity', () => jsonResponse({
  ok: true,
  session_id: 's_test01',
  revision: 7,
  turn: 3,
  persona_title: '雨夜诊所',
  clock_label: '第一天 21:30',
  place: 'clinic',
  open_action: '她把药盘放回车上，回头看了你一眼。',
  counts: { turns: 2, actions: 1, beats: 1 },
  rows: [
    {
      turn: 3, revision: 7, kind: 'commit', mode: 'continue', undone: false,
      created_at: '2026-10-25T13:30:00', summary: '她值完了夜班，雨还没停。', open_action: '她把药盘放回车上，回头看了你一眼。',
      actions: [{ npc_id: 'lin_wan', name: '林晚', kind: 'observe', kind_label: '在旁观察', significant: false, text: '她在门口站了一会儿。', target_id: null }],
      beats: [{ npc_id: 'lin_wan', name: '林晚', summary: '她把湿伞靠在墙角。' }],
      responses: [{ npc_id: 'lin_wan', name: '林晚', response: 'partial', label: '半配合', note: '' }],
      relations: [{ from: 'lin_wan', to: 'player', from_name: '林晚', to_name: '你', trust: 12, tension: 3, stage: 'stranger', stage_label: '陌生' }],
      thoughts: [{ npc_id: 'lin_wan', name: '林晚', label: '他记得我不喝冰的', delta: 6 }],
    },
    {
      turn: 2, revision: 6, kind: 'commit', mode: 'result', undone: true,
      created_at: '2026-10-25T13:10:00', summary: '', open_action: '',
      actions: [], beats: [], responses: [], relations: [], thoughts: [],
    },
  ],
}));
responses.set('DELETE /rp-soul/engine/thought', () => jsonResponse({ ok: true, revision: 8 }));
responses.set('GET /rp-soul/engine/persona-file', () => jsonResponse({
  ok: true,
  rel: 'rp-soul/persona.md',
  exists: false,
  bytes: 0,
  mtimeMs: null,
  source: 'legacy',
  legacyRel: 'rp-soul/parts/角色档案.md',
  error: null,
  preview: 'id: rain_clinic\ntitle: 雨夜诊所\n',
  front: {
    id: 'rain_clinic', title: '雨夜诊所', mood_base: 60,
    mood_thresholds: { open: 72, closed: 42, break: 20 },
    places: [{ id: 'clinic', name: '诊所', privacy: 'private' }],
    cast: [{
      id: 'lin_wan', name: '林晚', call: '林医生', gender: 'female', age: 26, tier: 'major',
      role: '夜班医生', appearance: '白大褂',
      voices: { surface: '冷淡', inner: '其实很在意' },
      schedule: [{ from: 0, to: 1439, location_id: 'clinic' }],
    }],
  },
}));
responses.set('PUT /rp-soul/engine/persona-file', (init) => jsonResponse({
  ok: true,
  rel: 'rp-soul/persona.md',
  exists: true,
  bytes: 512,
  mtimeMs: 1,
  source: 'file',
  legacyRel: null,
  error: null,
  preview: '',
  front: init.body.front,
}));

const tabTree = await renderUntil((t) => t.props['data-render-state'] === 'ready');
const tabText = textOf(tabTree);
eq(tabTree.props['data-tab'], 'persona', '11. 默认停在「人设提示词」页');
has(tabText, '人设提示词', '11. 有「人设提示词」页签');
has(tabText, '引擎人设', '11. 有「引擎人设」页签');
has(tabText, '情绪', '11. 有「情绪」页签');
has(tabText, '自主行动记录', '11. 有「自主行动记录」页签');
has(tabText, '拼接顺序', '11. 人设页仍然渲染原来的内容');

// 切到「引擎人设」：表单要能从 persona-file 读出结构化字段并渲染
calls.length = 0;
findButton(tabTree, '引擎人设').props.onClick();
for (let i = 0; i < 20; i++) await Promise.resolve();
const engineTree = await renderUntil((t) => t.props['data-tab'] === 'engine' && textOf(t).includes('林晚'));
eq(engineTree.props['data-tab'], 'engine', '11. 切到「引擎人设」页');
ok(calls.some((c) => c.method === 'GET' && c.url === '/rp-soul/engine/persona-file'), '11. 引擎人设页读 persona-file');
const engineText = textOf(engineTree);
has(engineText, 'rp-soul/persona.md', '11. 表单上写明文件位置');
ok(findAll(engineTree, (n) => n.type === 'input' && n.props.value === '雨夜诊所').length === 1, '11. 表单带出标题');
has(engineText, '心情基准', '11. 表单有心情基准字段');
has(engineText, '看 YAML', '11. 表单能切到 YAML 预览');
has(engineText, '前置块', '11. 未落盘时提示从散文前置块迁移');
has(engineText, '旧格式', '11. 旧的多角色格式会提示按单人读出');
ok(findAll(engineTree, (n) => n.type === 'input' && n.props.value === '林晚').length === 1, '11. 第一个主要角色读成了单人表单');
ok(findAll(engineTree, (n) => n.type === 'input' && n.props.value === '在诊所').length === 1, '11. 日程换成了作息「在<地点>」');
hasNot(engineText, '加一个地点', '11. 不再有地点编辑');
hasNot(engineText, '加一个角色', '11. 不再能加第二个角色');

// 改一个字段再存：请求体里必须带改后的值
calls.length = 0;
const titleInput = findAll(engineTree, (n) => n.type === 'input' && n.props.value === '雨夜诊所')[0];
ok(titleInput !== undefined, '11. 标题输入框在表单里');
titleInput.props.onChange({ target: { value: '雨夜诊所·续' } });
for (let i = 0; i < 20; i++) await Promise.resolve();
const dirtyTree = await renderUntil((t) => textOf(t).includes('未保存'));
has(textOf(dirtyTree), '未保存', '11. 改字段后标记未保存');
findButton(dirtyTree, '保存').props.onClick();
for (let i = 0; i < 30; i++) await Promise.resolve();
const personaPut = calls.filter((c) => c.method === 'PUT' && c.url === '/rp-soul/engine/persona-file')[0];
ok(personaPut !== undefined, '11. 点保存发出 PUT');
eq(personaPut.body.front.title, '雨夜诊所·续', '11. PUT 里带改后的标题');
eq(personaPut.body.front.name, '林晚', '11. PUT 写成单人格式：name 在顶层');
eq(personaPut.body.front.id, 'lin_wan', '11. 她的 id 来自原来那个角色');
eq(personaPut.body.front.cast, undefined, '11. PUT 里不再有 cast');
eq(personaPut.body.front.places, undefined, '11. PUT 里不再有 places');
eq(personaPut.body.front.legacy, undefined, '11. 界面用的 legacy 标记不写进文件');
eq(personaPut.body.front.adult_context, undefined, '11. 留空的可选字段不写成空串（引擎不收空串）');
eq(personaPut.body.front.call, '林医生', '11. 填了的可选字段照常写回');
eq(personaPut.body.front.routine, [{ from: 0, to: 1439, doing: '在诊所' }], '11. 作息随 PUT 写回');

// 切到「情绪」
calls.length = 0;
findButton(tabTree, '情绪').props.onClick();
for (let i = 0; i < 20; i++) await Promise.resolve();
const moodTree = await renderUntil((t) => t.props['data-tab'] === 'mood' && textOf(t).includes('林晚'));
eq(moodTree.props['data-tab'], 'mood', '11. 切到「情绪」页');
ok(calls.some((c) => c.method === 'GET' && c.url === '/rp-soul/engine'), '11. 情绪页读 /engine 拿当前局');
ok(calls.some((c) => c.method === 'GET' && c.url.indexOf('/rp-soul/engine/moods') === 0), '11. 情绪页读 /engine/moods');
const moodText = textOf(moodTree);
has(moodText, '林晚', '11. 情绪页列出 NPC 名字');
has(moodText, '42 / 100', '11. 情绪页显示心情值');
has(moodText, '低落', '11. 心情值带 band 文案');
has(moodText, '开心 ≥ 75', '11. 情绪页显示阈值');
has(moodText, '他记得我不喝冰的', '11. 列出情绪条目');
has(moodText, '+6', '11. 正 delta 带加号');
has(moodText, '-4', '11. 负 delta');
has(moodText, '剩 45 分', '11. 有剩余时间的条目显示剩余');
has(moodText, '记忆', '11. 区分记忆 / 情境');
has(moodText, '信任 12', '11. 显示对玩家的信任');
has(moodText, '陌生', '11. 显示关系阶段');
has(moodText, '感冒', '11. 显示状态');
has(moodText, '行动冷却中', '11. can_act=false 的文案');
has(moodText, '在你身边', '11. 在场写成「在你身边」');
hasNot(moodText, '主要', '11. 不再显示主要/次要');
has(moodText, '手动删除记录', '11. 有删除审计区');
has(moodText, '手上的疤', '11. 审计区列出被删的条目');
hasNot(moodText, '拼接顺序', '11. 情绪页不渲染人设页内容');

// 点 × 删一条 → DELETE /engine/thought
const delBtn = findAll(moodTree, (n) => n.type === 'button' && textOf(n) === '×' && typeof n.props.onClick === 'function')[0];
ok(delBtn !== undefined, '11. 每条情绪都有删除按钮');
calls.length = 0;
delBtn.props.onClick();
for (let i = 0; i < 20; i++) await Promise.resolve();
const delCall = calls.find((c) => c.method === 'DELETE' && c.url === '/rp-soul/engine/thought');
ok(delCall !== undefined, '11. 点 × 发 DELETE /engine/thought');
eq(delCall.body.session_id, 's_test01', '11. 删除带上 session_id');
eq(delCall.body.npc_id, 'lin_wan', '11. 删除带上 npc_id');
ok(delCall.body.thought_id === 'th1' || delCall.body.thought_id === 'th2', '11. 删除带上 thought_id');
eq(delCall.body.revision, 9, '11. 删除用面板里的最新 revision（不是 /engine 的旧值）');
has(clientSrc, 'panel && panel.revision', '11. 删除逻辑优先用面板 revision');

// 切到「自主行动记录」
findButton(moodTree, '自主行动记录').props.onClick();
for (let i = 0; i < 20; i++) await Promise.resolve();
const actTree = await renderUntil((t) => t.props['data-tab'] === 'activity' && textOf(t).includes('第 3 回合'));
eq(actTree.props['data-tab'], 'activity', '11. 切到「自主行动记录」页');
ok(calls.some((c) => c.method === 'GET' && c.url.indexOf('/rp-soul/engine/activity') === 0), '11. 记录页读 /engine/activity');
const actText = textOf(actTree);
has(actText, '第 3 回合', '11. 记录页按回合列出');
has(actText, '你没说没做', '11. mode 文案（continue）');
has(actText, '你说的话成了事实', '11. mode 文案（result）');
has(actText, '在旁观察', '11. 自主行动的类型文案');
has(actText, '她在门口站了一会儿。', '11. 自主行动的正文');
has(actText, '她把湿伞靠在墙角。', '11. 离屏片段');
has(actText, '半配合', '11. 回应文案');
has(actText, '林晚 对 你', '11. 关系变化');
has(actText, '信任 12', '11. 关系变化带数值');
has(actText, '陌生', '11. 关系阶段显示中文名');
hasNot(actText, 'stranger', '11. 关系阶段不漏英文枚举');
has(actText, '已撤销', '11. 撤销的回合有标记');
has(actText, '这回合没有可显示的变化', '11. 空回合有占位文案');
has(actText, '当前停在这里', '11. 显示 open_action');
has(actText, '1 次自主行动', '11. 顶部汇总计数');
hasNot(actText, '条情绪', '11. 记录页不渲染情绪页内容');

// 空局：没有 session 时两个新页都要给出提示而不是崩
hookState.length = 0;
hookDeps.length = 0;
childHooks.clear();
responses.set('GET /rp-soul/engine', () => jsonResponse({
  health: { enabled: true, present: true, python: { ok: true, version: [3, 12, 8] }, dataDir: 'C:/x', ready: true },
  persona: { title: '', personaId: '', bytes: 0, files: [], front: {}, error: null },
  sessionsFile: 'C:/x/s.json', sessions: [], session: null,
}));
const emptyPersona = await renderUntil((t) => t.props['data-render-state'] === 'ready');
findButton(emptyPersona, '情绪').props.onClick();
for (let i = 0; i < 20; i++) await Promise.resolve();
const emptyMood = await renderUntil((t) => t.props['data-tab'] === 'mood' && textOf(t).includes('这局还没开局'));
has(textOf(emptyMood), '这局还没开局', '11. 没开局时情绪页给提示');
has(textOf(emptyMood), 'soul_state', '11. 提示里指明会自动开局（soul_state）');

// ---- 13. 「唤醒」页签 ----
// 验的是：页签能切、读的是 /rp-soul/wake、开关与数字真的发对字段、状态区渲染对、
// 没宿主与「现在叫醒一次」失败时的文案。
hookState.length = 0;
hookDeps.length = 0;
childHooks.clear();
responses.set('GET /rp-soul/state', () => jsonResponse(statePayload));
responses.set('GET /rp-soul/wake', () => jsonResponse({
  mounted: true,
  config: {
    enabled: true, sessionId: 's_test01', dailyLimit: 8, dailyTokens: 120000,
    quiet: '23:30-07:00', missYou: 6, routine: true,
  },
  state: {
    at: '2026-10-26T21:40:00+08:00', reason: 'plan', why: '这是我说好做到的时间：洗澡',
    when: '21:40', day: '2026-10-26', count: 3, tokens: 5120, streak: 1,
    lastError: null, lastDeliveredAt: '2026-10-26T13:40:00+08:00', retryAt: null,
  },
  sessions: [
    { sessionId: 's_test01', title: '雨夜诊所', updatedAt: 2, running: false },
    { sessionId: 's_other2', title: '另一个会话', updatedAt: 1, running: false },
  ],
  engineSession: { session_id: 's_test01', revision: 7, turn: 3 },
}));
responses.set('POST /rp-soul/config', () => jsonResponse({ ok: true }));
responses.set('POST /rp-soul/wake/now', () => jsonResponse({ ok: true, count: 4 }));

const wakeFrom = await renderUntil((t) => t.props['data-render-state'] === 'ready');
has(textOf(wakeFrom), '唤醒', '13. 有「唤醒」页签');
findButton(wakeFrom, '唤醒').props.onClick();
for (let i = 0; i < 20; i++) await Promise.resolve();
const wakeTree = await renderUntil((t) => t.props['data-tab'] === 'wake' && textOf(t).includes('下次'));
eq(wakeTree.props['data-tab'], 'wake', '13. 切到「唤醒」页');
ok(calls.some((c) => c.method === 'GET' && c.url === '/rp-soul/wake'), '13. 唤醒页读 /wake');
const wakeText = textOf(wakeTree);
has(wakeText, '让她按自己的时间醒来', '13. 有总开关');
has(wakeText, '她说好做到的时间', '13. 理由显示中文（plan）');
has(wakeText, '这是我说好做到的时间：洗澡', '13. 显示理由原文');
has(wakeText, '已就绪', '13. 挂载状态');
has(wakeText, '今天已唤醒 3 次', '13. 显示今天次数');
has(wakeText, '用掉 5120 token', '13. 显示今天 token');
has(wakeText, '雨夜诊所（当前指定）', '13. 会话下拉标出当前指定');
has(wakeText, '现在叫醒一次', '13. 有手动叫醒按钮');
hasNot(wakeText, '缺桌面宿主', '13. 挂载时不显示缺宿主');

// 总开关：取消勾选 → wakeEnabled: false
const wakeToggle = findAll(wakeTree, (n) => n.type === 'input' && n.props.type === 'checkbox')[0];
ok(wakeToggle !== undefined, '13. 找得到总开关');
calls.length = 0;
wakeToggle.props.onChange({ target: { checked: false } });
for (let i = 0; i < 20; i++) await Promise.resolve();
const offCall = calls.find((c) => c.method === 'POST' && c.url === '/rp-soul/config');
ok(offCall !== undefined, '13. 关掉开关发 POST /config');
eq(offCall.body.wakeEnabled, false, '13. 关掉开关写 wakeEnabled: false');

// 会话下拉：换一场 → wakeSessionId
const sessionSelect = findAll(wakeTree, (n) => n.type === 'select' && n.props.value === 's_test01')[0];
ok(sessionSelect !== undefined, '13. 找得到会话下拉');
calls.length = 0;
sessionSelect.props.onChange({ target: { value: 's_other2' } });
for (let i = 0; i < 20; i++) await Promise.resolve();
const sidCall = calls.find((c) => c.method === 'POST' && c.url === '/rp-soul/config');
eq(sidCall.body.wakeSessionId, 's_other2', '13. 换会话写 wakeSessionId');

// 数字框：每日次数 / token / 想你小时
calls.length = 0;
const numberInputs = findAll(wakeTree, (n) => n.type === 'input' && n.props.type === 'number');
ok(numberInputs.length >= 3, '13. 有每日次数、token、想你三个数字框');
numberInputs[0].props.onChange({ target: { value: '5' } });
for (let i = 0; i < 20; i++) await Promise.resolve();
const limitCall = calls.find((c) => c.method === 'POST' && c.url === '/rp-soul/config');
eq(limitCall.body.wakeDailyLimit, 5, '13. 每日次数写 wakeDailyLimit');
calls.length = 0;
numberInputs[1].props.onChange({ target: { value: '90000' } });
for (let i = 0; i < 20; i++) await Promise.resolve();
eq(calls.find((c) => c.method === 'POST' && c.url === '/rp-soul/config').body.wakeDailyTokens, 90000, '13. token 写 wakeDailyTokens');
calls.length = 0;
numberInputs[2].props.onChange({ target: { value: '9' } });
for (let i = 0; i < 20; i++) await Promise.resolve();
eq(calls.find((c) => c.method === 'POST' && c.url === '/rp-soul/config').body.wakeMissYou, 9, '13. 想你小时写 wakeMissYou');

// 安静时段：失焦才写，避免每敲一个字就存盘
const quietInput = findAll(wakeTree, (n) => n.type === 'input' && n.props.value === '23:30-07:00')[0];
ok(quietInput !== undefined, '13. 找得到安静时段输入框');
calls.length = 0;
quietInput.props.onChange({ target: { value: '01:00-06:00' } });
has(clientSrc, 'setQuietDraft', '13. 安静时段先存草稿');
quietInput.props.onBlur({ target: { value: '01:00-06:00' } });
for (let i = 0; i < 20; i++) await Promise.resolve();
const quietCall = calls.find((c) => c.method === 'POST' && c.url === '/rp-soul/config');
ok(quietCall !== undefined, '13. 失焦写安静时段');
eq(quietCall.body.wakeQuiet, '01:00-06:00', '13. 写 wakeQuiet');

// 手动叫醒
calls.length = 0;
findButton(wakeTree, '现在叫醒一次').props.onClick();
for (let i = 0; i < 20; i++) await Promise.resolve();
ok(calls.some((c) => c.method === 'POST' && c.url === '/rp-soul/wake/now'), '13. 按钮发 POST /wake/now');

// 失败态：没挂载 + 上次没叫成
responses.set('GET /rp-soul/wake', () => jsonResponse({
  mounted: false,
  config: { enabled: false, sessionId: '', dailyLimit: 12, dailyTokens: 300000, quiet: '00:00-08:00', missYou: 6, routine: true },
  state: { at: null, reason: null, why: null, when: null, day: '2026-10-26', count: 0, tokens: 0, streak: 0, lastError: '会话不在了', lastDeliveredAt: null, retryAt: null },
  sessions: [],
  engineSession: null,
}));
findButton(wakeTree, '刷新').props.onClick();
for (let i = 0; i < 20; i++) await Promise.resolve();
const bareTree = await renderUntil((t) => t.props['data-tab'] === 'wake' && textOf(t).includes('缺桌面宿主'));
has(textOf(bareTree), '缺桌面宿主', '13. 没挂载时标出缺宿主');
has(textOf(bareTree), '上次没叫成：会话不在了', '13. 显示上次失败原因');
has(textOf(bareTree), '唤醒线关着', '13. 关着时给出提示');

done('client-bundle');
