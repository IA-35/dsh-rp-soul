# 插件注入的内容：一份真实样例

这是从你现在的账本里导出来的（session `s_cd96ac0f`，第三天 17:02，revision 16）。
不是编的，除了把时间抹成一整天、把记忆条数截短方便看。

---

## 一、总共注入四样东西

| # | 进哪儿 | 内容 | 体积 | 变不变 |
|---|---|---|---|---|
| 1 | 系统提示词 `soul-persona` | 你的人设散文（SOUL.md） | 5825 B | 几乎不变，缓存吃满 |
| 2 | 动态 context `soul-engine` | 「当前局面」快照 | ~494 B | 每次时间变了就变 |
| 3 | 工具定义 | soul_state / soul_commit / soul_admin | ~11.8 KB | 恒定 |
| 4 | 工具返回值 | `soul_state` 的 JSON | ~1.8 KB | 每次调用 |

外加一条规则：**账本不进系统提示词**。系统提示词里只要有一个字节在动，
后面全部前缀缓存作废；所以账本被挪到对话尾部的一条 user 消息里。

---

## 二、系统提示词里那一段（人设）

`~/.dsh/SOUL.md` 全文拼进去，三段用空行连起来：

```
<!-- soul-part: IDENTITY.md -->
## IDENTITY.md - 角色设定
- **Name:** 守岸人（Shorekeeper）
- **Emoji:** 🌊
...
（共 5825 字节，2234 字）
...
<!-- soul-part: rp-soul/parts/输出规范.md -->
### 反AI腔（硬规则）
- 禁止开场套话、禁止总结陈词...
```

它是 `interpolate: false` 的 section，所以里面出现 `{{...}}` 也不会被当模板变量。

---

## 三、动态 context 里那一段（账本快照）

就是你现在能在对话里看到的那块，原样：

```
【当前局面（引擎账本）】
时间：第三天 16:59
在场：守岸人
对主人的态度：陌生
心情：平稳（68）
最近的想法：很久没见你（-5）、在场（+3）
可能发生：守岸人 没出声，只是看着你 —— 因为心情平稳（68），很久没见你、在场
上一个悬念：推完了。他会说一声“好了”，还是只是在等结果。
这段只是账本快照：写之前用 soul_state 拿最新状态，写完用 soul_commit 交账。
```

### 它怎么被渲染出来的（`lib/engine-bridge.js` 的 `snapshotText`）

| 行 | 从哪来 | 备注 |
|---|---|---|
| 时间 | `context.clock.label` | 天 + 时分，粒度到分钟 |
| 在场 | `context.companion.name` | 只有她一个 |
| 对主人的态度 | `companion.stage` | 「陌生 / 熟悉 / 亲近…」 |
| 心情 | `companion.mood.band` + `.value` | band 转中文：open→开心、normal→平稳、closed→低落、break→难过 |
| 最近的想法 | `companion.mood.weighing[]` | 每条挂引擎算好的**当前**影响，含衰减，最多 3 条 |
| 可能发生 | `context.agency[0].options[0]` | 取第一个候选 + 它的 `because` |
| 上一个悬念 | `context.open_action` | 上一次留下的未决动作 |

**标题里绝不能放时间戳**——宿主的 RuntimeContextProjection 按整段文本去重，
文本一模一样就跳过、不追加。标题一旦带秒级时间戳，每次都不一样，
去重永远失效，每一轮都追加一条新快照，前缀缓存收益被吃干净。
所以时间只写在正文「时间：第几天 几点」里，粒度粗，内容不变它也不变。

---

## 四、`soul_state` 返回的完整 JSON（brief 档）

体积 1832 字节，这才是模型真正读到的东西：

```json
{
 "depth": "brief",
 "session_id": "s_cd96ac0f",
 "revision": 16,
 "turn": 5,
 "mode": "persona",
 "clock": {"day": 3, "minute": 1022, "label": "第三天 17:02"},
 "scene": {"id": "sc2", "since": "第三天 17:02"},
 "player": {"name": "你", "title": "你", "age": 28, "gender": null, "role": ""},
 "companion": {
  "id": "shorekeeper", "name": "守岸人", "age": 22, "gender": "female",
  "role": "漂泊者的助理与数字世界的守望者",
  "present": true, "can_act": true,
  "trust_to_player": 3, "tension": 2, "stage": "陌生",
  "mood": {"value": 68, "band": "normal",
           "weighing": [{"label": "很久没见你", "delta": -5},
                        {"label": "在场", "delta": 3}]}
 },
 "due_soon": [],
 "known_facts": [],
 "her_knows": [],
 "open_action": "推完了。他会说一声“好了”，还是只是在等结果。",
 "scene_responses": [],
 "safety": {"paused": false, "boundaries": []},
 "preferences": {"offscreen_simulation": true},
 "save": {"current_slot": null, "turns_since_save": 5},
 "requests": {"memory_fold": null, "memory_diary": null},
 "memories": [],
 "agency": [
  {"character_id": "shorekeeper", "name": "守岸人",
   "options": [{"kind": "observe", "label": "在旁观察",
                "text": "守岸人 没出声，只是看着你",
                "weight": 1.119, "basis_fact_ids": [], "event_ids": [],
                "reasons": ["心情平稳（68），很久没见你、在场"],
                "because": "因为心情平稳（68），很久没见你、在场"}]}
 ],
 "size_bytes": 1832
}
```

### 各字段什么意思

| 字段 | 含义 |
|---|---|
| `revision` | 乐观锁。提交时对不上就 `STALE_REVISION`，防并发写坏 |
| `turn` | 流水号。**规则不读它**，只当编号 |
| `clock` | 引擎时钟（真实时间结算出来的） |
| `scene.since` | 这一段相处从哪一刻开始；隔开就换新的一段 |
| `companion.mood.weighing` | 心情的**构成**：每条心事挂着它对当前值的实际影响（含衰减） |
| `due_soon` | 快到期的事件 |
| `known_facts` | 你知道的事（你说过、她记下的） |
| `her_knows` | **她**知道但没告诉你的事——这里可能是空的 |
| `open_action` | 上一个悬念 |
| `scene_responses` | 最近三次她对你的回应类型（refuse/negotiate/partial/surface/genuine） |
| `requests` | 有值时表示「该交账了」（`memory_fold` 收进 SCM / `memory_diary` 写日记），模型必须照 `memory_fold_sources` / `memory_diary_sources` 写 |
| `memories` | 想起来的记忆（只从 SCM / CLPA 取，3~5 条；**ABM 不进这里**，对话本身已经在上下文里）：`layer` 层级、`when` 多久以前、`text` 她记得的 |
| `agency` | 她「下一步可能做什么」的候选（最多 3 个，这里只算出 1 个） |
| `size_bytes` | 自报体积，超预算时按顺序砍：facts → her_knows → due_soon → 回应 → 记忆 → 候选 |

### 还有一块：`commit_template`

`soul_state` 除了 `context`，还回 1184 字节的提交样板，
直接抄了改就能交（这是为了让模型不用猜字段名）：

```json
{"session_id": "s_cd96ac0f",
 "request_id": "<上一次返回的 next_request_id>",
 "expected_revision": "<上一次返回的 revision>",
 "turns": [{"action_mode": "attempt|result|continue|wait",
   "operations": [{"op": "npc_response", "response": "refuse|negotiate|partial|surface|genuine", ...}],
   "summary": "<第三方视角一两句>", ...}]}
```

---

## 五、`full` 档比 `brief` 多什么

只在「隔了一阵回来 / 新的一天 / 上一次被驳回」时用，约 20 KB 上限：

| 多了 | 内容 | 样例体积 |
|---|---|---|
| `persona` | 结构化人设（id/title/revision/person/规则/转折/mood 阈值） | 421 B |
| `card` | 她的完整档案：称呼、年龄、外貌、声线、**完整心情面板**（每条想法的 id、峰值、种类、剩余分钟） | 895 B |
| `relationship` | 信任/张力/阶段 + 最近 4 条关系变化原因 | 113 B |
| `player_facts` | 你的事实，最多 30 条 | 少 |
| `events` | 剧情事件全量 | 少 |

`card` 里的心情面板长这样（比 brief 的 `weighing` 详细得多）：

```json
"mood": {"value": 68, "band": "normal", "base": 70,
 "thoughts": [
  {"id": "th11", "label": "很久没见你", "delta": -5, "peak_delta": -5,
   "kind": "situational", "decay": "none", "since_turn": 6, "remaining_minutes": 1440},
  {"id": "th10", "label": "在场", "delta": 3, "peak_delta": 3,
   "kind": "situational", "decay": "none", "since_turn": 6, "remaining_minutes": null}
 ]}
```

---

## 六、三个工具的定义（约 11.8 KB，恒定）

| 工具 | 定义体积 | 干什么 |
|---|---|---|
| `soul_state` | 1720 B | 读账本。参数 `depth`(brief/full)、`cue`(你这句话原话，用来挑记忆)、`want_twist` |
| `soul_commit` | 7809 B | 交账。最大的一块，描述了 action_mode 五种语义、ops 清单、内容标签枚举、记忆规则 |
| `soul_admin` | 2286 B | 行政：start/undo/save/load/set_safety/mood_panel… 共 14 个 action |

`soul_commit` 那 7809 字节里，花得最值的是这几条约束：

- 「只用写事，不用写数值」——信任怎么变、事件是否到期由引擎算
- 「只有你和主人两个人，op 里不写是谁」
- 「正文没提到的东西就一个字都别写，宁可写得短」
- 「隔了一小时以上（或跨天）再回来，必须写一条 offscreen_beat」
- 「心情档位在真实时间结算后、操作前冻结」

---

## 七、一次完整请求的字节账

以 brief 档一次普通对话算：

```
系统提示词
  人设 section        5825 B
  （其余是宿主自己的）      —
动态 context
  账本快照             494 B
工具定义
  soul_state          1720 B
  soul_commit         7809 B
  soul_admin          2286 B
  ─────────────────────────
  小计              11,815 B

运行时（每次调工具才加）
  soul_state 返回     1832 B
  commit_template     1184 B
```

关键是：**人设 + 工具定义这 17.6 KB 是恒定的**，命中前缀缓存后几乎不花钱。
每次真正变化的只有那 494 字节快照，和模型自己决定要不要读的 1832 字节。

---

## 八、自己复现的命令

```bash
cd "F:/DSH Workspace/_tmp_rp_soul/engine"
echo '{"session_id":"s_cd96ac0f","depth":"brief","cue":"你回来啦"}' \
  | python -m rp_soul_engine --data-dir "C:\Users\Administrator\.dsh\rp-soul\engine" get-context
```

把 `brief` 换成 `full` 就是完整档。`cue` 决定「被这句话勾起来的往事」那一块挑什么。
