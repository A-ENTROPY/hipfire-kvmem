# v2.1.1 — 修模型扫描（包内 models 目录才是规定位置）

v2.1.0 发出去之后发现两个扫描缺陷，模型放在包里却扫不出来。这一版修掉。

## 两个 bug

**一、候选模型目录里写死了发行包版本号。**
`HIPFIRE_MODELS_DIRS` 里硬编码了 `J:\hipfire-kvmem-2.0.0-…\models`，换成 2.1.0 的包之后
整张候选表全部落空，「扫描模型」返回 0 个。

改成按目录结构动态发现：包自身 `models\` 优先，然后是常见固定位置，再往上两级祖先目录里
任何名字像 kvmem/hipfire 的目录及其 `models\` 子目录。版本号不再出现在代码里。

**二、只扫目录第一层。**
`G:\models\ISTA-DASLab\*.gguf` 这种按仓库分文件夹的结构完全看不见 —— `main` / `mmproj`
一直是 0。现在递归一层，并且同一份文件被多个候选目录命中时按路径去重。

**三、llama 引擎缺 rocBLAS / hipBLASLt 的数据目录（会直接崩溃）。**

v2.1.1 首次上传时包里只拷了 `rocblas.dll`、`hipblaslt.dll`，**没拷它们要找的数据目录**
（`rocblas\library\`、`hipblaslt\library\`）。表现是引擎能加载、能监听，一处理请求就崩：

```
rocBLAS error: Cannot read ...\llama\/rocblas/library/TensileLibrary.dat:
  No such file or directory for GPU arch
rocBLAS error: Could not initialize Tensile host
```

现在按 gfx1100 精简后随包提供（无架构后缀的 fallback 库 + gfx1100 专用，共 55 MB，
原目录 1016 MB）。其它 RDNA 卡（gfx1201/gfx1150 等）需要时从对应 ROCm 安装的
`bin\rocblas\library` 与 `bin\hipblaslt\library` 补齐即可。

用 1M 上下文实测：`n_ctx=1000000` 正常加载，21 prompt / 53 completion token、27.65 tok/s 解码，
rocBLAS 无报错。**KVMem 模式支持 1M 上下文**，之前崩的是缺文件、不是上下文超限。
（模型本身的 `n_ctx_train` 是 262144，超过会有训练上下文溢出的警告，但这不影响运行。）

## 模型放哪（写进 README 与 models\README.txt）

**发行包里的 `models\` 目录就是本项目的规定位置**，面板打开即扫、自动填好四项：
hipfire 主模型、hipfire 草稿头、llama.cpp `.gguf`、`mmproj`。按子文件夹分也行。

## 验证（在你解压出来的包里实跑）

`GET /api/models`：

| 类别 | 修复前 | 修复后 |
|---|---:|---:|
| llama 主模型（gguf） | 0 | **10** |
| mmproj | 0 | **1** |
| hipfire 主模型 | 0 | **4** |
| hipfire 草稿头 | 0 | **2** |

全部来自包内 `models\`，去重后无重复项。

## 升级方式

把 v2.1.1 解压 **到新目录**，把旧包里的 `models\` 整个挪过去即可（模型不进 git、不随包发布）。
面板与引擎都在包里，没有外部依赖需要装。
