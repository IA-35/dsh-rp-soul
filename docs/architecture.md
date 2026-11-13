# dsh-rp-soul 全景

一份读完就知道「这个插件由什么组成、一次对话里谁按什么顺序干了什么、数据存在哪」的文档。
细节设计在 `docs/engine-js-design.md`（现行引擎）；`docs/memory-design.md`（记忆 ABM/SCM/CLPA）、
`docs/wake-line-design.md`（唤醒线）、`docs/time-not-turns.md`（数句话→读时钟）三份是重写前的设计，语义还成立，实现细节以代码为准。

> **2026-11-13 起引擎换成了进程内的 JS 版**（`lib/engine/`，`node:sqlite`）。Python 侧车那一套
> （`engine/`、`engine-client.js`、`engine-bridge.js`、`engine.db`、stdio 命令表）已经删干净；
> 这份全景也已按新引擎重写，旧形态只在 `docs/memory-design.md` 那几份历史设计里还能看到。

---

## 1. 它解决什么问题

DSH 原生只有 `AGENTS.md` / `CLAUDE.md` 这类「工作区指令」，以 user 角色提醒注入。
本插件补两块：

| 补什么 | 给谁 | 存在哪 |
|---|---|---|
| **人设成为真正的系统提示** | 模型的身份与口吻 | `$DSH_HOME` 下的若干 `.md` 拼接 |
| **一个会变的「她」**（情绪 / 关系 / 行动 / 记忆） | 由引擎按真实时间维护 | SQLite（`engine-v2.db`）+ 一段 brief 注入 |

只有两个角色：**你**（`player`）和**她**（`companion`）。没有配角、没有地图、没有世界观包。

---

## 2. 三层结构

```
┌──────────────────────────────────────────────────────────────┐
│ DSH 宿主                                                     │
│   systemPrompt（section / context）、tools、webServer        │
└───────────────┬──────────────────────────────┬───────────────┘
                │ 人设文本 + 动态 context       │ HTTP /rp-soul/*（设置页）
┌───────────────▼──────────────────────────────▼───────────────┐
│ 插件层（Node，lib/*.js）                                     │
│   index.js        注册提示段 / 路由 / 装配钩子 / 种子文件    │
│   persona-pack.js 手写 YAML 解析 → 人设包                    │
│   engine-v2-bridge.js 三个工具 + 引擎调用 + 快照渲染         │
│   engine-v2-memory.js 起子代理收 SCM / 写日记                │
│   wake.js         唤醒定时器 / 额度 / steer                  │
│   client.js       设置页（React，跑在 web 侧）               │
└───────────────┬──────────────────────────────────────────────┘
                │ 同一个进程，直接调函数
┌───────────────▼──────────────────────────────────────────────┐
│ 引擎层（Node ≥24.12，进程内，`lib/engine/`）                 │
│   core/       内核：真实时间、事实、事件、revision、校验      │
│   modules/    四个可开关模块（情绪 / 唤醒 / 常识 / 记忆）     │
│   store.js    SQLite（`node:sqlite`）读写，一个文件           │
│   index.js    对外 API：context / commit / panel / undo …     │
└──────────────────────────────────────────────────────────────┘
```

**为什么模块是纯函数**：可测、可重放、可存档回滚。开事务、碰数据库、写文件全在
`store.js` 和 `index.js`；`modules/` 里没有一处碰库。

---

## 3. 一次对话里发生了什么

顺序照抄 `lib/index.js` 的装配钩子和 `lib/engine/core/commit.js` 的提交顺序。

### 3.1 装配（每条 LLM 请求之前）

```
宿主 assemble()
  ① 同步求值 systemPrompt.section("soul-persona")  → 拼人设文件（每字节恒定）
  ② 同步求值 systemPrompt.context("soul-engine")   → 上一次读到的快照
  ③ 跑到 rp-soul 的 assemble 钩子：
       await next()（让宿主先装配完）
       row.text = await bridge.preparePrompt(context)
                    └─ 直接读库（进程内），拿到 context() 的 lines
                    └─ 失败就沿用上一次快照，绝不阻塞对话
  ④ 宿主只在文本真的变了时，追加一条 user 角色的快照消息
```

**关键约束**：人设放 `section`（进系统提示词前缀），账本快照放**动态 context**（追加在末尾）。
理由只有一个——上下文缓存按整段前缀的字节哈希命中。账本每次都在变，放进 section 会让整段
前缀每次都作废；放进动态 context 后系统提示词恒定，每次新增的只有尾部几十字节。

### 3.2 一次对话（模型侧）

```
模型：读动态上下文末尾的「当前现状」（时间、心情、最近的想法、可能发生）
      和「想起来的」（被这句话撞上的记忆、命中的常识、新会话第一轮的最近一篇日记）
      → 要看更细的局面（谁知道什么、有哪些约定、还没兑现的事）时才调 soul_state
      → 写正文
      → soul_commit 交账
```
```
宿主：回合结束（agent/turn-stopping）→ note-turn 只做一件事：给被勾起的那条记忆加一点活跃度
      （交账由她自己在正文之后用 soul_commit 完成，宿主不再替她记原文）
      → 再问一次引擎「该收了没有」，满了就自己起一个子代理
      → 子代理（provider: spawn，全新的子 agent，不复制会话上下文）写回来，applyFold 落成一条 SCM
      → 欠着日记就再起一个写日记，applyDiary 落盘
```

### 3.3 一次 soul_commit 在引擎内部

`lib/engine/core/commit.js commit()`，**全有或全无**：任何一条不合法，整份提交作废，
账本不动，回执里带 `problems`。

| # | 步骤 | 代码 |
|---|---|---|
| 1 | 校验 revision（对不上直接 `stale`） | `store.commit` 的乐观锁 |
| 2 | 全量校验：内核 + 每个开着的模块，问题一起报 | `S.validate` / `F.validate` / `E.validate` / `H.validate` / `mod.validate` |
| 3 | 应用：内核先，模块按登记顺序 | `commit()` 里逐个 `mod.apply` |
| 4 | 分发信号（`ctx.emit`），模块之间不直接调用 | `R.dispatch` |
| 5 | 每个模块 `tidy`（清过期、衰减、维护容量） | `mod.tidy` |
| 6 | 写快照 + 写账本 + 记流水，一个事务 | `store.commit` |
| 7 | revision + 1 | 同上 |

`memoryDue()` 在**每次交账之后**跑，决定「下一条要收什么」
（要不要把 ABM 收成一条 SCM、要不要写今天的日记）。

### 3.4 时间怎么走

**没有游戏时钟，也没有回合号在参与计算**：一切都是真实墙钟。一次交账发生在 `now`，
离上一次 `last_commit_at` 隔了多久，模块按 `T.minutesBetween()` 自己算。

| 谁 | 拿时间做什么 | 判据 |
|---|---|---|
| `wake` | 离上次交账 ≥60 分钟就要写一句 `away` | `AWAY_MINUTES = 60` |
| `mood` | 心事按分钟线性变淡；离得很久记成 `back_at` | `weightOf` / `DAY` |
| `memory` | ABM 搁 1 小时收 SCM；每天 23:30 之后写日记 | `IDLE_MINUTES = 60` / `DIARY_MINUTE = 23*60+30` |
| `core/events` | 约定到期、过期；30 天后清掉 | `status()` / `KEEP_DAYS = 30` |
| `core/context` | 「快到了」24 小时内提醒 | `DUE_SOON_MINUTES = 24*60` |

模型**不能**决定时间过了多久：交账表里没有「过了多久」这个字段，它只能写「发生了什么」。

---

## 4. 文件清单

### 4.1 Node 侧（`lib/`）

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.js` | 1395 | 插件入口：Config、种子文件、提示段注册、assemble 钩子、`/rp-soul` 全部路由 |
| `client.js` | 2619 | 设置页 React 组件，七个页签，跑在 web 侧（`dsh.client.platform = web`） |
| `engine-v2-bridge.js` | 483 | 三个工具（`soul_state` / `soul_commit` / `soul_admin`）、引擎调用、快照文本渲染 |
| `engine-v2-memory.js` | 272 | 记忆的宿主那一半：起子代理收 SCM、写日记 |
| `engine-v2-settings.js` | 138 | 设置页那些命令（常识库、记忆、自主行动记录、人设预览） |
| `persona-pack.js` | 579 | 手写 YAML 解析（约 250 行），把 markdown 人设解析成引擎认识的人设包 |
| `wake.js` | 552 | 唤醒线的运行侧：定时器、每日额度、steer 送达、失败退避 |

### 4.2 引擎侧（`lib/engine/`）

| 目录 / 文件 | 职责 |
|---|---|
| `index.js` | 对外 API：`start` / `context` / `commit` / `panel` / `undo` / `nextWake` / `recall` / 存档 / `importV1` / `spec` |
| `store.js` | 唯一认识 SQLite 的地方：六张表（ledger / snapshots / log / slots / common / meta），WAL，一次交账一个事务 |
| `import-v1.js` | 只读旧 Python 引擎的 `engine.db`，转成新库的账本（`readV1` / `convertV1` / `compareV1`） |
| `core/commit.js` | 一次交账：全量校验 → 全有或全无 → 分发信号 → 各模块 tidy → revision + 1 |
| `core/registry.js` | 模块注册表：开关、依赖、字段撞名检查、`ctx.ask` / `ctx.emit` |
| `core/schema.js` | 极简 schema 校验器与工具描述生成（`fields` / `guide` / `json`） |
| `core/context.js` | 把状态渲染成快照那几行（时间、作息、悬念、到期、各模块 project） |
| `core/time.js` | 真实墙钟、时段分桶、相对时间措辞 |
| `core/events.js` / `facts.js` / `her.js` | 约定与自己的事、事实四归属、她的条件与在场 |
| `modules/mood/` | `index.js` 交账表与快照；`thoughts.js` 心事与档位；`bond.js` 关系阶段；`agency.js` 自主行动候选 |
| `modules/memory/` | `index.js` 交账表与快照；`layers.js` 三层记忆；`recall.js` 想起来 |
| `modules/common/` | 常识库：关键词命中、权重排序、渲染 |
| `modules/wake/` | 什么时候该醒；`schedule.js` 排下一次 |

### 4.3 测试

| 位置 | 内容 |
|---|---|
| `test/v2-*.mjs`（9 个） | 新引擎：core / store / time / mood / wake / memory / common / bridge / import |
| `test/*.mjs`（其余 9 个） | 插件外壳：http / routes / mount / preset / prompt / client-bundle / wake / wake-lifecycle / snapshot-compact |
| `test/_check.mjs` | 断言库（`eq` / `ok` / `has` / `hasNot` / `between` / `done`） |
| `test/tools/import-v1-check.mjs` | 手工跑：拿一份旧 `engine.db` 试导入，先看会导进什么 |

---

## 5. 账本结构

一局的全部内容就是一棵 JSON 树（`lib/engine/core/commit.js` 的 `newLedger`）：

| 键 | 内容 |
|---|---|
| `v` | 账本格式版本（`LEDGER_VERSION = 1`） |
| `persona` | `{id, revision}`：开局时那份人设的标识，人设改了不自动作废账本 |
| `revision` | 乐观锁版本号，每次交账 + 1 |
| `started_at` / `last_commit_at` | 开局时刻 / 上一次交账时刻（都是真实墙钟 ISO） |
| `her` | `{name, conditions: []}`：她的名字与限时状况（醉了、睡了、受伤…） |
| `you` | `{name, last_said_at}`：你怎么称呼她、你最后一次真正说话的时刻 |
| `facts` | 事实表：`shared` / `you` / `her` / `inner` 四种归属，带 `retcon` |
| `events` | 约定与她自己的事（`promise` / `task`），到期、兑现、取消 |
| `next` | 各类 id 分配器 |
| `scene` | 这段相处：什么时候开始的、她回应过几次 |
| `log` | 最近 40 条交账摘要（设置页「自主行动记录」读的就是它） |
| `safety` | 暂停状态、硬边界清单 |
| `prefs` | 节奏、尺度 |
| `modules` | **四个模块各自的切片**，这是账本里最大的部分：`mood` / `wake` / `common` / `memory` |

> 模块切片归模块自己管，内核不解释它们。关掉某个模块时它的切片仍在（以后打开还能用），
> 只是不再参与校验、应用和投影。

---

## 6. 四本账

### 6.1 记忆（`lib/engine/modules/memory/`）

| 层 | 内部名 | 每小时衰减 | 容量 | 怎么离开 |
|---|---|---|---|---|
| ABM | `abm` | 不衰减 | 20 | 满 20 条或搁置 1 小时 → 宿主起的子代理收成一条进 SCM，本层清空；不重要的小动作 24 小时后直接丢 |
| SCM | `scm` | 0.005 | 50 | 约一个月淡光；满 50 淘汰最不活跃的；**绝不清空** |
| CLPA | `clpa` | 不衰减 | 不限 | 只有你手动删改 |
| 日记 | 落盘文件 | — | — | 每晚 23:30 把当天 SCM 写成 `rp-soul/memory/diary-<日>.md`，不删 SCM |

- **活跃度**：`a0 * (1 - rate) ** hours`，`a0` 是上次触碰时的值，`t0` 是那次时刻。
  不逐小时回写，读时现算，所以撤销 / 存档 / 导出天然一致。
- **被忘掉**：低于 `CLEAN_BELOW = 0.025` 且没 Pin。Pin 的不衰减、不清理。
- **采集靠她自己**：交账时填 `remember`（≤160 字、第一人称）就落一条 ABM，不填就不记。
  离屏片段与她一个人的那几次另记成 `experience`。
- **打分**：时间远近 + 重要度 × 场景权重 + 关键词重合 + 层级加成 + Pin / 你改过 + 活跃度。
  **ABM 不进上下文**（对话本身已经在里面），只从 SCM / CLPA 里取：`brief` 3 条、`full` 5 条，低于 0.15 不要。
- **越想越牢**：被这句话勾起来的记忆活跃度 +0.1（上限 1.0）。

### 6.2 心情（`lib/engine/modules/mood/`）

`value = clamp(base + Σ thoughts, 0, 100)`。每条 thought：
`{label ≤20字, delta -30..+15, kind, since, expires_at}`。

- 引擎自己算**情境类**（你在 / 你不在 / 隔了一天以上才回来 / 约定到期 / 张力高 / 深夜）
- 模型只能写 `feel` 加**记忆类**，每条都要有来由（`because`），不能凭空扣心情
- 引擎自己写的只来自「你对她做了什么」：信任变化 ×3、阶段前进、她做了一件大事
- **她的回应不进她自己的心情**——否则「低落 → 冷回应 → 更低落」会一路滑进崩溃档
- 最多 12 条（`STORED_CAP`），按原始强度淘汰

档位只做**行为门禁 + 一句说话的尺度**，不产生精神状态：

| 档位 | 区间（默认） | 影响 |
|---|---|---|
| `open` | ≥ 75 | 允许阶段前进；`significant` 行动冷却 −1 |
| `normal` | 45–75 | 无额外约束 |
| `closed` | 25–45 | 不接受 `stage_advance` |
| `break` | < 25 | 同上；这次有简短回应或一种情绪表达即可，重大情绪表达不受冷却限制 |

### 6.3 关系（`lib/engine/modules/mood/bond.js`）

只有**她对你**的一面——你的心情不入库。

- 信任一次最多变 2，模型不能拆成两次小操作绕过
- 阶段前进要证据：她这一次是配合的（`partial` / `genuine`），心情低落时不接受
- 7 级：`stranger → acquainted → familiar → flirting → testing → intimate → committed`

### 6.4 自主行动（`lib/engine/modules/mood/agency.js`）

引擎给最多 3 个**确定性候选**（不是让模型自由编），每个带理由和依据：
心情档位、张力、未结的事、她实际知道什么、此刻几点。

- 非崩溃档下 `significant: true` 的行动**必须**取候选里的 `kind`
- 冷却 `COOLDOWN = 20` 分钟（心情 open 时 10）：**按真实时间判**，连发三十句也不缩短她的下一次重大行动

### 6.5 唤醒（`lib/engine/modules/wake/` + `lib/wake.js`）

**判断全在引擎**（纯函数、可测），**副作用全在 node**（定时器、额度、送达、退避）。

```
到点 → 额度检查 → agent.steer 一条【我的时间】消息进指定会话
     → 她在那个时段 together: false，过自己的时间，用 plan 说好下一步
     → 那一次结束再算下一次
```

五个理由：`plan`（她的安排）/ `promise`（你们的约定）/ `event`（她自己的事）/
`miss_you`（你久不说话）/ `routine`（作息换段）。安静时段 `00:00-08:00`，只有她自己的安排能穿透。

---

## 7. 交账表

v2 没有「操作列表」这一层：交账就是**一张表单**，字段由开着的模块拼出来，
内核那部分是固定的十条 `CORE_FIELDS`。

| 字段 | 归属 | 干什么 | 关键约束 |
|---|---|---|---|
| `summary` | 内核 | 这一轮发生了什么 | ≤120 字，**必填** |
| `her` | 内核 | 她的名字与状况（醉了、睡着、受伤、外出、忙） | 情绪不在这里改 |
| `learned` | 内核 | 新知道的事 | 每项 `{key≤60, text≤120, who, retcon}`，最多 6 条；`who` 是 `shared`/`you`/`her`/`inner` |
| `reveal` | 内核 | 让只有一方知道的事变双方都知道 | 最多 6 条 |
| `promise` | 内核 | 约定 / 她自己要做的事 | 你不在场时只能立 `kind: task` |
| `open` | 内核 | 悬而未决的一件事 | ≤80 字 |
| `quotes` | 内核 | 这一轮值得留着的话 | ≤80 字 × 3 条；会被并进那一条记忆 |
| `tags` | 内核 | 分类 | — |
| `consent` | 内核 | 边界确认 | 安全边界只能你本人改 |
| `feel` | mood | 一条情绪事由 | 每项 `{label≤20, delta -30..+15, because≤120, minutes}`，最多 4 条；`because` 必填 |
| `bond` | mood | 信任 / 张力 / 阶段 | 一次信任 ±2；阶段前进要她这一次是配合的 |
| `act` | mood | 她主动做的事 | `significant: true` 受冷却 + 必须取 agency 候选的 kind |
| `plan` | wake | 她说好下一步做什么、做到几点 | `note ≤40 字`必填；`in_minutes` 或 `until` 二选一 |
| `away` | wake | 你不在的这段时间她做了什么 | ≤120 字；离上次交账 ≥60 分钟就必须写 |
| `common` | common | 新常识 | 先挂「待确认」，你确认才生效 |
| `remember` | memory | 这一轮她想记住的一两句 | ≤160 字、第一人称；**不写就不记** |

**驳回规则**：一次交账要么全落、要么全不落；回执带 `problems`（`path` + `reason` + `hint`）与 `retry_hint`，
模型最多重试 2 次；两次都不行就改正文，不要绕过。

---

## 8. 三个工具（模型侧）

| 工具 | 什么时候用 |
|---|---|
| `soul_state` | 读详细局面（`known_facts` / `her_knows` / `events` / `open`）。快照里已经有「时间 / 心情 / 想法 / 可能发生」，要更多细节时才调它 |
| `soul_commit` | 写完正文后交账。字段见上一节，由开着的模块动态生成 |
| `soul_admin` | `start` / `status` / `undo` / `log` / `save` / `load` / `list` / `delete` / `export` / `pause` / `resume` / `import` 十二个 action |

---

## 9. 设置页调引擎的命令

设置页要什么，桥接层直接查库，
只有少数几条走 `bridge.call(command, payload)`（`lib/engine-v2-settings.js` 的 `settingsCommands`）：

| 分类 | 命令 |
|---|---|
| 常识 | `debug-common` `add-common` `edit-common` `delete-common` `approve-common` `set-common-limit` |
| 记录 | `debug-activity` |
| 记忆 | `debug-memories` `edit-memory` `delete-memory` `request-memory` |
| 人设 | `preview-persona` |
| 其它 | `next-wake` `debug-moods` `debug-mood` `debug-delete-thought` |

不在这张表里的命令一律抛 `NOT_YET`（「新引擎还不支持这一项」）。

**写命令的壳**：`store.commit()` 的乐观锁——revision 对不上抛 `stale`，整份作废；
Node 的 `node:sqlite` 同步写，一个事务落地。没有幂等表，也没有 `STORAGE_BUSY`：
进程内只有一条写路径。

---

## 10. 设置页七个页签

`设置 →「角色人设」`，页签只影响界面，不影响数据。

| 页签 | 读什么 | 能改什么 |
|---|---|---|
| 人设提示词 | `files` 清单 + 各文件元信息 + 合成预览 | 增删文件、调顺序、编辑正文、分隔符、字节上限、总开关 |
| 引擎人设 | `rp-soul/persona.md` | id / 标题 / 阈值 / 名字 / 称呼 / 年龄 / 性别 / 开局态度 / 身份 / 外貌 / 表里两层语态 / 作息表；可「看 YAML」「校验」 |
| 情绪 | 她的心情面板 + 阈值 + 删除审计 | 每条 thought 右侧 `×` 手动删（留审计） |
| 记忆 | ABM / SCM / CLPA 三层 + 待交的汇总 / 日记 + 删除审计 | 改内容 / 重要度 / 活跃度 / 关键词 / 备注 / Pin；删（留审计）；「立即汇总」「立即写日记」 |
| 常识库 | 全局的「关键词 + 权重 + 常识」表（`common` 表，不挂会话） | 加 / 改 / 删；每次注入几条（2~4） |
| 自主行动记录 | 最近 1–50 次的行动、离屏片段、关系变化 | 只读 |
| 唤醒 | 唤醒配置 + 定时器状态 + 可指定会话 | 总开关 / 目标会话 / 每日次数 / 每日 token / 安静时段 / 想你阈值 |

---

## 11. HTTP 路由

前缀 `/rp-soul`（`ctx.webServer.register({kind:'prefix'})`）。
**所有请求先过 `connection.requestRejection()` 信任栅栏**；缺 `connection` 服务时 503 fail closed
（否则等于暴露一组无鉴权的读写文件接口）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/state` | 快照：配置 + 文件元信息 + 库列表 + 合成预览 |
| GET / PUT | `/file?rel=` | 读 / 写单个文件 |
| POST | `/new` | 新建文件 |
| GET / POST | `/config` | 读 / 写生效配置 |
| GET | `/engine` | 引擎健康 + 人设摘要 + 当前这一局 |
| GET | `/engine/persona` | 用真引擎校验人设 |
| GET | `/engine/persona-file` | 读 `persona.md` 原文 / 表单 |
| GET | `/engine/session` | 读该局上下文（`depth=brief\|full`） |
| GET | `/engine/mood` `/engine/moods` | 心情面板 |
| GET | `/engine/memories` | ABM / SCM / CLPA 三层 + 请求 + 审计 |
| PUT / DELETE | `/engine/memory` | 改 / 删一条记忆 |
| POST | `/engine/memory/request` | 立即汇总 / 立即写日记 |
| DELETE | `/engine/thought` | 手动删一条情绪 |
| GET / POST | `/engine/common` | 常识库：读全部 / 加一条 |
| PUT / DELETE | `/engine/common` | 改 / 删一条 |
| PUT | `/engine/common/limit` | 每次注入几条 |
| GET / DELETE | `/engine/facts` | 剧情事实（旧页面，已不从设置页进入） |
| GET | `/engine/activity` | 自主行动记录 |
| GET / POST | `/wake` | 唤醒配置 |
| POST | `/wake/now` | 现在叫醒一次 |

状态码：400 参数不合法 / 413 请求体超 1 MiB / 503 缺信任栅栏 / 401·403 被栅栏拦下。

---

## 12. 数据文件在哪

```
$DSH_HOME/                              # 默认 C:\Users\<你>\.dsh\
├── SOUL.md                             # 人设（种子，可换成任何 .md）
├── rp-soul/
│   ├── config.json                     # 设置页保存的配置（优先级高于 cordis.patch.yml）
│   ├── persona.md                      # 引擎人设（结构化 YAML）
│   ├── parts/角色档案.md                # 首装自动建的空文件
│   ├── preset.md                       # 单文件预设（改它比改 SOUL.md 方便）
│   ├── wake.json / wake.md             # 唤醒状态与提示词模板
│   ├── memory/                         # 她的日记：diary-<日>.md
│   └── engine/                         # ← 引擎数据目录
│       ├── engine-v2.db                # SQLite：账本、快照、流水、存档、常识、meta
│       ├── exports/                    # 导出
│       └── engine.db                   # 旧 Python 引擎的库，导入完就留着不动
```

**数据目录永不放在插件目录里**——升级会覆盖。

SQLite 六张表：`ledger` `snapshots` `log` `slots` `common` `meta`。
（`STORE_VERSION = 1`；`SNAPSHOT_KEEP = 30`、`LOG_KEEP = 2000`。）

`common` 是常识库：全局一张表，不挂会话——所有会话共用一个库。
每次注入几条存在 `meta` 的 `common_limit` 里，所以它也跟着是全局的。

---

## 13. 配置项

`cordis.patch.yml` 的 `config` 只是**首装种子**；设置页保存后写 `rp-soul/config.json`，此后以它为准。

人设相关：`files` `fileName` `separator` `annotate` `maxBytes` `storeFile` `title` `personaId`
引擎相关：`engineEnabled` `engineScope`（保留键，目前恒 `global`）`engineDataDir`
唤醒相关：`wakeEnabled` `wakeSessionId` `wakeDailyLimit` `wakeDailyTokens` `wakeQuiet` `wakeMissYou` `wakeRoutine`

模块开关不进 Config，存在 `config.json` 的 `modules` 里（`{mood:true, wake:true, common:true, memory:true}`）。

---

## 14. 六条硬规则（改代码前必读）

1. **人设进 `section`，账本进 `context`**。把账本挪进 section = 每次重刷几十 K token 的前缀缓存。
2. **时间不归模型**。`last_commit_at` 是唯一锚点；离开多久由墙钟算，不是模型写的。
3. **`events` 是约定，不是记忆层名**。记忆三层是 `abm` / `scm` / `clpa`，绝不可全局替换。
4. **模块是纯函数**。要写库、起子代理、碰文件系统，一律在桥接层（`engine-v2-bridge.js` / `engine-v2-memory.js`）。
5. **提交全有或全无**。校验不过就整份丢弃，绝不做「部分生效」。
6. **她是活人不是状态机**。心情低 ≠ 敌意；她的回应不进她自己的心情；自主行动必须有事实依据。

---

## 15. 已知未做

| 项 | 状态 |
|---|---|
| 日记 `.md` 的检索注入（按关键词翻日记并进上下文） | 只写不读 |
| 长期输入里「她在做什么」的处境注入（借鉴 dsh-longing 的三层：数值选档 / 处境拼句 / 自述指令） | 只做过可行性分析，未动手 |
| 设置页不再展示剧情事实 | 引擎内部照用，`/engine/facts` 直接答「还不支持」 |

---

## 16. 怎么跑起来

```bash
# 装（要求 Node ≥ 24.12，引擎用 node:sqlite，不用装 Python）
dsh plugin add dsh-rp-soul

# 自测（在插件目录下）
node test/v2-core.mjs            # 内核：时间、校验、全有或全无
node test/v2-bridge.mjs          # 三个工具 + 快照 + 设置页路由
```

设置页引擎卡显示「在进程内直接读写」与数据目录，让模型 `soul_admin start` 后能看到这一局。
改引擎或插件都要**重启 DSH** 才生效（提示词热更新只对人设文件有效）。
