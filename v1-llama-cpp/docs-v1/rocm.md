# ROCm KVMem: Windows and Linux

Windows native HIP and Linux/WSL2 HIP use the same KVMem adapter and GDN replay kernels.
The IQ3 launchers provide a 262144-token workspace, a 36864-token GPU KV budget,
16384-token generation reserve, q8_0 KV and MTP2 replay. Vision runs on the CPU.
Windows starts with `--load-mode none`; Linux starts with `--load-mode auto`.

> **Windows 注意 / Windows note**: 请务必使用 `--load-mode none`（启动脚本默认）。
> 若改用 mmap 加载，模型文件页会滞留内存，256K 全程内存读数会从 ~13 GiB 升至 23 GiB 以上。
> On Windows keep `--load-mode none` (launcher default). mmap loading retains model
> pages in RAM and raises the observed footprint from ~13 GiB to 23+ GiB.

## 运行包 / Runtime package

完整解压，保留 `bin/`、`scripts/rocm/`、`share/kvmem/` 的相对位置。模型单独下载：

- [IQ3 主模型](https://huggingface.co/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF/blob/main/Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf)
- [视觉投影](https://huggingface.co/HermiHg/Qwen3.8-27B-mmproj-Q5_K-MIX-GGUF/blob/main/mmproj-Qwen3.8-27B-Q5_K-MIX.gguf)

Windows 需要支持相应显卡的 AMD 驱动及 Microsoft Visual C++ x64 运行库。
Linux 需要与本机 GPU、发行版匹配的 ROCm 7.2.x 运行环境。WSL 使用 Linux ROCm，不能使用 Windows DLL。
当前 Linux 运行包基于 Ubuntu 24.04 构建，依赖系统 OpenSSL 3、glibc、libstdc++ 及 ROCm 的系统依赖；
其他发行版应确认二进制兼容性，或按下文从源码编译。
查看包内 `BUILD-INFO.json` 的编译目标与 `VALIDATION.md` 的实际验证范围。
建议 16 GiB 显存、16 GiB 或更多系统 RAM（256K 全程实测约 13~14 GiB）；关闭占用显存的大型应用。

在解压目录运行，先用 `bin/llama-kvmem-server --list-devices`（Windows 加 `.exe`）查看设备名。
下面的示例路径需要换成自己的模型路径；`ROCm0` 也应以实际列出的设备为准。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\rocm\start-iq3.ps1 `
  -Model 'D:\models\Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf' `
  -Mmproj 'D:\models\mmproj-Qwen3.8-27B-Q5_K-MIX.gguf' -Gpu ROCm0
```

```bash
bash scripts/rocm/start-iq3.sh /data/model-IQ3-mtp.gguf /data/mmproj.gguf ROCm0
```

模型加载完成后打开 **http://127.0.0.1:18200/**。保持终端开启，Ctrl+C 停止。
完整 UI 是默认值；将脚本里的 UI 目录改为 `share/kvmem/ui-lightweight` 即可使用轻量界面。
端口、推理参数和加载方式都写在启动脚本中，可直接编辑。`load-mode` 是启动参数，无需重新编译。
服务默认只监听本机；不要直接暴露到公网。

## 源码编译 / Build from source

Git checkout: initialize the pinned submodule with `git submodule update --init`.
The complete source bundle already includes the pinned llama.cpp sources.
Build scripts apply `patches/llama-kvmem-current.patch` idempotently and stop on conflicts.
Use separate build directories for each operating system and SDK version.

Common requirements: Python 3, Git, CMake >= 3.24, Ninja, a compatible ROCm/HIP SDK.
Windows additionally needs Visual Studio 2022 C++ Build Tools and a Windows SDK.
This build was developed with MSVC 14.44; later toolchains need separate validation.
Linux needs the normal C/C++ development headers.

```powershell
# Set this to the installed Windows HIP SDK root.
$env:ROCM_PATH = 'D:\DevTools\ROCm'
python scripts/build-rocm.py --windows --jobs 8
ctest --test-dir build-hip-win --output-on-failure
```

```bash
export ROCM_PATH=/opt/rocm
python3 scripts/build-rocm.py --linux --jobs 8
ctest --test-dir build-hip-linux --output-on-failure
```

`ROCM_PATH`, `HIP_PATH`, or `--rocm` select the native SDK. Windows build tools must be on PATH;
the launcher discovers Visual Studio via `vswhere`, or accepts `VCVARS=/path/to/vcvars64.bat`.
For WSL, use a Linux-filesystem checkout (for example under `~/code`), not a Windows build directory.

GPU architecture is detected with ROCm tools. WSL can use `rocm_agent_enumerator` when
`amdgpu-arch` returns no devices. Detection failure stops configuration with an actionable error.
An explicit override supports offline builds and additional GPUs:

```text
python scripts/build-rocm.py --gpu-targets gfx1100,gfx1200,gfx1201 --jobs 8
```

Only select targets supported by your installed SDK and GPU. A compiled target does not imply
an actual-device test. Build locally for architectures absent from a binary package.
`GGML_NATIVE=OFF` avoids host-specific CPU tuning; packaged x86_64 binaries require AVX2, FMA, F16C and BMI2.
The HIP builds use ggml's thread pool (`GGML_OPENMP=OFF`), so the Windows runtime package
does not depend on Visual Studio's non-redistributable `libomp140` DLL.

### UI and first start

Install Node.js/npm, then build the pinned full UI and optional lightweight UI:

```text
python scripts/build-webui.py --full-ui --output build-hip-win/share/kvmem/ui
python scripts/build-webui.py --output build-hip-win/share/kvmem/ui-lightweight
```

On Linux, use `python3` and replace `build-hip-win` with `build-hip-linux`.
The same IQ3 scripts also discover these source-build directories. For a custom output directory,
Windows accepts `-BuildDir`, and Linux accepts the `BUILD_DIR` environment variable.

### Verification and maintenance

- `python -m unittest discover -s scripts -p test_build_rocm.py`: model-free build entry tests.
- `ctest --test-dir BUILD_DIR --output-on-failure`: host tests and GDN replay regression.
- `BUILD_DIR/bin/llama-bench -m MODEL -ngl 99 -p 128 -n 128`: short baseline inference benchmark.
- Long-context testing must record the exact model hashes, command, commit, driver, SDK,
  MTP length and loading mode. Keep request/response and server logs, not only an aggregate speed.
- Windows Working Set is resident RAM; Private Bytes is committed private memory.
  Linux RSS is resident memory. Report loading and runtime peaks separately.
  Logged buffer sums are not measured device VRAM peaks.

If a GPU fails, attach `--list-devices`, the architecture probe output, compiler version,
`BUILD-INFO.json` (for a package), startup log and a minimal command to reproduce it.
Do not use a different architecture override to disguise an unsupported GPU.

The existing CUDA launchers and CUDA packages remain separate. NVMe offload is disabled.
The original contributions and integration choices are recorded in [rocm-contributors.md](rocm-contributors.md).
