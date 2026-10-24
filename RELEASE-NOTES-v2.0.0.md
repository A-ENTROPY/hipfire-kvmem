# v2.0.0 — hipfire × KVMem

这一版换了引擎：从 llama.cpp + ROCmFP4 的 C++ 构建，换成 Rust 写的 RDNA 原生引擎 hipfire，
并把 KVMem 的分页 KV 完整移植进去。旧版仍在 v1.x release 里。

## 实测

agent harness（工具调用 / 多轮 / 长上下文）连续 3 小时 14 分，20,928 步，峰值深度 198,673 token：

- 中位 **32.4 tok/s**（p10 28.0，最高 52.5），单步中位 **77.8 ms**
- 低于 15 tok/s 的采样块：**0**
- 报错：`page provisioning refused` / `capacity exhausted` / `completion failed` / `panicked` 全部 **0**
- 那次跑完，模型自己把一个 Android 项目编译出了 APK

C 档（page-softmax + 图传播 α=0.2）单独跑 1.82 小时 / 33,780 步，中位 32.0 tok/s、单步 77.1 ms，
与性能档持平；图传播累计约 25 万次接受、7 次拒绝。

## 这一版修掉的三处缺陷

1. **准入页数算术**：`held_pages` 用 `descriptor.seq_len` 抵扣窗口页，165k 深回合下少抵 159 页，
   把 9 页需求算成 168 页 → `page demand exceeds pool`（`retryable=false`）→ 压测中断。
   改成用块表已物化的页数。
2. **KV 采集每层阻塞回读**：`step_overlaps_query()` 拿不到提问区间时返回「重叠」，16 层每层一次
   `download_f32`，`harvest` 从 40 ms 爬到 123 ms、GPU 占用掉到 53%、速度 27 → 10.9 tok/s。
   改成空区间只用设备累加器。
3. **冷回合未释放旧窗口**：`rewind_to(0)` 后「洞自检」被 `registered_tokens() > 0` 挡住，
   `pool.release` 从未执行，冷预填从页 0 写入时撞洞 → `server capacity exhausted`。
   把同函数里已有的 `rewind_to(0) + pool.release` 补到冷回合分支。

## 包内容

引擎与网关二进制、HIP 运行库（amdhip64.dll 16 MB）、预编译内核（744 个 .hsaco，11 MB）、
中文调参面板、预设、脚本、对齐与性能调查文档。**不含模型权重**（约 15 GB，自行量化或获取）。

## 已知问题（发布时如实记录）

1. **DFlash 推测解码比 MTP 慢，建议用 MTP。** 实测同机同模型：DFlash（B=16）单步 219 ms、15 tok/s；
   MTP 单步 77.8 ms、32 tok/s。DFlash 每步 16 个草稿只接受约 3.3 个（≈20%），草稿成本收不回来。
   该次测试深度 21,750（小于 36,864 窗口），打分 0 次、换页累计 0，因此与 KVMem 分页无关。
2. **DFlash + 深上下文存在掉速风险（潜在断崖）。** KV 采集的设备累加器门槛是
   `DECODE_CAPTURE_MAX_ROWS = 12` 行，DFlash 验证批为 16 行；浅上下文无碍，深度超过窗口后
   会退回每层阻塞回读（即此前把解码拖到 13 tok/s 的病灶）。修法是把阈值抬到 32。
3. **DFlash 下分段计时缺失。** `fwd split` / `fa split` / `harvest 分支` 的门槛是 `n <= 8`，
   `draft prof` 只统计 MTP，故 DFlash 只能从总时长反推。

## 安装

解压即用，无安装程序。`start-panel.bat` 或 `start-engine.bat`，两条路都路径无关。

需要 Windows x64 + RDNA 显卡；面板需要 Node.js 18+。
