把 .hfq 模型文件放进这个目录，面板的「扫描模型」按钮就会列出来。

本发行包不包含模型权重（qwen3.8-27b 这一档约 15 GB）。
制作 .hfq 用 hipfire 自带的量化器：

    hipfire quantize --help

测试过的主力模型： qwen3.8-27b.mq4-pro-uniform.hfq
MTP 草稿头（可选，开了更快）： qwen3.8-27b.mq4-pro-uniform.mtp
