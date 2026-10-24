# v2.1.0 — 双引擎发行包

v2.0.0 只有 hipfire 引擎。这一版把 llama.cpp 那一侧也装进包里，面板上一个下拉框就能切。

## 包里现在有什么

| 引擎 | 程序 | 运行库 |
|---|---|---|
| hipfire（Rust 原生） | `bin\hipfire.exe` + `bin\daemon.exe` | `bin\runtime\amdhip64.dll`（HIP 10.x，16 MB） |
| llama.cpp（KVMem 补丁版） | `llama\llama-kvmem-server.exe`（自编译三合一：KVMem + ROCmFP4 + MTP/DFlash2） | `llama\` 下 8 个 ROCm 7.x DLL（279 MB） |

两个引擎都要一个叫 `amdhip64.dll` 的文件，版本却不同，所以**必须分目录**。面板按
`llama\llama-kvmem-server.exe` 是否存在来判定，并把该目录加进子进程 PATH——否则发行包里的
llama 引擎会因为找不到 `amdhip64.dll` 直接起不来。

包体：508 MB（解压后），压缩后见 Release 资产。

## 这一版修的面板缺陷

**引擎切换失败（两处）**

1. llama 侧的预检查只查服务程序、从不查模型，`model` 指向已经不存在的目录也照放行，
   服务在启动阶段退码，用户只看到一句笼统报错。现在提前拦截并写明缺哪个文件。
2. 模型目录写死成 `J:\hipfiremodels`。真机现场该目录被清空、模型全挪进了发行包目录，
   结果「扫描模型」扫不到任何东西、切回 hipfire 报「主模型不存在」。
   现在按候选列表扫描（`J:\hipfiremodels`、发行包 models、`J:\kvmemmodels`、`G:\models`、
   `<包根>\models`），扫描、自动挑选、`gguf`/`mmproj` 默认值全部走同一套。

## 验证

在包内（`H:\dshworkspace\KVMem\pkg\hipfire-kvmem-2.1.0`）实际跑过：

| 项 | 结果 |
|---|---|
| 首次启动自动挑选模型 | hipfire 主模型 / 草稿头、llama 的 `.gguf` / `mmproj` 四项全部命中 |
| hipfire 启动 + 生成 | `{"ok":true}` → health ok → 56 prompt / 32 completion token |
| 切到 llama + 生成 | `{"ok":true}` → health ok → 59 prompt / 48 completion token，内容正常 |
| 面板模型列表 | llama 侧 1 个 gguf + 1 个 mmproj；hipfire 侧 4 个主模型 + 2 个草稿头 |

## 已知问题（沿用 v2.0.0，未变）

- **DFlash 比 MTP 慢一倍多**：单步 219 ms / 15 tok/s vs 77.8 ms / 32 tok/s，每步 16 个草稿只接受约 3.3 个。
  那次测试深度 21,750（小于 36,864 窗口），打分 0 次、换页累计 0，与 KVMem 分页无关。
- **DFlash + 深上下文有掉速风险**：KV 采集的设备累加器门槛 `DECODE_CAPTURE_MAX_ROWS` 已从 12 抬到 32，
  但自适应块长控制器实测无收益（21k 深度：16 行 262 ms vs 6 行 265 ms，成本与行数无关）。
- **两个引擎的 KVMem 不是同一份代码**：hipfire 侧含三处缺陷修复，llama.cpp 侧沿用 v1.x 补丁集。
  压力测试结论只对 hipfire 侧成立。

## 安装

解压即用。`start-panel.bat`（面板，含引擎切换）或 `start-engine.bat`（只起 hipfire）。

需要 Windows x64 + RDNA 显卡；面板需要 Node.js 18+。模型不随包发布。
