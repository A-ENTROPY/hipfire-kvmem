# v2.2.0 — llama.cpp 引擎升级到 KVMem v0.18.0

v2.1.1 里的 llama 引擎是基于 KVMem **v0.16.0-rc3** 的旧移植。这一版换成上游
**v0.18.0**（`kvmem/kvmem`，llama.cpp 基线 `7fe450e1`），我们自己维护的 HIP 适配补丁全部作废。

## 为什么这次能直接吃上游

上游已经原生支持 Windows + ROCm/HIP 了（`docs/rocm.md`、`scripts/rocm/start-iq3.ps1`、
HIP 补丁 `0001`–`0005`），MTP 与 DFlash2 也都在树里。所以不需要再造一遍移植，
直接把上游编译出来即可。

**顺带澄清一件事**：检查过我们 v1 的 9 个补丁，`rocmfp4` / 类型 100·101 的命中数全是 0——
之前 README 里写的「ROCmFP4 AMD 专用 4-bit 格式」并不在这个移植里，它只是模型文件名里的
量化配方标签。也就是说没有任何自有格式需要往回搬。

## 实测对比（同一台机器、同一模型、同一份配置）

配置：`--ctx-size 1000000 --kvmem-budget 36864 --kvmem-gen-reserve 36864 --kv-dtype q4_0 --spec-type draft-mtp`。

| 指标 | v0.16（旧） | **v0.18（新）** |
|---|---:|---:|
| 浅上下文解码 | ~28 tok/s | **37.9–38.9 tok/s** |
| 77,024 token 深度解码 | — | **33.89 tok/s** |
| 77,024 token 深度预填 | — | **542.95 tok/s** |
| 引擎显存 | 21,089 MB | **18,362 MB** |
| 系统共享显存 | 3,716 MB | **2,755 MB** |

深度参考（旧版）：28 万深度约 30 tok/s，79 万深度掉到 **3.56 tok/s**。新版在 7.7 万深度
仍有 33.9 tok/s，显存还少了 2.7 GB。

## 为了让它在这个环境编出来，打了三个本地补丁

都记在 `llama/README.txt` 里，可复现：

1. **`cudaPeekAtLastError` 未声明**（`ggml/src/ggml-cuda/ggml-cuda.cu`，KVMem 的
   `GGML_CUDA_NODE_TRACE` 诊断块）。HIP 下叫 `hipPeekAtLastError`，加一条别名映射。
2. **`kvmem-stagein-hip` 目标缺 `kvmem/include`**——`llama-kvmem-execution.h → hooks.h`
   引到 `kvmem/lrfu.hpp`，该目标没拿到这个 include 目录。
3. **CUDA 头名在 HIP 下不存在**：`cuda_runtime.h` / `cuda_fp16.h` / `cuda_bf16.h`
   加一层 `kvmem/hip-compat/` 转发到 `hip/hip_runtime.h` 等。

另外构建环境需要 `ROCM_PATH` / `HIP_DEVICE_LIB_PATH` 环境变量（上游脚本只传了
`-DROCM_PATH`，到不了 clang，会报 "cannot find ROCm device library"）。

## 面板改动

- llama 侧「推测解码模式」只保留 **`none` / `draft-mtp`**：v0.18 的 `--spec-type` 不接受
  `draft-dflash`，也不接受独立的 `--model-draft`（会以 `unknown flag` 退出）。
- 旧配置里残留 `draft-dflash` 时，预检查直接拦下并说明原因，不再让引擎启动后失败。

## 配置口径：不改，仍用我们自己的

上游推荐的是 `budget 28672 + gen_reserve 16384`，那是给 262144 上下文配的。
**我们的上下文长度不同，这一版不动配置**，继续用 `ctx 1000000 / budget 36864 /
gen_reserve 36864 / q4_0 / MTP`。

已知后果：单轮生成超过 `gen_reserve` 仍会被硬墙打死（上游 v0.18 也没修这个上限，
`gen_reserve` 内的环形缓冲依旧只是他们的设计文档）。Qwen3.8-27B 的思维链偶尔会跑
3.6 万 token，撞上就会终止那一轮——要缓解就让 `gen_reserve` 比 `n_predict` 大一点。

## 升级方式

解压到新目录，把旧包的 `models\` 挪过去即可。旧包可以留着做回退。
