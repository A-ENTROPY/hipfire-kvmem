这个目录就是本项目的模型位置。模型放这里，面板一打开就能扫到。

可以直接铺开，也可以按子文件夹分（面板会往下找一层）：

    models\qwen3.8-27b.mq4-pro-uniform.hfq      hipfire 主模型
    models\qwen3.8-27b.mq4-pro-uniform.mtp      hipfire 的 MTP 边车
    models\qwen38-27b-dflash-mq4.hfq            hipfire 的 DFlash 草稿头
    models\Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf   llama.cpp 引擎的主模型
    models\mmproj-Qwen3.8-27B-BF16.gguf         llama.cpp 的视觉投影（可选）
    models\ISTA-DASLab\*.gguf                  子文件夹也认

本发行包不含模型权重（27B 这一档约 15 GB）。hipfire 侧的 .hfq 用 `hipfire quantize`
自己做，llama.cpp 侧直接用现成的 .gguf。

模型也可以放在这几个位置之一，面板同样会扫：`J:\hipfiremodels`、`J:\kvmemmodels`、
`G:\models`、`H:\models`，以及任何名字带 kvmem/hipfire 的目录下的 models\。
要指定唯一目录，设环境变量 `KVMEM_HIPFIRE_MODELS_DIR`。
