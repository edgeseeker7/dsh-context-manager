# dsh-context-reset

[English](README.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的按需硬切窗口插件 —— 输入框里与 `/compact` 并列的 **`/reset`** 命令。你输入它时，早期对话**不经过任何 LLM 摘要**直接离开模型上下文，模型自己记的持久笔记被重新注入，完整历史随时可以用工具查回来。

**官方压缩仍是默认。** 本插件不禁用、不抢占它——自动摘要压缩和 `/compact` 行为完全不变。只有你显式输入 `/reset` 时才会发生硬切。

## 为什么有时候要硬切？

摘要压缩是隐式有损的："这个接口千万别动"会被压成一句空话，而且模型不知道自己忘了。硬切把失败模式从"悄悄遗忘"换成"该查没查"——可见、可调试。它还**零**额外 token（没有摘要调用），且永不复利失真：第 5 次重置和第 1 次质量一样，因为原始日志一个字都没改。

想要摘要式的连续性，用 `/compact`；觉得窗口已经被污染、宁可让模型靠笔记 + 按需检索重建，用 `/reset`。

## 功能

- **`/reset` 命令**——与官方压缩器同款耐用事务（tool-pairing 平衡、checkpoint 框架），但替换进上下文的 checkpoint 是固定的重置通知，附带 agent 当前笔记。不调 LLM。
- **`notes_append` / `notes_read`**——模型自己记录持久事实（决策及原因、用户约束、路径/ID、已排除的死路）。笔记按会话存在 `~/.dsh/context-reset/notes/`，每次 `/reset` 后自动重新注入。
- **`history_search` / `history_read`**——对**完整**会话日志做关键词搜索和精确区间读取，包括已离开活动上下文的轮次。官方摘要压缩之后同样能查——什么都不删。
- **预算提示**——system prompt 里显示 ~25% / ~50% / ~75% 用量。做了量化，文本只在跨档时变化，provider 的 KV 缓存不会被打挂。

## 安装

```sh
dsh plugin --profile web add dsh-context-reset
```

装完重启 `dsh web`。然后在输入框敲 `/`,`reset` 就和 `compact` 并排出现了。

## 重置后模型看到什么

```
CONTEXT WINDOW RESET #1 (/reset, dsh-context-reset) — no summary was produced and no information was deleted.
The earlier conversation (148 replayed messages) left the active context but remains FULLY recorded
in this session's log. When a fact, path, decision or constraint feels missing, retrieve it instead of guessing:
- history_search({ query }) — find prior messages and tool activity by keyword
- history_read({ fromSeq, toSeq }) — read an exact event range

Durable notes (persisted across resets, newest last):
…
```

外加原封不动的 system prompt，以及官方手动压缩选区保留的对话尾部。

兜底边界：如果可切区间已经比 checkpoint 本身还小，官方事务守卫会跳过这次重置、对话原样继续——跳过会以 `compaction/end` 错误事件记在日志里。

## 配置

可选，在 profile 配置行里设置（`~/.dsh/profiles/<profile>/cordis.yml`):

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `budgetHints` | `true` | 显示 25/50/75% 预算提示 |
| `notesMaxChars` | `8000` | 重置后重新注入的笔记预算（保留最新） |
| `historyMaxChars` | `8000` | `history_read` 单次输出上限 |

## 兼容性

需要 dsh ≥ 0.1.2-rc.1（在 0.1.5-rc.1 上开发与验证）。引擎以 `auto: false` 子类化官方 `BasicCompactionEngine`；如果未来 dsh 改变该类的 `summarize()` 钩子或手动压缩路径，本插件需要同步更新。

## License

[MIT](LICENSE)
