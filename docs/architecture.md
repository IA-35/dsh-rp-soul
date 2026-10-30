# dsh-rp-soul 全景

一份读完就知道「这个插件由什么组成、一次对话里谁按什么顺序干了什么、数据存在哪」的文档。
细节设计另有三份：`docs/memory-design.md`（记忆 ABM/SCM/CLPA + 日记）、`docs/wake-line-design.md`（唤醒线）、
`docs/time-not-turns.md`（数句话→读时钟的改造方案，**已实施**：规则读时钟，不再数说了几句）。`turn` 字段仍在，只当流水号。

---

## 1. 它解决什么问题

DSH 原生只有 `AGENTS.md` / `CLAUDE.md` 这类「工作区指令」，以 user 角色提醒注入。
本插件补两块：

| 补什么 | 给谁 | 存在哪 |
|---|---|---|
| **人设成为真正的系统提示** | 模型的身份与口吻 | `$DSH_HOME` 下的若干 `.md` 拼接 |
| **一个会变的「她」**（情绪 / 关系 / 行动 / 记忆） | 由引擎按真实时间维护 | SQLite（`engine.db`）+ 一段 brief 注入 |

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
│   engine-bridge.js 三个工具 + 引擎调用 + 快照渲染            │
│   engine-client.js 常驻 Python 子进程（stdio JSON-lines）     │
│   wake.js         唤醒定时器 / 额度 / steer                  │
│   client.js       设置页（React，跑在 web 侧）               │
└───────────────┬──────────────────────────────────────────────┘
                │ stdin/stdout，一行一个 JSON
┌───────────────▼──────────────────────────────────────────────┐
│ 引擎层（Python ≥3.10，无第三方依赖，`python -m rp_soul_engine`）│
│   application/  命令表、事务、specs、导入导出                │
│   modules/      四个可替换职责（情绪 / 记忆 / 行动 / 唤醒）   │
│   domain/       纯函数：时钟、结算、提交、记忆、情绪、关系…   │
│   projections/  把状态渲染成 brief / full 上下文              │
│   persistence/  SQLite 读写                                  │
└──────────────────────────────────────────────────────────────┘
```

**为什么引擎是常驻子进程**：一次聊天会调几十次引擎，冷启动要重付 import 成本。
node 起一次、管道一直开着，除了 EOF / SIGTERM 什么都不杀它。

**为什么 domain 是纯函数**：可测、可重放、可存档回滚。开事务、碰数据库、写文件全在
application 层；`domain/` 里没有一处 `open()`。

---

## 3. 一次对话里发生了什么

顺序照抄 `lib/index.js:204` 的装配钩子和 `domain/turn.py:276` 的提交顺序。

### 3.1 装配（每条 LLM 请求之前）

```
宿主 assemble()
  ① 同步求值 systemPrompt.section("soul-persona")  → 拼人设文件（每字节恒定）
  ② 同步求值 systemPrompt.context("soul-engine")   → 上一次读到的快照
  ③ 跑到 rp-soul 的 assemble 钩子：
       await next()（让宿主先装配完）
       row.text = await bridge.preparePrompt(context)
                    └─ get-context(depth: brief)，超时 2500 ms
                    └─ 失败就沿用上一次快照，绝不阻塞对话
  ④ 宿主只在文本真的变了时，追加一条 user 角色的快照消息
```

**关键约束**：人设放 `section`（进系统提示词前缀），账本快照放**动态 context**（追加在末尾）。
理由只有一个——上下文缓存按整段前缀的字节哈希命中。账本每次都在变，放进 section 会让整段
前缀每次都作废；放进动态 context 后系统提示词恒定，每次新增的只有尾部几十字节。

### 3.2 一次对话（模型侧）

```
模型：读动态上下文末尾的「当前现状」（时间、心情、可能发生；宿主收不了时还有该交的总结）
      和「想起来的」（被这句话撞上的记忆、命中的常识、新会话第一轮的最近一篇日记）
      → 需要「下一步能做什么」的候选或别的细节时，才调 soul_state（brief；隔久了/新的一天/上一次被驳回用 full）
      → 写正文
      → soul_commit 交账
```
```
宿主：回合结束（agent/turn-stopping）→ note-turn 把这一问一答写进 ABM
      （模型这一轮交过账就跳过；记账失败不抛，绝不因此判这一轮出错）
      → 再问一次引擎「该收了没有」，满了就自己起一个子代理
      → 子代理（provider: spawn，全新的子 agent，不复制会话上下文）写回来，summarize-memory 落成一条 SCM
      → 欠着日记就再起一个写日记，write-diary 落盘
```

### 3.3 一次 soul_commit 在引擎内部

`domain/turn.py:276 commit_turn()`，**全有或全无**：任何一条操作不合法，整份提交作废，
调用方状态不动（工作副本丢弃）。

| # | 步骤 | 代码 |
|---|---|---|
| 1 | `replaces_turn`：先撤销被改写的那一次 | `_replace_base` |
| 2 | 记下本记录的请求（她昨天的总结 / 这个月的日记），交由**本记录第一项**支付 | `_apply_turn` 的 `undo_base` |
| 3 | **时钟按真实时间结算**（走完整的 settlement 五步） | `settlement.advance` |
| 4 | 按顺序应用操作（最多 40 条） | `OPS.apply_op` |
| 5 | 检查：离屏片段是否必填、break 档表达、动作模式、亲密标签、安全边界 | `_beat_checks` / `_mode_checks` / `_intimacy_checks` |
| 6 | 领域不变量校验 | `invariants.check` |
| 7 | 记账：对话流水、她的记忆（付请求 / 采这次 / 老化） | `MODULES.run(...)` |

`close_record` 在**一条记录的最后一项之后**跑一次，决定「下一条记录要什么」
（要不要交每日总结、要不要写月度日记）。

### 3.4 时间怎么走

```
state["real_at"]  上一次结算到的墙钟时刻（整分钟锚点）
now               这一次提交的真实时刻
span = now - real_at（整分钟，只前进不后退）
state["clock"]    故事时钟 {"day": N, "minute": M}，被 span 推着走
```

模型**不能**决定时间过了多久，也**不能**快进：没发生过的快进会结算还没到期的事件。

结算五步（`domain/settlement.py:120`）：

| 步 | 做什么 | 判据 |
|---|---|---|
| 1 | 时钟前移到真实时刻；**≥60 分钟算新的一段相处**（新 scene） | `SCENE_BREAK_MINUTES = 60` |
| 2 | 到期事件：过期 / 掷骰 / 伏笔浮出 | 按 `(due, id)` |
| 3 | 限时状况到期，情绪 thought 老化 | 一次时钟走完，只老一次 |
| 4 | 离屏：这段时间要模型补什么 | `tier_for(minutes)` |
| 5 | 给下一条记录的请求 | `simulation.finalize_requests` |

`tier_for`：`< 16 分钟` = routine，`16–59` = brief，`≥ 60` = full。**跨午夜本身不算间隔**
（23:50 说到 00:05 不是「隔了一小时」）。

---

## 4. 文件清单

### 4.1 Node 侧（`lib/`，5938 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.js` | 1123 | 插件入口：Config、种子文件、提示段注册、assemble 钩子、`/rp-soul` 全部路由 |
| `client.js` | 2323 | 设置页 React 组件，七个页签，跑在 web 侧（`dsh.client.platform = web`） |
| `engine-bridge.js` | 968 | 三个工具（`soul_state` / `soul_commit` / `soul_admin`）、引擎调用、快照文本渲染 |
| `engine-client.js` | 393 | 常驻子进程：探测 Python、spawn、请求-应答配对、超时、重启 |
| `persona-pack.js` | 579 | 手写 YAML 解析（约 250 行），把 markdown 人设解析成引擎认识的人设包 |
| `wake.js` | 552 | 唤醒线的运行侧：定时器、每日额度、steer 送达、失败退避 |

### 4.2 引擎侧（`engine/rp_soul_engine/`，10158 行）

| 目录 / 文件 | 行数 | 职责 |
|---|---|---|
| `application/service.py` | 1512 | 全部命令的实现；`session_write` 事务壳（revision 检查 + 幂等） |
| `application/specs.py` | 299 | 每个命令的输入 schema |
| `application/commands.py` | 81 | **唯一**命令表（31 条），懒加载处理函数 |
| `application/context.py` | 103 | 数据目录、DB 连接；写权限探测 |
| `application/transfer.py` | 243 | 导出 / 导入整局（带 sha256 校验） |
| `application/doctor.py` | 80 | 环境体检 + 首次初始化（幂等） |
| `modules/*.py` | 145 | 四个职责模块 + 固定注册表 `REGISTRY` |
| `domain/turn.py` | 391 | 提交主流程、commit schema |
| `domain/memories.py` | 662 | 她的记忆：ABM/SCM/CLPA、采集、衰减、打分、注入 |
| `domain/mood.py` | 383 | 心情条与行为门禁 |
| `domain/ops.py` | 857 | 12 个 op 的定义与实现 |
| `domain/ops_time.py` | 78 | `offscreen_beat`（离屏片段）单独放这里 |
| `domain/agency.py` | 257 | 她自己主动做什么：确定性候选 + 理由 |
| `domain/wake.py` | 234 | 什么时候该醒：纯函数，不改状态 |
| `domain/settlement.py` | 154 | 时间结算的五步固定顺序 |
| `domain/simulation.py` | 131 | 时间间隔、离屏请求、给下一条记录的请求 |
| `domain/facts.py` | 239 | 事实与知识边界（copy-on-write 视图） |
| `domain/common.py` | 156 | 常识库：关键词匹配、权重排序、渲染（全局共享，纯函数） |
| `domain/relationship.py` | 162 | 信任 / 张力 / 阶段，两条有向边 |
| `domain/invariants.py` | 102 | 提交后必须成立的硬规则 |
| `domain/structure.py` | 240 | 全部枚举与常量（单一来源） |
| `domain/state.py` | 126 | 状态字典的只读辅助 |
| `domain/clock.py` | 100 | 故事时钟 ↔ 绝对分钟 ↔ 墙钟 |
| `domain/text.py` | 149 | 关键词抽取与线索匹配 |
| `domain/meta.py` / `rng.py` | 216 | 元信息、确定性随机 |
| `projections/context.py` | 397 | 把状态渲染成 brief / full 两档上下文 |
| `persistence/db.py` | 480 | 建表、迁移（5 版）、备份 |
| `persistence/repo.py` | 700 | 会话 / 事实 / 存档 / 审计的读写 |
| `schema.py` | 338 | 极简 schema 校验器（自带构造器） |
| `jsonio.py` | 203 | 严格 JSON（拒重复键、NaN、孤立代理对、过深嵌套） |
| `errors.py` | 112 | 15 个稳定错误码 + 4 个退出码 |
| `migrate.py` | 226 | 旧存档（多角色时代）读成单人 |
| `persona.py` | 370 | 人设包校验与规范化 |
| `opening.py` | 140 | 开局：人设进，状态出 |
| `paths.py` | 76 | 数据目录、备份 / 导出 / 日记子目录 |
| `__main__.py` | 255 | stdio 主循环（也支持一次性命令） |

### 4.3 测试

| 位置 | 内容 |
|---|---|
| `engine/tests/test_*.py`（11 个，3342 行） | 引擎侧：clock / companion / game / memories / migrate / modules / mood_gates / persona / prompts / stdio / wake |
| `engine/tests/run_all.py` | 跑全部 Python 测试，输出 `N/N files passed` |
| `engine/tests/harness.py` / `fixture.py` | `check()` / `raises()` / 固定人设（林晚，31 岁夜班医生） |
| `test/*.mjs`（12 个） | Node 侧：http / routes / mount / prompt / schema-sync / seeds / wake / wake-lifecycle / client-bundle / engine / engine-http / `_check.mjs` |

---

## 5. 状态字典

一局的全部内容就是一棵 JSON 树（`opening.py:78`）：

| 键 | 内容 |
|---|---|
| `schema` / `revision` / `seed` | 存档格式版本、乐观锁版本号、随机种子 |
| `persona_id` / `persona_revision` / `persona_title` | 开局时的人设快照标识 |
| `mood_base` / `mood_thresholds` | 心情基准与三档阈值 |
| `player_id` | 永远 `"player"` |
| `turn` | 流水号（**只用于记账编号，不做决策**；规则一律读时钟） |
| `clock` | 故事时钟 `{"day","minute"}` |
| `real_start` / `real_at` | 开局墙钟（诊断用）/ 结算锚点 |
| `characters` | 两个角色卡（名字、称呼、年龄、性别、身份、外貌、语态、作息、心情 thoughts） |
| `relationships` | `{"her>player": {"trust","tension","stage"}}`，只写她这一侧 |
| `facts` | 事实表：谁知道 / 谁误信 / 可见性 / 来源 / 学到的时刻 `at` |
| `events` | 剧情事件（**与记忆层的 `events` 是两回事**） |
| `counters` | id 分配器、`major_action_turn`、`offscreen_beat_turn`、`scene` |
| `scene` | 当前这段相处：id / 在场者 / 开始时刻 / 本段的互动判定 |
| `plan` | 她自己定下的下一件事 |
| `memory` | `turns`（对话流水最近 40 条）、`entries`（ABM/SCM/CLPA 三层）、`open_action`、`last_quotes` |
| `preferences` | 离屏推演开关、节奏、尺度 |
| `safety` | 暂停状态、硬边界清单 |
| `requests` | 给下一次提交的请求（`memory_fold` / `memory_diary`） |
| `undo_floor` / `session_id` | 撤销下限、本会话 id |

> ⚠️ **命名陷阱**：`state["events"]` 是剧情事件，跟记忆层没有任何关系（记忆三层是 `abm` / `scm` / `clpa`）。
> 全局搜 `events` 时务必分清。

---

## 6. 四本账

### 6.1 记忆（`domain/memories.py`）

| 层 | 内部名 | 每小时衰减 | 容量 | 怎么离开 |
|---|---|---|---|---|
| ABM | `abm` | 不衰减 | 20 | 满 20 条或搁置 1 小时 → 宿主起的子代理收成一条进 SCM，本层清空；不重要的小动作 24 小时后直接丢 |
| SCM | `scm` | 0.005 | 50 | 约一个月淡光；满 50 淘汰最不活跃的；**绝不清空** |
| CLPA | `clpa` | 不衰减 | 不限 | 只有你手动删改 |
| 日记 | 落盘文件 | — | — | 每晚 23:30 把当天 SCM 写成 `journal/<session_id>/diary-<日>.md`，不删 SCM |

- **活跃度**：`a0 * (1 - rate) ** hours`，`a0` 是上次触碰时的值，`t0` 是那次时刻。
  不逐小时回写，读时现算，所以撤销 / 存档 / 导出天然一致。
- **被忘掉**：低于 `CLEAN_BELOW = 0.025` 且没 Pin。Pin 的不衰减、不清理、不占容量。
- **采集不花模型调用**：每次一条；有 `remember` 用她的第一人称，没有就用 `summary`。
- **打分**：时间远近 + 重要度 × 场景权重 + 关键词重合 + 层级加成 + Pin / 你改过 + 活跃度。
  **ABM 不进上下文**（对话本身已经在里面），只从 SCM / CLPA 里取：`brief` 3 条、`full` 5 条，低于 0.15 不要。
- **越想越牢**：被这句话勾起来的记忆活跃度 +0.1（上限 1.0）。

### 6.2 心情（`domain/mood.py`）

`mood = clamp(mood_base + Σ thoughts, 0, 100)`。每条 thought：
`{label ≤20字, delta -30..+15, kind, source_fact_id, since_turn, expires_at, decay}`。

- 引擎自己算**情境类**（你在 / 你不在 / 隔了一天以上才回来 / 事件到期 / 张力高 / 深夜打扰）
- 模型只能 `add_thought` 加**记忆类**，且必须挂到一个真实事实 id（不能凭空扣心情）
- 引擎自己写的记忆类只来自「你对她做了什么」：信任变化 ×3、阶段前进、事情搞砸
- **她自己选的回应不进她自己的心情**——否则「低落 → 冷回应 → 更低落」会一路滑进崩溃档
- 每角色最多 20 条（12 记忆 + 8 情境），按原始强度淘汰

档位只做**行为门禁**，不产生精神状态；按结算后、操作前的心情判定并冻结这一次：

| 档位 | 区间（默认） | 影响 |
|---|---|---|
| `open` | ≥ 75 | 允许阶段前进；`significant` 行动冷却 −1 |
| `normal` | 45–75 | 无额外约束 |
| `closed` | 25–45 | 驳回 `stage_advance`；`npc_response.note` ≤30 字 |
| `break` | < 25 | 同上；这次有简短回应或一种情绪表达即可，重大情绪表达不受冷却限制 |

### 6.3 关系（`domain/relationship.py`）

两条有向边 `"her>player"`。**只写她对你**的一面——你的心情不入库。

- 信任一次最多变 2（净变化），模型不能拆成两次小操作绕过
- 阶段前进要证据：这次你有实际行动（result/attempt）**且**她同时 `partial`/`genuine`
- 7 级：`stranger → acquainted → familiar → flirting → testing → intimate → committed`

### 6.4 自主行动（`domain/agency.py`）

引擎给 2–3 个**确定性候选**（不是让模型自由编），每个带理由和依据事实 id：
心情档位、张力、未结事件、她实际知道什么、此刻几点。

- 非崩溃档下 `significant: true` 的 `npc_action` **必须**取候选里的 `kind`
- 候选里的依据事实会对着她的信息集校验，她不能基于不知道的事行动
- 冷却 `ACTION_COOLDOWN_MINUTES = 20`（心情 open 时 10）：**按真实时间判**，连发三十句也不缩短她的下一次重大行动

### 6.5 唤醒（`domain/wake.py` + `lib/wake.js`）

**判断全在引擎**（纯函数、可测），**副作用全在 node**（定时器、额度、送达、退避）。

```
到点 → 额度检查 → agent.steer 一条【我的时间】消息进指定会话
     → 她在那个时段 together: false，过自己的时间，用 plan_next 说好下一步
     → 那一次结束再算下一次
```

五个理由：`plan`（她的安排）/ `promise`（你们的约定）/ `event`（她自己的事）/
`miss_you`（你久不说话）/ `routine`（作息换段）。安静时段 `00:00-08:00`，只有她自己的安排能穿透。

---

## 7. 12 个 op

只有两个角色，所以 op 里**不写是谁**——写的都是「她」。

| op | 干什么 | 关键约束 |
|---|---|---|
| `npc_response` | 她对你这回的回应 | `refuse/negotiate/partial/surface/genuine`；`surface` 必须写 `true_intent` |
| `npc_action` | 她主动做的事 | `significant: true` 受冷却 + 必须取 agency 候选的 kind |
| `npc_state` | 她的状况（醉酒、睡着、受伤、外出、忙） | 情绪不在这里改 |
| `add_thought` | 一条情绪事由 | 必须挂 `basis_fact_id` |
| `add_fact` | 新增事实 | `scope`：`shared`/`player_only`/`companion_only`/`inner` |
| `reveal_fact` | 让只有一方知道的事变双方都知道 | 你们必须在一起 |
| `relationship` | 信任 / 张力 / 阶段 | 一次信任 ±2；阶段前进要证据 |
| `event_create` | 约定、截止、风声、机会、伏笔 | 你们之间的约定要你本人授权 |
| `event_resolve` | 提前结束事件 | 概率事件只能引擎掷骰 |
| `event_cancel` | 因剧情取消 | — |
| `plan_next` | 她说好下一步做什么、做到几点 | `in_minutes` 或 `until` 二选一 |
| `offscreen_beat` | 你不在的这段时间她做了什么 | ≥16 分钟才能写；≥60 分钟或跨天必须写；子操作只能是她自己的 |

---

## 8. 三个工具（模型侧）

| 工具 | 什么时候用 |
|---|---|
| `soul_state` | 读这局的工作指令（`agency` / `due_soon` / `known_facts` / `her_knows` / 总结请求）。`depth: brief`（~6 KB）/ `full`（~20 KB，隔久了/新的一天/上一次被驳回）；`want_twist` 要转折。心情、常识跟「当前局面」一起每轮自动注入，不从这里取；记忆只有被这句话撞上的才自动注入，其余几条在这里 |
| `soul_commit` | 写完正文后交账。`operations` 最多 40 条；`summary` ≤120 字；`remember` ≤60 字（她第一人称怎么记）；引擎要把 ABM 收进 SCM 时带 `memory_fold`（≤300 字）、该写日记时带 `memory_diary`（≤300 字）；`memory_keep` 挑 0–2 条进 CLPA |
| `soul_admin` | 14 个 action：`start` / `status` / `undo` / `save` / `load` / `list` / `delete` / `set_safety` / `set_preferences` / `export` / `import` / `mood_panel` / `drop_thought` / `reset_mapping` |

**驳回规则**：带 `path` 与原因，模型最多重试 2 次；两次都不行就改正文，不要绕过。

---

## 9. 引擎 31 个命令

`application/commands.py` 是唯一来源，`{ "id": "c1", "command": "...", "payload": {...} }` 一行一个。

| 分类 | 命令 |
|---|---|
| 诊断 | `doctor` `version` `list-commands` |
| 人设 | `check-persona` `preview-persona` `new-game` |
| 会话 | `get-context` `commit-turn` `undo-turn` `list-sessions` |
| 存档 | `save-slot` `load-slot` `list-slots` `delete-slot` `export-save` `import-save` |
| 设置 | `set-boundary` `set-safety` `set-preferences` `status` `next-wake` |
| 情绪 | `debug-mood` `debug-moods` `debug-delete-thought` |
| 记忆 | `debug-memories` `edit-memory` `delete-memory` `request-memory` |
| 行动 / 事实 | `debug-activity` `debug-facts` `delete-fact` |

**写命令的固定壳**（`service.py:96 session_write`）：
`begin_write → 幂等查重 → 读会话 → 检查 revision（不等则 `STALE_REVISION`）→ 处理 → 记幂等 → COMMIT`。
锁冲突抛 `STORAGE_BUSY`。

**15 个稳定错误码**：`INVALID_INPUT` `STALE_REVISION` `IDEMPOTENCY_CONFLICT` `INVARIANT_VIOLATION`
`SAFETY_BLOCK` `CONTENT_ERROR` `NOT_FOUND` `SLOT_CONFLICT` `UNSUPPORTED_VERSION`
`RUNTIME_UNSUPPORTED` `DATA_DIR_UNAVAILABLE` `STORAGE_BUSY` `NO_MATCH` `MIGRATION_FAILED` `INTERNAL_ERROR`。

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
│   ├── engine-sessions.json            # 作用域键 → 引擎局 id 的映射
│   ├── wake.json / wake.md             # 唤醒状态与提示词模板
│   └── engine/                         # ← 引擎数据目录
│       ├── engine.db                   # SQLite：会话、事实、日志、存档、撤销点
│       ├── backups/                    # 迁移前自动备份
│       ├── exports/                    # 导出
│       ├── journal/                    # 她的日记：<session_id>/diary-<日>.md
│       └── logs/                       # 内部错误
```

**数据目录永不放在插件目录里**——升级会覆盖。node 每次都显式传 `--data-dir`。

SQLite 15 张表：`meta` `sessions` `facts` `fact_journal` `turn_log` `undo_points` `idempotency`
`archive` `slots` `slot_facts` `slot_archive` `commit_failures` `thought_debug` `memory_debug` `common`。
（`DB_SCHEMA_VERSION = 5`，`STATE_SCHEMA_VERSION = 3`。）

`common` 是常识库：全局一张表，不挂 `session_id`——所有会话共用一个库。
每次注入几条存在 `meta` 的 `common_limit` 里，所以它也跟着是全局的。

---

## 13. 配置项

`cordis.patch.yml` 的 `config` 只是**首装种子**；设置页保存后写 `rp-soul/config.json`，此后以它为准。

人设相关：`files` `fileName` `separator` `annotate` `maxBytes` `storeFile` `title` `personaId`
引擎相关：`engineEnabled` `engineScope`(`global`|`session`) `engineDataDir` `engineTimeoutMs` `engineSessions`
唤醒相关：`wakeEnabled` `wakeSessionId` `wakeDailyLimit` `wakeDailyTokens` `wakeQuiet` `wakeMissYou` `wakeRoutine`

---

## 14. 六条硬规则（改代码前必读）

1. **人设进 `section`，账本进 `context`**。把账本挪进 section = 每次重刷几十 K token 的前缀缓存。
2. **时间不归模型**。`real_at` 是唯一锚点；离开多久由墙钟算，不是模型写的。
3. **`state["events"]`（剧情事件）≠ 记忆层名**。记忆三层是 `abm` / `scm` / `clpa`，绝不可全局替换。
4. **domain 层是纯函数**。要写文件、开事务、碰 DB，一律在 application 层。
5. **提交全有或全无**。校验不过就整份丢弃，绝不做「部分生效」。
6. **她是活人不是状态机**。心情低 ≠ 敌意；她的回应不进她自己的心情；自主行动必须有事实依据。

---

## 15. 已知未做

| 项 | 状态 |
|---|---|
| 日记 `.md` 的检索注入（按关键词翻日记并进上下文） | 只写不读 |
| 旧存档里 `temp/days` 并进 SCM 后活跃度没重算 | 会带着老值开始淡 |
| 设置页不再展示剧情事实（`facts`） | 引擎内部照用，`/engine/facts` 路由还在 |

---

## 16. 怎么跑起来

```bash
# 装
dsh plugin add dsh-rp-soul

# 引擎自测（在 engine/ 下）
python -m rp_soul_engine <<< '{"id":"c1","command":"doctor"}'
python tests/run_all.py          # 期望 "12/12 files passed"
```

设置页引擎卡显示「就绪」+ Python 版本，让模型 `soul_admin start` 后能看到这一局。
改引擎或插件都要**重启 DSH** 才生效（提示词热更新只对人设文件有效）。
