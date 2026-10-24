/**
 * KVMem 控制台 — 参数配置 / 持久化 / 模型切换 控制器
 *
 * 作用：
 *   1. 提供中文 Web 设置界面（http://127.0.0.1:18201/）
 *   2. 用一个配置页维护 llama-kvmem-server 的全部可调参数
 *   3. 保存到 config.json（持久化），点「保存并重启」即可生效
 *   4. 自动扫描 models 目录，支持一键切换主模型 / 视觉投影器
 *
 * 只用 Node 内置模块，无需 npm install。
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 本脚本位于 <包根>/panel/ 下，ROOT 指向包根
const PANEL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PANEL_DIR, '..');
// Release package layout:
//   <root>/bin/llama-kvmem-server.exe      server (carries bundled ROCm runtime)
//   <root>/share/kvmem/ui/                  chat UI
//   <root>/models/                          user-provided GGUF models (auto-scanned)
//   <root>/config.json                      persisted settings written by this panel
const BIN_DIR = path.join(ROOT, 'bin');
const UI_DIR  = path.join(ROOT, 'share', 'kvmem', 'ui');
const SERVER_EXE = path.join(BIN_DIR, 'llama-kvmem-server.exe');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const LOG_FILE = path.join(ROOT, 'server.log');
const CONTROL_UI = path.join(PANEL_DIR, 'control-ui.html');
const CONTROL_PORT = 18201;
const CHAT_PORT_DEFAULT = 18200;

// ---------------------------------------------------------------------------
// 参数定义（全部来自 llama-kvmem-server --help，中文标注）
// type: bool | int | float | string | select | text
// optional: true 表示留空则不传给服务（用服务端默认值）
// ---------------------------------------------------------------------------
const SCHEMA = [
  {
    group: 'model', title: '模型与视觉', icon: '🧠',
    desc: '主模型与视觉投影器。切换模型后需重启生效（会重新加载权重，约 30-60 秒）。',
    params: [
      { id: 'model', flag: '--model', short: '-m', label: '主模型 (GGUF)', type: 'model', required: true,
        help: '对话使用的大模型权重文件。必须自带 MTP 头才能在 MTP 模式下开启推测解码。' },
      { id: 'mmproj', flag: '--mmproj', short: '-mm', label: '视觉投影器 (mmproj)', type: 'mmproj',
        help: '图像识别所需。留空表示纯文本模式（可省约 1 GB 显存）。' },
      { id: 'mmproj_offload', label: '视觉编码器放 GPU', type: 'bool', default: false,
        negFlag: '--no-mmproj-offload', flag: '--mmproj-offload',
        help: '关闭 = 视觉编码走 CPU（推荐，给推理留更多显存）。开启 = 走 GPU，图片处理更快但更占显存。' },
      { id: 'image_max_tokens', flag: '--image-max-tokens', label: '单图最大 token 数', type: 'int', default: 512, min: 1,
        help: '每张图片最多占用的 token 数。默认 512；做图像接地(grounding)任务建议 1024。' },
      { id: 'image_min_tokens', flag: '--image-min-tokens', label: '单图最小 token 数', type: 'int', optional: true,
        help: '留空用模型原生值。官方提示 Qwen-VL 做 grounding 任务至少需要 1024。' },
    ],
  },
  {
    group: 'device', title: '设备与显存', icon: '🎮',
    desc: 'AMD 显卡选择与模型加载方式。',
    params: [
      { id: 'device', flag: '--device', short: '-dev', label: '计算设备', type: 'select', default: 'ROCm0',
        options: ['ROCm0', 'none'], help: 'ROCm0 = AMD Radeon RX 7900 XTX。填 none 表示纯 CPU（很慢，仅排障用）。' },
      { id: 'n_gpu_layers', flag: '--n-gpu-layers', short: '-ngl', label: '卸载到 GPU 的层数', type: 'string', default: '99',
        help: '99 = 全部层都放显存。也可以填 all。GPU 显存放不下时减小此值可把部分层留在内存。' },
      { id: 'load_mode', flag: '--load-mode', short: '-lm', label: '模型加载方式', type: 'select', default: 'none',
        options: ['none', 'auto', 'mmap', 'mlock', 'mmap+mlock', 'dio'],
        help: 'Windows 必须用 none。用 mmap 会让模型文件页滞留内存，256K 全程内存占用从约 13 GB 涨到 23 GB 以上。' },
      { id: 'main_gpu', flag: '--main-gpu', short: '-mg', label: '主设备索引', type: 'int', optional: true, default: 0,
        help: '单卡默认 0，无需修改。' },
      { id: 'split_mode', flag: '--split-mode', short: '-sm', label: '多卡分割模式', type: 'select', optional: true,
        options: ['none', 'layer'], help: '单卡无需设置。KVMem 当前不支持多 GPU。' },
    ],
  },
  {
    group: 'context', title: '上下文与批处理', icon: '📐',
    desc: '逻辑工作区大小与 CPU/批处理参数。',
    params: [
      { id: 'ctx_size', flag: '--ctx-size', short: '-c', label: '逻辑工作区 (token)', type: 'int', default: 262144, min: 1,
        help: '含存放在主机内存的历史。256K = 262144 是官方测试过的默认值。实测 256K 与 32K 速度几乎相同，这是 KVMem 的核心价值。' },
      { id: 'n_predict', flag: '--n-predict', short: '-n', label: '单轮最大输出 (token)', type: 'int', default: 16384, min: -1,
        help: '单次回复（含思考内容）的输出上限。应 ≤「生成保留槽」。-1 表示不额外限制。' },
      { id: 'batch_size', flag: '--batch-size', short: '-b', label: '逻辑批大小', type: 'int', default: 512, min: 1,
        help: '一次处理的 token 数。512 是官方配方值。' },
      { id: 'ubatch_size', flag: '--ubatch-size', short: '-ub', label: '物理批大小', type: 'int', optional: true, min: 1,
        help: '留空则与逻辑批大小一致。显存紧张时可设小一点（如 128）。' },
      { id: 'threads', flag: '--threads', short: '-t', label: 'CPU 生成线程数', type: 'int', optional: true,
        help: '★ 强烈建议留空（用 llama.cpp 默认值）。实测填 0（=用满本机 32 线程）会让解码从 51.5 掉到 26.6 tok/s —— GPU 全卸载时空转的 CPU 线程会争抢采样与图调度。' },
      { id: 'threads_batch', flag: '--threads-batch', short: '-tb', label: 'CPU 批处理线程数', type: 'int', optional: true,
        help: '留空则与生成线程数一致。同样建议留空。' },
      { id: 'flash_attn', flag: '--flash-attn', short: '-fa', label: 'Flash Attention', type: 'select', optional: true,
        options: ['auto', 'on', 'off'], help: '★ 保持留空（auto）。实测强行设 on 会让 DFlash2 解码从 52.0 掉到 29.3 tok/s（-44%）。' },
    ],
  },
  {
    group: 'kvmem', title: 'KVMem 核心（分层 KV 内存）', icon: '🗂️',
    desc: 'KVMem 把完成的历史 KV 块存到主机内存，只把相关部分检索进显存，从而让 256K 上下文跑在消费级显卡上。',
    params: [
      { id: 'kvmem', label: '启用 KVMem', type: 'bool', default: true, flag: '--kvmem', negFlag: '--no-kvmem',
        help: '关闭后回退为 llama.cpp 原生全量 KV（会直接吃满显存，长上下文不可用）。' },
      { id: 'kvmem_budget', flag: '--kvmem-budget', label: 'GPU 检索窗口 (token)', type: 'int', default: 36864, min: 0,
        help: '检索时最多保留在显存里的历史 token 数。官方 16GB 配方值为 36864。本机 24GB 可提到 45056。' },
      { id: 'kvmem_gen_reserve', flag: '--kvmem-gen-reserve', label: '生成保留槽 (token)', type: 'int', default: 16384, min: 1,
        help: '★ 给新生成 token 预留的显存槽位 —— 也就是单轮输出（含思考）的硬上限，超过会被截断。要写长文就调大它。' },
      { id: 'kvmem_block_tokens', flag: '--kvmem-block-tokens', label: 'KV 块大小 (token)', type: 'int', default: 128, min: 1,
        help: '检索的最小粒度。默认 128，一般无需改动。' },
      { id: 'kvmem_method', flag: '--kvmem-method', label: '检索方法', type: 'select', default: 'retrieval',
        options: ['retrieval', 'recency'], help: 'retrieval = 按当前问题检索相关历史（默认）；recency = 只保留最近的（更快但会遗忘早期内容）。' },
      { id: 'kvmem_sink_tokens', flag: '--kvmem-sink-tokens', label: '始终保留的开头 (token)', type: 'int', default: 0, min: 0,
        help: '永远留在显存里的前缀长度，用于保住 system prompt。0 = 保留一个块。这些 token 计入检索窗口。' },
      { id: 'kvmem_recent_tokens', flag: '--kvmem-recent-tokens', label: '始终保留的结尾 (token)', type: 'int', default: 0, min: 0,
        help: '永远保留的最新后缀 token 数。0 = 不额外保留。' },
      { id: 'kvmem_query_policy', flag: '--kvmem-query-policy', label: '查询选择策略', type: 'select', default: 'user',
        options: ['user', 'legacy'], help: 'user = 用最近一条用户消息作为检索查询（默认，推荐）；legacy = 旧行为。' },
      { id: 'kvmem_query_replay', flag: '--kvmem-query-replay', label: '查询回放模式', type: 'select', default: 'auto',
        options: ['auto', 'legacy'], help: 'auto = 自动跳过可用缓存（默认）；legacy = 旧行为。' },
      { id: 'kvmem_query_max_tokens', flag: '--kvmem-query-max-tokens', label: '检索查询截断长度', type: 'int', optional: true, default: 512, min: 1,
        help: '用完最近用户消息的末尾多少 token 做检索。默认 512。' },
      { id: 'kvmem_query_last', flag: '--kvmem-query-last', label: '回退查询长度', type: 'int', optional: true, default: 64, min: 1,
        help: '找不到最近用户消息段时，用末尾多少个 token 当查询。默认 64。' },
      { id: 'kvmem_mtp_state', flag: '--kvmem-mtp-state', label: 'MTP 状态处理', type: 'select', default: 'replay',
        options: ['replay', 'auto', 'snapshots'], help: 'replay = ReplaySSM 状态回放（官方 ROCm 配方，配 MTP 用）；auto/snapshots 为备选。' },
      { id: 'kvmem_gpu_ratio', flag: '--kvmem-gpu-ratio', label: '槽位池显存占比上限', type: 'float', optional: true, default: 0.5, min: 0.05, max: 0.95, step: 0.05,
        help: 'KVMem 槽位池最多占用多少显存。默认 0.5（一半）。显存紧张时调小。' },
      { id: 'kvmem_cpu_gb', flag: '--kvmem-cpu-gb', label: 'CPU 溢出区 (GiB)', type: 'float', optional: true, default: 0, min: 0,
        help: '额外划给主机内存的 KV 存放区。0 = 关闭（默认，使用系统动态内存）。' },
      { id: 'kvmem_nvme_gb', flag: '--kvmem-nvme-gb', label: 'NVMe 缓存 (GiB)', type: 'float', optional: true, default: 0, min: 0,
        help: '本 ROCm 构建未启用 NVMe 卸载，保持 0。', advanced: true },
      { id: 'kvmem_nvme_dir', flag: '--kvmem-nvme-dir', label: 'NVMe 目录', type: 'string', optional: true, advanced: true,
        help: 'NVMe 缓存文件目录。本构建未启用。' },
      { id: 'kvmem_harvest_v', label: 'prefill 时搬运 V', type: 'bool', default: false, flag: '--kvmem-harvest-v',
        help: '预填充阶段把 V 随原始 K 一起搬到主机内存（默认关闭，直到 NVMe 刷新）。', advanced: true },
      { id: 'kvmem_raw_k_nvme', label: '原始 K/V 存 NVMe', type: 'bool', default: false, flag: '--kvmem-raw-k-nvme',
        help: '需要同时设置 NVMe 缓存大小。本构建未启用。', advanced: true },
    ],
  },
  {
    group: 'kvcache', title: 'KV 缓存精度', icon: '💾',
    desc: '降低 KV 缓存精度可显著省显存，代价是少量精度损失。',
    params: [
      { id: 'kv_dtype', flag: '--kv-dtype', label: 'K/V 缓存类型', type: 'select', default: 'q8_0',
        options: ['q8_0', 'q5_0', 'q4_0', 'f16', 'f32'],
        help: '同时设置 K 与 V。IQ3 配方用 q8_0（默认）。想省显存可用 q5_0；再往下精度损失开始明显。' },
      { id: 'cache_type_k', flag: '--cache-type-k', short: '-ctk', label: '单独设置 K 类型', type: 'select', optional: true,
        options: ['q8_0', 'q5_0', 'q4_0'], help: '留空跟随上面的「K/V 缓存类型」。想混合精度时在此单独指定（如 K=q8_0、V=q4_0）。' },
      { id: 'cache_type_v', flag: '--cache-type-v', short: '-ctv', label: '单独设置 V 类型', type: 'select', optional: true,
        options: ['q8_0', 'q5_0', 'q4_0'], help: '留空跟随上面的「K/V 缓存类型」。K 与 V 都设为量化类型才允许混合（浮点+量化混搭会被拒绝）。' },
    ],
  },
  {
    group: 'mtp', title: '推测解码加速（MTP / DFlash2）', icon: '⚡',
    desc: '两种加速方式二选一。MTP：用主模型自带的 nextn 头（模型名带 -mtp），或配 sidecar MTP 草稿模型。DFlash2：用独立 DFlash2 草稿模型（块扩散并行草稿）。本机实测（RX 7900 XTX，n=64）：无加速 43.8 t/s、MTP 78.7 t/s（+79%）、DFlash2 56.0 t/s（+28%）。MTP 明显更快，优先用 MTP。',
    params: [
      { id: 'spec_type', flag: '--spec-type', label: '推测解码模式', type: 'select', default: 'draft-mtp',
        options: ['none', 'draft-mtp', 'draft-dflash'],
        help: 'none = 关闭；draft-mtp = 用主模型自带的 nextn 头（模型名带 -mtp），或在下面选一个 mtp-*.gguf 作独立草稿；draft-dflash = 用独立 DFlash2 草稿模型（需在下面选草稿模型）。' },
      { id: 'model_draft', flag: '--model-draft', short: '-md', label: '草稿模型（sidecar drafter）', type: 'model', optional: true,
        help: '两种模式都能用，但必须配对：draft-dflash 选 Qwen3.8-27B-DFlash2-*.gguf（Q4_K_M，1.09 GB）；draft-mtp 选 mtp-*.gguf（Q4_0，1.56 GB），实测比用主模型自带 nextn 头更快（78.7 vs 71.7 t/s）。留空则 draft-mtp 回落到焊接 nextn 头。选错配对会被自动忽略。' },
      { id: 'spec_draft_n_max', flag: '--spec-draft-n-max', label: '草稿 token 数', type: 'int', default: 3, min: 1,
        help: '每步预测几个 token。最优值取决于草稿来源（取值过大会因接受率下降而变慢）：焊接 MTP 用 2（71.7 t/s）、sidecar MTP 用 4（78.7 t/s）、DFlash2 用 5（56.0 t/s）。' },
      { id: 'spec_kv_dtype', flag: '--spec-kv-dtype', label: '草稿 KV 类型（仅 MTP）', type: 'select', default: 'f16',
        options: ['f16', 'q8_0', 'q5_0', 'q4_0'], help: 'MTP 草稿模型的 KV 精度。官方配方用 f16。DFlash2 不需要此项。' },
      { id: 'spec_draft_p_min', flag: '--spec-draft-p-min', label: '草稿最低概率', type: 'float', optional: true, default: 0, min: 0, max: 1, step: 0.05,
        help: '低于此概率的草稿直接丢弃。0 = 不过滤（默认）。' },
    ],
  },
  {
    group: 'sampling', title: '采样参数（默认值）', icon: '🎲',
    desc: '这些是服务端默认采样参数，请求里可以逐次覆盖。Qwen3.8-27B 官方推荐：思考模式 温度1.0/top_p0.95；非思考模式 温度0.7/top_p0.80/存在惩罚1.5。',
    params: [
      { id: 'temperature', flag: '--temperature', short: '--temp', label: '温度 temperature', type: 'float', default: 1.0, min: 0, max: 2, step: 0.05,
        help: '越高越随机，0 = 完全确定性（贪心）。' },
      { id: 'top_p', flag: '--top-p', label: 'top_p 核采样', type: 'float', default: 0.95, min: 0, max: 1, step: 0.01,
        help: '只从累计概率前 p 的候选里采样。' },
      { id: 'top_k', flag: '--top-k', label: 'top_k', type: 'int', default: 20, min: 0,
        help: '只从概率最高的 k 个候选里采样。0 = 禁用。' },
      { id: 'min_p', flag: '--min-p', label: 'min_p 最小概率', type: 'float', default: 0, min: 0, max: 1, step: 0.01,
        help: '过滤掉相对概率低于此值的候选。0 = 禁用。' },
      { id: 'presence_penalty', flag: '--presence-penalty', label: '存在惩罚', type: 'float', default: 0, min: -2, max: 2, step: 0.1,
        help: '正值抑制重复话题。非思考模式官方推荐 1.5。' },
      { id: 'frequency_penalty', flag: '--frequency-penalty', label: '频率惩罚', type: 'float', default: 0, min: -2, max: 2, step: 0.1,
        help: '按出现次数抑制重复词。默认 0。' },
      { id: 'repeat_penalty', flag: '--repeat-penalty', label: '重复惩罚', type: 'float', default: 1.0, min: 0.1, step: 0.05,
        help: '大于 1 抑制重复（官方推荐保持 1.0）。' },
      { id: 'seed', flag: '--seed', label: '随机种子', type: 'int', optional: true, min: 0,
        help: '留空 = 每次随机。固定值可让输出可复现。' },
    ],
  },
  {
    group: 'thinking', title: '思考模式与对话模板', icon: '💭',
    desc: '控制模型的思考（reasoning）行为。注意：思考内容也占用「生成保留槽」额度。',
    params: [
      { id: 'enable_thinking', label: '启用思考模式', type: 'bool', default: true, flag: '--enable-thinking', negFlag: '--no-think',
        help: '开启后模型会先输出思考过程再给答案（更准但更慢）。请求级也可单独覆盖。' },
      { id: 'reasoning_budget', flag: '--reasoning-budget', label: '思考 token 预算', type: 'int', default: 4096, min: -1,
        help: '思考过程最长多少 token。-1 = 不限；0 = 立即结束思考；N>0 = 到 N 就强制结束思考。' },
      { id: 'reasoning_effort', flag: '--reasoning-effort', label: '思考努力程度', type: 'select', optional: true,
        options: ['none', 'low', 'medium', 'xhigh'],
        help: 'none = 关闭思考；low = 简短推理；medium = 不加额外指示；xhigh = 仔细推理（模板默认）。留空 = 用模板默认值。' },
      { id: 'reasoning_budget_message', flag: '--reasoning-budget-message', label: '预算用尽提示语', type: 'string', optional: true,
        help: '思考预算耗尽、强制结束前注入的一段提示文字。留空则不注入。' },
      { id: 'chat_template_kwargs', flag: '--chat-template-kwargs', label: '模板参数 (JSON)', type: 'string', optional: true,
        help: '传给对话模板的默认参数，例如 {"enable_thinking":true}。需为合法 JSON。' },
      { id: 'chat_template_file', flag: '--chat-template-file', label: '自定义模板文件', type: 'string', optional: true,
        help: '加载自定义 Jinja 模板文件路径。留空用模型自带模板。⚠ 已知故障：ROCmFP4 模型在 server 路径下会输出乱码或空回复（基线同样复现，与本机加速无关）。把此项指向一个内容为 {{ messages[0][\'content\'] }} 的单行模板文件即可规避，且不影响 MTP 加速。', advanced: true },
      { id: 'chat_template', flag: '--chat-template', label: '内联模板内容', type: 'string', optional: true,
        help: '直接写 Jinja 模板文本，一般用不到。', advanced: true },
    ],
  },
  {
    group: 'server', title: '服务与网络', icon: '🌐',
    desc: '监听地址、端口、界面与鉴权。',
    params: [
      { id: 'host', flag: '--host', label: '监听地址', type: 'string', default: '127.0.0.1',
        help: '127.0.0.1 = 仅本机访问（安全）。要让局域网访问改成 0.0.0.0，并务必同时设置 API 密钥。' },
      { id: 'port', flag: '--port', label: '服务端口', type: 'int', default: 18200, min: 1, max: 65535,
        help: '聊天界面与 API 的端口。改完需重启生效。' },
      { id: 'webui', label: '启用内置聊天界面', type: 'bool', default: true, flag: '--webui', negFlag: '--no-ui',
        help: '关闭后只剩 API，没有网页界面。' },
      { id: 'alias', flag: '--alias', short: '-a', label: 'API 模型别名', type: 'string', optional: true,
        help: '接口里显示的模型名。留空 = 用文件名。' },
      { id: 'api_key', flag: '--api-key', label: 'API 密钥', type: 'string', optional: true,
        help: '设置后所有请求需带 Authorization: Bearer <密钥>。本机自用可留空。' },
      { id: 'api_key_file', flag: '--api-key-file', label: 'API 密钥文件', type: 'string', optional: true,
        help: '每行一个密钥的文件路径。与上面的密钥可叠加。', advanced: true },
      { id: 'timeout', flag: '--timeout', short: '-to', label: 'HTTP 超时 (秒)', type: 'int', optional: true, default: 1800, min: 1,
        help: '读写的超时时间。默认 1800 秒，长上下文生成较慢时可调大。' },
      { id: 'threads_http', flag: '--threads-http', label: 'HTTP 工作线程', type: 'int', optional: true,
        help: '留空自动。注意这不代表能并发推理。', advanced: true },
      { id: 'parallel', flag: '--parallel', short: '-np', label: '并发槽位', type: 'select', default: '1', options: ['1'],
        help: 'KVMem 当前只支持单槽位（1），无法设置更多。', advanced: true },
    ],
  },
  {
    group: 'logging', title: '日志与诊断', icon: '📋',
    desc: '排障时用。诊断跟踪会明显拖慢速度，平时请保持关闭。',
    params: [
      { id: 'verbosity', flag: '--verbosity', short: '-lv', label: '日志级别', type: 'select', default: '3',
        options: ['0', '1', '2', '3', '4', '5'],
        help: '0=静默 1=错误 2=警告 3=信息(默认) 4=trace 5=debug。' },
      { id: 'kvmem_trace', label: '输出 KVMem 诊断记录', type: 'bool', default: false, flag: '--kvmem-trace',
        help: '打印原始 KVMEM_* 诊断行（相当于设置环境变量 KVMEM_TRACE=1）。会降低速度，仅在排障时开启。' },
    ],
  },
];

const ALL_PARAMS = SCHEMA.flatMap((g) => g.params.map((p) => ({ ...p, group: g.group, groupTitle: g.title })));

// 从 models/ 目录自动挑选：外层按优先级遍历模式，保证 ROCmFP4 优先于 IQ3
function pickFromModels(pred, preferPatterns) {
  const dir = path.join(ROOT, 'models');
  if (!fs.existsSync(dir)) return "";
  let files = [];
  try { files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.gguf$/i.test(f)); } catch { return ""; }
  for (const pat of preferPatterns) {
    // pat 为子串匹配，* 作为通配符
    const re = new RegExp(pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i');
    for (const f of files) {
      if (pred && !pred(f)) continue;
      if (re.test(path.basename(f))) return path.join(dir, f);
    }
  }
  return "";
}

function defaultConfig() {
  const cfg = {};
  const modelDir = path.join(ROOT, 'models');
  const isMmproj = (f) => /mmproj|projector|vision/i.test(f);
  // 发行包由用户把模型放进 models\\，这里自动挑最合适的一个作为默认值
  const autoMain  = pickFromModels((f) => !isMmproj(f) && !/dflash|eagle|draft/i.test(f) && !/^mtp[-_]/i.test(f),
                                   ['ROCMFP4', 'IQ3_S-mtp', 'IQ3', '27B', '.*']);
  const autoDraft = pickFromModels((f) => /dflash/i.test(f), ['Q4_K_M', 'Q8_0', 'BF16', '.*']);
  const autoMtpDraft = pickFromModels((f) => /^mtp[-_]/i.test(path.basename(f)), ['Q4_0', 'Q8_0', '.*']);
  const autoMmp   = pickFromModels(isMmproj, ['BF16', 'Q5', '.*']);
  for (const p of ALL_PARAMS) {
    if (p.type === 'bool') cfg[p.id] = p.default ?? false;
    else if (p.id === 'model')       cfg[p.id] = autoMain  || path.join(modelDir, 'Qwen3.8-27B-Q4_0_ROCMFP4_STRIX.gguf');
    else if (p.id === 'model_draft') cfg[p.id] = autoMtpDraft || autoDraft;
    else if (p.type === 'mmproj')    cfg[p.id] = autoMmp   || '';
    else cfg[p.id] = p.optional ? (p.default ?? '') : (p.default ?? '');
  }
  // MTP 实测远快于 DFlash2（+79% vs +28%），有 MTP 草稿就优先用 MTP。
  // n_max 最优值随草稿来源不同：sidecar MTP 用 4、DFlash2 用 5。
  if (autoMtpDraft)   { cfg.spec_type = 'draft-mtp';    cfg.spec_draft_n_max = 4; }
  else if (autoDraft) { cfg.spec_type = 'draft-dflash'; cfg.spec_draft_n_max = 5; }
  return cfg;
}
// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------
function loadConfig() {
  const base = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...base, ...raw };
  } catch {
    return base;
  }
}

function saveConfig(cfg) {
  const clean = {};
  for (const p of ALL_PARAMS) if (cfg[p.id] !== undefined) clean[p.id] = cfg[p.id];
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

// ---------------------------------------------------------------------------
// 配置 -> 命令行参数
// ---------------------------------------------------------------------------
function buildArgs(cfg) {
  const args = [];
  const flagOf = (p) => p.flag;
  const isDflash = String(cfg.spec_type || '') === 'draft-dflash';
  for (const p of ALL_PARAMS) {
    const v = cfg[p.id];
    if (v === undefined || v === null || v === '') continue;

    // Sidecar drafter: usable by BOTH modes, but the pairing must match.
    // draft-dflash wants a DFlash2 GGUF; draft-mtp wants an mtp-* GGUF.
    // Handing the wrong one to the drafter init makes it fail to load.
    if (p.id === 'model_draft') {
      const base = String(v).split(/[\\/]/).pop() || '';
      const looksMtp = /^mtp[-_]/i.test(base);
      if (isDflash ? !looksMtp : looksMtp) args.push('--model-draft', String(v));
      continue;
    }
    // MTP-only knobs are meaningless for a sidecar drafter.
    if (isDflash && (p.id === 'spec_kv_dtype' || p.id === 'spec_draft_p_min')) continue;

    if (p.type === 'bool') {
      if (p.id === 'kvmem' && v === true) { args.push('--kvmem'); continue; }
      if (v === true) { if (flagOf(p)) args.push(flagOf(p)); }
      else if (p.negFlag) args.push(p.negFlag);
      continue;
    }
    if (p.optional && (v === '' || v === null)) continue;

    const flag = flagOf(p);
    if (p.id === 'model') { args.push('-m', String(v)); continue; }
    if (!flag) continue;
    args.push(flag, String(v));
  }
  // -ngl 用短选项更稳；同时确保 --webui/--ui-dir 正确
  const i = args.indexOf('--n-gpu-layers');
  if (i >= 0) { args.splice(i, 1, '-ngl'); }
  if (!args.includes('--ui-dir')) args.push('--ui-dir', UI_DIR);
  return args;
}

// ---------------------------------------------------------------------------
// 服务进程管理
// ---------------------------------------------------------------------------
let serverProc = null;
let lastStartAt = 0;
let lastError = '';
let starting = false;

function cleanPath() {
  const parts = (process.env.PATH || '').split(';').filter((p) => p && !/TheRock/i.test(p) && !/AMD.ROCm/i.test(p));
  // The locally built binary needs the standard ROCm 7.2 runtime DLLs.
  // 发行包自带 ROCm 运行库，放在 bin\ 里，优先使用
  return [BIN_DIR, ...parts].join(';');
}

function serverArgsPreview(cfg) {
  return ['"' + SERVER_EXE + '"', ...buildArgs(cfg).map((a) => (a.includes(' ') ? `"${a}"` : a))].join(' ');
}

async function isUp(port, timeoutMs = 2500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

// 端口是否被占用（不判断是谁占的）
function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });
}

function stopServer() {
  const killed = [];
  if (serverProc && serverProc.pid) {
    try { execFileSync('taskkill', ['/f', '/pid', String(serverProc.pid), '/t'], { stdio: 'ignore' }); killed.push(serverProc.pid); } catch {}
    serverProc = null;
  }
  try { execFileSync('taskkill', ['/f', '/im', 'llama-kvmem-server.exe'], { stdio: 'ignore' }); killed.push('all'); } catch {}
  return killed;
}

function startServer(cfg) {
  if (!fs.existsSync(SERVER_EXE)) throw new Error('未找到服务程序：' + SERVER_EXE);
  const args = buildArgs(cfg);
  const logFd = fs.openSync(LOG_FILE, 'w');
  fs.writeSync(logFd, `# KVMem 启动 ${new Date().toLocaleString('zh-CN')}\n# 命令行：${serverArgsPreview(cfg)}\n\n`);
  serverProc = spawn(SERVER_EXE, args, {
    cwd: ROOT,
    env: { ...process.env, PATH: cleanPath() },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    detached: false,
  });
  serverProc.on('exit', (code) => { lastError = `服务进程退出，代码 ${code}`; serverProc = null; });
  serverProc.on('error', (e) => { lastError = '服务启动失败：' + e.message; serverProc = null; });
  fs.closeSync(logFd);
  lastStartAt = Date.now();
  lastError = '';
  return args;
}

async function waitReady(port, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await isUp(port)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function listModels() {
  const dirs = [path.join(ROOT, 'models')];
  const main = [];
  const mmproj = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d, { recursive: true })) {
      if (!/\.gguf$/i.test(String(f))) continue;
      const full = path.join(d, String(f));
      let mb = 0;
      try { mb = Math.round(fs.statSync(full).size / 1048576); } catch {}
      const item = { path: full, name: String(f).replace(/\\\\/g, '/'), mb };
      if (/mmproj|projector|vision/i.test(String(f))) mmproj.push(item); else main.push(item);
    }
  }
  // 配置里出现的自定义路径也一并列出
  const cfg = loadConfig();
  for (const [key, arr] of [['model', main], ['mmproj', mmproj]]) {
    const v = cfg[key];
    if (v && fs.existsSync(v) && !arr.some((x) => x.path.toLowerCase() === v.toLowerCase())) {
      let mb = 0; try { mb = Math.round(fs.statSync(v).size / 1048576); } catch {}
      arr.push({ path: v, name: path.basename(v), mb });
    }
  }
  return { main, mmproj };
}

function tailLog(n = 120) {
  try {
    const txt = fs.readFileSync(LOG_FILE, 'utf8');
    return txt.split(/\r?\n/).slice(-n).join('\n');
  } catch { return '（暂无日志）'; }
}

// 带超时的 fetch —— 模型加载期间 /v1/models 会长时间不响应，
// 没有超时会让 /api/status 一起挂住（曾导致启动器误判“控制台未运行”）。
async function fetchJson(url, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

let lastKnownModel = null;
let lastKnownKvmemInfo = null;

async function status() {
  const cfg = loadConfig();
  const port = Number(cfg.port) || 18200;
  const up = await isUp(port, 1500);
  if (up) {
    try {
      const j = await fetchJson(`http://127.0.0.1:${port}/v1/models`, 1500);
      lastKnownModel = j?.data?.[0]?.id ?? lastKnownModel;
    } catch {}
    try {
      const m = tailLog(400).match(/(kvmem=\d+ method=\w+ n_ctx=\d+ spec=[\w-]+ n_max=\d+ think=\d+ rbudget=-?\d+ qmax=\d+)/);
      if (m) lastKnownKvmemInfo = m[1];
    } catch {}
  }
  return {
    running: up,
    port,
    // 服务未就绪时回退到上次已知值，界面不至于空白
    model: up ? (lastKnownModel ?? null) : (lastKnownModel ?? null),
    kvmemInfo: up ? (lastKnownKvmemInfo ?? null) : (lastKnownKvmemInfo ?? null),
    pid: serverProc?.pid ?? null,
    starting,
    controlPort: CONTROL_PORT,
    chatUrl: `http://127.0.0.1:${port}/`,
    lastError,
    uptimeSec: lastStartAt ? Math.round((Date.now() - lastStartAt) / 1000) : 0,
  };
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${CONTROL_PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    if (p === '/' || p === '/index.html') {
      if (!fs.existsSync(CONTROL_UI)) return send(res, 500, '缺少 control-ui.html', 'text/plain; charset=utf-8');
      return send(res, 200, fs.readFileSync(CONTROL_UI, 'utf8'), 'text/html; charset=utf-8');
    }
    if (p === '/api/schema') return send(res, 200, { groups: SCHEMA, defaults: defaultConfig() });
    if (p === '/api/config') return send(res, 200, loadConfig());
    if (p === '/api/models') return send(res, 200, listModels());
    if (p === '/api/status') return send(res, 200, await status());
    if (p === '/api/log') return send(res, 200, { log: tailLog(Number(url.searchParams.get('tail')) || 150) });
    if (p === '/api/command') return send(res, 200, { command: serverArgsPreview(loadConfig()) });

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, { ok: true, config: saveConfig(body) });
    }

    if (p === '/api/apply' && req.method === 'POST') {
      const body = await readBody(req);
      if (body && Object.keys(body).length) saveConfig(body);
      const cfg = loadConfig();
      stopServer();
      await new Promise((r) => setTimeout(r, 2000));
      starting = true;
      let args;
      try { args = startServer(cfg); } catch (e) { starting = false; return send(res, 500, { ok: false, error: e.message }); }
      const ok = await waitReady(Number(cfg.port) || 18200);
      starting = false;
      return send(res, 200, { ok, command: serverArgsPreview(cfg), args });
    }

    if (p === '/api/restart' && req.method === 'POST') {
      const cfg = loadConfig();
      stopServer();
      await new Promise((r) => setTimeout(r, 2000));
      starting = true;
      try { startServer(cfg); } catch (e) { starting = false; return send(res, 500, { ok: false, error: e.message }); }
      const ok = await waitReady(Number(cfg.port) || 18200);
      starting = false;
      return send(res, 200, { ok, command: serverArgsPreview(cfg) });
    }

    if (p === '/api/stop' && req.method === 'POST') {
      stopServer();
      starting = false;
      return send(res, 200, { ok: true });
    }

    if (p === '/api/start' && req.method === 'POST') {
      const cfg = loadConfig();
      if (await isUp(Number(cfg.port) || 18200)) return send(res, 200, { ok: true, note: '已在运行' });
      starting = true;
      try { startServer(cfg); } catch (e) { starting = false; return send(res, 500, { ok: false, error: e.message }); }
      const ok = await waitReady(Number(cfg.port) || 18200);
      starting = false;
      return send(res, 200, { ok });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      return send(res, 200, { ok: true, config: saveConfig(defaultConfig()) });
    }

    return send(res, 404, { error: '未知接口：' + p });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
// 端口被占用时不要抛未捕获异常（那样控制台会直接闪退，用户只看到窗口关闭）
server.on('error', async (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[错误] 控制台端口 ${CONTROL_PORT} 已被占用。`);
    console.error('');
    if (await isUp(CHAT_PORT_DEFAULT)) {
      console.error('       看起来 KVMem 控制台/服务已经在运行了，无需重复启动。');
      console.error(`       聊天界面：http://127.0.0.1:${CHAT_PORT_DEFAULT}/`);
      console.error(`       参数设置：http://127.0.0.1:${CONTROL_PORT}/`);
      console.error('');
      console.error('       如需重启：先运行 start-kvmem.bat stop，再重新启动。');
    } else {
      console.error('       占用端口的进程可能是一个残留的控制台，请执行：');
      console.error('           start-kvmem.bat stop');
      console.error('       然后重新双击 start-kvmem.bat。');
    }
    console.error('');
    process.exit(2);
  }
  console.error('[错误] 控制台启动失败：' + (e && e.message ? e.message : e));
  process.exit(2);
});

server.listen(CONTROL_PORT, '127.0.0.1', async () => {
  console.log(`KVMem 控制台已启动：http://127.0.0.1:${CONTROL_PORT}/`);
  const cfg = loadConfig();
  const port = Number(cfg.port) || CHAT_PORT_DEFAULT;
  if (await isUp(port)) {
    console.log(`检测到服务已在端口 ${port} 运行，直接接管（不会重复启动）。`);
    return;
  }
  console.log('正在按 config.json 启动 KVMem 服务...');
  starting = true;
  try { startServer(cfg); } catch (e) { console.error('启动失败：' + e.message); starting = false; return; }
  const ok = await waitReady(port);
  starting = false;
  if (ok) {
    console.log(`KVMem 服务已就绪：http://127.0.0.1:${port}/`);
  } else {
    // 把服务端日志的关键行回显到控制台，便于用户直接看到原因
    const lines = tailLog(60).split(/\r?\n/).filter((l) => /error|fail|invalid|out of memory|assert|terminate|too large/i.test(l));
    console.error('等待服务就绪超时。');
    if (lastError) console.error('原因：' + lastError);
    if (lines.length) {
      console.error('服务日志中的错误行：');
      for (const l of lines.slice(-8)) console.error('  ' + l);
    }
    console.error('完整日志：' + LOG_FILE);
  }
});

// 退出时清理子进程，避免留下孤儿服务进程（关闭控制台窗口即等于停止服务）
let cleaningUp = false;
function cleanupAndExit(code = 0) {
  if (cleaningUp) return;
  cleaningUp = true;
  console.log('\nKVMem 控制台退出中，同时停止服务...');
  try { stopServer(); } catch {}
  process.exit(code);
}
process.on('SIGINT', () => cleanupAndExit(0));
process.on('SIGHUP', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));
try { process.on('SIGBREAK', () => cleanupAndExit(0)); } catch {}
process.on('exit', () => { if (!cleaningUp) { try { stopServer(); } catch {} } });
