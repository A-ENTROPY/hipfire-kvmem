# hipfire × KVMem

**把 KVMem 的分页 KV 移植进 hipfire 这个 RDNA 原生引擎，让 262144 上下文在 24 GB 显卡上真正跑起来。**

hipfire 是 Rust 写的 AMD 原生推理引擎，不是 llama.cpp 的分支。KVMem 是那套「显存里只放一个滑动窗口，其余按块换到主机内存」的 KV 管理方案。这个仓库做的是把后者完整搬进前者——逐文件对照上游移植，保留它的打分、图传播、准入与淘汰策略，而不是自己发明一套近似的。

发行包里**两个引擎都在**：hipfire 侧是原生 Rust 实现，llama.cpp 侧是原来的 KVMem 补丁版。面板上一个下拉框切换，同一份配置、同一个端口。

移植后的实测：agent harness（工具调用、多轮、长上下文，最容易把 KV 打爆的那种负载）连续跑 **3 小时 14 分 / 20,928 步 / 峰值深度 198,673 token**，中位 **32.4 tok/s**、单步 **77.8 ms**，全程没有报错，也没有掉到过 15 tok/s 以下。那次跑完，模型自己把一个 Android 项目编译出了 APK。

## 它解决什么问题

27B 模型按 Q8 存 KV，每 1000 token 大约 34 MB。262144 上下文光 KV 就要 9 GB 上下，再叠 14.6 GB 权重，24 GB 的卡装不下。

KVMem 的办法是只把一部分 KV 留在显存里：

| 组成 | 大小 | 说明 |
|---|---|---|
| sink | 16384 token | 提示词开头（系统提示 + 工具 schema），永不淘汰 |
| recent | 8 页 / 1024 token | 最近写入的尾巴 |
| 打分填充 | 剩余约 152 页 | 按查询相关性排序挑出来 |

窗口一共 288 页 = 36864 token，显存池 425 页 = 54400 token，其余全部落在 12 GB 主机层（2891 个块槽位，约 37 万 token）。换入换出按块走，块大小 128 token。

## 快速开始

需要：Windows x64、gfx1100 / gfx1101 / gfx1201 这类 RDNA 卡、Node.js 18+（用面板的话）。

发行包解压后有两个入口：

```
start-panel.bat     中文调参面板（推荐），127.0.0.1:18201
start-engine.bat    只起引擎，OpenAI 兼容接口 + 内置网页 UI
```

`start-panel.bat` 会自己把引擎拉起来，模型在面板里选。`start-engine.bat` 直接吃 `models\` 里第一个 `.hfq`，也可以把路径当参数传进去：

```
start-engine.bat D:\models\qwen3.8-27b.mq4-pro-uniform.hfq
```

两条路都是**路径无关**的：整个包挪到别的盘、别的目录照样起；配置落在包内 `.hipfire\config.toml`，不碰用户主目录。

### 模型放哪

**放发行包里的 `models\` 目录。** 面板一打开就扫这个目录，主模型、草稿头、`.gguf`、`mmproj`
全部自动填好；按子文件夹分也行（会往下找一层）。也可以放在 `J:\hipfiremodels`、
`J:\kvmemmodels`、`G:\models`、`H:\models`，或者任何名字带 kvmem/hipfire 的目录下的 `models\`；
要指定唯一目录就设环境变量 `KVMEM_HIPFIRE_MODELS_DIR`。

### 两个引擎怎么切

面板顶部「推理引擎」选 hipfire 或 llama.cpp，点「保存并重启」。首次启动时面板会自己扫描模型目录，
把 hipfire 的主模型、草稿头、llama 的 `.gguf` 和 `mmproj` 都填好，不用手工挑。

两个引擎的运行库是分开放的，因为都要一个叫 `amdhip64.dll` 的文件、版本却不同：

```
bin\           hipfire.exe + daemon.exe
bin\runtime\   amdhip64.dll  （HIP 10.x，hipfire 用）
llama\          llama-kvmem-server.exe + ROCm 7.x 的运行库（llama.cpp 用）
share\kvmem\    llama.cpp 侧的网页 UI
```

面板会按是否存在 `llama\llama-kvmem-server.exe` 自动判定，并把该目录加进子进程 PATH。

## 两档配置

面板里一键切换，或者直接套 `presets\` 里的文件。

**性能档（默认）**——打分器 `meanq-cosine`，聚合取 max，LRFU 开，图传播关。选块偏向「最近用过」的连续段，窗口不怎么翻页。

**质量档**——打分器 `page-softmax`，聚合取 mean，LRFU 关，图传播 α=0.2。按查询相关性全局重排窗口。

两档实测速度没有差别（同 288 页窗口：中位 32.4 vs 32.6 tok/s，单步都是 77.8 ms）。早先我以为质量档慢一倍，后来查清楚是 KV 采集路径上每层一次阻塞回读，跟打分器无关，那个问题已经修掉了。

## 这个移植里修掉的三件事

都能在日志里指出具体一行，不是「优化了一下」。

**一、准入页数算错，压测会被 503 打断。** 续写时引擎要判断这一步还需要几页，抵扣量原本用 `descriptor.seq_len`。可对分页槽来说那只是最后一次写前沿的戳：一次 165k 的深回合会把它留在 16438，而块表里实际已经物化了 288 页。少抵 159 页，真实需求 9 页被算成 168 页，池子只剩 136 页空闲，于是判定「需求超过池容量」、`retryable=false`，请求连报六次之后整场压测结束。抵扣改成用块表已物化的页数。

**二、KV 采集每层一次阻塞回读，把解码拖到 13 tok/s。** `step_overlaps_query()` 在拿不到本轮提问位置区间时（agent 回合以工具结果结尾很常见）返回「重叠」，于是十六个全注意力层**每层**都走一次 `download_f32`——`memcpy_dtoh` 会抽干 GPU 队列。表现是 `harvest` 从 40 ms 一路爬到 123 ms、占满整个 forward，其余五段恒定在 0.1–0.3 ms，GPU 占用掉到 53%，速度从 27 掉到 10.9。改成空区间不回读、只用设备累加器，阻塞回读归零。

**三、冷回合没释放上一轮的窗口，冷预填撞洞报 503。** `rewind_to(0)` 只清 tier 的登记，不动 pool 里那张旧窗口表；紧随其后的「洞自检」又因为 `registered_tokens()` 刚被清成 0 而进不去，`pool.release` 从来没执行过。冷预填从第 0 页开始写，那些页既不在旧窗口里、也追加不到它的尾部，provisioning 一路拒绝，最后变成 `server capacity exhausted`。修法是把同函数里早就在用的 `rewind_to(0) + pool.release` 这一对补到冷回合分支。

## 单步成本长什么样

引擎自带分段计时，`server.log` 每 64 步打一行：

```
[serve] decode gap: 77.8 ms/decode-step over 20121 steps
[serve] fwd split: 上传 0.4 | 逐层 46.3（DeltaNet×48 1.2 / FullAttn×16 45.2）| lm_head 0.0 ms
[serve] fa split: 投影+norm 0.1 | harvest 44.7 | RoPE 0.0 | KV写入 0.1 | 注意力 0.1 | 后段 0.2 ms
[serve] harvest 分解: flush D2H 12.3 次/44.5 ms | 发射 64.0 次/0.1 ms | add_layer 16.0 次/44.7 ms
[serve] harvest 分支: 设备累加 16.0 层/步 | 阻塞下载 0.0 层/步
```

77.8 ms 里，46 ms 是 64 层的权重流（48 层线性注意力只用 1.2 ms，16 层全注意力 45.2 ms），30 ms 花在采样与提交。那 44.7 ms 的 `harvest` 是块均值回写，每步约 12 次回读。这段还有压缩空间——改成层内异步落盘、整步一次回读，单步能再降一截——但那是下一轮的事。

## 已知问题

**DFlash 推测解码目前比 MTP 慢，建议先用 MTP。** 实测同一台机器、同一模型：DFlash（B=16）单步 **219 ms**、15 tok/s，其中主模型 forward 只要 3.2 ms，成本几乎全在 forward 之后的草稿与验证段；MTP 单步 77.8 ms、32 tok/s。每步 16 个草稿只接受约 3.3 个，接受率约 20%，草稿的代价没收回来。这次测试跑在 21,750 深度（小于 36,864 窗口），`[kv] 打分` 零次、`tier transfer` 累计 0，所以**与 KVMem 分页无关**，是推测解码路径本身的账。

**由此还带出一个潜在断崖，用它之前请先知道：** KV 采集的设备累加器门槛是 `DECODE_CAPTURE_MAX_ROWS = 12` 行，而 DFlash 的验证批是 16 行。浅上下文（窗口内）没问题，一旦深度超过窗口、采集被激活，16 行会退回**每层一次阻塞回读**——正是把解码拖到 13 tok/s 的那个老病灶。所以现在这套组合下，**DFlash + 深上下文有掉速风险**，修复方式是把这个阈值抬到 32（设备累加器本身按行累加、按块边界 flush，16 行撑得住）。

**DFlash 下分段计时是盲的。** `fwd split` / `fa split` / `harvest 分支` 的门槛是 `n <= 8`，`draft prof` 只统计 MTP。所以 DFlash 出问题时只能从总时长反推，看不到「16 行验证」与「草稿模型」各占多少。这两处诊断门槛下一步会按 `spec_rows` 判定。

## 已知边界

**两个引擎的 KVMem 实现不是同一份代码。** hipfire 侧是本次移植的版本（含三处缺陷修复：准入页数算术、
KV 采集阻塞回读、冷回合窗口释放）；llama.cpp 侧沿用 v1.x 的补丁集，没有这三条修复。所以压力测试的
结论只对 hipfire 侧成立。

**288 页窗口是硬口径。** agent harness 会压缩历史：某次它把 196148 token 的历史压成 168776 token 的提示词，前缀在 42% 处就分叉了。复用点落在窗口之外时只能整段重填，15 万 token 大约七分钟。这种冷回合跑几小时会遇到几次，但不会再变成 503——修三就是为这个。

**模型不在包里。** qwen3.8-27b 这一档约 15 GB，用 `hipfire quantize` 自己做 `.hfq`，或者从别处拿。包里只带引擎、HIP 运行库（16 MB 的 `amdhip64.dll`）和预编译内核（744 个 `.hsaco`，11 MB）。

**ROCm 只要有 HIP 运行库就能跑。** 预编译内核覆盖 gfx1100，正常运行不调用编译器。要现场编译内核才需要完整 ROCm 和 MSVC 头——`hipfire.bat` 会自动 call vcvars64 并把 VC98 的 include 剔掉（不剔会拿到 1998 年的 cstdlib）。

## 目录结构

```
hipfire.bat          启动器（路径无关，纯 ASCII，别往里写中文）
start-engine.bat     只起引擎
start-panel.bat      起面板
config.json          面板配置（不含模型路径，进来先选模型）
bin/                 hipfire.exe + daemon.exe + runtime/amdhip64.dll
llama/               llama-kvmem-server.exe + ROCm 7.x 运行库（llama.cpp 引擎）
share/kvmem/ui/      llama.cpp 侧的网页 UI
.hipfire_kernels/    预编译内核
.hipfire/            引擎配置（首次启动自动生成/更新）
panel/               中文调参面板
presets/             性能档 / 质量档 等预设
scripts/             recall A/B、预设构建、预设回环校验
docs/                对齐文档与性能断崖调查
models/              放 .hfq
```

## 文档

- [`docs/KVMem-0.18-ALIGNMENT.md`](docs/KVMem-0.18-ALIGNMENT.md) — 逐项对齐表、逐位对拍、C 档实测
- [`docs/PERF-CLIFF-2026-10-23.md`](docs/PERF-CLIFF-2026-10-23.md) — 速度断崖的完整调查记录

## 旧版

这个仓库的 v1.x 走的是另一条路：llama.cpp + ROCmFP4 + KVMem 补丁的 C++ 构建。那套仍在 release 里可取，源码在 git 历史里（本仓库改成 hipfire 版之前的所有提交）。
