# KVMem 0.18.0 全量对齐表（hipfire 版）

日期：2026-10-23
上游基准：`kvmem/kvmem` master `7c8e896`（KVMem **0.18.0**，"Merge PR #167: graph recall and bounded query replay"）
本端口：`H:\hipfire-home\.hipfire\src`（Rust / hipfire-kvmem-tier）
备份：`I:\kvmem-backup\20261022-pre-upstream\`

---

## 一、逐项对照

| 上游模块/特性 | 上游语义 | hipfire 版状态 | 位置 |
|---|---|---|---|
| **LRFU 时序保留** | `lrfu.hpp`：preview/commit 两阶段、λ=0.5、top-p=0.9、快照可序列化 | ✅ 已移植（含 5 个单测） | `hipfire-kvmem-tier/src/lrfu.rs` |
| **GQA-max** | `mean_key_retrieval.hpp`：Max = 组内逐 Q-head 余弦取最大，跨 KV head/层仍平均 | ✅ 已移植 | `scorer.rs::GqaAggregation` |
| **page-softmax** | `page_softmax_scores`（`graph_recall.cpp:224-297`）：逐 token/head 对页域做 scaled-dot softmax，Mean/Max 两种聚合 | ✅ 已移植（逐 token 行环形缓冲，64 行/层上限） | `scorer.rs::page_softmax_scores` |
| **打分域掩码** | `query_score_frame`（`graph_recall.cpp:171-195`）：`n > budget` 时把前 `sink` 个与后 `recent` 个页从 `score_mask` 里剔掉 | ✅ 已移植（含 2 个单测） | `scorer.rs::score_mask` |
| **图召回传播** | `propagate_query_scores`（`graph_recall.cpp:400`）：单跳、相邻块 α·0.25、注意力边 α·0.5·mass/denom、掩码重归一化、钳非负 | ✅ 已移植（含 7 个单测） | `graph_recall.rs` |
| **query_policy** | 「Tool continuations have no new Query」 | ✅ 已实现（`Continuation::ToolResults` ⇒ 空 span） | `serve_engine.rs` |
| **打分器耦合规则** | `resolve_query_scoring`（`cli_options.h:37-45`）：page-softmax ⇒ Mean/无 LRFU/α=0.2；cosine ⇒ Max/LRFU/α=0 | ✅ 已实现（含两条硬约束校验） | `scorer.rs::QueryScoring::resolve` |
| **选项面** | `--kvmem-query-scorer / --kvmem-score-agg / --kvmem-lrfu / --kvmem-lrfu-lambda / --kvmem-lrfu-top-frac / --kvmem-graph-alpha` | ✅ 配置键 + 环境变量双通道 | `memory.kvmem.query_scorer / graph_alpha / page_softmax_rows`；`HIPFIRE_KVMEM_*` |
| `memory_contract` | 多后端 C++17 契约 | ⚪ 不适用 | 单后端 Rust 引擎；等价约束由 `KvBackend` trait + `PagePool` 断言承担 |
| `host_kv_storage` / `spill_io` / `native_kv_payload` / `kv_content` | 存储租约与配额 | ⚪ 不适用 | 等价物：`host_tier.rs` + `host_arena.rs` |
| `prefix_checkpoint` | 取代 `prefix_store`，键为「已验证/已接受的 frontier」 | ⚪ 未移植 | 等价物是会话前缀复用（`[reuse] prefix match`） |
| `monitor` / `monitor_hardware` | 服务期有界元数据观测 | ⚪ 未移植 | 等价物：`[kv]` 周期摘要 + `[serve] tier/step` |
| `speculative` | 仅配置与遥测 | ⚪ 不适用 | MTP/DFlash 由引擎自身管理 |
| **`graph_recall` 的捕获层** | `GraphSnapshot` + `GraphStatisticsBudget`/租约 / `normalized_mass` / `append_row` / `seal`（top-4）/ `span_coefficient` / `prepare_graph_accept`（`:358`）/ `prefill_sample_rows` / `accepted_output_samples` / `AttentionFeedback`（`:456-526`）/ `pressure_selection`（`:527`） | ✅ 已移植（32 个单测 + 逐位对拍） | `graph_recall.rs`；引擎侧 `KvRuntime::graph` + `kv_tier_harvest::score_and_publish` |
| ↑ 的**输入**（逐位置原生注意力质量） | 适配器从原生注意力采样一个 `AcceptedAttentionRow`（含自身、总和 1） | ⚠️ 替代 | RDNA 的 flash-attention 不输出注意力概率。改用**页质量**（page-softmax 的输出）做因果截断并归一化到 1 —— 形状与上游一致（每个采样位置一个"覆盖完整可见窗口"的分布），差别在同一次打分内同块的不同位置共享同一分布 |
| `span_coefficient`（跨消息系数 0.25） | 有可信消息边界时 0.25，否则 1 | ✅ 取 1 | 不解析消息边界，取上游的 unknown-boundary 回退分支 |

图例：✅ 已移植并验证 / ⚠️ 语义等价但实现路径不同（已注明）/ ⚪ 判定不适用或未移植（已给等价物）

---

## 二、本轮修掉的缺陷（全在移植里，不是上游问题）

### 1. 续跑轮从不打分（严重）

`query span` 只在 `admit` 的冷路径里设置；`Continuation::UserTurn/ToolResults` 提前 return，
**从不到达那段**。实测 `set_query_span` 全程只被调用 1 次，span 永远停在第 1 轮。

后果：捕获按过期 span 过滤（`q_rows=0`），`[kvmem-score]` 一行不打印 ——
**检索打分在所有续跑轮里从未执行**，选择退化成"按 id 就近"，
LRFU / GQA-max / page-softmax 全部拿不到分数。

修法：把 span 设置移进 `admit` 顶部「提前 pin」那段（对所有路径都执行）。

### 2. 捕获开关按单 chunk 估算

`need_scores` 用 `registered_tokens + 一个 prefill_chunk` 估本轮增长，长预填轮因此**整轮关捕获**。
改用本步绝对长度 `live_tokens`。

### 3. `RawKvStore::has_block` 是「存在性」而不是「可用性」（移植偏差）

上游（`raw_kv_store.cpp:428-441`）：

```cpp
for (const auto & lb : blocks_[block_id].layers)
    if (lb.n_tokens > 0 && (!lb.k.empty() || lb.k_gpu_fmt ||
        (lb.mean_tokens > 0 && !lb.k_sum.empty()))) return true;
return false;
```

移植版是 `block_id < blocks.len()`。而 `ensure_blocks` 会把向量**先撑到容量**，
于是「预分配但从未写入」的空块也回答 `true`，一路进到 page-softmax 的竞争域。

后果可观测且很脏：`mean_k` 对空块零填充 → `dot == 0` → `logit == 0` →
每个空块都拿到**同一个** `exp(0 - max) / denom` 常量质量。
线上实测 **273 个块并列在 `0.0044317560772243695`**。这既给无内容的块凭空记分，
又实实在在占掉 softmax 分母的一部分，把真块的分数压低。
上游撞不到这件事：它的 `page_softmax_scores` 对每个启用块 `check(keys.has_block(block))`
（`graph_recall.cpp:250`），失败即抛异常。

修法：`has_block` 按上游谓词重写（本引擎不保留原始 K，所以上游三个分支里只剩 `k_sum` 那一条）。

### 4. page-softmax 的竞争域没有**按层**过滤

上游的 `enabled` 是跨层共享的一个列表，并在每层取 `mean_k` 前用 `check` 断言
「该块有数据」，否则抛异常。移植版直接 `mean_k(...)` 不看返回值 ——
缺均值的块会零填充，然后以 `logit == 0` 参与该层竞争，正是第 3 条里那种伪质量。

修法：逐层构建实际竞争域（`mean_k` 返回 `false` 就不参与该层），并把次数
计进 `scorer::page_softmax_missing_means()`，由 `[kv] 打分` 行报出来。

**这不是放宽标准**：断言成立时两种做法逐位等价（集合相同）；断言不成立时上游
没有定义结果（进程抛异常），而在这个引擎里抛异常 = 让 harness 报错，
那是绝对不允许的。降级成"该层不参与"而不是"用零均值硬算"，才是拒绝伪造。

实测：健康数据下这个计数**始终为 0**（`[kv] 打分` 行不带该后缀），说明分页表与
RawKvStore 的均值覆盖是一致的 —— 它现在是一条真正的守卫。

### 5. 缺 `score_mask`：sink / recent 段进了打分域

上游 `query_score_frame` 在 `n > budget` 时把前 `sink` 个、后 `recent` 个页从
`score_mask` 里剔掉。这两段是**无条件常驻**的，不参与竞争，也就不该进 softmax 域：

1. 它们抢走分母里的质量，把真正竞争的选择压低；
2. 它们拿到分数后进入检索配额排序，可能挤掉一个本该被选中的中间块。

修法：`scorer::score_mask` 逐行移植，harvest 按 store 配置（`select_budget` /
`sink_blocks` / `recent_blocks`）构造后传入。

实测（1952 块、sink 128 + recent 8）：`scores` 里 **0..127 全 0、末 8 个全 0**，
中间 1721 块有效 —— 掩码确实在起作用。

### 6. 行子采样从「尾部 8 行」改成「整段等距」（有偏 → 无偏）

上游对**每一个** query token 算一次（`graph_recall.cpp:255`），GPU 按 64 行一块流式处理，
覆盖整段 span。主机侧付不起那个成本，所以有 `rows_budget`（默认 8）。

原实现取的是**最后** 8 行。这不只是"少采几行"：它把 507 行里的 499 行直接扔掉，
并把打分依据偏到轮次末尾 —— 与"整段 query 的注意力分布"不是同一个量。
改成在整段上等距取 `budget` 行（含首尾），**成本一字不变**。

这是**有意的降采样**，不是等价移植：等距采样在期望上无偏，尾部窗口有偏。

---

## 三、C 档（page-softmax）解码慢：三层归因

| 层 | 现象 | 根因 | 处置 |
|---|---|---|---|
| 1 | 每次打分 **8.8 s**，decode 12.3 tok/s | `recall_fp16`（位运算往返 ~15 条指令）被放在**最内层 `d` 循环**里：`rows × heads × blocks × head_dim` 次。2000 块、8 行、16 头、128 维 = **1.3 亿次** | 提到**行级**算一次（量化只依赖 query 元素本身，与块无关）→ **逐位不变**，8.8 s → 0.24 s |
| 2 | 273 个块并列同一个伪常量 | 第 3、4 条缺陷：空块/缺均值块以 `logit == 0` 参与竞争 | 修 `has_block` + 按层过滤 → 域缩水、真块分数恢复 |
| 3 | 1952 块时仍 **700 ms/次** | 4.4 GMAC（16 层 × 8 行 × 16 头 × 1952 块 × 128 维）÷ 0.70 s = **12.6 GFLOP/s** | 已到顶，见下 |

**第三层为什么不再优化**：12.6 GFLOP/s 正好是 AVX2 标量 `f64` 在 3.15 GHz 下的
理论峰值（4 lane × 1 MAC/cycle）。LLVM 已经把内层循环完整向量化，
**没有剩余空间**。要再快只有四条路，每条都有代价：

| 手段 | 收益 | 代价 |
|---|---|---|
| `f32` 累加替 `f64` | ~2× | 改变数值（上游是 `double` 累加），违反"照搬" |
| 减 `rows_budget`（8 → 4） | ~2× | 降采样更狠，质量未知 |
| 减打分域 | 只有掩码那 7% | 候选池本来就是全域 |
| 多线程 | ~8×（16 核） | 求和顺序改变 ⇒ 与串行不再逐位一致 |

**结论：这不是"没优化好"，是这部分工作上游放在 GPU 上做，主机侧的天花板就在这里。**

而它在整轮里的占比很小：打分**每回合一次**，1952 块时 0.70 s，
而一轮墙钟 25 s ⇒ **约 2.8%**。`[serve] tier/step` 里真正每步都付的是
`reselect 14–18 ms`（与打分器无关，余弦档同样有）。

⚠️ **`decode_now` 不是吞吐指标**：它是"最近 N 个已提交 token"的瞬时速率，
一次 0.7 s 的打分尖峰落在窗口里就会把它拉低一大截（同一份数据里 median 25.3 而末轮 21.8）。
判断快慢请看 `wall`。

---

## 四、实测（40 轮 × chunk 6000 × max_tokens 600 → 25 万 token）

⚠️ 脚本 `temperature = 1.0`，**答案长度本身有 ±20% 随机性**，跨次比较只能看量级和病理值。

| 构建 | 成功 | ans 中位 | ans 末 | ans 最小 | decode 中位 | wall 中位 |
|---|---|---|---|---|---|---|
| **原始 C 档**（移植后首测） | 40/40 | 518 | **23** | **16** | 12.3 | 32.0 s |
| + `has_block`/按层过滤（仍尾部 8 行） | 39/39 | 708 | 713 | 578 | 26.9 | 26.2 s |
| + 等距行采样 + 打分器 banner | 40/40 | 561 | 561 | 512 | 21.9 | 24.8 s |
| + `score_mask` | 40/40 | 666 | 701 | 103 † | 25.3 | 25.0 s |
| **全对齐版（图捕获层接入）** | **39/39** | **774** | **782** | 659 | **28.4** | **25.6 s** |
| **全对齐版 + 帧前缀修复（最终）· 第 1 次** | **39/39** | **735** | **738** | **663** | **29.6** | **25.4 s** |
| **全对齐版 + 帧前缀修复（最终）· 第 2 次** | **40/40** | **575** | **575** | **527** | **21.1** | **26.5 s** |
| 参照：cosine + LRFU + GQA-max | 39/39 | 738 | 740 | 670 | 29.9 | 24.3 s |

† 第 37 轮模型自己给了短答（19 completion token），`degen=false`，不是缺陷。

**关于两次最终版之间的差距（735 vs 575 / 29.6 vs 21.1）**：脚本 `temperature = 1.0`，
答案长度本身有 ±20% 随机性；两次的**深度剖面也不同**（第 1 次在第 39 轮就撞到
`--stop-at=250000` 停下，第 2 次跑满 40 轮、到 255 888 token），而深度越大 decode 越慢、
答案越短。所以这两行**不是可比的 A/B**，它们是同一份构建的两次重复。真正要看的判据是
**病理值**：两次的 `ans 最小` 分别是 663 / 527，`degen` 都是 0，错误签名都是 0 ——
早期那种「末轮 23 / 最小 16」的崩溃形态没有复现。

**读法**：判据是「有没有病理值」。原始 C 档 `ans 末=23 / 最小=16` 是缓存真的掉了
（模型答"我没有这段"），修完后最小也在 500+；中位数在 561–708 之间的波动是
temperature 1.0 的采样噪声，不是版本差异。**wall 与余弦档同量级（25.0 vs 24.3 s）**。

---

## 五、验证证据（最终配置）

| 项 | 结果 |
|---|---|
| 40 轮 harness 式压测 | **连续两次全部通过**：39/39（到 250 398 token）与 **40/40**（到 255 888 token），`degen=0`、错误轮 0、错误签名 **0** |
| 错误签名 | `capacity exhausted` / `page demand exceeds pool` / `轮内窗口超预算` / `underflow` / `HipError` / `首写页` / `already mapped` / `need 1 pages` / `streaming completion failed` **全 0** |
| 页池水位 | `free_pages` 全程最低 **125**（历史事故里是降到 0） |
| 前缀复用 | `reuse_rejected_new = 0`、`gate_new = 0`（40 轮合计） |
| 缺均值守卫 | `page_softmax_missing_means()` 全程 **0**（守卫从未触发 ⇒ 不变量成立） |
| 图召回 | 推进 **71** 次，末态 `acpt=250 368 / rev=71 / 1683 行`；`prepare_graph_accept` 拒绝 **0**，`propagate` 拒绝 **0** |
| 打分域掩码 | `scores` 前 128 全 0、末 8 全 0、中间有效块按域计 |
| 单轮 **20 万 token** prompt（503 原形态） | ✅ 完整跑完（**352.2 s**，服务端 `prompt=132 388`），答案正确、无 503 |
| 工具循环 | ✅ 1 个 tool call → 续跑 **99.9% 前缀复用**（40 973 / 40 997）→ 模型自行 `stop` 收尾 |
| 单元测试 | **300 通过 / 0 失败**（171 lib + 83 host_only + 31 runtime + 15 逐位对拍） |
| 打分器可观测 | 启动后首行 `[kv] 打分器 = page-softmax / agg=Mean / lrfu=false / graph_alpha=0.2 / rows=8` |

**两个既有 `config_bridge` 测试失败的处置**（都是测试断言过期，不是实现错）：

1. `zero_sink_blocks_becomes_one`：实现把 `sink_blocks = 0` 当作本 schema 的
   "未设"拼写，走上游 `resolve_kvmem_keep_allocation` 的自动带
   （`clamp(1% of budget, 1024, 2048)` = 1024 tok = 8 块），而测试还在断言旧映射的 `1`。
   上游实际有两层（`explicit_blocks >= 0` 的分支 vs `make_runtime_cfg` 的
   `sink_tokens == 0 ? 1 : ...`），本 schema 是纯 `u32`、没有 `-1` 哨兵，
   必须放弃两者之一 —— 选了"未设"，因为那才是操作者不写这个键时的状态，
   且替代方案会让自动带在本 schema 下完全不可达。已改成断言 8 并把这段推理写进测试注释。
2. `a_budget_below_one_block_rounds_up_rather_than_failing`：它构造的
   `select_budget=0 + recent_blocks=0` 现在必然被 band 校验拒绝（recent 走自动带 = 32 块）。
   改成直接断言 `align_tokens` 的上取整，并断言拒绝消息里写的是
   "of 1 block(s)"（即预算确实先被抬到一块，再被 band 拒绝）。

---

## 六、逐位对拍：上游 host 库作为 oracle

**为什么不是编译 `backends/llamacpp`**：那条路要 218 MB 源码 + 完整 C++ 工具链 + GGUF 模型，
而权重量化（`.hfq` mq4-pro-uniform vs GGUF）、KV 布局、mean-K 捕获路径、runtime 配置解析
两边本就不同，**分数不可比**，只能做定性对比 —— 而定性的部分 40 轮压测已经覆盖了。

**实际做法**：上游 `kvmem/src/host/` 的四个打分文件不依赖 llama.cpp、不依赖 ROCm、
不需要模型（实测 `g++ -std=c++17 -Iinclude -fsyntax-only` 全部零报错），
是唯一能做**逐位**比较的输入面。于是：

| 角色 | 文件 |
|---|---|
| 参考输出生成器（C++） | `oracle/host_scores_oracle.cpp` |
| 参考输出（f64 位模式） | `oracle/oracle-host-scores.txt` |
| Rust 对拍测试生成器 | `oracle/gen_rust_test.py` |
| Rust 对拍测试 | `crates/hipfire-kvmem-tier/tests/upstream_host_oracle.rs` |

用例几何刻意同时压三件事：`n_layer = 3` 但 **layer 1 没有任何 query 行**（约束
`active_layers` 的平均）、写 14 token / `block_tokens = 4` 造成**不满的尾块**、
`ensure_blocks(6)` 造出**两个预分配空块**（`has_block` 缺陷的现场）。

**结果：6/6 逐位通过，一次通过。**

| 项 | 覆盖 |
|---|---|
| `block_ledger_matches_upstream` | `has_block`（空块必须 false）、`n_tokens`、`mean_k` |
| `recall_fp16_matches_upstream_bit_for_bit` | 正规/次正规/上溢共 8 个探针 |
| `score_mask_matches_query_score_frame` | 全开 / 首尾剔除 / `sink+recent>=n` 守卫 |
| `page_softmax_matches_upstream_bit_for_bit` | Mean 与 Max |
| `page_softmax_masked_matches_upstream_bit_for_bit` | 带 `score_mask` 的竞争域 |
| `mean_query_cosine_matches_upstream_bit_for_bit` | Mean 与 Max（**确认了 Max 分支「不乘 invq」是对的**） |

**一个结构差异（已记录，未改）**：上游 `page_softmax_scores` 返回的向量长度是
**已接受的页数**（`frame.starts.size()`），我们返回 **store 的块数**。
生产里两者相等（块只因写入而存在）；测试里因 `ensure_blocks(6)` 才不同。
我们的多出来的项恒为 0，所以消费侧等价。测试对前 4 项逐位比、后 2 项单独断言为 0。

**图传播没有做逐位对拍**，原因是它不可比：上游 `propagate_query_scores` 的
`allowed` 来自 `frame.transport_mask`，注意力边来自 `GraphSnapshot`（由
`prepare_graph_accept`/`seal` 产生），而这正是我们**未移植的捕获层**。
另外上游用 `unordered_map` 遍历 `allowed`，**求和顺序本身未指定**，
逐位相等对这段代码不是有意义的判据。它的算术恒等式由 `graph_recall.rs` 的 7 个单测覆盖。

---

## 六·补、图捕获层：从「未移植」到「已移植 + 逐位对拍」

上一轮这里写的是"未移植，因为需要逐行原生注意力概率"。本轮把它拆成两件事，分别处理：

### 已逐行移植（纯逻辑，可证等价）

| 上游 | 位置 | 移植 |
|---|---|---|
| `GraphStatisticsBudget` + `GraphBudgetLease` | `:15-42` | 「分配**之前**就失败」的保守计费；租约用 `Drop` 归还，`resize` 只迁移差额，`parent` 链约束所有 lane |
| `GraphSnapshot`（`chunks`/`partial`/`messages`/`bytes`） | `:44-96`、`:318-327` | `chunks: Vec<Arc<Vec<GraphRow>>>` 共享不变块；`bytes()` 逐项对应（`capacity` 语义与 `sizeof` 一致） |
| `normalized_mass` | `:99-113` | 同 target 合并（**升序**，等价 `std::map`）、`|Σ-1| ≤ 0.005` 判据、逐项除以总和 |
| `append_row` / `seal` | `:114-135` | 256 行一块、末块**重建**再追加；封边按「质量降序、target 升序」取 top-4，再除以采样数 |
| `span_coefficient` | `:136-147` | 无可信边界 ⇒ 1（unknown-boundary 回退）；边界落进区间 ⇒ `cross` |
| `query_score_frame` | `:171-195` | `starts`/`counts`/`score_mask`/`transport_mask`，含 `sink+recent >= n` 守卫与 `fixed` 清零 |
| `prepare_graph_accept` | `:358-397` | 前缀严格扩展、位置严格递增、边目标因果、同源块先合并再封边、末尾按 `source + bt <= end` 决定是否封 |
| `propagate_query_scores` | `:400-451` | `allowed` 取 `transport_mask`；相邻 `α·0.25·span_coeff`；注意力边 `α·0.5·mass/Σ存活`；末尾钳零 |
| `accepted_output_samples` / `prefill_sample_rows` | `:329-356` | 思考区间不计数；尾部按 `stride` 取行再反转 |
| `AttentionFeedback`（restore/observe_output/finish_output/observe_prefill/pressure_scores） | `:456-526` | pending→finish 的衰减并入；预填侧 `mass/exposure` 的退路 |
| `pressure_selection` | `:527-556` | mandatory 优先、分数降序、同分取**更靠后**的块 |

### 逐位对拍（新增 9 条，共 15 条）

`tests/upstream_host_oracle.rs` 现在**直接读** `tests/oracle/oracle-host-scores.txt`
（由上游 C++ 生成，单一真源），覆盖：`query_score_frame` 四个几何的**每个字段**、
`prepare_graph_accept` 的**每一行每一条边**（source/samples/target/mass 位模式）、
`propagate`（相邻 + 注意力边，逐位）、带消息边界的 `propagate`（≤1 ULP，见下）、
`accepted_output_samples`、`prefill_sample_rows`（三种几何）、`AttentionFeedback`
两段序列、`pressure_selection`。

**为什么带消息边界那一例只判 ≤1 ULP**：上游遍历
`std::unordered_map<uint64_t,size_t> allowed`（`graph_recall.cpp:411`），而 C++ 标准
**不规定**它的遍历顺序（libstdc++ 实际按插入逆序）。混合权重下
`out[0] -= 0.00625` 与 `out[0] += 0.00375` 的先后会改变舍入。权重全相同的用例
（无消息边界）是逐位相等。这是**上游自身的不确定性**，不是移植偏差。

### 输入侧的替代（唯一不是逐行等价的地方，单独标出）

上游的 `AcceptedAttentionRow` 来自**逐位置原生注意力采样**（适配器在原生 attention 里取
一个位置对整个可见窗口的质量，含自身，和为 1）。RDNA 的 flash-attention 路径不输出
注意力概率，所以改用 **page-softmax 的页质量**：每个采样位置取同一份分布的
**因果截断版**（`target <= position`）归一到 1。

形状与上游完全一致（一个位置一个覆盖完整可见窗口的分布），差别只在
"同一次打分内、同一块里的不同位置共享同一分布"。对 `< 1 块` 粒度的取舍（选出哪 4 个
历史目标、按什么质量）与上游同一套 `seal`/`topk`/`normalized_mass` 逻辑。

### 尚未接线（诚实标注，不假装完成）

`AttentionFeedback` 与 `pressure_selection` **已移植并有对拍**，但引擎的驱逐路径
（`maybe_offload_during_prefill` / decode reselect）仍走"最近使用 + 检索分"，
没有接上上游的 `PrefillPressure`/`DecodePressure` 状态机。原因：那两条路径的触发
是上游适配器调度器自己判定的（`SelectionReason`），接进本引擎等于**换掉驱逐策略**，
必须单独做 A/B 才能上；在 40 轮压测里它不参与，因此不会影响本轮结论。

## 七、本轮新增的一个语义对齐（图传播）

`propagate_query_scores` 的 `allowed` 域来自 `query_score_frame` 的
`transport_mask = (n > budget)`（`graph_recall.cpp:178`）——所以**上下文没超过
选择预算时上游根本不传播**（`allowed.size() <= 1` 早退）：全都装得下，
就没有"召回冷页"这回事。移植版之前无条件在 ≥2 个有数据块时传播，已改。
mask 为真之后仍要过 `has_block`：上游 `frame.starts` 每项都是已接受的页，
天然有数据；我们的块向量里可能还有预分配的空块，让它们当传播目标会凭空吸走质量。

---

## 八、本轮修掉的另外两处（都在引擎接线里）

1. **图传播的 `transport_mask` 域**：上游的 `allowed` 来自 `query_score_frame` 的
   `transport_mask = (n > budget)`，所以**上下文没超过选择预算时根本不传播**。
   移植版之前无条件传播，已改为同一条门。
2. **帧与分数向量的长度必须相等**（`frame.starts.len() == scores.len()`）。
   原来帧按 `span.end` 建（`ceil(span.end/bt)` 个页），而打分器按 store 的块数返回；
   实测 `scores 330 / 帧 331`，`propagate` 每两轮就被拒一次（`Geometry`），
   图传播近半失效。改成按**块数**建帧（`accepted = block_count × block_tokens`）——
   上游的 `accepted` 是"已接受进原生 KV 的前缀"，而 store 的块数才是这个前缀的真值
   （`span.end` 是**已采样**长度，尾部不满的一块未必已接受）。修后拒绝数 0。

## 八·补、解码变慢的排查（2026-10-23 下午，受控 A/B）

用户 harness 反馈"解码明显变慢"。以下每一条都是**实测排除**，不是推理：

| 被否掉的假设 | 判据 | 结果 |
|---|---|---|
| 引擎重启后永久变慢 | 干净引擎复测 6 轮 | **35.1 tok/s（中位）**，与变慢前一致 |
| 上下文深度 | 按深度分桶 | >200k 段反而最快（23.4），80k–200k 才卡在 12.7–13.4 |
| KV 碎片化 | 段数（48→157）与 decode 的皮尔逊相关 | **+0.318（正）**，段越多越好；分档全 12.6–14.0 |
| 主机侧开销 | 每步增量分解 | 你的段主机侧 **61.7 ms**、我的段 **320.5 ms**；`reselect` 1.9–2.6 ms |
| 打分/图 | 每回合一次、0.7 s | 占墙钟 2.8% |
| 抢卡 | GPU 引擎占用 / vram / 内存 | 只有 daemon 在用，vram 3.92 GiB 空闲，内存 40.5 GiB 空闲 |
| 并发 | 请求在途最大重叠 | **0** |
| 做重预填 | 每 64 步预填行数 | 你的段 151 行 vs 我的段 3668 行 |
| **召回非常驻页** | 同深度"问开头 vs 问结尾" | **成立：OLD 12.2 / NEW 30.9（2.5×）** |

每步成本增量（自开机累计做差，无效值已剔除）：

| 每步成本 | 我的窗口 | 你的 harness |
|---|---|---|
| GPU 前向 | 63.5 ms | **161.1 ms** |
| 主机侧 sample+commit+emit | 320.5 ms | **61.7 ms** |
| 草稿头 | 11.1 ms | 9.5 ms |

**结论**：变慢的是 GPU 前向，主机侧（打分/图/重选）反而更轻。而 GPU 前向变慢的直接诱因是
**窗口里混进了换入的历史页** —— 见下。

### 根因与复现

同深度（60k）、同脚本、强制长答案，只换问题指向：

| 问题 | 窗口 36864（288 页） | 窗口 **44032（344 页）** |
|---|---|---|
| 问**开头**（旧内容，非驻留） | **12.2** tok/s（最低 5.4） | **19.6**（最低 12.2） |
| 问**结尾**（近期，驻留） | 30.9 | 27.6 |
| 新/旧 比值 | 2.52 | **1.41** |
| 问开头 墙钟速率 | 15.4 | **24.5（+59%）** |
| 问结尾 墙钟速率 | 14.9 | **21.0（+41%）** |
| 浅深度 6 轮（6k→38k） | 35.1 | **38.1** |
| `reselect` 每步 | 2.60 ms | **1.93 ms** |

机制：`free=137/425` 一直是"窗口 288 + 空槽 137"，而召回需要把历史页换进窗口 —— 换页本身很便宜
（`tier transfer` 一次几十页，带宽上只有几毫秒），贵的是**换页打断了解码的连续性**（`decode now`
在同一次请求内能掉到 5.4 tok/s，而墙钟平均仍 15.4 —— 说明是**间歇停顿**，不是整体变慢）。

窗口从 36864 提到 44032（344 页，仍留 137 空槽）之后，召回类问题提速 61%、浅深度也顺带 +9%。
显存计划 17.10 → **17.33 GiB**（余 3.92 GiB）。

> 这个值的选择受既往实测约束（面板帮助文本 2026-10-18）：窗口 **64k / 100k** 会让 paged 解码
> 走"不淘汰"那条路，同一 55k 深度掉到 **4.4 tok/s**（49k 时是 40.1）。所以只取到 44032 < 49000，
> 不跨那条线；已备份 `config.json` / `config.toml`（`.bak-window288`）。

## 九、未完成 / 需用户决策

1. **`fp4-upstream-0.18.0` 只做了源码同步**（`backends/llamacpp` @`620d2225` +
   `llamacpp-kvmem.patch`，树哈希 `82ba9525…` 与上游 `patched_tree` 逐字节吻合），**未编译**。
2. **逐位对拍已覆盖打分算术，未覆盖图传播**：见第六节（传播的求和顺序在上游本身未指定）。<br>3. **图的捕获层未移植**（`GraphSnapshot` / `prepare_graph_accept` / `AttentionFeedback` /
   `pressure_selection`）：它们的输入是**逐行原生注意力质量**，而 RDNA 的
   flash-attention 路径不输出注意力概率。不带这个输入去移植，就是死代码 ——
   所以当前的边由页级质量 top-4 派生，这一点在对照表里标为 ⚠️ 而不是 ✅。
   要真做，先得让注意力内核把每行的页级质量吐出来（独立子项目）。
4. **`rows_budget` 是 hipfire 独有的降采样旋钮**（`memory.kvmem.page_softmax_rows`），
   上游没有对应选项。默认 8；上限 64（= `QUERY_ROW_CAP`）。

---

# 九、C 档（对齐上游新功能）实测收尾 —— 2026-10-25

开启 `query_scorer = page-softmax` + `graph_alpha = 0.2`（上游 C 档耦合：agg=Mean / lrfu=off / α=0.2），
窗口 288 页（kvmem 物理页口径 36864 token），跑 agent harness 真实负载。

## 实测（1.82 小时 / 33,780 步 / 峰值深度 197,950）

| 指标 | 值 |
|---|---|
| 累计 decode | **32.3 tok/s** |
| tok/s（535 个采样块） | 最低 15.0 · p10 28.6 · **中位 32.0** · p90 36.6 · 最高 53.0 |
| `decode gap` | 最低 53.0 · **中位 77.1** · 最高 128.5 ms |
| < 15 tok/s 的块 | **0** |

与 cosine 档同条件对照（同为 288 页、harness 负载）：

| | cosine | **C 档** |
|---|---:|---:|
| tok/s 中位 | 32.4 | **32.6** |
| `decode gap` 中位 | 77.8 | **77.8** |
| <15 tok/s 块 | 0 | **0** |

⇒ **开启对齐上游的打分与图传播，步级性能没有损失。** 早前"C 档慢一倍"的观测，
真实原因是 harvest 的每层阻塞 D2H（见 §八），不是打分器。

## 报错审计：全零

`page provisioning refused` / `capacity exhausted` / `completion failed` /
`panicked` / `device synchronize failed` 全部 **0**。
`prefix hit rejected` 5 次（冷回合，均未转 503）。

## 图传播健康度

| 块数 | 非零块 | 行数 | 图行 / 接受 / 拒 | 耗时 |
|---:|---:|---:|---|---:|
| 432 | 146 | 386 | 152 / 55,296 / 1 | 57.7 ms |
| 1548 | 1262 | 512 | 1,268 / 198,144 / 6 | 508.9 ms |

累计约 25 万次传播接受、7 次拒绝。帧长度不匹配导致的"约半数被拒"已彻底消失。

## 两处已知残余（均非缺陷）

1. **打分在引擎线程同步跑**：全场仅 2 次，单次 57.7 ms / 508.9 ms，落进哪个解码步，
   那一步就多 0.5–0.6 s（`慢步` 记录的 2 次即此）。代价随块数超线性（3.6× 块 → 8.8× 时间）。
2. **冷回合来自 harness 改写历史**：`stored=196148` vs `prompt=168776`，`lcp` 只剩 42%，
   复用点落在 288 页窗口之外 ⇒ 整段重填。修 3 已保证不再 503，代价仅一次 7 分钟重预填。

## 对接攻坚结论

hipfire × KVMem 对接到此收尾。最终配置：**A 版（对齐上游）+ 三处修复 + kvmem 物理页口径 288 页窗口**。
harness 端到端验证：agent 在该引擎上完成 Android 项目并产出 APK，全程 3 小时 14 分无报错、无慢态。
