# 基准测试 / Benchmarks

> **2026-10-05 全部重测。** 本文件此前记录的 `38.8 / 48.1 / 53.0 / 37.5 tok/s` 等数字
> 是在 **ROCmFP4 的 MMQ 路径损坏**、目标模型输出乱码的状态下测出来的，已全部作废。
> 根因与修复见 [`../README.md`](../README.md) 的「本版修复」一节。

## 数据口径（先读这一段）

| 项 | 说明 |
|---|---|
| **推测解码不打 perf** | 开 `--spec-type draft-mtp` / `draft-dflash` 时**不会**打印 `llama_perf_context_print`，只打印 `KVMEM_GEN_WALL n=<token> ms=<毫秒> toks=<tok/s>`。解析日志必须先匹配这一行。 |
| **不要引用服务端的 `prompt_per_second`** | 推测解码下 `timings.prompt_per_second`（以及 CLI 的 `KVMEM_STAGE` prefill 字段）是**假数字**（曾观测到 26.49 / 85.65 这种量级错乱）。prefill 请用非推测解码跑。 |
| **`--threads` / `--flash-attn` 只存在于服务端** | 精简的 `llama-kvmem-cli.exe` 不接受这两个开关（会直接 `unknown flag` 退出），参数敏感性只能在 `llama-kvmem-server.exe` 上测。 |
| **采样** | 全部为贪心（`temperature=0`），同一提示词、同一输出长度对比。 |

## 测试平台

| 项 | 值 |
|---|---|
| GPU | AMD Radeon **RX 7900 XTX**，gfx1100（RDNA3），24 GB |
| CPU / 内存 | 24 核 / 32 线程 · 64 GB DDR4-3200 四通道 |
| 系统 | Windows x64 |
| ROCm | 7.2（HIP 7.2.60201-38d754472），标准布局安装 |
| 编译 | MSVC 14.44.35207 · AMD Clang 21.0.0git · Ninja |

## 模型

| 角色 | 文件 | 大小 |
|---|---|---|
| **主模型（推荐）** | `Qwen3.8-27B-Q4_0_ROCMFP4_STRIX.gguf` | 13.75 GB |
| **草稿（推荐，MTP sidecar）** | `mtp-Qwen3.8-27B-Q4_0.gguf` | 1.28 GB |
| 主模型（备选） | `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf`（自带 MTP 焊接头） | 11.29 GB |
| 草稿（备选，DFlash2） | `Qwen3.8-27B-DFlash2-Q4_K_M.gguf` | 1.06 GB |

---

## 1. CLI 单轮解码对照（主基准）

**协议**：`llama-kvmem-cli.exe`，单轮生成 **256 token**，`-c 8192`，`-ngl 99`，
`--kv-dtype q8_0`，**不传 `--threads`、不传 `--flash-attn`**（CLI 也不支持）。
速度取日志里的 `KVMEM_GEN_WALL`。

| 配置 | 解码速度 | 相对 | 备注 |
|---|---:|---:|---|
| ROCmFP4 原生（`--spec-type none`） | 43.39 tok/s | 基线 | |
| MTP 草稿 `n_max=1` | 57.40 tok/s | +32% | |
| **MTP 草稿 `n_max=2`** | **63.10 tok/s** | **+45%** | ★ **本机最快** |
| MTP 草稿 `n_max=3` | 61.38 tok/s | +41% | |
| MTP 草稿 `n_max=4` | 58.70 tok/s | +35% | 收益回落 |
| DFlash2 `n_max=3` | 54.64 tok/s | +26% | |
| DFlash2 `n_max=5` | 50.80 tok/s | +17% | |
| IQ3_S 原生 | 45.14 tok/s | 基线 | |
| IQ3_S 焊接头 `n_max=1` | 54.61 tok/s | +21% | |
| **IQ3_S 焊接头 `n_max=2`** | **58.18 tok/s** | **+29%** | IQ3_S 侧最优 |
| IQ3_S 焊接头 `n_max=3` | 52.74 tok/s | +17% | |
| IQ3_S 焊接头 `n_max=4` | 48.87 tok/s | +8% | |

**结论**

1. **草稿数 `n_max = 2` 最好**，而且**两种 MTP 方式（sidecar / 焊接头）都是 2**。加到 4 反而更慢。
2. **ROCmFP4 + MTP sidecar（63.10）比 IQ3_S + 焊接头（58.18）快约 8.5%**，
   所以推荐组合是 STRIX 主模型 + 独立的 `mtp-*.gguf` 草稿。
3. DFlash2 最优仍是 `n_max=3`，但两种情况下都**慢于 MTP sidecar**（54.64 vs 63.10）。

每轮 wall time 12.3–15.1 s（含 256 token 解码 + 模型常驻）。

## 2. 服务端对照

同一台机器、同一组模型，走 HTTP：

**协议**：`llama-kvmem-server.exe`，`-c 32768`、`-b 512`、`-n 4096`、
`--kvmem --kvmem-budget 36864 --kvmem-gen-reserve 32768`、`--kv-dtype q8_0`；
`POST /v1/chat/completions`，`max_tokens=256`、`temperature=0`；
速度取响应里的 `timings.predicted_per_second`。

| 配置 | 解码速度 |
|---|---:|
| 原生（`--spec-type none`） | 40.32 tok/s |
| MTP 草稿 `n_max=2` | **67.00 tok/s** |
| MTP 草稿 `n_max=2`（长请求实测区间） | 68.6–72.3 tok/s |

→ 服务端的批处理调度路径比精简 CLI 更顺，同配置**比 CLI 快约 6%**（67.0 vs 63.1）。

## 3. prefill（提示处理）

**协议**：**关闭推测解码**（否则 prefill 计时行不出现），5356 token 提示词，服务端，
`-c 32768`、`--kvmem`、`--kv-dtype q8_0`，并且**每个 case 都核对输出内容**。

| 构建 | prefill | 输出 |
|---|---:|---|
| 9/27 三合一（MMQ 开，输出正确） | **944 tok/s** | `The capital of France is **Paris**.` ✅ |
| 10/5 坏构建（MMQ 开，输出乱码） | 3818.8 tok/s | `hecifica` ❌ **假数字** |
| **10/5 当前（ROCmFP4 走 MMVQ，输出正确）** | **815.8 tok/s** | `The capital of France is **Paris**.` ✅ |

→ **禁用 MMQ 的真实代价 ≈ -14%**（944 → 816）。
→ 旧版「prefill 825 → 623（-24%）」是**拿 6.5K 提示词的旧数对比 1K 提示词的新数**，
口径不一致，**已作废**。当前构建短提示词（约 1K）读数为 610–625 tok/s（预热占比高）。
→ ⚠️ **坏构建的 3818.8 tok/s 是乱码导致的假快**，绝非 MMQ 的收益。
**在输出不正确时不得引用任何性能数字。**

prefill 对 CPU 线程数 / Flash Attention **同样不敏感**（见第 5.2 节）。

**解码侧的跨构建 A/B（`bench10.ps1`，同协议，256 token）**：
9/27 构建 39.97（无草稿）/ 61.50（MTP2）；**当前构建 40.45 / 67.40**。
→ MMQ→MMVQ 不影响解码，本版解码还更快（MTP2 +9.6%）。

## 4. 上下文长度的代价

**协议**：CLI，MTP 草稿 `n_max=2`，`--kvmem-mtp-state replay`，其余同第 1 节。

| 配置 | 解码速度 |
|---|---:|
| `-c 32768` + `--kvmem` | 62.88 tok/s |
| **`-c 262144` + `--kvmem`** | **63.13 tok/s** |
| `-c 262144`，**去掉 `--kvmem`** | **8.34 tok/s** |

→ **开着 KVMem 时，256K 上下文与 32K 几乎无差别（+0.4%）**：GPU 工作集固定为
`budget + gen-reserve`，与 `-c` 无关，这正是分层 KV 的价值。
→ **一旦去掉 `--kvmem`，256K 立刻塌到 8.34 tok/s**（比 32K 慢 87%）：262144 token 的 KV
装不进 24 GB，被迫卸载到 CPU。这也说明 **`-c 262144` 必须配合 `--kvmem` 才有意义**。

## 5. 参数敏感性

### 5.1 本版结论：这三项已经不影响速度

固定其他条件，只加一个参数（服务端，`-c 32768`，贪心 256 token）：

| 变体 | 关草稿（原生） | 开 MTP 草稿 `n_max=2` |
|---|---:|---:|
| 基准（都不传） | 40.32 tok/s | 67.00 tok/s |
| `+ --threads 0` | 40.31 tok/s（±0%） | 66.90 tok/s（±0%） |
| `+ --flash-attn on` | 40.19 tok/s（-0.3%） | 67.35 tok/s（+0.5%） |
| `+ --ubatch-size 2048` | 40.03 tok/s（-0.7%） | — |

→ **全部差异在 ±0.7% 噪声内。CPU 线程数与 Flash Attention 开关对本版解码已无影响。**
仍然**建议留空**（本机无收益，且留空正是启动脚本与面板的默认值），但不必再当成"腰斩陷阱"。

### 5.2 旧版实测（已作废，仅作历史说明）

上一代构建（KVMem rocm-beta / 9-27 三合一，DFlash2 n=3、`-c 32768`）曾测得：

| 变体 | 解码速度 | 影响 |
|---|---:|---|
| 基准 | 51.45 tok/s | — |
| `+ --threads 0` | 26.60 tok/s | -48%（**本版不复现**） |
| `+ --flash-attn on` | 29.26 tok/s | -44%（**本版不复现**） |

当时的解释是"GPU 全卸载时空转的 CPU 线程争抢采样与图调度"。
这些数字与 MMQ 无关（解码路径本就走 MMVQ），但**在当前构建上已无法复现**，
推测与 2026-10-05 重新钉定上游有关。如果将来又观测到类似骤降，请重新测量后再下结论。

## 6. 三合一 vs 官方基线

同机同协议（CLI，256 token，`-c 8192`）：

| 方案 | 主模型 | 加速 | 解码速度 | 相对各自基线 |
|---|---|---|---:|---:|
| KVMem 官方配方 | IQ3_S（11.29 GB） | MTP 焊接头 `n=2` | 58.18 tok/s | +29% |
| **本仓库（推荐）** | **ROCmFP4 STRIX（13.75 GB）** | **MTP sidecar `n=2`** | **63.10 tok/s** | **+45%** |
| 本仓库 | ROCmFP4 STRIX | DFlash2 `n=3` | 54.64 tok/s | +26% |
| 本仓库 | ROCmFP4 STRIX | 无 | 43.39 tok/s | — |
| 本仓库（不推荐组合） | IQ3_S | DFlash2 `n=3` | 12.6 tok/s | 旧版数据，结论仍成立 |

⚠️ 最后一行：IQ3_S 是 GDN 混合架构，其回滚机制与独立草稿模型不合，DFlash2 会显著变慢。
**不要**用 DFlash2 配 IQ3_S，要提速就用它自带的 MTP 焊接头。

## 7. 复现方式

```powershell
cd G:\KVMem

# 服务端（推荐组合，MTP sidecar）
.\start-kvmem.bat

# 关掉推测解码，量 prefill
.\start-kvmem.bat -Spec none

# 只列模型，看脚本识别成什么
.\start-kvmem.bat -List

# 干跑，只打印最终命令
.\start-kvmem.bat -DryRun
```

本次报告使用的基准脚本（在源码工作区 `H:\dshworkspace\KVMem\sync-v017`）：

| 脚本 | 内容 |
|---|---|
| `bench2.ps1` | 第 1 节：CLI 11 组解码 + 2 组 prefill |
| `bench4.ps1` | 第 4 节：KVMem 开关 × 32K/256K |
| `bench5.ps1` | 第 5.1 节：服务端 + MTP 草稿的三个参数变体 |
| `bench6.ps1` | 第 5.1 节：服务端原生（无草稿）的三个参数变体 |
| `bench7.ps1` | 第 5.2 节：**prefill 敏感度**（5356 token，6 个变体） |
| `bench8.ps1` | 第 3 节早期数据（后被 bench9 证伪，仅留档） |
| `bench9.ps1` | 第 3 节：**prefill 三方 A/B + 每个 case 的输出正确性核对** |
| `bench10.ps1` | 第 3 节末：**解码跨构建 A/B**（9/27 vs 当前 × 无草稿/MTP2） |

产物在 `bench2/` `bench4/` `bench5/` `bench6/` `bench7/` `bench8/` `bench9/` `bench10/`
下的 `summary.csv` 与原始日志。

> 注意：不要把不同上下文长度、不同输出长度、不同采样设置的数字直接对比。
> 本文所有对照都在同一协议下完成。旧的 `38.8 / 48.1 / 53.0` 系列数字**不要再用**；
> 旧的 `825 → 623（-24%）` 与坏构建的 `3818.8 tok/s` 同样**不要再用**（见第 3 节）。
