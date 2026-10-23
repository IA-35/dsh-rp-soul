# dsh-rp-soulload

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

设置 →「角色人设」：

- **拼接顺序**：文件清单就是拼接顺序，用 `↑` `↓` 调整，`×` 从清单移除（**不删文件**）。
- **从库中添加**：下拉里列出 `$DSH_HOME` 下最多两层的所有 `.md` / `.txt`。
- **新建**：建在 `rp-soul/parts/` 下，自动加进清单末尾。
- **编辑器**：`Ctrl/⌘+S` 保存；切文件前若未保存会提示。
  打开标签页时会**自动选中第一个真实存在的文件**（清单里若全是缺失文件则选第一个），
  避免右侧一开始是「未选择文件」让人以为功能没生效。
- **空文件**：编辑器显示占位提示「这个文件还是空的 —— 直接在这里写」，直接写、保存即可。
- **高级**：总开关、每段 `soul-part` 注释、总字节上限、分隔符、合成预览。

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

状态码：400 = 参数不合法（扩展名不在白名单 / 路径穿越 / 含 `U+FFFD` 的乱码名）、
413 = 请求体超 1 MiB、503 = 缺 `connection` 服务时 fail closed、401/403 = 信任栅栏拦下。

## 安装（一条 dsh 命令）

包声明了 `dsh.bundle` 元信息，`dsh plugin add` 会把插件装进当前 profile 的
`node_modules` 并自动挂载（无需手改任何配置文件）：

```
dsh plugin add dsh-rp-soulload
```

等价地，也可以从 GitHub 或本地打包文件安装：

```
dsh plugin add github:IA-35/dsh-rp-soul
dsh plugin add ./dsh-rp-soulload-0.2.1.tgz
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

设置页里保存的值写入 `$DSH_HOME/rp-soul/config.json`，优先级高于 `cordis.patch.yml` 的 `config`。

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

## 验证 / 卸载

- **验证**：新开一个对话，观察系统提示开头出现 `SOUL.md` 的人设文本；修改
  `SOUL.md` 再发消息，随下一条请求更新。
- **卸载**：`dsh plugin remove dsh-rp-soulload`（自动移除 bundle 挂载）；
  若曾手动安装，再从 `cordis.patch.yml` 删除 `soul-persona` 行并删除
  `profiles\plugins\soul-persona\` 目录。

## License

[MIT](LICENSE)