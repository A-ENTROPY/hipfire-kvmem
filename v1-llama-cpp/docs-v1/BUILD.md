# 从源码编译 / Build from source

本仓库**不包含** llama.cpp 源码（那是 300+ MB，且需要与 ROCmFP4 基线合并）。
构建流程是：拉取指定基线 → 套 KVMem 补丁 → 编译。

## 0. 环境要求

| 组件 | 版本（实测通过） | 说明 |
|---|---|---|
| Windows | x64 | 本仓库实测于 Windows 10/11 |
| MSVC | **14.44.35207**（VS 2022 Build Tools） | 必须 14.44；14.51（VS 2026）会因 `<cmath>` constexpr 问题编译失败 |
| ROCm / HIP SDK | **7.2（HIP 7.2.60201-38d754472）** | 标准布局安装（`amdgcn\bitcode` 在顶层） |
| AMD Clang | 21.0.0git（随 ROCm 7.2 提供） | 与 KVMem 官方包同一编译器版本 |
| CMake | ≥ 3.24（实测 4.4.0） | |
| Ninja | 1.12.1 | 单文件 exe 即可 |
| 磁盘 | ≥ 10 GB | 源码 + 构建产物 |
| 显卡 | **gfx1100 / gfx1030 / gfx1151 / gfx1200** | 通过 `-DCMAKE_HIP_ARCHITECTURES` 指定 |

> ⚠️ **ROCm 安装路径的坑**：必须使用**标准布局**的 ROCm（设备库位于 `<ROCM>\amdgcn\bitcode`）。
> 某些新发行版（如 TheRock）把设备库放在 `<ROCM>\lib\llvm\amdgcn\bitcode`，clang 找不到，会报
> `cannot find ROCm device library`。用 `scripts/build-windows.bat` 时它会自动隔离 PATH 中的干扰项。

## 1. 拉取基线并打补丁

```powershell
.\scripts\fetch-llama-and-patch.ps1 -RocmPath "C:\Program Files\AMD\ROCm\7.2"
```

脚本会：
1. 下载 `walcz-de/llama.cpp-ROCmFP4` 的 `rocmfp4-pre-3466812d-20260902` 分支到 `llama.cpp\`
2. 应用 `patches/llama-kvmem-current.patch`（KVMem 的 llama.cpp 集成补丁）—— 该基线与其钉定版本仅差 8 个提交，**零冲突**

想手工做也可以：

```powershell
curl.exe -L -o llama-src.tar.gz https://codeload.github.com/walcz-de/llama.cpp-ROCmFP4/tar.gz/refs/heads/rocmfp4-pre-3466812d-20260902
tar -xzf llama-src.tar.gz
Move-Item llama.cpp-ROCmFP4-rocmfp4-pre-3466812d-20260902 llama.cpp
cd llama.cpp
git init; git apply ..\patches\llama-kvmem-current.patch
```

## 2. 编译

```powershell
.\scripts\build-windows.bat -RocmPath "C:\Program Files\AMD\ROCm\7.2" -GpuTarget gfx1100 -Jobs 24
```

产物在 `build-hip-win\bin\`，主要文件是 **`llama-kvmem-server.exe`**。

关键 CMake 开关（脚本已内置）：

```
-DGGML_HIP=ON -DGGML_CUDA=OFF -DROCM_PATH=<ROCM>
-DCMAKE_HIP_ARCHITECTURES=<gfx arch> -DGPU_TARGETS=<gfx arch>
-DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_VULKAN=OFF
-DKVMEM_BUILD_LLAMA=ON -DLLAMA_KVMEM=ON -DLLAMA_KVMEM_ROOT=<repo>
```

> `GGML_CUDA_FA_ALL_QUANTS` 会被 CMakeLists 强制打开（`--kv-dtype q5_0` 需要），
> 因此首次构建会编译大量 flash-attention 实例 —— **首次编译约 20–40 分钟属正常**。

## 3. 打包发行版

```powershell
.\scripts\package-runtime.ps1 -RocmPath "C:\Program Files\AMD\ROCm\7.2"
```

会生成 `kvmem-rocmfp4-<arch>-windows-rocm7.2.zip`，内含 exe + ROCm 运行库 + 启动脚本（约 740 MB）。

## 4. 运行

```powershell
.\start-kvmem.bat -Model "G:\models\Qwen3.8-27B-Q4_0_ROCMFP4_STRIX.gguf" -Draft "G:\models\Qwen3.8-27B-DFlash2-Q4_K_M.gguf"
```

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `cannot find ROCm device library` | ROCm 不是标准布局（见上方警告），或 PATH 里混入了别的 HIP SDK |
| `invalid ggml type 101` | 你用了**上游原版** llama.cpp 加载 ROCmFP4 模型；必须用本仓库的构建 |
| `MTP draft context is null` | 模型没有内置 nextn 头，却用了 `--spec-type draft-mtp`；改用 `draft-dflash` + `-md` |
| `--spec-type draft-dflash requires --model-draft` | 忘传草稿模型；加 `-md <dflash.gguf>` |
| 速度只有一半 | 检查是否加了 `--threads 0` 或 `--flash-attn on`。旧版会腰斩，本版实测已无影响（±0.7%），留空即可 |
| `deploy` 报错/无输出 | 确认 `llama.cpp` 子目录已打上 KVMem 补丁（存在 `src/llama-kvmem-factory.h`） |
