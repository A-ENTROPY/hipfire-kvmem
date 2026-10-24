这个目录放 llama.cpp 侧的引擎与它的运行库。

  llama-kvmem-server.exe   自编译三合一（KVMem + ROCmFP4 + MTP/DFlash2）
  amd_comgr0702.dll        ┐
  amd_comgr_3.dll          │
  amdhip64_7.dll           │ ROCm 7.x 运行库。和 hipfire 用的 HIP 10.x
  hipblas.dll              │ 不是同一套，所以必须分目录，不能混进 bin\
  hipblaslt.dll            │
  hiprtc-builtins0702.dll  │
  hiprtc0702.dll           │
  rocblas.dll              ┘
  rocblas\library\         rocBLAS 的 Tensile 内核库（**缺了会在处理请求时崩**）
  hipblaslt\library\       hipBLASLt 的内核库（同上）

两个 library 目录随包提供的是 gfx1100 版本（含架构无关的 fallback 库），共约 55 MB。
换到别的 RDNA 卡（gfx1201 / gfx1150 等）时，从该卡对应 ROCm 安装目录里补：

    <ROCm>\bin\rocblas\library\*.hsaco|*.dat
    <ROCm>\bin\hipblaslt\library\

漏掉这两个目录的症状是引擎能启动、能监听，一有请求就打印
"rocBLAS error: Cannot read .../rocblas/library/TensileLibrary.dat" 然后退出。
