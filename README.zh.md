# dsh-compaction-hardcut

[English](README.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的硬切窗口插件 —— 把 Codex `new_context` 的思路做成插件：窗口满了之后，早期的对话**不经过任何 LLM 摘要**直接离开模型上下文，模型自己记的持久笔记被重新注入，完整历史随时可以用工具查回来。

## 为什么不摘要？

摘要式压缩（官方 `dsh-compaction-basic` 的做法）有两笔固定账：

- **隐式有损。**"这个接口千万别动""方案 A 为什么被否掉"——这些最容易被压成一句空话，而且模型不知道自己忘了，照样自信作答。
- **每次都烧一次模型调用**，长会话里反复发生。

硬切把失败模式从"悄悄遗忘"换成"该查没查"——后者在日志里看得见、能调试。每次重置**零**额外 token，第 5 次重置和第 1 次质量完全一样（没有"总结的总结"层层失真），因为原始日志一个字都没改。

## 功能

- **硬切引擎**——触发时机与官方一致（步间压力、上下文溢出兜底、`/compact`），事务也一样耐用，但 `summarize()` 不调 LLM。替换进上下文的 checkpoint 是一段固定的重置通知，附带 agent 当前的笔记。
- **`notes_append` / `notes_read`**——模型自己记录持久事实（决策及原因、用户约束、路径/ID、已排除的死路）。笔记按会话存在 `~/.dsh/compaction-hardcut/notes/`，每次重置后自动重新注入 checkpoint。
- **`history_search` / `history_read`**——对**完整**会话日志做关键词搜索和精确区间读取，包括已离开活动上下文的轮次。什么都不删。
- **`new_context`**——模型可以在自己觉得合适的时候主动请求重置，在下一个步边界执行（那里 tool-call 配对天然平衡）。
- **预算提示**——system prompt 里显示 ~25% / ~50% / ~75% 用量。做了量化，文本只在跨档时变化，provider 的 KV 缓存不会被打挂。

## 安装

```sh
dsh plugin --profile web add dsh-compaction-hardcut
```

装完重启 `dsh web`。

插件的 patch 做两件事：禁用 **root 级**官方引擎（`dsh-base` 的 `compaction-basic` 行），并把 `HardcutEngine` 挂在 root、阈值 `0.75`。agent preset(standard/cordis/ptc）里隔离的官方引擎（0.8）不动，但硬切在 0.75 先提交，所以实际上每次自动压缩都是硬切。极端情况——单个巨型 step 从 0.75 以下直接跳过 0.8——preset 引擎可能仍会做一次经典摘要，无害，只是那一次有损。

## 配置

在 profile 配置行里设置（`~/.dsh/profiles/<profile>/cordis.yml`):

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `thresholdRatio` | `0.75` | 压力阈值（占模型上下文窗口的比例） |
| `retainRatio` | `0.16` | 每次切割后原文保留的最近尾部比例 |
| `retainTokens` | — | 绝对尾部预算；覆盖 `retainRatio` |
| `budgetHints` | `true` | 显示 25/50/75% 预算提示 |
| `notesMaxChars` | `8000` | 重置后重新注入的笔记预算（保留最新） |
| `historyMaxChars` | `8000` | `history_read` 单次输出上限 |
| `auto` | `true` | 自动压力/溢出压缩 |

## 重置后模型看到什么

```
CONTEXT WINDOW RESET #2 (dsh-compaction-hardcut) — no summary was produced and no information was deleted.
The earlier conversation (148 replayed messages) left the active context but remains FULLY recorded
in this session's log. When a fact, path, decision or constraint feels missing, retrieve it instead of guessing:
- history_search({ query }) — find prior messages and tool activity by keyword
- history_read({ fromSeq, toSeq }) — read an exact event range

Durable notes (persisted across resets, newest last):
…
```

外加原封不动的 system prompt 和最近 ~16% 对话的原文。

兜底边界：如果可切区间已经比 checkpoint 本身还小（会话尾部保留很大时可能出现），官方事务守卫会跳过这次切割、对话原样继续——跳过会以 `compaction/end` 错误事件记在日志里，看得见。

## 兼容性

需要 dsh ≥ 0.1.2-rc.1（在 0.1.5-rc.1 上开发与验证）。引擎子类化官方 `BasicCompactionEngine`；如果未来 dsh 改变该类的 `summarize()` 钩子签名，本插件需要同步更新。

## License

[MIT](LICENSE)
