# dsh-rp-soul

用 `$DSH_HOME` 下的**若干个文本文件**拼出 **DSH 系统提示人设**（persona）的插件
（Runtime-Persona Soul loader），带**设置页可视化编辑器**。

DSH 原生只把 `AGENTS.md` / `CLAUDE.md` 当作「工作区指令」（以 user 角色提醒注入）。
本插件补上缺失的一块：**让人设成为真正的系统提示**——模型的身份与对话风格，
而不是一段上下文指令。

## 特性

- **系统提示注入**：通过 `systemPrompt.section()` 注册，与部署级 persona 前缀同一档位（order 0）。
- **多文件拼接**：`files` 是**有序数组**，按顺序拼成一段人设；先写身份、再写口吻、最后写禁忌，
  顺序由你控制（设置页可上下移动）。
- **设置页可视化编辑**：设置 →「角色人设」标签页里可以直接增删文件、调顺序、编辑正文、
  调分隔符 / 字节上限 / 总开关，并查看**合成预览**。
- **热更新**：每次组装系统提示都重新读取文件，改完**无需重启**，下一条消息即生效。
- **安全兜底**：文件缺失 / 为空 / 超过大小上限时自动跳过，不影响其它提示片段。
  `maxBytes` 同时是**总预算**，逐文件累加，超了就截断并停止。
- **字面渲染**：section 声明 `interpolate: false`，人设里的 `{{variable}}` 原样输出，不会被系统提示渲染器当成严格模板变量（那一类未知引用会抛错）。
- **只碰文本**：读写白名单只有 `.md` / `.markdown` / `.txt`，且拒绝一切越出 `$DSH_HOME` 的路径。
- **首装即有东西可写**：插件第一次运行会自动建出空的 `SOUL.md` 和 `rp-soul/parts/角色档案.md`
  （0 字节，你写什么就是什么），并把它们写进清单——设置页一打开就能看到文件、点开就能编辑，
  不用先手动建文件。**已存在的文件绝不会被覆盖**。
- **引擎（可选）**：结构化字段单独放在 `rp-soul/persona.md`（设置页表单可改），
  引擎据此维护**情绪（心情条）/ 人际关系（信任·张力·阶段）/ 自主行动**三本账，
  由 SQLite 记账、可存档可回滚。人设散文仍原样进系统提示，引擎状态以一段 brief 追加在后面。
- **乱码拒收**：文件名里出现 `U+FFFD`（说明送来的字节不是合法 UTF-8，典型是客户端按 GBK 编码发中文名）
  直接 400，不允许在磁盘上留下乱码文件名。

## 工作原理

每次组装系统提示时，插件调用一个 provider 函数，实时读取 `files` 里列出的每个文件
（相对 `$DSH_HOME`，默认 `C:\Users\<你>\.dsh\`，位置由 `$DSH_HOME` 决定），
按数组顺序拼接（中间插 `separator`，可选每段加 `<!-- soul-part: 文件名 -->` 注释），
把结果注册为名为 `soul-persona` 的提示片段。使用自定义段名，因此**不与** DSH 自带的
`deployment:persona-prefix` 冲突，可以在全局（profile 层）挂载。

配置有两层：

1. `cordis.patch.yml` 里的 `config` —— **首次运行的种子**；
2. `$DSH_HOME/rp-soul/config.json` —— 设置页保存后写这里，**此后以它为准**。

之所以不直接用 `settings.mutate` 写 `cordis.patch.yml`，是因为那条路要求把 Config 字段
声明成 `volatile`、并且靠 patch 热替换才生效，链路长；本插件的卖点是「改完下一条消息就生效」，
所以自己存一份 JSON，读的时候实时合并。

## 首次运行的种子文件

插件加载时（`apply()` 内，早于任何一次提示组装）会做一次幂等的落地检查：

1. 按 `files`（未配则 `fileName`，再退到 `SOUL.md`）逐项确认存在，缺哪个就 `writeAtomic(abs, "")` 建一个**空文件**（临时文件 + `rename` 原子落地）；
2. 总会额外补一份 `rp-soul/parts/角色档案.md`（同样只在缺失时建空文件）；
3. 存储配置 `rp-soul/config.json` 不存在时，写一份包含上述全部种子的 `files` 清单；
   已存在则**只在角色档案是新建成**的情况下把它追加到末尾（老用户升级路径），不动你已有的顺序。

这三步都只在**缺失**时动作，写完就走，因此重复启动不会改动任何内容。
磁盘只读 / 权限不足时整段包在 `try/catch` 里静默跳过——人设仍按已有文件生效，不会因为建不出种子而挂掉。

## 设置页

设置 →「角色人设」：顶部四个页签，**人设提示词 / 引擎人设 / 情绪 / 自主行动记录**。
页签只影响界面，不影响数据——四页读的是同一份引擎状态，切换时各自取一次当前这一局。

### 人设提示词

- **拼接顺序**：文件清单就是拼接顺序，用 `↑` `↓` 调整，`×` 从清单移除（**不删文件**）。
- **从库中添加**：下拉里列出 `$DSH_HOME` 下最多两层的所有 `.md` / `.txt`。
- **新建**：建在 `rp-soul/parts/` 下，自动加进清单末尾。
- **编辑器**：`Ctrl/⌘+S` 保存；切文件前若未保存会提示。
  打开标签页时会**自动选中第一个真实存在的文件**（清单里若全是缺失文件则选第一个），
  避免右侧一开始是「未选择文件」让人以为功能没生效。
- **空文件**：编辑器显示占位提示「这个文件还是空的 —— 直接在这里写」，直接写、保存即可。
- **引擎（账本）**：Python 侧车是否就绪（版本 / 数据目录）、当前人设包的结构摘要、
  真引擎校验人设（`/engine/persona`，失败时逐条列出 `路径：原因 —— 怎么改`）、标识（标题 / persona_id）。
- **高级**：总开关、每段 `soul-part` 注释、总字节上限、分隔符、合成预览。

### 引擎人设

`rp-soul/persona.md` 的表单版：id / 标题 / 心情基准 / 心情阈值 / 地点 / 角色，
角色里还有称呼、年龄、性别、开局态度、身份、外貌、表里两层语态与排班。
改完点保存写回文件，点「看 YAML」看原文，「校验」直接把这份人设交给引擎校验。
没有任何人填的「当前目标 / 处境」——那些由引擎按心情、关系、到期的事现场测算。

### 情绪

每回合重算的**心情条**（RimWorld 式：基准 + 一组带衰减的 thought，夹在 0..100）：

- 每个 NPC 一张卡：`当前值 / 100 · 档位`、条形图、三档阈值（人设 `mood_thresholds` 可调，
  默认 `开心 ≥ 75` / `低落 < 45` / `难过 < 25`）、对你 的信任 · 张力 · 阶段 · 是否可自主行动。
- 下面按条列 thought：`delta`、标签、`记忆|情境`、还剩多少分钟。
- 每条右侧 `×` 手动删掉（会留一条审计记录，之后引擎不再复述这件事）；
  卡片底部「手动删除记录」列出这些审计条目。
- 情绪**不是**存档里的一份独立数值：`state.characters[npc].mood` 只存 thought 列表，
  值每回合从它重算，玩家侧不入库。

### 自主行动记录

按回合倒序的回合流水，可切「最近 10 / 20 / 50 回合」：

- 每条：`第 N 回合` + 行动模式（你说的话成了事实 / 你在尝试 / 其实…… / 你没说没做 / 时间在走）、
  时间、本回合摘要、「停在这里」的 `open_action`。
- 分组列出这回合实际发生的变化：`自主行动`（NPC 的 kind + 动作文本 + 是否重大）、
  `离屏片段`、`对方的回应`（拒绝 / 协商 / 半配合 / 表面配合 / 真心回应 + note）、
  `关系变化`（信任 / 张力 / 阶段，阶段显示中文名）、`留下的情绪`。
- 顶部汇总：当前第几回合 / revision / 共多少条记录 / 多少次自主行动 / 多少个离屏片段 / 时钟。
- 撤销过的回合（`undone`）与「开局」这类非 commit 记录也会出现，标出来但不重复算变化。

## HTTP 接口

宿主侧注册了 `/rp-soul` 前缀路由（`ctx.webServer.register({kind:'prefix'})`），
所有请求先过 `connection.requestRejection()` 信任栅栏（缺 `connection` 服务时 503 fail closed）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/rp-soul/state` | 快照：配置 + 各文件元信息 + 库列表 + 合成预览 |
| GET | `/rp-soul/file?rel=...` | 读单个文件 |
| PUT | `/rp-soul/file` | 写单个文件 `{rel, text}` |
| POST | `/rp-soul/new` | 新建文件 `{name, text}` |
| GET | `/rp-soul/config` | 读生效配置 |
| POST | `/rp-soul/config` | 写配置 `{files, separator, annotate, enabled, maxBytes}` |
| GET | `/rp-soul/engine` | 引擎健康 + 人设摘要 + 当前这一局 |
| GET | `/rp-soul/engine/persona` | 用真引擎校验人设，返回结构摘要或带 path 的错误 |
| GET | `/rp-soul/engine/session?session_id=` | 读该局上下文（`depth=brief|full`） |
| GET | `/rp-soul/engine/mood?session_id=&npc_id=` | 单个 NPC 的心情面板（值 / 档位 / 阈值 / 条目 / 审计） |
| GET | `/rp-soul/engine/moods?session_id=` | 「情绪」页：全部 NPC 的心情面板 + 阈值 + 删除审计 |
| GET | `/rp-soul/engine/activity?session_id=&limit=` | 「自主行动记录」页：最近 N 回合（1–50，默认 20） |
| DELETE | `/rp-soul/engine/thought` | 手动删一条情绪 `{session_id, npc_id, thought_id, revision, reason}` |

状态码：400 = 参数不合法（扩展名不在白名单 / 路径穿越 / 含 `U+FFFD` 的乱码名）、
413 = 请求体超 1 MiB、503 = 缺 `connection` 服务时 fail closed、401/403 = 信任栅栏拦下。

## 安装（一条 dsh 命令）

包声明了 `dsh.bundle` 元信息，`dsh plugin add` 会把插件装进当前 profile 的
`node_modules` 并自动挂载（无需手改任何配置文件）：

```
dsh plugin add dsh-rp-soul
```

等价地，也可以从 GitHub 或本地打包文件安装：

```
dsh plugin add github:IA-35/dsh-rp-soul
dsh plugin add ./dsh-rp-soul-0.3.0.tgz
```

> 若你此前用手动方式装过（见下），请先删掉 `cordis.patch.yml` 里的
> `soul-persona` 行并移除 `$DSH_HOME\profiles\plugins\soul-persona\`，
> 避免同一 `id` 的配置被用户层旧行覆盖，导致 bundle 层的挂载不生效。

## 旧的手动安装方式（备选）

### 1. 放置插件

把仓库里的 `lib/`、`package.json` 复制到：

```
$DSH_HOME\profiles\plugins\soul-persona\
```

> 必须是 `profiles\plugins\`（而不是 `profiles\web\plugins\`）：
> 插件用 ESM `import` 加载 `@deepseek-ai/dsh-home-paths` 等依赖，需要向上命中
> `profiles\node_modules` 里的 `@deepseek-ai` 包。

### 2. 挂载插件

打开 `$DSH_HOME\profiles\web\cordis.patch.yml`，附加以下内容
（参考 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)）：

```yaml
- insert:
    - id: soul-persona
      name: '../plugins/soul-persona/lib/index.js'
      config:
        files:
          - SOUL.md
        maxBytes: 65536
```

保存后 `patchReload: live` 会尝试热加载；若界面无反应，重启一次 `dsh web`。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `files` | `["SOUL.md"]` | **有序**文件列表（相对 `$DSH_HOME`），按顺序拼接 |
| `fileName` | `SOUL.md` | 旧字段，`files` 为空时退回用它（向后兼容） |
| `separator` | `"\n\n"` | 段与段之间的连接串 |
| `annotate` | `false` | 每段前加 `<!-- soul-part: 文件名 -->` |
| `maxBytes` | `65536` | **总预算**（字节），逐文件累加，超了截断并停止 |
| `storeFile` | `rp-soul/config.json` | 设置页写入的存储文件（相对 `$DSH_HOME`） |
| `engineEnabled` | `true` | 关掉则完全不启引擎（工具会明确报未启用，人设仍照常注入） |
| `engineScope` | `global` | `global` = 所有会话共用一局（心情与关系是连续的）；`session` = 每个 DSH 会话各自一局 |
| `engineDataDir` | `""` | 引擎数据目录；空 = `$DSH_HOME/rp-soul/engine/` |
| `engineTimeoutMs` | `30000` | 单次侧车调用超时（毫秒） |
| `engineSessions` | `rp-soul/engine-sessions.json` | 作用域键 → 引擎局 id 的映射表（global 下只有 `shared` 一行） |
| `title` | `""` | 覆盖存档列表里显示的人设标题（空 = 取 `persona.md` 的 `title`，再退到正文首行） |
| `personaId` | `""` | 覆盖人设 id（空 = 取 `persona.md` 的 `id`） |

设置页里保存的值写入 `$DSH_HOME/rp-soul/config.json`，优先级高于 `cordis.patch.yml` 的 `config`。

## 引擎（可选）

人设散文解决「他是什么人」，引擎解决「他现在怎么样、会怎么变」。引擎是随插件分发的
Python 包（无第三方依赖，`python -m rp_soul_engine` 常驻子进程，stdio JSON-lines 通信），
需要 **Python ≥ 3.10**；找不到 Python 时插件照常工作，只是三个工具会明确报未就绪。

### 引擎人设：单独一个文件

引擎要的结构化字段（地点、角色、心情阈值……）放在 **`$DSH_HOME/rp-soul/persona.md`**，
就是一个纯 YAML 文件（不需要 `---` 包裹，写了也只当装饰）。它和人设提示词是两件事：

- 人设提示词（`files` 里那些 md）只管「他是谁、怎么说话」，会被原样注入 system prompt；
- `persona.md` 只管引擎要的数据，**不注入提示词**。

设置页「角色人设 → 引擎人设」里是表单，不用手写 YAML；想看一眼原文就点「看 YAML」。
**改完就生效**：`persona.md` 是静态事实，引擎每次 `soul_state` / `soul_commit` 都会把它
一并送过去，所以名字、称呼、年龄、外貌、语态、作息、心情基准当场就跟上，不用为了看一眼新的
名字重开一局。剧情那半不动：时间、地点、你们之间的关系进度、心情里已经发生的想法、
记下的事实都留在原地。唯一有条件的字段是 `start_stage`——它只描述「开局时这段关系在哪」，
所以只有当两边还干干净净（信任 0、张力 0、没有历史）时才按文件来；一旦有过往来，
关系进度就是账本说了算，文件改不动它。

这份文件不存在时退回老行为：从**第一个**带 YAML 前置块的散文文件里读（表单会提示「从散文前置块迁移」，
点一次保存就搬过来，之后散文里的前置块不再参与解析）。

```yaml
id: rain_clinic
title: 雨夜诊所
mood_base: 55
mood_thresholds: {open: 72, closed: 40, break: 18}
places:
  - {id: clinic, name: 诊所, privacy: private}
cast:
  - id: lin_wan
    name: 林晚
    tier: major
    role: 夜班医生
    age: 34
    gender: female
    voices: {surface: 说话克制。, inner: 一直在等一句道歉。}
    start_stage: familiar
    schedule: [{from: 0, to: 1439, location_id: clinic}]
```

`places` 与 `cast` 是硬要求。`cast` 里 `id` / `name` / `age` / `gender` 必填，`tier: major` 的角色
还得填 `voices.surface` 与 `voices.inner`；`adult_context`、`appearance`、`call`、`role` 这些
可选的，不写就不写，引擎不会替你编。
`start_stage` 是**开局时她对你的关系阶段**，不填就是 `stranger`（陌生）；可选
`stranger` / `acquainted` / `familiar` / `flirting` / `testing` / `intimate` / `committed`。
**没有 `goal` / `decision` / `situation` 这几项**：他现在想做什么、心里压着什么，由引擎按心情、
关系、到期的事现场测算，人写一份静态的反而会每回合盖住活的信号。性格与说话方式写进人设提示词就够了。
没有 `persona.md`、散文里也没有前置块时，正文首行当标题、只有一个默认地点，但**不发明角色**——
`cast` 缺了就是缺了，自动开局与 `soul_admin start` 都会拒绝，并说明缺什么。

### 作用域：全局还是按会话

默认 `engineScope: global`——**所有 DSH 会话共用同一局**。心情、人际关系、未结的事
是「她这个人的」，不是「某个窗口的」：在 A 会话里吵完架，切到 B 会话她还带着那股气。
从 `session` 改成 `global` 时，映射表里最近活跃的那一局会被自动**接管**成全局局
（`adopted_from` 记着来历），不会重开一局把账本扔掉。
需要「每个会话各自一局」时把 `engineScope` 设成 `session`（设置页引擎卡上有切换按钮）。

全局作用域下开局是**自动的**：`soul_state` 发现没有局会就地开一局（返回 `autoStarted: true`），
不需要先跑 `soul_admin start`。开不起来（人设缺 `places`/`cast` 等）不算失败，工具会如实说
「这回合只按人设散文演，不要假装有账本」。

### 时间：按真实墙钟，不是虚拟时钟

引擎没有「游戏时间」这个概念，也没有 `advance_time` 这种操作：**每一回合的时间跨度就是真实的
时间间隔**——上一回合结算的时刻记为 `real_at`，这一回合提交时取当前时间，两者之差就是要结算的
跨度。你隔三分钟回来，它就是三分钟；隔一夜回来，它就是一夜，事件到期、心情衰减、场景切换
都按这个真实跨度一次性补算。

- 时钟按真实分钟数累加：`day` / `minute` 是「建局那一刻」加上这段时间走过的分钟推出来的，
  所以同一天内不变，跨过零点自然 `day + 1`，隔了几天回来也落在正确的那一天。
- 跨度 ≥ 60 分钟（或跨天）判定为 `full` 档：这段时间不在场的 major 角色必须各补一条
  `offscreen_beat`，说明他们这段时间干了什么；≥ 16 分钟为 `brief`，其余 `routine`。
- 模型不能快进、也不能自己写时间：`soul_state` 不再接受快进参数，`new-game` 不再有
  `start_minute`，`persona.md` 里也不再需要 `start` 字段。
- 时钟只在真实时间向前时前进；同一时刻重复提交不会让时间倒流。

### 三个工具

| 工具 | 什么时候用 |
|---|---|
| `soul_state` | 每回合开始读上下文（`brief` 约 6 KB；换地点 / 换人 / 新的一天 / 上回合被驳回用 `full` 约 20 KB）。`want_twist` 取转折 |
| `soul_commit` | 写完这一回合后提交。`operations` 是账本改动清单（`npc_response` / `relationship` / `add_thought` / `move` …，最多 40 条），引擎校验后要么全收要么全驳（驳回带 `path` 与原因，最多重试 2 次）。**时间不用写**：引擎按真实时钟自己结算这回合过了多久 |
| `soul_admin` | 开局（`start`，全局作用域下通常不必手动开）/ 回滚（`undo`）/ 存档（`save` `load` `delete` `list`）/ 改边界与偏好（`set_safety` `set_preferences`） |

### 心情条（情绪怎么算）

`mood = clamp(mood_base + Σ thoughts, 0, 100)`。每条 thought 是
`{label(≤20字), delta(-30..+15), kind, source_fact_id, since_turn, expires_at, decay}`
——**引擎自己算情境类**（在场 / 缺席 / 离开太久 / 事件到期 / 张力高 / 深夜打扰），
模型只能通过 `add_thought` 加记忆类，且必须挂到一个事实 id 上（不能凭空扣心情）。
引擎自己写的记忆类只来自**别人对他做了什么**：信任变化（×3）、关系阶段前进、事情搞砸。
**他自己选的回应（拒绝 / 配合）不进他自己的心情**——否则「低落 → 只能冷回应 → 更低落」会一路滑进崩溃档。
衰减两种：`linear`（默认，随时间等比缩小，`|delta| < 1` 才删）与 `none`（到点一刀切）。
同一角色最多 20 条（12 记忆 + 8 情境），超了按「原始强度」淘汰最弱的。

档位只做**行为门禁**，不产生精神状态。档位按**回合开始时**的心情判定（就是模型在 `soul_state`
里看到的那一档），本回合中途加减想法不改变这回合的门禁：

| 档位 | 区间（默认） | 影响 |
|---|---|---|
| `open` | ≥ 75 | 允许关系阶段前进；`npc_action` 的 `significant` 冷却 −1 回合 |
| `normal` | 45–75 | 无额外约束 |
| `closed` | 25–45 | 驳回 `stage_advance`；`npc_response` 只允许 refuse/negotiate/surface，回应（`note`）≤30 字 |
| `break` | < 25 | 驳回 `npc_response` 与 `stage_advance`；在场的他本回合必须有一条 `npc_action(significant: true, kind: provoke/leave)`，不受冷却限制，并顶替玩家 attempt 所需的回应；心情回升即恢复 |

非崩溃档下，`significant: true` 的 `npc_action` 必须写 `kind`，且只能取本回合开始时引擎给出的
agency 候选里的种类（`soul_state` 的 `agency`）；不重大的行动不受此限。

阈值可在 `persona.md` 的 `mood_thresholds` 里改（必须满足 `0 ≤ break < closed < open ≤ 100`，
不满足**报错而不回退默认**）。玩家自己的心情**不入库**——只记录 NPC 怎么想。

### 心情与关系是两条轴

mood 是「此刻怎么样」（短期会回落），trust / stage 是「长期怎么判断你」（慢变 7 级）。
信任高 + 心情低 = 会抱怨会冷一下但不会走；信任低 + 心情高 = 意外地好说话。
`relationship` 的 `trust` 单回合最多变动 2，阶段前进要求本回合有玩家实际行动 + NPC 同回合
`partial`/`genuine` 回应，否则报 `INVARIANT_VIOLATION` 而不是自动截断。

## 与 `AGENTS.md` 的区别

| | `AGENTS.md`（原生） | `SOUL.md`（本插件） |
|---|---|---|
| 注入形式 | user 角色 `<system-reminder>` | **系统提示片段** |
| 语义 | 工作区指令 / 指导 | 身份与对话风格（人设） |
| 覆盖 | 不覆盖系统提示 | 直接参与系统提示渲染 |

## 注意事项

- **`complete: true` 的预设不会生效**：例如内置 `minimal` 预设把 persona 作为
  唯一系统提示，会丢弃所有其它片段（包括本插件的注入）。请改用 `standard` 等
  普通预设，或自行新建预设：
  ```yaml
  agent-presets:
    default: standard
  ```
- 若你同时把 SOUL 内容合并进了 `AGENTS.md`，建议删掉那份，避免人设注入两次。
- **引擎每回合至少一次 stdio 往返**（毫秒级）。引擎不可用时不会阻塞对话，只是
  `soul_state` / `soul_commit` / `soul_admin` 会返回「引擎未就绪」并说明原因
  （缺 Python / 版本太低 / 引擎包缺失），此时人设注入照常生效。
- **引擎要 3.10 以上**，且不加 `PYTHONPATH` 也能 import 的形态是「装完就带 `engine/` 目录」，
  所以请用 `dsh plugin add dsh-rp-soul` 安装，别手工拷 `lib/`。
- **人设改心情阈值不需要迁存档**：`revision` 是「散文 + 结构化字段」的 sha256，
  但引擎只在新开局时读阈值，已有存档沿用开局时那份。

## 验证 / 卸载

- **验证**：新开一个对话，观察系统提示开头出现 `SOUL.md` 的人设文本；修改
  `SOUL.md` 再发消息，随下一条请求更新。
- **验证引擎**：设置 →「角色人设」→ 引擎卡里应显示「就绪」与 Python 版本；
  让模型 `soul_admin start` 之后，同一张卡里能看到这一局与 NPC 的心情条。
  或直接命令行：`python -m rp_soul_engine <<< '{"id":"c1","command":"doctor"}'`
  （在 `engine/` 目录下），返回 `{"id":"c1","ok":true,...}` 即通。
- **卸载**：`dsh plugin remove dsh-rp-soul`（自动移除 bundle 挂载）；
  若曾手动安装，再从 `cordis.patch.yml` 删除 `soul-persona` 行并删除
  `profiles\plugins\soul-persona\` 目录。

## License

[MIT](LICENSE)