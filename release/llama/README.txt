这个目录在发行包里放 llama.cpp 侧的引擎与它的运行库：

  llama-kvmem-server.exe   自编译三合一（KVMem + ROCmFP4 + MTP/DFlash2）
  amd_comgr0702.dll        ┐
  amd_comgr_3.dll          │
  amdhip64_7.dll           │ ROCm 7.x 运行库，
  hipblas.dll              │ 与 hipfire 用的 HIP 10.x
  hipblaslt.dll            │ 不是同一套 —— 所以必须
  hiprtc-builtins0702.dll  │ 分目录放，不能混进 bin\
  hiprtc0702.dll           │
  rocblas.dll              ┘

仓库里只保留这份说明，二进制不进 git（发布在 Release 资产里）。
重新组装时：

  llama-kvmem-server.exe  ← build-fp4/bin/（v1.1.0 那次构建的产物）
  *.dll                   ← 任一自带运行库的 KVMem 发行包 bin/ 目录

面板靠 `llama\llama-kvmem-server.exe` 是否存在来判定要不要启用 llama 引擎，
并会把该目录加进子进程 PATH（见 kvmem-control.mjs 里的 LLAMA_DIR / cleanPath）。
