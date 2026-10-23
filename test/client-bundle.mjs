/* 用假的 __ModuleLoader__ + 迷你 React 运行时跑 lib/client.js，逐条断言。
 * 验的是：bundle 注册契约、factory 的 require 边界、settings.section 的注册参数、
 * 组件三个渲染态（loading / error / ready）、以及"点按钮真的发出正确 HTTP 请求"。
 * 这层跑在 vm 沙箱里，不能替代真浏览器，但能挡住绝大多数低级错误。 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { eq, ok, has, done } from './_check.mjs';

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

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
  },
  useState(init) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = typeof init === 'function' ? init() : init;
    return [hookState[i], (next) => { hookState[i] = typeof next === 'function' ? next(hookState[i]) : next; }];
  },
  useEffect(fn, deps) {
    const i = hookIndex++;
    const prev = hookDeps[i];
    const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, k) => d !== prev[k]);
    if (changed) { hookDeps[i] = deps; pendingEffects.push(fn); }
  },
  useCallback(fn) { hookIndex++; return fn; },
  useMemo(fn) { hookIndex++; return fn(); },
  useRef(init) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = { current: init };
    return hookState[i];
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
async function renderOnce() {
  hookIndex = 0;
  pendingEffects = [];
  const tree = slotComponent({ close: () => {} });
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

done('client-bundle');
