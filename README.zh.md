# dsh-context-manager

DeepSeek Harness 的显式上下文内存子系统。一个插件,四层内存,七个工具,一个命令。

[English README](README.md)

## 要解决的问题

上下文窗口涨满时,官方压缩把旧历史替换成一份 LLM 摘要。这份摘要是**唯一**的桥——它会静悄悄地丢东西("忘了还自信"),多次压缩错误层层累积,而且没有任何逐字信息能保证存活。

## 模型:四层内存

```
① 保险柜  pin: 逐字事实,住在 system prompt 最后一段。
            任何压缩和 /reset 都动不了它,永不经过 LLM 转述。
② 日记     notes: 模型自己提炼的笔记,存在会话文件里。
            /reset 时注入 checkpoint。
③ 草稿     /reset 的 checkpoint: LLM 摘要(标注"未验证")
            + 笔记 + 检索说明。
④ 交换区   完整会话日志。什么都不删;
            history_search / history_read 按需取回任何原文。
```

回收策略:**pin = mlock(锁定),官方 compact = 带摘要的 GC,/reset = 批量 free** 堆(和任务级 pin)。

## 工具(装进每个 agent,子 agent 也有)

| 工具 | 语义 |
|------|------|
| `context_alloc(text, label, scope)` | 逐字钉入一条事实,返回句柄(`t*`/`w*`)。`scope: "task"`(默认)随 `/reset` 清除;`"permanent"` 跨本工作区的会话永存。 |
| `context_free(handle)` | 释放一个 pin。句柄单调递增、永不复用——被释放的句柄是悬空的,绝不会指向新内容。 |
| `context_list()` | 分配表:每个 pin 的句柄/标签/大小/年龄 + 配额占用。 |
| `notes_append(text)` / `notes_read()` | 持久日记(只追加)。 |
| `history_search(query)` / `history_read(fromSeq, toSeq)` | 全日志检索,含被压缩/切掉的段落。 |

节拍提醒(每 6 次非内存类工具调用一次,搭在工具结果里、几乎不耗 KV 缓存)提醒模型该钉东西了——和 dsh-subagent-progress 里让 notify_user 汇报可靠的是同一个模式。

## `/reset`

和输入框里的 `/compact` 并排。把可切的历史替换成混合 checkpoint(标注"未验证"的草稿 + 笔记 + 检索说明),批量释放任务级 pin 并在结果里报告数量。官方自动压缩**不动**,仍是默认。

## 配额(双阀)

pin 住在 system prompt,每次请求都交租,所以保险柜有两道上限:

- 单个 pin:≤ `pinMaxChars`(默认 4000 字符)
- 总量:≤ min(`pinsMaxChars`(默认 12000), `pinsWindowRatio`(默认 5%)× 上下文窗口 × 3 字符/token)

配额打满时 alloc 被拒绝,并在错误里附上最老的几个任务级 pin 作为释放候选——诚实的失败加扶手,绝不静悄悄地自动驱逐。

## 配置

| 键 | 默认 | 含义 |
|-----|------|------|
| `budgetHints` | `true` | 25/50/75% 量化预算提示(缓存稳定)。 |
| `llmSummary` | `true` | `/reset` 调一次缓存友好的 LLM 草稿;`false` = 纯硬切。 |
| `notesMaxChars` | `8000` | 笔记读取预算(最旧的截断)。 |
| `historyMaxChars` | `8000` | 单次 `history_read` 输出上限。 |
| `pinMaxChars` | `4000` | 单 pin 逐字上限。 |
| `pinsMaxChars` | 12000 | 两种 scope 合计的 pin 总量上限。 |
| `pinsWindowRatio` | `0.05` | pin 可占上下文窗口的比例。 |
| `nudgeEvery` | `6` | 多少次工具调用提醒一次。 |
| `suggestCount` | `3` | 配额拒绝时建议释放的候选数。 |
| `summarizationProvider` / `summarizationModel` / `maxTokens` | — | 可选的草稿调用路由,透传给官方摘要器。 |

## 存储位置

- 任务级 pin:`~/.dsh/context-manager/pins/<sessionId>.json`
- 工作区 pin:`~/.dsh/context-manager/pins/ws/<workspace-slug>.json`(同工作区所有会话和子 agent 共享)
- 笔记:`~/.dsh/context-manager/notes/<sessionId>.md`(旧的 `~/.dsh/context-reset/notes/` 会懒迁移)

## 设计说明

- **pin 为什么住 system prompt**:它是唯一每次请求都重新拼装的层——唯一能扛住任何历史替换的位置。pin 段排在最后(order 10300,在官方 persona 后缀之后),pin 增删对 KV 缓存的破坏最小。
- **为什么是 free+alloc 而不是 update 工具**:三个工具比四个好;换句柄顶多是悬空(可解释),复用句柄是错误指针。
- **为什么模型自己管 pin**:用户钉打断心流,引擎启发式会误判;自觉性风险由节拍提醒 + 量化预算提示兜底。
- 本插件取代 `dsh-context-reset`(同一个引擎、同一个 `/reset`,新增 malloc 层)。

## 兼容性

dsh 官方插件用 `peerDependencies` 声明对自己触碰的 `@deepseek-ai/*` 核心包的版本契约(比如 `dsh-compaction-basic` 声明了八个核心包),本插件遵循同一约定。核心包按发布列车(0.1.x-rc)整体联动,所以一个区间即可覆盖整个宿主。

**支持范围:dsh ≥ 0.1.2-rc.1 且 < 0.2.0。在 0.1.5-rc.1 上开发并验证**(malloc 全链路 headless e2e + dsh web 实测 `/reset`)。

下限来自本插件实际使用的 API 面,已逐一对照各核心版本的发布 tarball 核实:

| 我们使用的 API | 包 | 引入版本 |
|---|---|---|
| `SessionSeq` + `session.eventAt()`(history 工具、reset 计数) | `@deepseek-ai/dsh-session` | **0.1.2-rc.1**(0.1.0-rc.8 和 0.1.1-rc.2 都没有) |
| `BasicCompactionEngine` + `summarize()` 覆写钩子 | `@deepseek-ai/dsh-compaction-basic` | ≤ 0.1.0-rc.8 |
| `ManualCompactionError` | `@deepseek-ai/dsh-compaction` | ≤ 0.1.0-rc.8 |
| `defineTool`(带 output schema 的工具注册) | `@deepseek-ai/dsh-tools` | ≤ 0.1.0-rc.8 |
| `dshHomePath` | `@deepseek-ai/dsh-home-paths` | ≤ 0.1.0-rc.8 |
| `commands` / `llm` / `tokenMeter` / `sessions` 服务、`agent/created` 事件 | `@deepseek-ai/dsh-commands` 等 | ≤ 0.1.0-rc.8 |

约束瓶颈是 `SessionSeq`,所以所有下限统一对齐到 0.1.2-rc.1。0.1.2 到 0.1.3 按 API 面推断可用,但未持续测试。

关于声明区间的一点说明:npm semver 无法表达"X 之后的所有预发布列车"——在同元组预发布规则下,`>=0.1.2-rc.1 <0.2.0` 严格解析时只认 0.1.2-rc.* 一列,而官方插件的 `^0.1.5-rc.1` 是钉死单列、每次发布重声明。实际上 pnpm 对已装宿主做 peer 检查是宽松的(0.1.5-rc.1 在安装时能满足这些区间),所以这些区间作为"文档化下限"是有效的;本节才是契约意图的权威声明。

## 许可证

MIT
