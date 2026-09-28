# dsh-rp-Soulload

把 `$DSH_HOME/SOUL.md` 作为 **DSH 系统提示人设**（persona）加载的插件（Runtime-Persona Soul loader）。

DSH 原生只把 `AGENTS.md` / `CLAUDE.md` 当作「工作区指令」（以 user 角色提醒注入）。
本插件补上缺失的一块：**让 `SOUL.md` 成为真正的系统提示人设**——模型的身份与对话风格，
而不是一段上下文指令。

## 特性

- **系统提示注入**：通过 `systemPrompt.section()` 注册，与部署级 persona 前缀同一档位（order 0）。
- **热更新**：每次组装系统提示都重新读取 `SOUL.md`，改完**无需重启**，下一条消息即生效。
- **安全兜底**：文件缺失 / 为空 / 超过大小上限时自动跳过，不影响其它提示片段。
- **`{{` 转义**：内容里的 `{{variable}}` 会被打断，避免被系统提示渲染器当成严格模板变量而报错。

## 工作原理

每次组装系统提示时，插件调用一个 provider 函数，实时读取 `$DSH_HOME/SOUL.md`
（默认 `C:\Users\<你>\.dsh\SOUL.md`，位置由 `$DSH_HOME` 决定），把内容注册为
名为 `soul-persona` 的提示片段。使用自定义段名，因此**不与** DSH 自带的
`deployment:persona-prefix` 冲突，可以在全局（profile 层）挂载。

## 安装（一条 dsh 命令）

包声明了 `dsh.bundle` 元信息，`dsh plugin add` 会把插件装进当前 profile 的
`node_modules` 并自动挂载（无需手改任何配置文件）：

```
dsh plugin add dsh-rp-soulload
```

等价地，也可以从 GitHub 或本地打包文件安装：

```
dsh plugin add github:IA-35/dsh-rp-Soulload
dsh plugin add ./dsh-rp-soulload-0.1.1.tgz
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
        fileName: SOUL.md
        maxBytes: 65536
```

保存后 `patchReload: live` 会尝试热加载；若界面无反应，重启一次 `dsh web`。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `fileName` | `SOUL.md` | 要读取的文件名（相对 `$DSH_HOME`） |
| `maxBytes` | `65536` | 内容上限（字节），防止超长文本灌入上下文 |

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