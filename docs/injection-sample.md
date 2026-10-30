# 插件注入的内容：一份真实样例

数字是这次真跑出来的：宿主的 `SystemPrompt` + 真 Python 侧车 + 一份临时账本（`s_39eb2f2f`，第一天 18:48，ABM 3 条、SCM 2 条、CLPA 1 条、常识 3 条）。不是照旧文档抄的。

---

## 一、一共注入五样东西

| # | 进哪儿 | 内容 | 体积 | 变不变 |
|---|---|---|---|---|
| 1 | 系统提示词 `soul-persona` | 人设散文（SOUL.md 全文） | 5825 B | 几乎不变，缓存吃满 |
| 2 | 动态 context `soul-engine` | 当前局面 + 她想起来的 + 常识 | 459～869 B | 时间变了 / 记忆常识命中变了才变 |

> 这份是拆分之前测的。现在「她想起来的」（被这句话撞上的记忆、命中的常识、新会话第一轮的最近一篇日记）
> 单独成一段动态 context `soul-recall`，什么都没想起来时是空的；`soul-engine` 只剩局面，不再跟着你这句话变。
| 3 | 工具定义 | soul_state / soul_commit / soul_admin | 10,882 B | 恒定 |
| 4 | 唤醒消息 `【我的时间】` | 到点叫她时插的一条 user 消息 | 约 180 B | 只在唤醒时，且 `wakeEnabled` 开着才有 |
| 5 | 工具返回值 | `soul_state` 的 JSON + 提交样板 | 1921 B | 模型调了才有 |

**没有别的了。** 宿主自己的人设前缀、AGENTS.md 那些不归插件管。

规矩还是那一条：**账本不进系统提示词**。系统提示词里有一个字节在动，后面全部前缀缓存作废，所以账本被放在对话尾部一条 user 消息里。

---

## 二、系统提示词那一段（5825 B）

`~/.dsh/SOUL.md` 原样拼进去，`interpolate: false`，里面写 `{{...}}` 也不会被当模板变量。一个字都没多加。

本文档所属的那次实测里，`renderPrompt()` 出来的系统提示词总长 = **5825 B**，与 SOUL.md 文件字节数完全相等——也就是说这个 section 没有加标题、没有加前缀。

---

## 三、动态 context：真实的两版

### 空账本版（459 B，只有局面）

```
【当前局面（引擎账本）】
时间：第四天 18:42
在场：守岸人
对主人的态度：陌生
心情：平稳（73）
最近的想法：在场（+3，刚刚）
可能发生：守岸人 没出声，只是看着你 —— 因为心情平稳（73），在场
上一个悬念：推完了。他会说一声“好了”，还是只是在等结果。
这段只是账本快照：写完用 soul_commit 交账。
```

### 有记忆有常识版（869 B）

用户那句话是「我回来了。灯塔的灯还点着吗」，命中 1 条常识（关键词「灯塔」）：

```
【当前局面（引擎账本）】
时间：第一天 18:46
作息上你这时候：在黑海岸守着那盏灯
在场：守岸人
对主人的态度：陌生
心情：平稳（70）
可能发生：守岸人 没出声，只是看着你 —— 因为心情平稳（70）
上一个悬念：他明天还会来吗
【她想起来的】
- [大概记得] 第一次有人问我这盏灯是给谁点的。我说不出来，但那天晚上灯没灭。（周日凌晨 01:00）
- [记忆犹新] 他说灯塔的灯要不要一直点着，我说点着。他问为什么，我说光是为了让远处的人知道岸在哪。（周二晚上 21:40）
## 常识
- 灯塔： 灯塔的光是为了让远处的人知道岸在哪，不是为了让谁看见灯。
这段只是账本快照：写完用 soul_commit 交账。
```

多出来的 410 字节里：两条记忆 353 B，常识一段 106 B（含 `## 常识` 首行和末尾换行）。

### 逐行的来源（`lib/engine-bridge.js` 的 `snapshotText`）

| 行 | 从哪来 | 备注 |
|---|---|---|
| 时间 | `context.clock.label` | 天 + 时分 |
| 作息上你这时候 | `companion.routine_now` | 只有当前时段有安排时才出现 |
| 在场 | `context.companion.name` | 只有她一个 |
| 对主人的态度 | `companion.stage` | 「陌生 / 熟悉 / 亲近」 |
| 心情 | `companion.mood.band` + `.value` | open→开心、normal→平稳、closed→低落、break→难过 |
| 最近的想法 | `companion.mood.weighing[]` | 每条带引擎算好的当前影响（含衰减）+ 多久以前，最多 3 条 |
| 可能发生 | `context.agency[0].options[0]` | 第一个候选 + 它的 `because` |
| 上一个悬念 | `context.open_action` | 上一次留下的未决动作 |
| 【她想起来的】 | `context.memories[]` | 从 SCM / CLPA 挑，**ABM 不进**（对话本身就在上下文里）。每行是 `[记得多清楚] 正文（多久前）`，档位来自活跃度的四档映射 |
| ## 常识 | `context.common` | `domain/common.py:87 render()` 渲染好的整段 |

**线索是哪来的**：装配系统提示词那一刻，`cueOf(context)` 从 `context.agent.session.deriveMessages()` 倒着找最后一条 `role === "user"` 且 `source.kind === "user"` 的文本块（别人注入的 goal、压缩摘要不算），截 500 字，拿它去挑记忆和常识。所以**不需要模型自己调工具**，说中关键词的那一轮就已经在上下文里了。

**标题里绝不能放时间戳**——宿主的 RuntimeContextProjection 按整段文本去重，文本一样就跳过。标题带秒级时间戳会让去重永远失效，每轮追加一条新快照，前缀缓存收益被吃干净。时间只写在正文里，粒度粗。

---

## 四、三个工具的定义（10,882 B，恒定）

按 `{name, description, parameters}` 序列化后算：

| 工具 | 定义体积 | 其中描述 | 干什么 |
|---|---|---|---|
| `soul_state` | 1293 B | 714 B | 读这局的工作指令：候选 / 近期事件 / 底细 / 要不要交总结。心情、记忆、常识、时间、在场**不从这里取**——每轮已随快照注入 |
| `soul_commit` | 7766 B | 2436 B | 交账。最大的一块：action_mode 五档语义、ops 清单、内容标签枚举、记忆规则 |
| `soul_admin` | 1823 B | 318 B | 行政：start/undo/save/load/set_safety/mood_panel… |
| **合计** | **10,882 B** | 3468 B | |

`soul_commit` 那 7766 字节里，花得最值的是这几条：

- 「只用写事，不用写数值」——信任怎么变、事件是否到期由引擎算
- 「只有你和主人两个人，op 里不写是谁」
- 「正文没提到的东西就一个字都别写，宁可写得短」
- 「隔了一小时以上（或跨天）再回来，必须写一条 offscreen_beat」
- 「心情档位在真实时间结算后、操作前冻结」

---

## 五、`soul_state` 返回什么（brief 档，1921 B）

```json
{
 "started": true, "session_id": "s_39eb2f2f", "revision": 4, "turn": 3,
 "context": {
  "agency": [{"character_id": "shorekeeper", "name": "守岸人",
    "options": [{"kind": "observe", "label": "在旁观察",
      "text": "守岸人 没出声，只是看着你", "weight": 1.024,
      "reasons": ["心情平稳（73），在场"], "because": "因为心情平稳（73），在场"}]}],
  "due_soon": [], "known_facts": [], "her_knows": [],
  "requests": {"memory_fold": null, "memory_diary": null},
  "mood": {"value": 73, "band": "normal",
           "weighing": [{"label": "在场", "delta": 3, "ago_minutes": 0}]}
 },
 "persona": {"ok": true, "changed": true, "revision": "d8d10d32…", "updated": ["shorekeeper"]},
 "commit_template": { ... 1127 B ... },
 "next_request_id": "r_19f3a53b07c3"
}
```

拆开看：`context` 497 B，`commit_template` 1127 B，其余是外壳。

**`context` 只有 497 B**，因为时间、在场、态度、心情、名字、记忆、常识**全都不在里面了**——那些已经在提示词快照里写着。工具结果再抄一份就是让模型读两遍。

`commit_template` 是可以直接抄了改的提交样板（1127 B），列了 `action_mode` 五档、四种 op 的字段、`quotes` / `remember` 的形状。它存在的唯一目的是让模型不用猜字段名。

### full 档（1838 B）

只在「隔了一阵回来 / 新的一天 / 上一次被驳回」时用。比 brief 多：

| 多了 | 内容 |
|---|---|
| `persona` | 结构化人设（id/title/revision/person/mood 阈值） |
| `card` | 完整档案：称呼、年龄、声线、**完整心情面板**（每条想法的 id、峰值、种类、剩余分钟） |
| `relationship` | 信任/张力/阶段 + 最近 4 条关系变化原因 |
| `player_facts` / `events` | 你的事实、剧情事件全量 |

full 反而**比 brief 小**（1838 vs 1921）——它不带 `commit_template` 的后半段，且实例里 facts/events 都是空的。

### `soul_admin`（1219 B）

`status` 一次跑完返回的东西，绝大多数轮次不会调。

---

## 六、唤醒消息（开着才有，约 180 B）

`lib/wake.js` 的 `DEFAULT_TEMPLATE`，模板可被 `rp-soul/wake.md` 整份覆盖，占位符 `{when}` `{why}` `{player}`：

```
【我的时间】{when} 了{why}。
{player} 不在。接下来做什么由我决定：可以自己做点什么，也可以在这里给 {player} 留一句话。
做完用 soul_commit 记账，再用 plan_next 说好接下来做什么、做到几点；什么都不定，就按平常的时间叫我。
```

它是一条 `agent.steer` 出去的 user 消息，`source.kind` 是唤醒专用标记，所以不会被当成你的原话。

---

## 七、一次普通请求的字节账

```
恒定（命中前缀缓存后几乎不花钱）
  系统提示词 人设 section      5825 B
  工具定义                    10,882 B
  ────────────────────────────────────
  小计                        16,707 B

每轮可能变
  动态 context 快照             459 ～ 869 B

模型调工具才加
  soul_state 返回              1921 B
  soul_admin 返回              ~1200 B
```

真正每轮都在动的只有那 459～869 字节。恒定那 16.7 KB 里，10.9 KB 是工具定义——**这是最大的一块开销，也是最值得压的**（描述 3468 B 里 `soul_commit` 占 2436 B）。

---

## 八、自己复现

```bash
cd "F:/DSH Workspace/_tmp_rp_soul/engine"
echo '{"session_id":"s_cd96ac0f","depth":"brief","cue":"你回来啦"}' \
  | python -m rp_soul_engine --data-dir "C:\Users\Administrator\.dsh\rp-soul\engine" get-context
```

把 `brief` 换成 `full` 就是完整档。

`cue` 平时不用传：插件装配时自己从会话里取最后一条真实用户消息。上面手动传是为了单独复现某句话的效果。

工具定义和系统提示词的字节数没法用命令量，得在真实 Context 里挂一次插件、把 `tools` 注册的 def 序列化后数字节（本文数字就是这么来的：`{name, description, parameters}` 三段 JSON，UTF-8）。
