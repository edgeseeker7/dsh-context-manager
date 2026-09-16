# dsh-context-manager

DeepSeek Harness 的显式上下文内存子系统。一个插件,四层内存,七个工具,一个命令。

[English README](README.md)

## 要解决的问题

上下文窗口涨满时,官方压缩把旧历史替换成一份 LLM 摘要。这份摘要是**唯一**的桥——它会静悄悄地丢东西("忘了还自信"),多次压缩错误层层累积,而且没有任何逐字信息能保证存活。

## 模型:四层内存

```
① 保险柜  pin: 逐字事实,住在 system prompt 最后一段。
            任何压缩都遮蔽不了它,永不经过 LLM 转述;w* 工作区 pin 也扛得住
            /reset,t* 任务级 pin 则会被 /reset 清除。
② 日记     notes: 模型自己提炼的笔记,存在会话文件里。
            /reset 时注入 checkpoint。
③ 草稿     /reset 的 checkpoint: 确定性的机械栏目(本次清除/存活的
            pin、最后一条用户消息、高频 id/路径/URL)
            + LLM 摘要(标注"未验证") + 笔记 + 检索说明。
④ 交换区   完整会话日志。什么都不删;
            history_search / history_read 按需取回任何原文。
```

回收策略:**pin = mlock(锁定),官方 compact = 带摘要的 GC,/reset = 批量 free** 堆(和任务级 pin)。

## 工具(装进每个 agent,子 agent 也有)

| 工具 | 语义 |
|------|------|
| `context_alloc(text, label, scope[, sourceSeq])` | 逐字钉入一条事实,返回句柄(`t*`/`w*`)。`scope: "task"`(默认)随 `/reset` 清除;`"permanent"` 跨本工作区的会话永存。`sourceSeq` 记录事实出自哪条日志事件(`context_list` 可见,不进 vault 正文)。 |
| `context_free(handle)` | 释放一个 pin。句柄单调递增——被释放的句柄是悬空的;只有损坏(已隔离并告警)的存储才会重置计数器。 |
| `context_list()` | 分配表:每个 pin 的句柄/标签/计费大小/年龄 + 配额占用。 |
| `notes_append(text[, supersedes, tags, sourceSeq])` | 持久日记,JSONL 只追加,每条有稳定 id(`n7`)。三个可选的"边"是模型自己造结构的原语:`supersedes` 让被取代的旧笔记折叠成一行审计条目(版本链),`tags` 把笔记装进自建的桶,`sourceSeq` 指向来源日志事件。 |
| `notes_read([listTags, id, tag, includeSuperseded])` | 读日记:默认显示活跃笔记 + 折叠的已取代条目;`listTags` 枚举全部桶及活跃条数,`id` 逐字取单条(含链状态,也是被截断笔记的逃生口),`tag` 只读一个桶,`includeSuperseded` 展开折叠条目全文。 |
| `history_search(query[, limit, beforeSeq])` | 混合匹配的全日志搜索,含被压缩/切掉的段落:整串短语 → 全词命中 → 部分词三档,按密度排序,默认排除自己的记忆工具流量(`includeSelf` 可加回)。命中带字符 `offset` 可续读。 |
| `history_read(fromSeq, toSeq[, offset])` | 精确区间读;单条超长事件的读取被截断时,用截断标记给出的 `offset` 续读。 |

节拍提醒(每 20 次非内存类工具调用一次,搭在工具结果里、使 prompt 前缀保持可缓存)提醒模型钉逐字关键事实、记提炼过的进展——和 dsh-subagent-progress 里让 notify_user 汇报可靠的是同一个模式。

## `/reset`

和输入框里的 `/compact` 并排。把可切的历史替换成混合 checkpoint(机械栏目 + 标注"未验证"的草稿 + 笔记 + 检索说明),释放本会话的任务级 pin,并如实报告清理结果——写盘失败会明说并记 warn,绝不谎报已释放。官方自动压缩**不动**,仍是默认。

### 可查看的 checkpoint(Web UI)

原版聊天界面只有 `/compact` 能展开看摘要(它的渲染器按命令名硬编码)。本插件自带一个小客户端包,通过官方的多头认领投影和 `conversation.chat.node` 插槽机制注册自己的会话 Definition 和节点渲染器:`/reset` 之后,命令结果下方会出现一条可展开的**"上下文已重置"**行——点开就能逐字阅读本次注入的完整 checkpoint(markdown 渲染)。不改动任何宿主代码。

## 配额(按窗口动态推导的双阀)

pin 住在 system prompt,每次请求都交租,所以保险柜的上限来自**当前发起 alloc 的 agent 实际路由到的模型**(主会话和每个子 agent 各自解析自己的模型):

- 总量:`pinsWindowRatio`(默认 5%)× 该模型声明的 `contextWindow` × 3 字符/token
- 单个 pin:与总量同值(一条不能超过整个保险柜预算);label 限长 200 字符
- 计费用的是渲染后的 pin:逐字正文 + label + handle 行

`pinsMaxChars`(默认 12000)和 `pinMaxChars`(默认 4000)只在**窗口解析失败**时作为 fallback 上限;没有绝对下限,换到小窗口模型,保险柜就真的变小。

配额打满时 alloc 被拒绝,并在错误里附上最老的几个任务级 pin 作为释放候选——诚实的失败加扶手,绝不静悄悄地自动驱逐。

保险柜还有一道**渲染闸**(v1.5.0 起):alloc 只是写入时的准入检查,所以渲染器每次请求都用**读者**的窗口重新评估配额——大窗口会话灌满的工作区保险柜不会灌爆小窗口会话的提示词。超出的 pin 用一行响亮的 `[vault overflow …]` 点名省略(仍在册,`context_list` 可见)。

## 配置

| 键 | 默认 | 含义 |
|-----|------|------|
| `budgetHints` | `true` | 25/50/75% 量化预算提示(缓存稳定)。 |
| `llmSummary` | `true` | `/reset` 调一次缓存友好的 LLM 草稿;`false` = 纯硬切。 |
| `notesMaxChars` | `8000` | 笔记读取预算(最旧的截断,标记会说明丢了多少)。 |
| `historyMaxChars` | `8000` | 单次 `history_read` 单页上限(超长事件用 `offset` 续读)。 |
| `pinMaxChars` | `4000` | 单 pin 上限——窗口解析失败时的 **fallback**。 |
| `pinsMaxChars` | 12000 | 两种 scope 合计的 pin 总量上限——窗口解析失败时的 **fallback**。 |
| `pinsWindowRatio` | `0.05` | pin 可占所路由模型上下文窗口的比例(真正的门槛)。 |
| `nudgeEvery` | `20` | 多少次工具调用提醒一次。 |
| `suggestCount` | `3` | 配额拒绝时建议释放的候选数。 |
| `summarizationProvider` / `summarizationModel` / `maxTokens` | — | 可选的草稿调用路由,透传给官方摘要器。 |

## 存储位置

- 任务级 pin:`~/.dsh/context-manager/pins/<sessionId>.json`
- 工作区 pin:`~/.dsh/context-manager/pins/ws/<workspace-hash>.json`——规范化 cwd 的 sha256(取前 16 个 hex 字符),同工作区所有会话和子 agent 共享;v1.1.0 的 slug 文件名会在首次触碰时迁移
- 笔记:`~/.dsh/context-manager/notes/<sessionId>.jsonl`(v1.4.0 起)——一行一条结构化笔记。v1 的 markdown 日记和旧的 `~/.dsh/context-reset/notes/` 会在首次触碰时惰性迁移成编号条目(合并,绝不覆盖),原文件保留不动
- 所有 pin/notes 写入都走只用 `node:fs` 实现的 O_EXCL lockfile(过期锁回收 + 有限重试),两个 Harness 进程无法交错读-改-写;不新增任何 npm 运行时依赖
- pin 存储损坏时改名为 `<file>.corrupt-<timestamp>` 并告警、按空库启动;能解析出 nextHandle 就抢救,保不住会在告警里说明

## 设计说明

- **pin 为什么住 system prompt**:它是唯一每次请求都重新拼装的层——唯一不会被历史替换遮蔽的位置(pin 只因显式 free,或 `/reset` 清空 `t*` 任务级 scope 而离开)。pin 段排在最后(order 10300,在官方 persona 后缀之后),pin 增删对 KV 缓存的破坏最小。
- **为什么是 free+alloc 而不是 update 工具**:三个工具比四个好;换句柄顶多是悬空(可解释),复用句柄是错误指针。
- **为什么模型自己管 pin**:用户钉打断心流,引擎启发式会误判;自觉性风险由节拍提醒 + 量化预算提示兜底。
- 本插件取代 `dsh-context-reset`(同一个引擎、同一个 `/reset`,新增 malloc 层)。

## 兼容性

dsh 官方插件用 `peerDependencies` 声明对自己触碰的 `@deepseek-ai/*` 核心包的版本契约(比如 `dsh-compaction-basic` 声明了八个核心包),本插件遵循同一约定。核心包按发布列车(0.1.x-rc)整体联动,所以一个区间即可覆盖整个宿主。

**支持范围:dsh ≥ 0.1.6-alpha.1 且 < 0.2.0。** 运行时解析决定了这句话的实际含义:link 安装的插件会从**自己的** `node_modules` 解析 `@deepseek-ai/*` 导入,而不是从宿主安装目录解析——所以本地副本必须带着实际运行平台的 API 面。`devDependencies` 因此跟随在用的平台版本(当前 0.1.6-alpha.1;`dsh-code-runtime` 不跟随每列火车发布,保持其最新发布版 0.1.5-rc.2)。手工指到宿主 npx 缓存的符号链接不是替代方案——缓存一变链接就空。

### 平台升级

宿主 dsh 版本变更后,首次启动前先把本插件对齐:

1. 把 `devDependencies` 里每个 `@deepseek-ai/*` 条目指向新平台版本(逐个确认 npm 上存在;跳过该列火车的包保持其最新发布版)。`peerDependencies` 的下限同步到同一边界。
2. `pnpm install`
3. `pnpm run check` —— smoke 套件必须保持全绿。
4. 启动冒烟:`npx -y @deepseek-ai/dsh@<version> web` 必须无插件树错误加载。

下限分析来自本插件实际使用的 API 面,已逐一对照各核心版本的发布 tarball 核实:

| 我们使用的 API | 包 | 引入版本 |
|---|---|---|
| `SessionSeq` + `session.eventAt()`(history 工具、reset 计数) | `@deepseek-ai/dsh-session` | **0.1.2-rc.1**(0.1.0-rc.8 和 0.1.1-rc.2 都没有) |
| `BasicCompactionEngine` + `summarize()` 覆写钩子 | `@deepseek-ai/dsh-compaction-basic` | ≤ 0.1.0-rc.8 |
| `ManualCompactionError` | `@deepseek-ai/dsh-compaction` | ≤ 0.1.0-rc.8 |
| `defineTool`(带 output schema 的工具注册) | `@deepseek-ai/dsh-tools` | ≤ 0.1.0-rc.8 |
| `dshHomePath` | `@deepseek-ai/dsh-home-paths` | ≤ 0.1.0-rc.8 |
| `commands` / `llm` / `tokenMeter` / `sessions` 服务、`agent/created` 事件 | `@deepseek-ai/dsh-commands` 等 | ≤ 0.1.0-rc.8 |

历史上的约束瓶颈是 `SessionSeq`(0.1.2-rc.1 引入);声明的下限此后已随上面的运行时对齐策略前移。

关于声明区间的一点说明:npm semver 无法表达"X 之后的所有预发布列车"——在同元组预发布规则下,`>=0.1.6-alpha.1 <0.2.0` 严格解析时只认 0.1.2-rc.* 一列,而官方插件的 `^0.1.5-rc.1` 是钉死单列、每次发布重声明。实际上 pnpm 对已装宿主做 peer 检查是宽松的(0.1.5-rc.1 在安装时能满足这些区间),所以这些区间作为"文档化下限"是有效的;本节才是契约意图的权威声明。

## 许可证

MIT
