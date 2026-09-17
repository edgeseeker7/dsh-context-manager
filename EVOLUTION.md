# dsh-context-manager 进化路线（全景版）

(2026-09-17。证据基础:Dream-recall 五臂 325 trials + 五路行业调研 + OpenAI/Anthropic 一手文档 + 六开源系统机制卡 + RAG 文献。本文不按厂商组织,按**设计问题**组织——每个问题给出全行业方案光谱、我们的位置、进化方向。)

## 〇、总设计哲学:从"求模型"到"不麻烦模型"

所有调研材料指向同一条进化主轴:**记忆机制的可靠性 = 把决策点从模型自觉中拿走的程度**。

- 我们今天的形态:协议写"NEVER answer without searching",触发靠模型自由心证——24.6% 零检索率就是这条路线的定价(NeurIPS 2025 与工业界补丁双双证伪 prompt 强制)。
- 行业收敛的终态:**能机械的不 prompt,能管线的不宿主,能常驻的不检索**。模型只负责"用记忆",不负责"决定要不要记忆"。

后文每个设计问题都沿这条主轴展开。

## 一、设计问题光谱

### Q1 触发:记忆什么时候进上下文?

```
模型自觉 ←——————————————————————————→ 管线自动
(我们在这)                                                        (终态)
```

| 方案 | 代表 | 可靠性 | 成本 | 我们的适配 |
|---|---|---|---|---|
| prompt 口号 | 我们的现状 | ✗ 被证伪(16/65 零检索) | 0 | 淘汰 |
| 模型自主+说明书 | Anthropic memory tool | △ 依赖模型素质 | 0 | 参照但不够 |
| 宿主强制首动作 | ADR-027 tool_choice=required | ✓ 触发率 100% | 一次廉价调用 | **v1.9 采用** |
| 分类器闸门 | AgentOS Memory Router / Adaptive-RAG | △~✓ 5-15% 漏判 | 每轮一次小调用 | v2.x 深度门控 |
| 每轮自动检索注入 | Zep Context Block / Mem0 / LlamaIndex | ✓ 但有噪声注入风险 | 每轮检索+token | v2.x 廉价常开层 |
| 小块事实永远注入 | OpenAI saved memories / Claude MEMORY.md / Letta core blocks | ✓✓(无触发问题) | 固定 token 预算 | **v1.9 索引/v2.0 账本** |
| 训练进模型 | OpenAI bio / Self-RAG / Toolformer / Cursor self-summary | ✓ 但不可迁移 | 训练成本 | 不可行(无训练能力) |

**关键洞察**:行业没有单选,全是分层组合——**常驻层无触发问题、枚举层无条件执行、深层按需才被允许"判断"**。

### Q2 记忆存什么形态?

| 形态 | 代表 | 检索难度 | 我们的适配 |
|---|---|---|---|
| 原文全文 | Kimi 超长上下文 / 我们的 swap 日志 | 最高(需好检索) | 保留为底座(无损) |
| 压缩摘要 | compaction / rolling summary | 低但 **summarization drift**(arXiv 2603.07670 实锤:归属定语蒸发+错误继承) | sketch 降级为枚举用途 |
| 规范化事实句 | OpenAI dreaming / Mem0 facts / Anthropic auto memory | 低(答案词汇) | **v2.0 账本采用** |
| 类型化条目+版本链 | Graphiti 双时态 / 我们 notes(supersedes) | 低 | 已有半成品,补类型 |
| 文件树可枚举 | Anthropic memory tool / MEMORY.md | 零(枚举代替检索) | **v1.9 索引渲染** |
| 知识图谱 | Graphiti / Cognee / Mem0g | 低但构建重 | ✗ over-engineering(无图库/embedding) |

**关键洞察**:形态决定检索难度。"原文+好检索"与"事实句+枚举"是两条腿;摘要是最差形态(drift),只能当指针不能当记忆。

### Q3 检索怎么做(原文层之上)?

三层楼,每层都有无 embedding 的可行集:

```
呈现层:  结果形态(FACT(date range)/高亮/置信度) + 多样性(簇上限/MMR) + 位置(lost-in-middle)
召回层:  多路(multi-query)+融合(RRF)+反馈(PRF/RM3 二轮)+扩展(LLM 改写/step-back)
基建层:  CJK 分词(unigram+bigram)+ BM25 打分 + 实体/代号正则倒排
```

- 治词汇错位(水晶盒 vs 内盒):PRF 成本最低 → multi-query 次之 → contextual retrieval 入库治本(Anthropic 实测 -49%)
- 治同簇(limit=6 同主题):簇上限(500-seq 窗口每桶≤2)词项环境优于 MMR
- 治自回环(probe 自己霸榜):当前轮排除边界修正+自匹配降权
- 明确出局:真 HyDE/向量 MMR/cross-encoder(无 embedding/GPU)

### Q4 写入路径:什么时候提取与整理?

| 时机 | 代表 | 我们的适配 |
|---|---|---|
| 每消息实时 | Zep episode 摄入 / Mem0 每消息对 | 太重(每消息 LLM 调用) |
| 事件驱动(约束句式/实体出现) | — | **v2.0 账本写入** |
| 模型自主"值才记" | Anthropic auto memory | 参照(nudge 已有雏形) |
| 防抖批处理 | LangMem ReflectionExecutor | 思路可抄(纯 JS 定时器) |
| 睡眠点离线整理 | Letta sleep-time / OpenAI dreaming | **/reset 前 consolidation(天然睡眠点)** |

### Q5 评测怎么跟上?

- 端到端榜单(LongMemEval/LoCoMo)测不出触发失败——**触发召回率是我们的差异化维度**(24.6% 是稀缺数据)
- 检索/生成分离诊断(RAGAS 式:recall@k 定召回失败,faithfulness 定组装失败)
- 功效:65 题检出 5 点差距需 300+ 题或每题 k=4 重复;配对 bootstrap CI 把"不显著"变"差距<X"

## 二、四层架构的各自进化梯

不推倒重来——每个现有层一条成熟度梯子:

```
vault  ─ 手工 pin ──→ +自动索引(MEMORY.md 式一行一条) ──→ +类型化账本 ──→ 双层常开注入
diary  ─ JSONL notes ──→ +索引渲染进 checkpoint ──→ 事件驱动四类型账本 ──→ /reset 前 consolidation
sketch ─ UNVERIFIED 自残 ──→ 合法化为"枚举检索面的地图" ──→ dreaming 轻量精修 ──→ (或被账本+索引取代)
swap   ─ phrase 匹配 ──→ CJK 分词+BM25 ──→ +PRF/簇上限/multi-query+RRF ──→ contextual retrieval 入库
```

## 三、版本切割(v1.9 → v2.0 → v2.x)

### v1.9 —— 止血(治模式 A 零检索 + 检索质量三件套)

目标:reset 臂均值 0.387 → 0.45+(救回 16 道零检索题的大部分)。

1. **索引常驻**:diary tags buckets 渲染成一行一条进 checkpoint(可枚举面清单,Anthropic MEMORY.md 形态)
2. **无条件首动作**:reset 后 armed,首答前必须"view 索引 + ≥1 次 history_search",宿主 post-execute 拦截(ADR-027 背书,触发失败→0)
3. **CJK unigram+bigram 分词**(检索基建)
4. **PRF/RM3 二轮检索**(首轮 top-k 高频词扩展;19fda262 案例直接可救)
5. **簇上限**(500-seq 窗口每桶≤2)
6. **答案自检门**:悬置指代("all four entities"式)机械回退检索(行业无先例,差异化)
7. **sketch 合法化**:明确"可用于枚举检索面"(不自残)

### v2.0 —— 成型(类型化账本 + 写入整理)

8. **既定事实账本**:四类型(user/feedback/project/reference,抄 Anthropic auto memory 分类),事件驱动写入(约束句式/实体出现),索引常驻+内容按需;notes supersedes 链即版本(Graphiti 双时态轻量版)
9. **/reset 前 consolidation**:近期原文→规范化事实句入账本(dreaming 轻量版,/reset=天然睡眠点);同时治错位 C 与 sketch 质量
10. **检索结果形态**:FACT(date range)稳定布局(Zep constructor)+命中高亮+置信度档位
11. **覆盖工具**:multi-query 改写+RRF 融合+dilated windows 多粒度窗口并集(LangMem 思路)
12. **自回环修正**:当前轮排除边界修正(runtime-context 注入把边界推过 probe 本身)+自匹配降权

### v2.x —— 治本与终态

13. **Contextual Retrieval 入库**:LLM 给 chunk 生成上下文前缀(行业实测检索失败率 -49%),治 C 治本
14. **双层触发终态**:廉价常开(每轮无条件注入 top-3 超短事实,位置=历史之后最新消息之前保前缀缓存,Zep 做法)+ 分类器深度门控——"要不要搜"彻底消失
15. **评测体系**:触发召回率(差异化维度)+ recall@k 分离诊断 + 每题 3 次重复 + 配对 bootstrap CI

### 明确不做(诚实边界)

- 知识图谱(Graphiti/Cognee 整图):构建重、依赖图库,只抄双时态 invalidation 思想
- 向量检索全家桶(Mem0 判重/真 HyDE/向量 MMR/cross-encoder):无 embedding 服务
- sleep-time 双 agent:第二常驻 LLM 进程太重,用 /reset 睡眠点替代
- Kimi 纯长上下文路线:实验证明不是银弹(截尾臂大题 0.288 输掉主战场)

## 四、验证计划(每个版本怎么知道成了)

| 版本 | 验证 | 通过标准 |
|---|---|---|
| v1.9 | 同 65 题复跑 reset 臂 | 零检索题数 16→≤2;总均值 ≥0.45;触发召回率 ≥97% |
| v2.0 | 同集复跑 + 错位专题(19fda262 类) | 错位题得分率显著升;账本索引引用率(trace 统计) |
| v2.x | 分离诊断 + 重复采样 | recall@k 与 faithfulness 分开报;配对 bootstrap CI 不含 0 |

## 五、资产索引

- 实验:`~/.cache/dream-report.md` `~/.cache/dream-aggregate.json` `~/.cache/dream-reset-search-stats.json` 对比页 https://dream-compare.app.msh.team/
- 一手文档:`~/.cache/mem-docs/`(Anthropic memory-tool 全文含系统提示原文/Claude Code auto memory/context-management +39% 数字)
- 调研缓存:`~/memresearch/`(LangMem 代码级精读等 8 份)
- 失败分类:模式 A 触发缺失(24.6%)/ B 覆盖盲区 / C 词汇错位 / D 组装误杀——见 §三每条括注
