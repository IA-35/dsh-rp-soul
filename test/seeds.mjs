/* 首装落地：种子文件自动创建、绝不覆盖已有内容、老用户升级时补进清单。 */
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, done } from './_check.mjs';

/** 建一个干净的 $DSH_HOME 并返回路径。 */
function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'soulseed-'));
  mkdirSync(join(home, 'rp-soul'), { recursive: true });
  return home;
}

/** 用 mock ctx 加载插件（只关心 section 是否注册，路由不测）。 */
async function boot(mod, config) {
  const ctx = {
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    inject() { /* 不注入 webServer：本测试只关心文件落地 */ },
    systemPrompt: {
      getSectionOrder() { return 100; },
      section() { return () => {}; },
    },
  };
  mod.apply(ctx, config);
  return ctx;
}

const mod = await import(new URL('../lib/index.js', import.meta.url).href);

// ---- 1. 全新安装：种子里没有的文件建空文件，角色档案也建 ----
const h1 = freshHome();
process.env.DSH_HOME = h1;
await boot(mod, { files: ['SOUL.md'] });
ok(existsSync(join(h1, 'SOUL.md')), '1. SOUL.md 被创建');
eq(statSync(join(h1, 'SOUL.md')).size, 0, '1. SOUL.md 是空文件');
ok(existsSync(join(h1, 'rp-soul', 'parts', '角色档案.md')), '1. 角色档案被创建');
eq(statSync(join(h1, 'rp-soul', 'parts', '角色档案.md')).size, 0, '1. 角色档案是空文件');
const store1 = JSON.parse(readFileSync(join(h1, 'rp-soul', 'config.json'), 'utf8'));
eq(store1.files, ['SOUL.md', 'rp-soul/parts/角色档案.md'], '1. 存储配置写入了两个种子');

// ---- 2. 已有内容绝不被覆盖 ----
const h2 = freshHome();
process.env.DSH_HOME = h2;
writeFileSync(join(h2, 'SOUL.md'), '你是老侦探。\n', 'utf8');
await boot(mod, { files: ['SOUL.md'] });
eq(readFileSync(join(h2, 'SOUL.md'), 'utf8'), '你是老侦探。\n', '2. 已有 SOUL.md 原样保留');
ok(existsSync(join(h2, 'rp-soul', 'parts', '角色档案.md')), '2. 缺少的角色档案仍被补建');

// ---- 3. 老用户：存储里已有 files，只追加新建的角色档案 ----
const h3 = freshHome();
process.env.DSH_HOME = h3;
writeFileSync(join(h3, 'SOUL.md'), '旧内容', 'utf8');
writeFileSync(join(h3, 'rp-soul', 'config.json'), JSON.stringify({ files: ['SOUL.md'], maxBytes: 4096 }), 'utf8');
await boot(mod, { files: ['SOUL.md'] });
const store3 = JSON.parse(readFileSync(join(h3, 'rp-soul', 'config.json'), 'utf8'));
eq(store3.files, ['SOUL.md', 'rp-soul/parts/角色档案.md'], '3. 角色档案被追加到清单末尾');
eq(store3.maxBytes, 4096, '3. 其它配置字段未被改动');

// ---- 4. 幂等：重复启动不重复追加、不重写文件 ----
await boot(mod, { files: ['SOUL.md'] });
const store4 = JSON.parse(readFileSync(join(h3, 'rp-soul', 'config.json'), 'utf8'));
eq(store4.files, ['SOUL.md', 'rp-soul/parts/角色档案.md'], '4. 二次启动清单不变');
eq(readFileSync(join(h3, 'rp-soul', 'parts', '角色档案.md'), 'utf8'), '', '4. 角色档案仍是空文件');

// ---- 5. cordis 里配多文件：全部落地 ----
const h5 = freshHome();
process.env.DSH_HOME = h5;
await boot(mod, { files: ['a.md', 'rp-soul/parts/b.md'] });
ok(existsSync(join(h5, 'a.md')), '5. a.md 被创建');
ok(existsSync(join(h5, 'rp-soul', 'parts', 'b.md')), '5. b.md 被创建');
const store5 = JSON.parse(readFileSync(join(h5, 'rp-soul', 'config.json'), 'utf8'));
eq(store5.files, ['a.md', 'rp-soul/parts/b.md', 'rp-soul/parts/角色档案.md'], '5. 清单 = 配置顺序 + 角色档案');

// ---- 6. 越界路径不建文件 ----
const h6 = freshHome();
process.env.DSH_HOME = h6;
await boot(mod, { files: ['../evil.md'] });
ok(!existsSync(join(h6, '..', 'evil.md')), '6. 越界路径不会在 DSH_HOME 外建文件');

done('seeds');
