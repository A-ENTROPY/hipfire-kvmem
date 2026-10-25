这个目录放 llama.cpp 侧的引擎与它的运行库。

  llama-kvmem-server.exe   基于上游 KVMem v0.18.0（llama.cpp 基线 7fe450e1）自编译
  amd_comgr0702.dll        ┐
  amd_comgr_3.dll          │
  amdhip64_7.dll           │ ROCm 7.x 运行库。和 hipfire 用的 HIP 10.x
  hipblas.dll              │ 不是同一套，所以必须分目录，不能混进 bin\
  hipblaslt.dll            │
  hiprtc-builtins0702.dll  │
  hiprtc0702.dll           │
  rocblas.dll              ┘
  rocblas\library\         rocBLAS 的 Tensile 内核库（缺了会在处理请求时崩）
  hipblaslt\library\       hipBLASLt 的内核库（同上）

## 这一版二进制怎么来的

上游 v0.18.0 的源码 + 三个本地补丁。上游没有 Windows ROCm 预编译包（release 里只有
CUDA/ninfer），所以必须自己编。

构建环境：
- ROCm 7.2（提供 AMD clang 21）：`C:\Program Files\AMD\ROCm\7.2`
- MSVC 14.44（VS 2022 BuildTools；上游明确说 14.51/VS2026 会拒绝两参 `<cmath>` 内建）
- CMake + Ninja；GPU 目标 `gfx1100`

```bat
set ROCM=C:\Program Files\AMD\ROCm\7.2
set ROCM_PATH=%ROCM%
set HIP_PATH=%ROCM%
set HIP_DEVICE_LIB_PATH=%ROCM%\amdgcn\bitcode
set GPU_TARGETS=gfx1100
python scripts\prepare-backends.py --backend llamacpp
scripts\build-hip.bat
```

三个本地补丁（都在上游树的拷贝里，注释里写了原因）：

1. `backends/llamacpp/ggml/src/ggml-cuda/ggml-cuda.cu`：KVMem 的 `GGML_CUDA_NODE_TRACE`
   诊断块用了 `cudaPeekAtLastError`，HIP 下叫 `hipPeekAtLastError`，加别名映射。
2. 根 `CMakeLists.txt`：`kvmem-stagein-hip` 目标缺 `kvmem/include`（`lrfu.hpp` 找不到）。
3. `kvmem/hip-compat/`：把 `cuda_runtime.h` / `cuda_fp16.h` / `cuda_bf16.h` 转发到
   `hip/hip_runtime.h` / `hip/hip_fp16.h` / `hip/hip_bf16.h`，并在根 `CMakeLists.txt`
   与 `backends/llamacpp/src/CMakeLists.txt` 里加上该目录。

漏掉 `HIP_DEVICE_LIB_PATH` 的症状是：`clang++: error: cannot find ROCm device library`。
漏掉 `kvmem/hip-compat` 的症状是：`fatal error: 'cuda_runtime.h' file not found`。

两个 library 目录随包提供的是 gfx1100 版本（含架构无关的 fallback 库），共约 55 MB。
换到别的 RDNA 卡（gfx1201 / gfx1150 等）时，从该卡对应 ROCm 安装目录里补：

    <ROCm>\bin\rocblas\library\*.hsaco|*.dat
    <ROCm>\bin\hipblaslt\library\

漏掉这两个目录的症状是引擎能启动、能监听，一有请求就打印
"rocBLAS error: Cannot read .../rocblas/library/TensileLibrary.dat" 然后退出。
