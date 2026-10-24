# 2026-10-23 性能档 decode 断崖 — 实测记录

被测进程：`hipfire.bat serve --model qwen3.8-27b.mq4-pro-uniform.hfq`
配置：`select_budget=36864`（288 页）、`sink_tokens=16384`、`recent_blocks=8`、
`query_scorer=meanq-cosine`、`graph_alpha=0`、`speculation=mtp`（mtp_k=3）、pool 425 页。

## 1. 断崖形状（原进程 server.log，同一进程内反复翻）

| 时刻 | step | max_pos | 窗口 | forward 累计 | 该块增量 | decode |
|---|---:|---:|---:|---:|---:|---:|
| +969s | 5120 | 81359 | 299 页 | 38.0 ms | 38 ms | 30.5 tok/s |
| +986s | 5184 | 82632 | **288 页** | 39.5 ms | **159 ms** | 14.3 |
| +1380s | 6976 | 96089 | 288 页 | 75.1 ms | 44 ms | 28.8 |
| +1909s | 9472 | 118981 | 288 页 | 95.5 ms | **181 ms** | 13.8 |

**同窗口、同深度（81 359 vs 82 632）差 4.2×**，两个死区都是平顶（82k～118k 恒 173–191 ms）。

## 2. 已排除（每条都有日志证据）

| 候选 | 证据 | 判定 |
|---|---|---|
| 深度 | 82k 与 118k 都 ~180 ms；同进程 152k 时仅 44 ms | ✗ |
| 窗口页数 | 慢态 288 页 **小于** 快态 299 页 | ✗ |
| KV 碎块 | 慢态 264 runs（比快态 284 更整） | ✗ |
| 主机层换页 | 全程 `tier transfer +0 in`，`stage_ins=0` | ✗ |
| 打分 / 图传播 | 1909 秒只触发 1 次（`server.log:342`） | ✗ |
| 显存 | `vram 3.97 GiB` 145 次采样恒定 | ✗ |
| 并发 | 单 daemon、单槽 | ✗ |
| **注意力跳度** | **`[attn-span] max_pos_plus_1` 在 70k 深度仍封顶 36 864 = 窗口，8/8 `translated=true`** | **✗（实测证伪）** |

## 3. 重开进程复现 + 探针结论

用 `HIPFIRE_ATTN_SPAN=1` 重启后实测：

```
[attn-span] rows=4 max_pos_plus_1=13646 translated=true
[attn-span] rows=4 max_pos_plus_1=13736 translated=true
[attn-span] rows=1024 max_pos_plus_1=30720 translated=true
[attn-span] rows=1024 max_pos_plus_1=36864 translated=true   ← 封顶
[attn-span] rows=4 max_pos_plus_1=36829 translated=true
```

⇒ `windowed_positions` 的窗口翻译是对的，注意力跳度恒为窗口 36 864，**与深度无关**。
「跳度被绕过」这条假设排除。

同一进程、70k 深度、110 token 生成的 profile：

```
[serve] decode forward: 4.5 ms/step over 44 decode steps
[serve] loop prof:      post-forward 757.6 ms/step over 127 steps
[serve] decode gap:     172.2 ms/decode-step over 44 steps
[serve] step prof:      735.7 ms/decode-step over 128 steps
[serve] decode now:     9.00 tok/s (111.2 ms/token)
```

**`decode forward = 4.5 ms/步` 是关键**：15 GB 权重不可能 4.5 ms 走完。
⇒ `decode forward` 只量到**主机侧入队**，不是 GPU 计时器。原日志里
「forward 38 → 180」的归属**不可信**；可信数是 `decode gap`（每解码步总墙钟）。

## 4. 修正后的结论

慢的不是 GPU 算力、不是注意力、不是换页量，而是**每个解码步被一次队列抽干/主机侧
同步拖住**：健康 81 ms/步 → 病灶 170–200 ms/步，平顶、随会话状态翻转。
与代码里早已记录的旧病灶同型（`serve_engine.rs:7285`：forward 仅 2.2 ms，而
forward 之后这一步 776 ms，decode 掉到 4.4 tok/s）。

嫌疑守卫：`needs_sync = HIPFIRE_SYNC_EACH_STEP || reclaim_pending_count() > 0`
→ 为真就每步 `device_synchronize()`（`serve_engine.rs:~7284`）。

## 5. 下一步（待执行）

1. 在复现态下确认 `reclaim_pending_count()` 是否**每步**非零。
2. 若是：把「每步抽干」改成「仅空闲页低于水位时抽干」，回收延后一步（流序保证
   新 kernel 排在旧读之后），不改任何数值路径。
3. 复测 70k 深度 `decode gap`，目标回到 81 ms/步。

---

# 第二轮（无人值守攻坚）：实测结论 —— 当前二进制在全部可构造条件下达标

工作区与 `b23a01f` 的差异**只有两个文件**（本次新增的诊断），所以 18:02 跑压测那个
二进制与本轮实测的二进制在计算路径上**完全一致**。

## 逐项 A/B（全部 70k–154k 深度、`select_budget=36864`、mtp_k=3、rows=4）

| 条件 | forward | **decode gap** | 速度 |
|---|---:|---:|---:|
| 70k，temp 0（基线） | 42.5 ms | **79.2 ms** | 41.1 tok/s |
| 70k，temp 1.0 + top_p/k/min_p（= harness 采样设置） | 38.1 | **81.0** | 48.2 |
| 122k，探针开 | 39.1 | **81.0** | 50.0 |
| 70k，6 轮 warm-prefix-reuse | 39.8 | **79.5** | 49.7 |
| 154k，主机层被 3×14 万会话填满 | 39.2 | **83.4** | — |
| 70k，**流式 + 42k token 工具 schema** | 39.6 | **79.5** | 49.7 |
| 70k，sync 计量版 | 42.8 | **79.8** | 40.8 |
| **原压测慢态（server.log 18:18–18:34）** | **180 ms** | **199 ms** | **13.8** |

**目标 30 tok/s 在每一行都被超过，余量 2.6×。** 慢态一次也没复现。

## 新增排除项（均为实测）

| 候选 | 实测 | 判定 |
|---|---|---|
| 探针自身开销 | 探针开/关两臂同为 79.8 ms/步 | ✗ |
| `device_synchronize` 每步抽干 | `sync: 0 次 | reclaim 非零 0/319 步` | ✗ |
| 主机层容量耗尽 | 三会话填满后 83.4 ms/步 | ✗ |
| 流式 + 工具 schema | 79.5 ms/步 | ✗ |
| `temperature=1.0` 采样路径 | 81.0 ms/步 | ✗ |
| 外部进程抢 GPU | 解码期间 `daemon` 占 **98.5%** GPU，桌面栈合计 <1.5% | ✗ |
| 注意力跳度 | 122k 深度时 `max_pos_plus_1=37248`（窗口），`translated=true` | ✗ |

## 新增永久诊断（已编译部署）

1. **跳度指纹**：`windowed_positions` 每步把 `(span, rows, translated)` 写入进程级原子量
   （两次 relaxed store，无分配、无锁、不改计算），`forward_slots::last_attn_span()` 读取。
2. **慢步看门狗**：任何解码步 ≥300 ms 就打印一行（限流 512 步），内容为
   `墙钟 / forward / 其余 | 跳度 span rows translated | win free reg res | commit_rej`。
3. **抽干计量**：周期 profiler 新增
   `sync: N 次 / 总 ms / 每次 ms | 占步墙钟 X% | reclaim 非零 a/b 步 | 其中解码步 N 次`。
4. **GPU 归属采样**：`probe/gpu-watch.ps1`（Windows 性能计数器，按进程给出 GPU 时间占比）。

## 残留

18:02 那场的 199 ms 慢态在重启后的 20 次受控实验里**未再出现**，因此不能宣称"已定位并修好"；
能宣称的是：**移植后的引擎在全部可构造条件下都稳定在 40–50 tok/s**，且慢态若复发，
日志会当场给出定责所需的一行（`慢步`）与抽干计数（`sync`）。

---

# 第三轮：压测中当场复现（22:21–22:40），全仪表观测

引擎 21:59 由面板启动（性能档，探针 `HIPFIRE_ATTN_SPAN=1` 生效），harness 22:19 开始。

## 现场分解（同一场、同一进程内快慢两态）

| t(s) | tok/s | **forward** | gap | tok/步 |
|---:|---:|---:|---:|---:|
| 2234 | 30.6 | 44.7 ms | 82.8 | 2.39 |
| 2245 | 35.2 | 31.2 | 78.0 | 2.75 |
| 2296 | 14.7 | **178.7** | 194.2 | 2.75 |
| 2321 | 12.8 | **180.3** | 195.5 | 2.61 |
| 2359 | 13.9 | **182.6** | 197.3 | 2.83 |

**采纳率（tok/步）两态一致 2.4–2.8** ⇒ 不是猜测解码退化，是**每步 forward 涨 4 倍**。

## 慢态期间引擎侧全部正常

| 量 | 值 | 说明 |
|---|---|---|
| 注意力跳度 | `max_pos_plus_1=37705`，`translated=true` | 封在窗口（36864+slack），不跟 142k 深度 |
| 每步抽干 | `sync: 0 次`，`reclaim 非零 0/4151 步` | 未抽干队列 |
| tier reselect | **1.86 ms/步** | 与快态同 |
| MTP 起草 | **9.5 ms/draft-step** | 与快态同（4 轮实测 9.4–9.5） |
| 窗口 | `win=288 free=137/425 res=36736` | 两态一致 |
| 常驻/登记 | `reg=142943 res=36736` | 一致，无背离 |
| KV 碎块 | `288 pages in 50 contiguous runs` | 比健康态（112 runs）**更整** |
| commit_rej | 22 | 未增长 |

## 慢态期间 GPU 侧全部正常

| 量 | 值 |
|---|---|
| GPU 时间归属 | `daemon 97.1%`，桌面栈合计 <2% |
| 显存 | `daemon 20.15 GB` 独占 / `dwm 3.03 GB` / `vram_free 4.05 GiB` —— **20 秒采样 11 次全程不变** |
| 共享（系统内存）占用 | `daemon Shared Usage = 0.00 GB` ⇒ 模型未被换出显存 |
| prefill（算力型） | 241–259 tok/s，**快慢两态相同** |

## 唯一未变的解释

- **算力不受影响**（prefill 恒定）；
- **小张量 GEMV 不受影响**（MTP 头 9.5 ms 恒定）；
- **只有 14.6 GiB 主权重的流式读取掉了 4 倍**（418 → 88 GB/s）；
- 翻转无固定周期（57s/234s/604s/123s），慢态占比 **79%**。

⇒ 这是**主模型权重流带宽**层面的两态塌陷，与 KV 窗口/跳度/换页/抽干/碎块/显存驻留/外部争抢**全部无关**。

## 顺带查到的实现偏差（待修，但不是本次断崖的成因）

`forward_step` 里 `max_ctx_len = step_max_ctx_len(batch, physical_cap)` 用的是
**绝对位置**（`batch.positions`），而 `windowed_positions()` 只产出翻译后的副本、不改
`batch.positions`。于是注意力 grid 的分块数按绝对深度算：
142k 深度时 `ceil(142164/tile)` ≈ 1111 块，而实际在窗内的只有 288 块（3.9× 过发射）。
实测该过发射**不额外耗带宽**（70k 与 122k 的 forward 同为 39 ms ⇒ 越界块提前退出），
但它是与上游语义不一致的偏差，应改为窗口长度。

## 判决性对照：算力型 prefill 在同场两态下几乎不变

同一场压测、同一进程，按每个 profiler 块的瞬时 forward 分组成"快态 / 慢态"，
再算同块里 prefill 的实际速率：

| 状态 | n | prefill 中位 | forward 中位 |
|---|---:|---:|---:|
| 快态 | 3 | **275 tok/s**（259–321） | 58 ms |
| 慢态 | 13 | **224 tok/s**（73–283） | **179 ms** |

**算力只掉 18%（在块大小差异噪声内），权重流掉 4.7×。**

⇒ 由此**实测排除**：GPU 时钟/功耗/温度节流（会同时拖慢 prefill）、显存挤压/换出
（`Shared Usage = 0`，20.15 GB 独占 11 次采样不变）、外部争抢（daemon 97.1%）、
注意力（span 37705 恒定）、抽干（sync 0）、窗口/碎块/reselect/commit。

⇒ 只剩一个可能：**主模型 14.6 GiB 的逐层权重 GEMV 在慢态换成了效率低 ~4.7× 的
内核变体或访存路径**（prefill 走 GEMM、MTP 头走另一族，两者都实测不受影响）。
下一步要在 dispatch 层把每层实际选中的 GEMV 变体打出来（一次性 banner + 每步直方图）。
