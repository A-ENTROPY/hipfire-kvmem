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

// 本脚本可能处在两种布局之一，按「哪边真的有服务端二进制」判定，两种都认：
//   发行包：<包根>/panel/kvmem-control.mjs → BIN_DIR=<包根>/bin，UI=<包根>/share/kvmem/ui
//   开发树：<仓库根>/kvmem-control.mjs     → BIN_DIR=<仓库根>/kvmem-rocm-windows-review/bin
// 判据用**存在性**而不是目录名 —— 目录名（"panel"）会撞名，存在性不会。
//
// ⚠️ ROOT 是 config.json / server.log / presets / snapshots 的落点。发行包里它
// 必须是包根（挨着 bin/ 和 models/），不能是 panel/ 自己 —— 否则用户的状态会散
// 在一个子目录里，和 start-panel.ps1、读我用我.txt 里描述的位置对不上。
const PANEL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PARENT_DIR = path.resolve(PANEL_DIR, '..');
// 发行包有两种：llama.cpp 侧（bin/llama-kvmem-server.exe）与 hipfire 侧（bin/daemon.exe）。
// 两者都要认，否则 hipfire-only 包会把 config.json / server.log 落到 panel/ 里。
const PKG_ROOT = (fs.existsSync(path.join(PARENT_DIR, 'bin', 'llama-kvmem-server.exe'))
  || fs.existsSync(path.join(PARENT_DIR, 'bin', 'daemon.exe')))
  ? PARENT_DIR
  : PANEL_DIR;
const ROOT = PKG_ROOT;
// 运行时目录：发行包里就是包根（bin/ + share/ 在根下），开发树里是那个临时
// 解出来的发布目录。同样按存在性判定。
// 双引擎发行包里，llama 服务与它的 ROCm 运行库单独放在 `<包根>\llama\` ——
// 不能和 hipfire 的 `bin\runtime\amdhip64.dll`（HIP 10.x）混在一起：两个引擎都要
// 一个叫 `amdhip64.dll` 的文件，但版本不同（llama 要 ROCm 7.x 的）。
const LLAMA_DIR = path.join(PKG_ROOT, 'llama');
const LLAMA_EXE_IN_LLAMA_DIR = path.join(LLAMA_DIR, 'llama-kvmem-server.exe');
const RUN_DIR = fs.existsSync(LLAMA_EXE_IN_LLAMA_DIR) ? PKG_ROOT
  : fs.existsSync(path.join(PKG_ROOT, 'bin', 'llama-kvmem-server.exe')) ? PKG_ROOT
  : (fs.existsSync(path.join(PKG_ROOT, 'bin', 'daemon.exe'))
      ? PKG_ROOT
      : path.join(PKG_ROOT, 'kvmem-rocm-windows-review'));
const BIN_DIR = path.join(RUN_DIR, 'bin');
const UI_DIR = fs.existsSync(path.join(PKG_ROOT, 'share', 'kvmem', 'ui'))
  ? path.join(PKG_ROOT, 'share', 'kvmem', 'ui')
  : path.join(RUN_DIR, 'share', 'kvmem', 'ui');
// Prefer the locally built three-in-one binary (KVMem + ROCmFP4 + DFlash2)
// when present; otherwise fall back to the shipped runtime package.
const BUILT_SERVER = path.join(PKG_ROOT, 'build-fp4', 'bin', 'llama-kvmem-server.exe');
const SHIPPED_SERVER = fs.existsSync(LLAMA_EXE_IN_LLAMA_DIR)
  ? LLAMA_EXE_IN_LLAMA_DIR
  : path.join(BIN_DIR, 'llama-kvmem-server.exe');
const USE_BUILT = fs.existsSync(BUILT_SERVER);
const SERVER_EXE = USE_BUILT ? BUILT_SERVER : SHIPPED_SERVER;
// The locally built binary links against the standard ROCm 7.2 runtime, which
// lives outside the package; the shipped package carries its own DLLs.
const ROCM_RUNTIME_BIN = 'C:\\Program Files\\AMD\\ROCm\\7.2\\bin';

// ---------------------------------------------------------------------------
// 可选子引擎：hipfire（RDNA-native Rust 引擎，独立于 llama.cpp）
//
// 为什么走 hipfire.bat 而不是直接 spawn hipfire.exe：hipfire 运行期要 spawn
// clang 编译内核，而这个 clang 在 Windows 上会自动探测到
// E:\Microsoft Visual Studio\VC98\include（Visual C++ 6.0，1998），把它的
// cstdlib 排在真正的 MSVC 头前面 ⇒ 内核编译失败。hipfire.bat 负责
// (a) call vcvars64 拿到正确的 MSVC 头，(b) 把 VC98 那几条从 INCLUDE 里剔除。
// 另外 ROCm 10.1 把设备库放在 <rocm>\lib\llvm\amdgcn\bitcode，clang 经
// --rocm-path 找不到，已在 <rocm>\amdgcn\bitcode 放了一份拷贝。
//
// 两者都是本机安装细节，见 hipfire.bat 的注释。
const HIPFIRE_ROOT       = process.env.KVMEM_HIPFIRE_ROOT || 'H:\\hipfire-home';
const HIPFIRE_BAT        = path.join(HIPFIRE_ROOT, 'hipfire.bat');
// hipfire 模型目录（「扫描模型」按钮扫的就是它）。同样可用环境变量覆盖 ——
// 和 HIPFIRE_ROOT 一个道理：写死本机路径的发行包，别人拿到只能看到一个扫不出
// 任何东西的按钮。
const HIPFIRE_MODELS_DIR = process.env.KVMEM_HIPFIRE_MODELS_DIR || 'J:\\hipfiremodels';
// 模型目录**不能写死**。两次真机事故都出在这上面：
//   1) `J:\\hipfiremodels` 被清空，模型挪进了发行包目录；
//   2) 候选表里写死了 `hipfire-kvmem-2.0.0` 的包路径，用户换成 2.1.0 的包后整个表都落空。
// 所以改成按目录结构动态发现：包自身的 models、常见固定位置、以及 ROOT 各级祖先目录下
// 任何名字像 kvmem/hipfire 的目录（含它的 models 子目录）。
function discoverModelDirs() {
  const out = [];
  const push = (d) => {
    if (!d) return;
    try {
      if (!fs.statSync(d).isDirectory()) return;
    } catch { return; }
    const k = path.resolve(d).toLowerCase();
    if (!out.some((x) => path.resolve(x).toLowerCase() === k)) out.push(d);
  };
  if (process.env.KVMEM_HIPFIRE_MODELS_DIR) { push(process.env.KVMEM_HIPFIRE_MODELS_DIR); return out; }
  // 包自身
  push(path.join(ROOT, 'models'));
  // 常见固定位置
  for (const d of ['J:\\hipfiremodels', 'J:\\kvmemmodels', 'J:\\models',
                   'G:\\models', 'H:\\models']) push(d);
  // 动态发现：ROOT 及其上两级目录里，名字像发行包/kvmem 的目录，及其 models 子目录
  const ancestors = [];
  let cur = ROOT;
  for (let i = 0; i < 3; i++) {
    cur = path.dirname(cur);
    if (!cur || ancestors.includes(cur) || path.dirname(cur) === cur) break;
    ancestors.push(cur);
  }
  for (const a of ancestors) {
    let names = [];
    try { names = fs.readdirSync(a); } catch { continue; }
    for (const n of names) {
      if (!/(kvmem|hipfire)/i.test(n)) continue;
      const base = path.join(a, n);
      push(base);
      push(path.join(base, 'models'));
      // 发行包常见布局：<解压层>/<同名目录>/models
      let inner = [];
      try { inner = fs.readdirSync(base); } catch { continue; }
      for (const m of inner) {
        const sub = path.join(base, m);
        push(sub);
        push(path.join(sub, 'models'));
      }
    }
  }
  return out;
}
const HIPFIRE_MODELS_DIRS = discoverModelDirs();
// 候选目录里递归一层列文件：很多人按仓库/量化方分子文件夹放模型
// （`G:\\models\\ISTA-DASLab\\*.gguf`），只看第一层会全部漏掉。
function* modelFilesIn(dir, depth = 1) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) yield* modelFilesIn(full, depth - 1);
    } else if (e.isFile()) {
      yield full;
    }
  }
}
// hipfire 的 serve.port 环境变量是 HIPFIRE_PORT（不是 HIPFIRE_SERVE_PORT）。
const HIPFIRE_PORT_ENV   = 'HIPFIRE_PORT';
// memory.kv_cache 的合法值（逐字抄自 hipfire 的报错 Enum，不是 llama.cpp 的 dtype）。
const HIPFIRE_KV_MODES = ['auto', 'f32', 'f16', 'bf16', 'q8', 'asym4', 'asym3', 'asym2',
                          'fwht4', 'fwht3', 'fwht2', 'turbo', 'turbo4', 'turbo3', 'turbo2',
                          'fp8', 'legacy-asym3'];
// K/V 两轴单独覆盖的枚举（逐字抄自 memory.kv_k / memory.kv_v 的 ValueRule::Enum）。
// 只列**未弃用**的名字 —— 引擎里还接受 asymN/turboN/legacy-asymN，但那批会在 0.5.0
// 移除，列在面板上等于邀请用户写一个将来会失效的值。
const HIPFIRE_KV_K_NAMES = ['q8', 'fwht2', 'fwht3', 'fwht4'];
const HIPFIRE_KV_V_NAMES = ['q8', 'lloyd2', 'lloyd3', 'lloyd4'];

// ═══════════════════════════════════════════════════════════════════════════
// hipfire 引擎适配器 —— **单写者由构造保证，不靠约定**
//
// 背景：面板有 77 个参数，其中多个会落到同一个 hipfire 键上。实测（机械求逆
// 穷举 + 两轮独立复算）有 6 组真碰撞：
//     memory.max_seq        ← hf_max_seq / ctx_size / kvmem_budget
//     memory.kv_cache       ← hf_kv_cache / kv_dtype
//     generation.max_tokens ← n_predict / kvmem_gen_reserve
//     prompt.chat_template  ← chat_template_file / chat_template
//     developer.dflash_draft← hf_draft / model_draft
//     HIPFIRE_LOG           ← verbosity / kvmem_trace
// 不加约束的话，两栏会**互相静默覆盖**（last-writer-wins）。
//
// 做法：声明「每个键恰好一个 owner」+「哪些参数在 hipfire 下禁用」，发射器
// 只认 owner。测试断言这两条不变量（见 tests/panel-parity.test.mjs）。
// ═══════════════════════════════════════════════════════════════════════════

// 每个 hipfire 键的**唯一写者**。发射器只用这张表决定谁的值出去。
// 表里既有环境变量（HIPFIRE_*）也有 config.toml 键 —— 两者都是"一个键"，都受
// last-writer-wins 威胁，所以放进同一张表。测试会逐键验证"非 owner 改动不影响输出"。
const HIPFIRE_KEY_OWNER = {
  'serve.host':            'host',
  'serve.port':            'port',
  'speculation.mode':      'hf_spec',
  'speculation.mtp_ngram': 'hf_mtp_ngram',
  // MTP 草稿窗口：内核侧按 `mtp_k + 1` 行验证批，就是"每周期起草几个 token"。
  // 只在 mtp 模式下有意义（dflash 的块宽 B 来自草稿模型元数据，不是这个）。
  'speculation.mtp_k':     'hf_mtp_k',
  // 重复环断路器。**是环境变量**：hipfire_runtime::config 直接读
  // HIPFIRE_NGRAM_LOOP_THRESHOLD，不经过 config.toml 的键。
  'HIPFIRE_NGRAM_LOOP_THRESHOLD': 'hf_loop_guard',
  'memory.max_seq':        'hf_max_seq',
  'memory.kv_cache':       'hf_kv_cache',
  // K/V 两轴**单独覆盖**。留空 = 不覆盖，沿用上面模式预设给出的那一半
  // （asym3 就同时决定 K=fwht3、V=q8；这里可以只改其中一轴）。
  // scope 是 ModelLoad，**不是** Request —— 所以写全局 config.toml 是生效的，
  // 与 generation.* 那几个 Request 键（必须写每模型层）不同。
  'memory.kv_k':           'hf_kv_k',
  'memory.kv_v':           'hf_kv_v',
  'generation.max_tokens': 'n_predict',
  'prompt.chat_template':  'chat_template_file',
  'developer.dflash_draft':'hf_draft',
  'serve.prefix_cache':            'hf_prefix_cache',
  'serve.prefix_cache_max_bytes':  'hf_prefix_cache_gb',
  'serve.idle_timeout_seconds':    'hf_idle_timeout',
  'serve.multi_slot':              'hf_multi_slot',
  'serve.multi_slot_slots':        'hf_multi_slot_slots',
  'serve.multi_slot_ctx':          'hf_multi_slot_ctx',
  // ── KV 分层（2026-10-16 修正三处死键）────────────────────────────────
  //
  // **真正的开关是 `memory.kvmem.enabled`**（env 别名 `HIPFIRE_KVMEM`）。
  // 这里原先是 `HIPFIRE_KVMEM_TIER` —— 那个名字**全仓零读取点**，只在一条
  // 警告串（serve_engine.rs:1825）和两处注释里出现过。于是面板点"开"实际只有
  // `HIPFIRE_SLOTS_PAGED` 那一半生效；分层能跑起来纯粹是因为 config.toml 里
  // 恰好留着 `[memory.kvmem] enabled = true`。反过来说：**面板点"关"也关不掉**
  // —— 那一半从来不写，config.toml 的值继续说话。
  'memory.kvmem.enabled':          'hf_kvmem_tier',
  'HIPFIRE_SLOTS_PAGED':           'hf_kvmem_tier',
  // **窗口是语义预算（token），不是页数。** `HIPFIRE_KVMEM_WINDOW_PAGES` 同样是
  // 零读取点的名字（只在 :1686/:1837 两处注释里）。真实键是
  // `memory.kvmem.select_budget`（→ `HIPFIRE_KVMEM_BUDGET`），而它的单位**正好
  // 就是面板一直标称的 token** —— 所以页↔token 的换算在这里整个取消，少一处
  // 能错的算术。留空同样不行：config.toml 里有 38912，落回它就等于"窗口 304 页"，
  // 与面板显示的"未设窗口"完全不是一回事。
  'memory.kvmem.select_budget':    'hf_kvmem_window_tokens',
  'HIPFIRE_SLOTS_PAGED_PAGES':     'hf_kvmem_pool_tokens',
  // 选择策略与检索规模。**"分层开着会不会掉速"的两个主旋钮**：
  //   · `select_method`：`retrieval` 每步给候选块打余弦分；`recency` 只看新旧。
  //   · `query_max_tokens`：打分用的查询前缀长度，直接乘进每步的打分成本。
  // 两者的参考默认都在 config_bridge 里注册过，面板此前一个都没暴露。
  'memory.kvmem.select_method':    'hf_kvmem_method',
  'memory.kvmem.query_max_tokens': 'hf_kvmem_query_tokens',
  'memory.kvmem.gen_budget':       'hf_kvmem_gen_budget',
  'memory.kvmem.sink_blocks':      'hf_kvmem_sink_blocks',
  'memory.kvmem.sink_tokens':      'hf_kvmem_sink_tokens',
  'memory.kvmem.recent_blocks':    'hf_kvmem_recent_blocks',
  'memory.kvmem.cpu_bytes':        'hf_kvmem_cpu_gb',
  'memory.kvmem.trace':            'hf_kvmem_trace',
  // 查询打分器与图传播强度（上游 `--kvmem-query-scorer` / `--kvmem-graph-alpha`）。
  // 两者的耦合规则（page-softmax 不支持 LRFU、cosine 不支持图传播）由引擎裁决。
  'memory.kvmem.query_scorer':     'hf_kvmem_query_scorer',
  'memory.kvmem.graph_alpha':      'hf_kvmem_graph_alpha',
  'memory.kvmem.page_softmax_rows':'hf_kvmem_page_softmax_rows',
  'serve.queue_timeout_ms':'timeout',
  'HIPFIRE_LOG':           'verbosity',
};

// ═══════════════════════════════════════════════════════════════════════════
// Request 作用域的键 —— **必须写到每模型层**，写全局层是静默无效的
//
// 引擎的 request_config_value（hipfire-cli/src/main.rs:7813）按来源分流：
//     ConfigSource::BuiltIn    → None，不参与请求默认
//     ConfigSource::GlobalUser → **只**取被它遮蔽的 RegistryModel/RegistryTarget 层
//     _（CLI / LegacyEnv / ModelUser…）→ 直接用
// `hipfire config set` 写的正是 GlobalUser（config.toml）⇒ 对 Request 作用域的键
// **永远返回 None**，请求默认根本拿不到它。
//
// 实测（同一台机器，dflash + 多槽，散文 384 token）：
//     · 全局层 generation.temperature=0，重启引擎，发不带 temperature 的请求
//       → 28.7 tok/s（rows=1，纯自回归）—— 全局层没用
//     · 每模型层 generation.temperature=0（`hipfire config <模型> set`，落 models.toml）
//       → **61.2 tok/s**（rows=16，DFlash 验证批）—— 每模型层有用
//
// 还有一条**踩了一整轮的坑**：每模型层的键是 `J:\hipfiremodels\...`（**反斜杠**，
// 即 --model 传进去的原样字符串）。用正斜杠发请求会匹配不上，覆盖静默失效 ——
// 我先前所有对照都是用正斜杠发的，于是得出了"面板控制不了"的错误结论。
// ═══════════════════════════════════════════════════════════════════════════
const HIPFIRE_REQUEST_SCOPE = {
  'generation.temperature':       'temperature',
  'generation.top_p':             'top_p',
  'generation.top_k':             'top_k',
  'generation.min_p':             'min_p',
  'generation.repeat_penalty':    'repeat_penalty',
  'generation.presence_penalty':  'presence_penalty',
  // ⚠️ 没有 generation.frequency_penalty —— hipfire 的 schema 里根本没有这个键
  // （实测 `hipfire config explain generation.frequency_penalty` →
  //  "unknown configuration key"）。我一开始把 7 个都写上了，是测试
  //  "config.toml 键：每个都必须被 hipfire 认识" 把它抓出来的。面板的
  //  frequency_penalty 因此对 hipfire 是死键，已列进 HIPFIRE_EXCLUSIVE。
};
for (const [k, v] of Object.entries(HIPFIRE_REQUEST_SCOPE)) HIPFIRE_KEY_OWNER[k] = v;

// hipfire 下**引擎互斥**的 panel 参数：语义在 hipfire 上不存在或已由别的参数承担。
// 它们仍渲染（用户要能看见），但置灰 + 给文案，且**不产生任何输出**。
const HIPFIRE_EXCLUSIVE = {
  model:             'hipfire 只加载 HFQM 权重（用「hipfire 主模型」）；此栏是 GGUF，仅 kvmem 引擎用。',
  model_draft:       'hipfire 的草稿头走「hipfire 草稿头 (DFlash)」；此栏是 llama 侧的 --model-draft。',
  ctx_size:          'hipfire 没有主机溢存层，逻辑工作区 = 显存容量。请用「hipfire 上下文窗口」控制。',
  kvmem_budget:      'hipfire 只有单层 KV，没有「显存内检索子集」这个概念。',
  kvmem_gen_reserve: 'hipfire 不预留显存槽；单轮输出上限由「单轮最大输出」承担。',
  kv_dtype:          'hipfire 的 KV 枚举与 llama.cpp 的 --kv-dtype 不通用（它没有 q4_0/q5_0）。用「hipfire KV 精度」。',
  spec_type:         'hipfire 下请用「hipfire 推测解码」（它含 ngram，本栏没有）。',
  // 这三个是 llama.cpp 的投机解码旗标（--spec-*）。hipfire 的 serve 不认这些旗标，
  // 而它们既不在互斥表里、也没有对应输出 —— 也就是说在 hipfire 下它们**照常显示、
  // 可编辑、然后静默失效**。这正是本次重构要消灭的那类东西，所以补上互斥说明。
  spec_draft_n_max:  'hipfire 的草稿窗口走「草稿 token 数（MTP）」（speculation.mtp_k），此栏是 llama.cpp 的 --spec-draft-n-max。',
  spec_draft_p_min:  'hipfire 没有这个参数：它的 DFlash/MTP 路径不作逐 token 概率过滤。（唯一近似的 dspark 置信度阈值属于 llama 架构的 DSpark 推测器，qwen35 架构走不到。）',
  spec_kv_dtype:     'hipfire 的草稿 KV 精度由主模型的 KV 精度承担（「hipfire KV 精度」），没有独立的 --spec-kv-dtype。',
  // hipfire 的 schema 里没有 frequency_penalty 这个键（实测 `hipfire config explain`
  // 报 "unknown configuration key"）。它只有 presence_penalty 与 repeat_penalty。
  frequency_penalty: 'hipfire 没有「频率惩罚」这个键 —— 它的采样只有 presence_penalty 与 repeat_penalty。要用惩罚请改那两项。',
  threads_batch:     'hipfire 不区分生成线程与批线程，prefill 也在 GPU 上。',
  chat_template:     'hipfire 只接受模板**路径**（它的 prompt.chat_template 是 PathOrEmpty），不收内联文本。请用上面的「对话模板文件」。',
};

// 值域校验：面板范围与 hipfire 的 ValueRule 不一致的字段。
// 返回 null = 合法；返回字符串 = 人话错误（**显式拒绝，绝不静默钳制或丢值**）。
function validateHipfireField(id, value) {
  const v = Number(value);
  if (value === '' || value === null || value === undefined) return null;   // 留空 = 不写
  switch (id) {
    case 'top_k':
      if (!Number.isFinite(v)) return 'top_k 必须是整数。';
      if (v < 1)  return 'hipfire 不能禁用 top-k：采样器始终保留候选池。请填 1–64；要放宽采样请调大 top_p 或减小 min_p。';
      if (v > 64) return 'hipfire 的 top_k 上限是 64（超过会被采样期静默钳到 64，不是拒绝）。';
      return null;
    case 'presence_penalty':
    case 'frequency_penalty':
      if (!Number.isFinite(v)) return `${id} 必须是数值。`;
      if (v < 0) return 'hipfire 只支持 0–2 的惩罚；负值（奖励 token）在 hipfire 上不生效。请用 0 或更大。';
      if (v > 2) return 'hipfire 的惩罚上限是 2.0。';
      return null;
    case 'repeat_penalty':
      if (!Number.isFinite(v)) return 'repeat_penalty 必须是数值。';
      if (v < 1.0) return 'hipfire 不支持 <1.0 的重复惩罚（<1 是奖励重复）。请用 ≥1.0。';
      if (v > 3.0) return 'hipfire 的重复惩罚上限是 3.0。';
      return null;
    case 'top_p':
      if (!Number.isFinite(v)) return 'top_p 必须是数值。';
      if (v <= 0) return 'hipfire 要求 top_p 在 (0,1]；不能用 0 禁用 —— 想关掉请填 1.0。';
      if (v > 1)  return 'top_p 不能超过 1。';
      return null;
    case 'timeout':
      if (!Number.isFinite(v) || v < 1) return 'timeout 必须 ≥1 秒。（hipfire 侧 0 表示「无限等待」，语义与这里不同，不接受 0。）';
      return null;   // >3600 由发射器钳制并提示（见 hipfireQueueTimeout）
    case 'hf_spec':
      if (value && !HIPFIRE_SPEC_MODES.includes(String(value))) {
        return `hipfire 不接受推测解码模式 "${value}"。合法值：${HIPFIRE_SPEC_MODES.join(' / ')}`;
      }
      return null;
    // speculation.mtp_k 的 ValueRule 是 Integer{1,10}。留空 = 用引擎默认 3。
    case 'hf_mtp_k':
      if (!Number.isFinite(v)) return 'MTP 草稿 token 数必须是整数。';
      if (v < 1 || v > 10) return 'hipfire 的 MTP 草稿窗口范围是 1–10（引擎的 ValueRule 就是这么定的）。';
      return null;
    case 'hf_max_seq':
      if (!Number.isFinite(v)) return '上下文窗口必须是整数。';
      if (v < 512 || v > 1048576) return 'hipfire 的上下文窗口范围是 512–1048576 token。';
      return null;
    case 'hf_kv_cache':
      if (value && !HIPFIRE_KV_MODES.includes(String(value))) {
        return `hipfire 不接受 KV 精度 "${value}"。合法值：${HIPFIRE_KV_MODES.join(' / ')}`;
      }
      return null;
    // 两轴单独覆盖。留空 = 不覆盖（合法）。
    case 'hf_kv_k':
      if (value && !HIPFIRE_KV_K_NAMES.includes(String(value))) {
        return `hipfire 不接受 K 轴 "${value}"。合法值：${HIPFIRE_KV_K_NAMES.join(' / ')}（留空 = 沿用模式预设）。`;
      }
      return null;
    case 'hf_kv_v':
      if (value && !HIPFIRE_KV_V_NAMES.includes(String(value))) {
        return `hipfire 不接受 V 轴 "${value}"。合法值：${HIPFIRE_KV_V_NAMES.join(' / ')}（留空 = 沿用模式预设）。`;
      }
      return null;
    // serve.prefix_cache_max_bytes 的 ValueRule 是 Integer{0, 1099511627776}，
    // 但 0 会让 hipfire 直接拒绝启动 ⇒ 面板这一栏的合法区间是 1..1024 GB。
    case 'hf_prefix_cache_gb':
      if (!Number.isFinite(v)) return '前缀缓存上限必须是整数（GB）。';
      if (v < 1)  return '不能填 0：hipfire 规定 serve.prefix_cache_max_bytes 必须 > 0，为 0 会直接拒绝启动。';
      if (v > 1024) return '前缀缓存上限最多 1024 GB（hipfire 的 max 是 1 TiB）。';
      return null;
    // 检查点间隔。**0 是合法值**（= 不间隔：每个页对齐边界都抓，即修复前的行为，
    // 留给 A/B），所以下限是 0 而不是 1 —— 把它按"没设"处理会让 0 悄悄变成 4096。
    case 'hf_prefix_cache_min_step':
      if (!Number.isFinite(v)) return '检查点间隔必须是整数 token 数。';
      if (v < 0) return '检查点间隔不能是负数。0 = 不间隔（每个页对齐边界都抓一份，这是旧行为）。';
      if (v > 65536) return '检查点间隔最多 65536 token。';
      return null;
    case 'hf_multi_slot_slots':
      if (!Number.isFinite(v)) return '槽位数必须是整数。';
      if (v < 1 || v > 64) return 'hipfire 的槽位数范围是 1–64。';
      return null;
    case 'hf_multi_slot_ctx':
      if (!Number.isFinite(v)) return '每槽上下文必须是整数。';
      if (v < 512 || v > 1048576) return 'hipfire 的每槽上下文范围是 512–1048576 token。';
      return null;
    // 窗口大小，单位 token（与 KVMem 的 kvmem_budget 同单位，数值可照搬）。
    // **引擎侧收的就是 token**（`memory.kvmem.select_budget`），换算已经取消 ——
    // 旧代码在这里做了一次 token→页，因为当时发的是 `HIPFIRE_KVMEM_WINDOW_PAGES`
    // 那个零读取点的名字。下限 256 token = 2 块：引擎硬拒 window<2
    // （kvmem_tier.rs —— 一块装不下 attention sink 与至少一个最近块）。
    // 留空合法 = **不淘汰任何页**；发射器会显式写成「每槽上下文」而不是不写
    // （不写会落回 config.toml 的 38912）。
    case 'hf_kvmem_window_tokens':
      if (!Number.isFinite(v)) return '窗口大小必须是整数 token 数。';
      if (v < 256) return '窗口至少要 256 token（= 2 块）：引擎硬拒 0 和 1 块（一块装不下 attention sink 块与至少一个最近块）。';
      if (v > 1048576) return '窗口最大 1048576 token（= 8192 块），与「hipfire 上下文窗口」上限一致。';
      return null;
    // 分页池总量，单位 token（**所有槽共享**的物理容量）。引擎侧同样收页。
    // 下限 256 token = 2 页：池子比一个窗口还小就永远准入失败，那是配错不是调制。
    // 上限 4194304 token = 32768 页，只是防手滑的护栏；真正的边界是显存，
    // 引擎超订物理显存时会在加载期报错，不会静默降级。
    case 'hf_kvmem_pool_tokens':
      if (!Number.isFinite(v)) return '分页 KV 池总量必须是整数 token 数。';
      if (v < 256) return '分页 KV 池至少要 256 token（= 2 页）——池子比一个窗口还小的话请求会永远准入失败。';
      if (v > 4194304) return '分页 KV 池最大 4194304 token（= 32768 页）。真正的边界是显存，但这个上限挡住了手滑多打一位。';
      return null;
    // 主机层容量，单位 GB（引擎收字节，换算在发射器里）。
    // **下限 1 GB、不给 0**：0 在引擎里是"禁用主机层"，而那正是 KVMem 的
    // 一半机制 —— 禁用后被换出的块直接消失，模型在残缺历史上生成，最后
    // 表现成协议错误。这个坑真机踩过（`kvmem_cpu_gb = 0`）。
    case 'hf_kvmem_cpu_gb':
      if (!Number.isFinite(v)) return '主机层容量必须是整数 GB。';
      if (v < 1) return '主机层至少要 1 GB：填 0 等于**禁用主机层**，被换出的块会直接消失（本移植没有 NVMe 层接住），模型将在残缺历史上生成。';
      if (v > 1024) return '主机层最大 1024 GB。这一层是 pinned（不可换页）的系统内存，真正的边界是系统 RAM。';
      return null;
    default:
      return null;
  }
}

// 整数钳制：发射器里的**最后一道**防线（值域校验应该已经在保存时拦下了，
// 但老配置、手改的 config.json、以及 API 直连都可能绕过它）。
function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// 面板 timeout → serve.queue_timeout_ms。
// 上限 3,600,000 ms 来自 hipfire-config/src/lib.rs:1150 的 ValueRule::Integer{min:0,max:3600000}。
// ⚠️ 这两个参数**语义不同**，所以即使没被钳制也要给提示（静默改语义是最难查的那类 bug）：
//     面板 timeout   = llama.cpp 的 --timeout，读写超时；
//     hipfire 那一个 = **准入队列等待**，排太久就回 503，0 表示永久等待。
function hipfireQueueTimeout(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 1) return null;
  if (s > 3600) {
    return { ms: 3600000, notice: '面板的 timeout 在 hipfire 上映射为 serve.queue_timeout_ms，' +
      '它的上限是 3600 秒（≤ 3,600,000 ms），已按 3600 秒生效。' };
  }
  return { ms: Math.round(s * 1000), notice: '面板的 timeout 在 hipfire 上映射为 serve.queue_timeout_ms —— ' +
    '注意它限制的是**准入队列等待**（排不到就回 503），不是读写总超时。' };
}

const CONFIG_FILE = path.join(ROOT, 'config.json');
const LOG_FILE = path.join(ROOT, 'server.log');
// 控制面板自己的 UI 跟着脚本走（发行包里就是 <包根>/panel/control-ui.html）。
const CONTROL_UI = path.join(PANEL_DIR, 'control-ui.html');
// 控制台端口可用环境变量覆盖。默认 18201；覆盖的用途是**在不停掉现有控制台的前提下
// 起第二个实例**（测试/对比），否则第二个实例会绑不上端口直接退出。
const CONTROL_PORT = Number(process.env.KVMEM_PANEL_PORT) || 18201;
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
    group: 'engine', title: '推理引擎（子引擎选择）', icon: '⚙️',
    desc: '选用哪个引擎跑推理。KVMem = 基于 llama.cpp 的主引擎（默认，支持全套 KVMem 特色功能：跨会话前缀缓存、分层存储、对话快照）。hipfire = RDNA-native 独立引擎，用自己的 HFQM 权重格式，长散文推测解码更快（实测 DFlash 104 tok/s）。切换引擎后需点「保存并重启」生效。',
    params: [
      { id: 'engine', label: '引擎', type: 'select', default: 'hipfire', options: ['kvmem', 'hipfire'],
        help: 'kvmem = llama.cpp 主引擎（GGUF 模型，KVMem 特色功能全在）；hipfire = 独立子引擎（HFQM 模型，下面四项只对 hipfire 生效）。' +
              '**本机默认是 hipfire**。' +
              '⚠️ 选 hipfire 需要机器上已装 hipfire（默认找 H:\\hipfire-home，可用环境变量 KVMEM_HIPFIRE_ROOT 覆盖）；' +
              '没装的话「启动前置检查」会直说找不到启动器，不会静默失败。' },

      { id: 'hf_model', label: 'hipfire 主模型 (HFQM)', type: 'hfmodel',
        help: 'hipfire 专属格式（魔术字节 HFQM，不是 GGUF）。点「扫描模型」从 J:\\hipfiremodels 读取。' },
      { id: 'hf_draft', label: 'hipfire 草稿头 (DFlash)', type: 'hfdraft',
        help: 'DFlash 推测解码的草稿模型。选 dflash 模式时**必填** —— 不填 hipfire 会直接报错退出（它要求 registry 登记的模型，而按路径给的文件拿不到登记信息）。' },
      { id: 'hf_spec', label: 'hipfire 推测解码', type: 'select', default: 'dflash',
        options: ['off', 'mtp', 'dflash', 'ngram', 'auto'],
        help: 'off=纯自回归（散文约 40 tok/s）；dflash=草稿头（散文实测 104 tok/s，最快）；mtp=模型自带 MTP 头（散文约 52）；ngram=无模型 n-gram（散文约 75，但代码场景会变慢）。' },
      { id: 'hf_mtp_ngram', label: 'MTP n-gram takeover', type: 'select', default: 'off', options: ['off', 'on'],
        help: '仅 mtp 模式有效。把 n-gram 候选接管进 MTP 草稿窗口，散文实测 52 → 66 tok/s。默认 off 是因为 hipfire 只在 gfx1151/gfx1201 自动开启，我们是 gfx1100 需要手动开。' },
      { id: 'hf_mtp_k', label: '草稿 token 数（MTP）', type: 'int', optional: true, min: 1, max: 10, default: 3,
        help: 'hipfire 的 MTP 草稿窗口（speculation.mtp_k）：**每个投机周期起草几个 token**。' +
              '内核侧就是按 `mtp_k + 1` 行组一个验证批 —— 起草 3 个、连同种子共 4 行。' +
              '引擎默认 3，范围 1–10。' +
              '**只在 mtp 模式下有意义**：dflash 的块宽 B 来自草稿模型的元数据（本机是 B=16），不受这一项控制；' +
              'ngram 模式走的是「n-gram 草稿窗口」那一个键。' +
              '**dflash 模式不受它管**：DFlash 的块宽 B 由草稿模型元数据给，贪心与采样都用 DFlash 自己的验证路径。' +

              '起草得越多、单步潜在收益越大，但接受率会掉 —— 掉过头就是净亏（llama 侧实测 3 → 7 时接受率 37%→19%、总吞吐反而回落）。' },
      { id: 'hf_max_seq', label: 'hipfire 上下文窗口 (token)', type: 'int', optional: true, default: 262144, min: 512, max: 1048576,
        help: '★ 与上面「逻辑工作区」是两套东西：那个是 llama.cpp 的 --ctx-size（KVMem 可把 KV 溢到主机内存，所以能给 256K）；' +
              'hipfire 没有分层 KV，上下文受显存约束，且这个值**没有环境变量**，控制台会写进 hipfire 的 config.toml（用它的官方 config set，不动其它键）。' +
              '留空 = 不干预。实测不设时 hipfire 只用 legacy 默认 4096，长文会报 "prompt+max_tokens exceeds ctx_capacity 4096"。' },
      { id: 'hf_prefix_cache', label: 'hipfire 跨会话前缀缓存', type: 'bool', default: false,
        help: 'hipfire 自带的**进程内**前缀缓存（radix 索引 + 页引用计数 + CheckpointPool）。' +
              '开了之后同一进程内多个对话的公共前缀只算一次 prefill —— 这就是「跨会话复用」。' +
              '官方标注「未经发布闸门」，且**开启会强制切 paged KV**。模型卸载即失效。' },
      { id: 'hf_prefix_cache_gb', label: 'hipfire 前缀缓存上限 (GB)', type: 'int', optional: true, default: 8, min: 1, max: 1024,
        help: '上面前缀缓存的**保留上限**（含混合快照）。hipfire 规定为 0 时**启动即拒**' +
              '（报 "serve.prefix_cache requires serve.prefix_cache_max_bytes > 0"），所以这个值必须 ≥1。' +
              '**注意：这是上限，不是预留，而且它会真的花掉显存** —— 混合快照（DeltaNet 状态）按 capture ' +
              '惰性 malloc，长文 prefill 每 1024 token 就抓一份，一路长到这个上限。实测 24 GiB 卡上 ' +
              '8 GB 上限把峰值推到 27.8 GB。引擎现在会按设备余量把这个值收口（日志打 ' +
              '"prefix cache ceiling: configured … effective …"），所以设大不会撑爆卡，但设大了也不等于拿到。' },
      { id: 'hf_prefix_cache_min_step', label: 'hipfire 检查点间隔 (token)', type: 'int', optional: true, default: 4096, min: 0, max: 65536,
        help: '两份**混合状态快照**（DeltaNet 状态）之间至少隔多少 token。捕获不便宜：每份都要为全部 ' +
              '48 个 DeltaNet 层新 malloc 一整份循环状态。**不分隔时的实测**：prefill 的 chunk 正好 8 页、' +
              '页对齐，于是**每个 chunk 都抓一份** —— 37k 的 prefill 抓了 39 份、把 checkpoint 池从空推到约 ' +
              '5.5 GB，24 GiB 卡上这就是 22.3 GB 与 27.8 GB 的差别。\n' +
              '检查点是**续跑点，不是逐 chunk 日志**：4096 让 37k prefill 只抓约 9 份，代价只是落在两个检查点' +
              '之间的复用请求回退到较早那个（或如实重算）—— 和现在页内尾部 chunk 的回退是同一条路。\n' +
              '0 = 退回旧行为（每个页对齐边界都抓），只留着做 A/B。' },
      { id: 'hf_idle_timeout', label: 'hipfire 空闲卸载延迟 (秒)', type: 'int', optional: true, default: 0, min: 0, max: 86400,
        help: '多久没有请求就把模型从显存卸载（`serve.idle_timeout_seconds`，引擎默认 **300 = 5 分钟**）。\n' +
              '**默认 0 = 永不卸载**，因为卸载的代价在长跑里非常大：下次请求要**重新加载权重**' +
              '（本机实测权重扫描约 9-18 秒，整段加载更久），而这期间请求是阻塞的。' +
              '做 harness / 压测时它会把「思考时间」算进延迟，看起来像引擎卡住了。\n' +
              '**引擎侧的判据**（`serve/mod.rs:1597-1606`）：`if !idle_timeout.is_zero()` 才 spawn 那个' +
              '每秒检查一次的监视线程 —— 所以 **0 是真的禁用**（线程根本不启动），不是"立刻过期"。\n' +
              '日常聊天想省显存就设个 300 之类；**跑压测必须设 0**。' },
      { id: 'hf_multi_slot', label: 'hipfire 多槽并发', type: 'bool', default: false,
        help: '同时服务多个请求（一个权重副本 + 多套 KV 槽），而不是一次一个。' +
              '**这是会话换出（eviction→主机内存→按需换回）唯一会发生的路径** —— 单槽永远不会换出。' +
              '官方把它标为实验特性。' },
      { id: 'hf_multi_slot_slots', label: 'hipfire 槽位数', type: 'int', optional: true, default: 4, min: 1, max: 64,
        help: '多槽模式下的并发槽数量（hipfire 默认 4，上限 64）。每槽各占一份 KV。' },
      { id: 'hf_multi_slot_ctx', label: 'hipfire 每槽上下文 (token)', type: 'int', optional: true, default: 8192, min: 512, max: 1048576,
        help: '多槽模式下**每个槽**的上下文容量（hipfire 默认 8192）。' +
              '总占用 ≈ 槽位数 × 这个值，与「hipfire 上下文窗口」是两套东西：' +
              '单槽模式用上面那个，多槽模式用这个。' },
      { id: 'hf_kvmem_tier', label: 'hipfire KV 分层（常驻窗口）', type: 'bool', default: false,
        help: '把 KVMem 式的常驻窗口接到 hipfire 的分页 KV 池上：每步每槽只保留「第 0 页（attention sink）' +
              '+ 最近若干页 + 注意力打分最高的若干页」，其余页**换出到主机层**（`memory.kvmem.cpu_bytes`），' +
              '下一轮选择时可以换回来，从而给设备占用封顶。' +
              '（**2026-10-16 修正**：此前面板写的是"直接丢弃、不换出到主机内存" —— 那是旧实现。' +
              '移植后的分层有主机层与 NVMe 层，被换出的块**可以**换回来。）\n\n' +
              '⚠️ **必须先打开「hipfire 多槽并发」**：分层跑在多槽引擎（slot engine）里，' +
              '而多槽引擎只在多槽并发打开时才被创建，单槽/普通路径是另一套模型所有者、没有块表。' +
              '不开多槽的话分层参数**一个都不会被引擎读到**，KV 会按「hipfire 上下文窗口」全量分配 —— ' +
              '这不是"没效果"，是直接把设备顶穿（实测 262144 上下文下溢出到共享显存，prefill 与 decode 一起塌）。' +
              '面板会在保存时直接拒绝这个组合。\n' +
              '⚠️ **「hipfire 槽位数」会被自动钉成 1**。引擎在 `n_slots > 1` 时**直接把分层关掉**' +
              '（serve_engine.rs:1803，打印「kvmem 致命：分层在多槽引擎上尚未支持」），而槽位数缺省是 4。' +
              '也就是说：多槽开 + 槽位 4 = 分层被关掉的那个组合，而旧面板恰好要求的就是这个组合。' +
              '多槽在这里只是让 SlotEngine 存在的**通道**，不是让分层并发跑多个会话 —— 分层目前是单序列语义。' +
              '面板发射时会写 `serve.multi_slot_slots = 1` 并出声说明。\n' +
              '**开启会自动同时设 HIPFIRE_SLOTS_PAGED=1** —— 分层要改写块表，而只有分页池有块表。\n' +
              '⚠️ 实验特性：多槽路径要求 trunk 的 dense DeltaNet 层是 Q8_0 或 MQ4G256 族，否则会拒绝启动。' +
              '**本机已实测可用的权重**：`qwen3.8-27b.mq4-xt` 与 `qwen3.8-27b.mq4-pro-uniform.hfq`。' +
              '**`qwen3.8-27b.mq4-pro` 过不了这道门** —— pro 档把 `ssm_out`（linear_attn.out_proj）抬到了 Q8，' +
              '八个投影的 dtype 不再统一，slot 路径没有逐 token 回退，只能直接拒绝。' +
              '换档位时记得先在「hipfire 主模型」里重新扫一次。\n\n' +
              '── 开关是**双向显式写**的 ──\n' +
              '发射器会写 `memory.kvmem.enabled = true/false`，**两个方向都写**。' +
              '（旧面板只写"开"那一半 ⇒ 点"关"关不掉：config.toml 里的 `enabled = true` 继续说话，' +
              '引擎照旧跑分层，而用户以为自己在做 A/B 对照。两个臂其实是同一个配置。）\n\n' +
              '── 关掉分层会怎样 ──\n' +
              '**关掉 = 稠密槽位，上下文全进显存**：面板不再发 HIPFIRE_SLOTS_PAGED，' +
              '引擎 `paged_pages = None` 就走非分页 arena，按「上下文窗口」整块分配、不淘汰任何页。' +
              '这正是做 A/B 排除分层干扰时想要的模式。\n' +
              '**代价必须自己算**：稠密 KV ≈ 上下文 × 16 层 × 1488 B。本机实测口径：\n' +
              '  · 264000 → 5.85 GiB：计划 20.56 GiB，预检**卡在** vram_free 边缘，含草稿后约 27 GB 越线；\n' +
              '  · 96000 → 2.13 GiB：计划 16.84 GiB，约 23 GB ✓；\n' +
              '  · 64000 → 1.42 GiB：计划 16.13 GiB，约 22 GB ✓。\n' +
              '所以测这条前**先把「上下文」降下来**，否则会看到预检拒绝启动（那是内存不够，不是分层的问题）。' },
      { id: 'hf_kvmem_window_tokens', label: 'hipfire KV 检索窗口 (token)', type: 'int', optional: true, min: 256, max: 1048576,
        help: '每个槽最多常驻多少历史 token（= attention sink 页 + 最近若干页 + 注意力打分最高的若干页）。' +
              '**单位与上面 KVMem 的「GPU 检索窗口 (token)」一致，数值可直接照搬**：' +
              'KVMem 官方 16GB 配方值 36864 在这里就是 36864，等价于 288 页。' +
              '写的是 `memory.kvmem.select_budget` —— **引擎内部单位本来就是 token**，' +
              '（2026-10-16 修正：旧面板发的是 `HIPFIRE_KVMEM_WINDOW_PAGES`，那个名字**零读取点**，' +
              '滑条填的值从来没到过引擎；引擎读的是 config.toml 里那个 38912 = 304 页。' +
              '当时还在这里做了一次 token→页 的换算，现在整个取消 —— 少一处能错的算术。）' +
              '**留空 = 不淘汰任何页**：发射器会把它**显式写成「每槽上下文」**，' +
              '而不是什么都不写。这一点很重要 —— config.toml 里留着 38912，不显式覆盖就会落回它，' +
              '那与面板显示的"未设窗口"完全不是一回事（旧面板正是这么骗人的）。' +
              '填了就必须 ≥256（= 2 块）——引擎硬拒 0 和 1 块（一块装不下 sink 块与至少一个最近块，静默丢 sink 是灾难性的）。' +
              '窗口按 128-token 块对齐，不是 128 的整数倍会向上取整并给出提示。' +
              '选页优先级：sink 块 → 最近若干块 → **注意力质量最高的若干块**（质量来自 attention 的 softmax 权重，已内核每步产出，无需额外回读）。' +
              '注意力打分在上下文超过 8192 token 后生效（q8 KV 在 8192 以内走的是共享内存里算 softmax 的那条 arm，权重用完即弃；' +
              '其他 KV 模式与 8192 以上的 q8 走 flash arm，质量随时可用）。8192 以内窗口退化为 sink + 最近——而那个长度本来也不需要分层。\n' +
              '**掉速注意**：窗口 ≥ 上下文时选择器**根本不启动**（`pick_topk_blocks` 有早退：块数 ≤ 预算就直接全留，' +
              'hipfire-kvmem-tier/src/store.rs:750）。窗口设小、上下文超过它之后，每步才开始真打分 —— ' +
              '要查分层是否掉速，先看这一栏是不是比上下文小了。' +
              '仅在「hipfire KV 分层」开启时生效。' +
              '\n**怎么填（2026-10 本机实测，比上面那套旧推荐更准）**：窗口决定的是**淘汰有没有发生**，' +
              '而淘汰一开，prefill 就贵 2–3 倍（20 万 token 提示：窗口内 0.76 ms/token，跨窗口 1.7–3.1）。' +
              '实测同一 20k 提示换三档窗口：22k → 768–863 tok/s、**36.5k → 982 tok/s**、49k → 592–780。' +
              '所以 **窗口 = max(提示 × 1.5, 提示 + 12k)** 最划算：' +
              '刚跨过（×1.1）会一直踩边界、远超（×2.5）池子/块表本身又有开销。' +
              '20k 提示 → 36k；40k 提示 → 49k。' +
              '**别再往大了调**（2026-10-18 实测）：窗口 64k / 100k 时 paged 解码走的是「不淘汰」那条路，' +
              '同一 55k 深度 decode 只有 **4.4 tok/s**（49k 窗口下是 40.1）——比淘汰还慢 9 倍，且与显存无关（100k 仍有 3.5 GiB 余量）。' +
              '所以窗口就该停在 49k 附近：让该被淘汰的历史被淘汰，换来单位注意力的效率。' +
              '**多条长会话同时跑时，池里要装下好几份窗口**，必须按会话数放大，否则淘汰照样发生。' },
      { id: 'hf_kvmem_pool_tokens', label: 'hipfire 分页 KV 池总量 (token)', type: 'int', optional: true, min: 256, max: 4194304,
        help: '分页 KV 池的**物理**容量，**所有槽共享**一份。这是分层功能唯一能压住显存的旋钮 —— ' +
              '「检索窗口」决定每槽**留**多少，「池总量」决定物理上**有**多少。' +
              '**留空 = 引擎默认**：`槽位数 × ceil(每槽上下文 / 128)` 页，即与不分页时的容量相同，' +
              '准入行为不变、只是分配方式变成按需分页（最保守，但分层省下的显存一点也没省）。' +
              '开了分层之后**建议显式设**：池子只需覆盖每槽的窗口加上一步 prefill 的峰值，' +
              '即约 `槽位数 × (窗口页数 + 9)`，再留一点余量。' +
              '例如单槽 / 窗口 36864（288 页）⇒ 297 页 ≈ 38016 token，取 40960 即可；两槽取 76800。' +
              '（那个 9 = 引擎默认的 prefill 块 1024 token（8 页）+ 1 页前沿余量。' +
              '**不用把「单轮最大输出」算进去** —— 生成是一步一个 token、每步都压实，它不会在表里累积。）' +
              '**设小了不会损坏数据**：池耗尽时该步**失败关闭**（在写任何内核之前报错），不会写穿到别的槽；' +
              '**设大了会超订物理显存**，这是操作者的判断。' +
              '⚠️ 同时开了「hipfire 跨会话前缀缓存」时要额外留空间 —— 缓存页与活动槽共用这个池；' +
              '留空时引擎会自动多留 `prefill 块 / 128 + 槽位数` 页，**显式填了就不再自动加**。' +
              '按 128-token 页对齐，不是 128 的整数倍会向上取整并给出提示。' +
              '\n**2026-10 起「留空」的含义变了，建议就留空**：引擎现在按**窗口**定尺 —— ' +
              '`槽位数 × (窗口页 + prefill 块页 + 1 + 余量) + 缓存预留`，再按**真实空闲显存**夹紧（夹紧时会打印实际页数）。' +
              '旧口径（按整槽上下文定尺）会为 264k 上下文一口气要 2063 页 ≈ 9.7 GiB，' +
              '把显存吃光后 `hipMalloc` 会**静默回落到系统内存**，速度掉到 1/6 而且不报错。' +
              '只有一种情况要手填：想**故意**多留余量给并发。手填时务必 ≥ `窗口页数 + prefill 块页 + 1`，' +
              '否则第一步换页就会失败关闭（现象是 `503 server capacity exhausted while reserving KV pages`）。' },
      // ── 以下为 2026-10-16 新增：此前 hipfire 的 `memory.kvmem.*` 有 31 个键，
      // 面板只暴露了 3 个，且其中 2 个是死名（见发射器那段）。这里补上**与掉速
      // 直接相关**的那几个 —— 选择策略、检索规模、预算分配、主机层容量。
      { id: 'hf_kvmem_method', label: 'hipfire KV 选择策略', type: 'select', optional: true,
        options: ['retrieval', 'recency', 'h2o'],
        help: '候选块的排序依据（`memory.kvmem.select_method`）。\n' +
              '· **retrieval**（引擎默认）：按块均值 K 与当前查询的余弦相似度排序 —— 能捞回"中间那段相关历史"，' +
              '但**每步都要给候选块打分**。\n' +
              '· **recency**：只看新旧，sink + 最近若干块。**打分成本接近零**。' +
              '· **h2o**：参考实现的第三种策略（Heavy-Hitter Oracle）。\n' +
              '**掉速排查第一站**：如果窗口小于上下文（选择器真的启动了），' +
              '把这一栏从 retrieval 改成 recency 就是"分层打分是否值得"的直接对照 —— 两臂的其他参数可以完全不动。' },
      { id: 'hf_kvmem_query_tokens', label: 'hipfire KV 检索查询长度 (token)', type: 'int', optional: true, min: 1, max: 65536,
        help: '打分时用多少个 token 的查询前缀（`memory.kvmem.query_max_tokens`，引擎默认 512）。' +
              '**打分成本与它近似线性** —— 每步的打分工作量 ≈ 查询长度 × 候选块数。' +
              '参考实现里这个值是可配的，因为它直接决定"检索准不准"与"每步花多少"的取舍：' +
              '查询太短（比如只取最后一个 token）会让余弦分噪声很大，选出来的块不稳定；' +
              '太长则把成本推到每步都看得见。' +
              '本机做小轮次对照时用过 131（= 一轮的长度），就是为了让 pin 跨度不覆盖整个窗口预算、' +
              '两个策略臂才能分化。' },
      { id: 'hf_kvmem_gen_budget', label: 'hipfire KV 生成预留 (token)', type: 'int', optional: true, min: 0, max: 1073741824,
        help: '生成期预留的预算（`memory.kvmem.gen_budget`，引擎默认 32768）。' +
              '按参考的 `kvmem_compute_pool`（llama-memory-kvmem.cpp:395-414），' +
              '**池 = 预算 + 生成预留**，而池超出物理上限时**先收缩预留**（一路降到一块），' +
              '只有当预算**单独**就超上限时才动预算。' +
              '所以这个值通常不需要改：池紧张时它是那个被吃掉的一方。' +
              '**留空 = 不写**，用引擎的 32768。' },
      { id: 'hf_kvmem_sink_tokens', label: 'hipfire KV sink 前缀长度 (token)', type: 'int', optional: true, min: 0, max: 1073741824,
        help: '**永远保留的前缀长度，按 token 计**（`memory.kvmem.sink_tokens`，参考的 `--kvmem-sink-tokens`）。\n' +
              '**为什么按 token**：这个旋钮的用途是保住**长驻的系统提示**（含工具定义），' +
              '而它天然是按 token 量的（"我的 system prompt 3000 token"）。' +
              '参考的 CLI 就是按 token 收的（`llama-memory-kvmem.cpp:294-296`）：\n' +
              '    sink_blocks = sink_tokens == 0 ? 1 : max(1, sink_tokens / block_tokens)\n' +
              '**非 0 时它会覆盖下面的「sink 块数」**（两者同时写，tokens 赢）。' +
              '除法向下取整到整块，与参考一致。\n' +
              '**什么时候必须设**：system 提示（尤其带工具定义）比 128 token 长的时候。' +
              '不设的话只保住第 0 块，其余靠检索打分竞争窗口 —— 而系统提示是声明语气、' +
              '与用户当前问题语义不占优，容易被挤出窗口。' +
              '**症状**：模型看不到完整工具列表，开始猜工具名（`mcp__local__xxx` 一路 `unknown tool`），' +
              '最后吐 `malformed_protocol` —— 报错完全不指向这一栏。\n' +
              '**怎么估**：`system 提示的 token 数`。宁大勿小（多留一点只花窗口预算，少留就是丢工具）。' +
              '留空/0 = 用下面的「sink 块数」。' },
      { id: 'hf_kvmem_sink_blocks', label: 'hipfire KV sink 块数', type: 'int', optional: true, min: 0, max: 1048576,
        help: '永远保留的前若干**块**（`memory.kvmem.sink_blocks`，引擎默认 1）。' +
              '第 0 块是 attention sink，丢它会让模型整体失稳 —— 所以它优先于一切，包括用户 pin。' +
              '**上面的「sink 前缀长度」非 0 时这一栏被忽略**（参考的优先级，' +
              '`llama-memory-kvmem.cpp:294-296`）。长 system 提示请用上面那一栏（按 token 更直接）。' },
      { id: 'hf_kvmem_recent_blocks', label: 'hipfire KV 最近块数下限', type: 'int', optional: true, min: 0, max: 1048576,
        help: '除 sink 外**至少**保留的最近块数（`memory.kvmem.recent_blocks`，引擎默认 0）。' +
              '0 表示不设下限，完全交给选择器。' +
              '引擎每步还会把「本步要读写的那几块」作为 mandatory 传进选择器（参考的 `retrieval_mandatory`），' +
              '所以 0 不会导致本步要用的块被淘汰 —— 这一栏是给"生成期希望多留一点近处上下文"用的。' },
      { id: 'hf_kvmem_cpu_gb', label: 'hipfire KV 主机层容量 (GB)', type: 'int', optional: true, default: 12, min: 1, max: 1024,
        help: '主机 pinned 层的容量（`memory.kvmem.cpu_bytes`）。' +
              '被换出设备窗口的块落在这里，下一轮选择时可以换回来。' +
              '**这是 KVMem 的机制本体**：GPU 只留常驻窗口，「其余的」全部压在这一层 —— ' +
              '所以它必须装得下「总上下文 − 窗口」的全部块，否则被换出的块**直接消失**' +
              '（本移植没有 NVMe 第三层接住它们）。\n' +
              '**留空 = 不写**，引擎会落回 config.toml 里的旧值；**设成 0 = 禁用主机层**，' +
              '那等于关掉 KVMem 的一半机制。所以这一栏的下限是 1 GB，不给 0。\n' +
              '**怎么估**：块大小 = 16 层 × 每 token K/V 字节 × 128 token。\n' +
              '  · fwht3 + lloyd3：400 + 1088 = 1488 B/pos ⇒ **2.91 MiB/块**；\n' +
              '  · q8：1088 + 1088 = 2176 B/pos ⇒ **4.25 MiB/块**。\n' +
              '需要的块数 = ceil(上下文 / 128) − 窗口页数。256k 上下文（2063 块）减 285 页窗口：\n' +
              '  · q8 ⇒ 1778 块 × 4.25 MiB = **7.4 GiB**；\n' +
              '  · fwht3 ⇒ 1778 块 × 2.91 MiB = **5.1 GiB**。\n' +
              '**默认 12 GB** 是按 q8 + 256k 留约 1.6× 余量定的。' +
              '这一层是 **pinned（不可换页）的系统内存**，不是显存 —— 设大了会挤占系统 RAM。\n' +
              '⚠️ 设小了不会报错，只会让超出部分的块被丢弃，模型在残缺历史上生成，' +
              '最后表现为奇怪的输出或协议错误 —— 报错不指向这一栏。宁大勿小。' },
      // ── 查询打分与图召回（上游 `--kvmem-query-scorer` / `--graph-alpha` 的
      //    三个旋钮，2026-10-23 接入）────────────────────────────────────────
      // 三个键的**写入块**在 applyHipfireConfig 里（不在 int-key 循环里，因为
      // 它们是 select / float，得单独校验）。这里的字段定义决定面板**显不显示**。
      { id: 'hf_kvmem_query_scorer', label: 'hipfire KV 查询打分器', type: 'select', optional: true,
        options: ['meanq-cosine', 'page-softmax'],
        help: '`memory.kvmem.query_scorer`（上游 `--kvmem-query-scorer`）。**这是这组里唯一真正的开关**。\n' +
              '· **meanq-cosine**（0.18 发布版配置，本移植默认）：块均值 K 对本轮均值 Query 的余弦，' +
              '叠 LRFU 时序衰减 + GQA-max 聚合。\n' +
              '· **page-softmax**（上游源码默认的 C 档）：逐 token 对页域做 scaled-dot softmax，' +
              '再走一次单跳图召回传播。\n' +
              '⚠️ 两臂**不是可自由组合的**，耦合规则由引擎裁决（上游 `resolve_query_scoring`）：' +
              'page-softmax ⇒ 均值聚合 / 关 LRFU / 图传播 α=0.2；meanq-cosine ⇒ max 聚合 / 开 LRFU / 关图传播。' +
              '所以下面两个旋钮的取值会不会生效，取决于这一栏。\n' +
              '实测（40 轮到 25 万 token）：两档**稳定性与墙钟同量级**（0 错误、0 退化）；' +
              '答案长度与解码速率的完整对照见 `KVMem-0.18-ALIGNMENT.md` 第四节。' },
      { id: 'hf_kvmem_graph_alpha', label: 'hipfire 图召回传播强度 α', type: 'float', optional: true,
        default: 0, min: 0, max: 1, step: 0.05,
        help: '`memory.kvmem.graph_alpha`（上游 `--kvmem-graph-alpha`），**0 = 用上游默认 0.2**。\n' +
              '只在 page-softmax 档生效：α·0.25 给相邻块、α·0.5 沿注意力边搬运，单跳、不再传播\n' +
              '（α=0.2 时正好是文档写死的 0.05 / 0.1）。\n' +
              '⚠️ **在 page-softmax 档下填 0 关不掉图传播**：上游是 ' +
              '`if (!graph_alpha_set) graph_alpha = cosine ? 0.0 : 0.2`，' +
              '而配置键的默认值 0 就是"未设"的拼写，所以在 C 档里 0 会被解释成 0.2。' +
              '真要关掉图召回，把上面的打分器切回 meanq-cosine —— 耦合规则会顺带把它归零。' },
      { id: 'hf_kvmem_page_softmax_rows', label: 'hipfire page-softmax 每层采样行数', type: 'int', optional: true,
        default: 0, min: 0, max: 64,
        help: '`memory.kvmem.page_softmax_rows`，**0 = 用引擎默认 8**，上限 64（= `QUERY_ROW_CAP`）。\n' +
              '⚠️ **上游没有这个选项**：它在 GPU 上按 64 行一块遍历**全部** query token\n' +
              '（`graph_recall.cpp:255`）。主机侧付不起 `rows × heads × blocks × dim` ——' +
              '实测 64 行在 1500 块上要数秒 —— 所以这是 hipfire 独有的**降采样预算**：' +
              '在整段 query 上**等距**取这么行（不是取尾部，取尾部会把 507 行里的 499 行丢掉并偏向轮次末尾）。\n' +
              '成本随这个值线性：1904 块时 8 行 ≈ 650 ms/次，每回合打一次（占墙钟约 2.8%）。' },
      { id: 'hf_kvmem_trace', label: 'hipfire KV 分层跟踪日志', type: 'bool', default: false,
        help: '打开 `memory.kvmem.trace`：引擎逐步打印分层决策（选择/换出/换入）。' +
              '**只在排查时开** —— 每步一行，长生成下日志会很大。' +
              '与上面的「hipfire 日志级别」是两条路：这一条是分层的结构化跟踪，那一条是 EnvFilter 级别。' },
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
    desc: '两个引擎都按同一个套路：**上面一栏"K 和 V 一起调"，下面两栏单独覆盖其中一轴**。' +
          '降低精度显著省显存，代价是一点精度损失。',
    params: [
      { id: 'kv_dtype', flag: '--kv-dtype', label: 'K/V 缓存类型', type: 'select', default: 'q8_0',
        options: ['q8_0', 'q5_0', 'q4_0', 'f16', 'f32'],
        help: '同时设置 K 与 V。IQ3 配方用 q8_0（默认）。想省显存可用 q5_0；再往下精度损失开始明显。' },
      { id: 'cache_type_k', flag: '--cache-type-k', short: '-ctk', label: '单独设置 K 类型', type: 'select', optional: true,
        options: ['q8_0', 'q5_0', 'q4_0'], help: '留空跟随上面的「K/V 缓存类型」。想混合精度时在此单独指定（如 K=q8_0、V=q4_0）。' },
      { id: 'cache_type_v', flag: '--cache-type-v', short: '-ctv', label: '单独设置 V 类型', type: 'select', optional: true,
        options: ['q8_0', 'q5_0', 'q4_0'], help: '留空跟随上面的「K/V 缓存类型」。K 与 V 都设为量化类型才允许混合（浮点+量化混搭会被拒绝）。' },
      { id: 'hf_kv_cache', label: 'hipfire KV 精度', type: 'select', optional: true,
        // ⚠️ 这张表必须与 hipfire 的 memory.kv_cache 枚举逐字一致 —— 不能照抄
        // llama.cpp 的 dtype（那边有 q4_0/q5_0，hipfire 一个都没有）。
        // 抄错的症状是 hipfire 启动即拒、退码 1，日志里只有一行
        // "invalid value for memory.kv_cache: string does not satisfy Enum([...])"。
        options: ['auto', 'f32', 'f16', 'bf16', 'q8', 'asym4', 'asym3', 'asym2',
                  'fwht4', 'fwht3', 'fwht2', 'turbo', 'turbo4', 'turbo3', 'turbo2', 'fp8', 'legacy-asym3'],
        help: '留空 = 按模型推荐（本模型为 q8）。注意这是 hipfire 自己的枚举，与 llama.cpp 的 --kv-dtype 不通用（没有 q4_0/q5_0）。' },
      { id: 'hf_kv_k', label: 'hipfire K 轴单独覆盖', type: 'select', optional: true,
        options: ['q8', 'fwht2', 'fwht3', 'fwht4'],
        help: '只覆盖 **K** 这一半（`memory.kv_k`），留空 = 沿用上面模式预设给出的 K。' +
              '和 llama 那边一样：**上面那一栏是"K 和 V 一起调"，这里只动 K**。' +
              '取值：q8 / fwht2 / fwht3 / fwht4（fwhtN = N-bit FWHT 旋转量化）。' +
              '引擎里还有 asymN / turboN / legacy-asymN 这批**已弃用**的别名，面板不列 —— 它们会在 0.5.0 移除。' +
              '重启生效（scope = ModelLoad）。' },
      { id: 'hf_kv_v', label: 'hipfire V 轴单独覆盖', type: 'select', optional: true,
        options: ['q8', 'lloyd2', 'lloyd3', 'lloyd4'],
        help: '只覆盖 **V** 这一半（`memory.kv_v`），留空 = 沿用上面模式预设给出的 V。' +
              '取值：q8 / lloyd2 / lloyd3 / lloyd4（lloydN = N-bit Lloyd-Max 量化）。' +
              '⚠️ 当前 V 是 KV 占用的大头：实测 K 400 B/pos、V 1088 B/pos —— ' +
              '把 V 降到 lloyd3 能把 KV 显存从约 0.89 GiB 压到约 0.46 GiB，' +
              '但 K 已经是 3-bit 了，V 再降到 3-bit 是"两头都低"，长文质量要先评测再定。' +
              '重启生效（scope = ModelLoad）。' },
    ],
  },
  {
    group: 'mtp', title: '推测解码加速（MTP / DFlash2）', icon: '⚡',
    desc: '两种加速方式二选一。MTP：用主模型自带的 nextn 头（模型名带 -mtp）。DFlash2：用独立草稿模型（块扩散并行草稿）。本机实测：无加速 39.2 t/s、DFlash2(n=3) 49.8 t/s（+27%）、MTP2 37.5 t/s。',
    params: [
      { id: 'spec_type', flag: '--spec-type', label: '推测解码模式', type: 'select', default: 'draft-mtp',
        options: ['none', 'draft-mtp', 'draft-dflash'],
        help: 'none = 关闭；draft-mtp = 用主模型自带的 MTP 头（需模型名带 -mtp）；draft-dflash = 用独立 DFlash2 草稿模型（需在下面选草稿模型）。' },
      { id: 'model_draft', flag: '--model-draft', short: '-md', label: 'DFlash2 草稿模型', type: 'model', optional: true,
        help: '仅 draft-dflash 模式需要。选 Qwen3.8-27B-DFlash2-*.gguf，例如 Q4_K_M（1.09 GB）。留空则 MTP 不需要。' },
      { id: 'spec_draft_n_max', flag: '--spec-draft-n-max', label: '草稿 token 数', type: 'int', default: 3, min: 1,
        help: '每步预测几个 token。实测：DFlash2 用 3 最佳（49.8 t/s）；用 7 会因接受率降低（37%→19%）而回落到 39.6 t/s。MTP 用 2。' },
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
      { id: 'hf_loop_guard', label: '重复环断路器（4-gram 重复 N 次即停）', type: 'int', optional: true, min: 0, max: 64, default: 8,
        help: 'hipfire 自带的**退化重复环**断路器（环境变量 HIPFIRE_NGRAM_LOOP_THRESHOLD）：' +
              '最近 N 个 token 里，同一个 4-gram 出现 ≥ 这个次数就**强制 EOS**。0 = 关闭。' +
              '**为什么需要它**：多槽路径的投机验证是贪心专用的，所以开了投机就必须 temperature=0，' +
              '而贪心没有熵 —— 一旦落进重复吸引子就出不来（实测在思维链里撞见过每轮把零串拉长一截的环）。' +
              '而惩罚类做法（repeat/presence penalty）会被引擎的 request_penalized 挡下、**顺带把投机关掉**，' +
              '所以只能靠这个**不是惩罚**的断路器。' +
              '默认 8：同一个 4-gram 在窗口里重复 8 次，正常文本几乎不可能出现，' +
              '所以误杀风险很低；想更激进可以降到 4~6，想关掉填 0。' +
              '⚠️ 引擎的原生实现只接在**稠密路径**上，多槽路径的这一处是本次新接的。' },
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
        help: '加载自定义 Jinja 模板文件路径。留空用模型自带模板。', advanced: true },
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

// 生效时机（设计文档 §2）。按 LM Studio 的分法把参数切成两类：
//   live   改完**立即生效**（请求期参数；llama.cpp 侧由请求体带过去）
//   其余   引擎在**进程启动时**读取，改完必须重启才生效
// 界面据此在分组标题挂徽标 —— 用户最常犯的错就是"改完设置忘了重启"，
// 或者反过来"以为要重启、其实不用"。真值只有这一处，UI 不自己维护副本。
const LIVE_GROUPS = new Set(['sampling', 'thinking']);
for (const g of SCHEMA) g.live = LIVE_GROUPS.has(g.group);

// 从 J:\hipfiremodels 自动挑一个默认 HFQM 文件（用户已保存的配置永远优先，
// 因为 loadConfig 是 {...defaultConfig(), ...saved}）。
// 裸 `-pro` 档过不了 slot 引擎的 dtype 门：`ssm_out`（linear_attn.out_proj）被抬到
// Q8，八个投影不再统一，而 slot 路径没有逐 token 回退 ⇒ 直接拒绝启动。分层与多槽
// 都跑在 slot 引擎里，所以**自动挑选必须把它排到最后** —— 否则面板钦定的默认模型
// 恰恰是它自己在帮助文本里写着"过不了这道门"的那个。注意 `-pro-uniform` 是好的，
// 所以否定环视 `(?!-)` 是必要的，不能只写 `-pro`。
const HF_MODEL_SLOT_INCOMPATIBLE = /\.mq\d+-pro(?!-)/i;

// `dir` 是为了可测：默认走真实目录，测试可以塞一个临时目录进来，从而真的验证
// "有 pro 也有 xt 时会挑哪个"，而不是只测正则本身（那只证明正则对，不证明选对了）。
function pickHf(re, avoid = null, dir = null) {
  // `dir` 给定时只搜那一个（测试用）；否则按 HIPFIRE_MODELS_DIRS 的顺序找第一个命中的
  // 目录 —— 模型被搬走时自动挑选仍能落到实际存在的那份。
  const dirs = dir ? [dir] : HIPFIRE_MODELS_DIRS;
  for (const d of dirs) {
    for (const full of modelFilesIn(d)) {
      const n = path.basename(full);
      if (!re.test(n)) continue;
      // `avoid` 只改变**优先级**，不是判据：即使全都命中也要返回一个，让后置检查
      // 去报明确的错。返回空串的症状是"模型框是空的"，比"选了个过不了门的"更难查。
      if (avoid && avoid.test(n)) continue;
      return full;
    }
  }
  return '';
}

// 按文件名在模型候选目录里找第一份存在的（gguf/mmproj 用；.hfq 走 pickHf 的正则挑选）。
function pickName(name) {
  for (const d of HIPFIRE_MODELS_DIRS) {
    try {
      const direct = path.join(d, name);
      if (fs.existsSync(direct)) return direct;
    } catch {}
    for (const full of modelFilesIn(d)) {
      if (path.basename(full).toLowerCase() === name.toLowerCase()) return full;
    }
  }
  return '';
}

function defaultConfig() {
  const cfg = {};
  const modelDir = path.join(ROOT, 'models');
  for (const p of ALL_PARAMS) {
    if (p.type === 'bool') cfg[p.id] = p.default ?? false;
    else if (p.id === 'model') cfg[p.id] = pickName('Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf')
      || path.join(modelDir, 'Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf');
    else if (p.id === 'model_draft') cfg[p.id] = '';   // only for draft-dflash; never auto-fill
    else if (p.id === 'hf_model') cfg[p.id] = pickHf(/\.mq[0-9]/i, HF_MODEL_SLOT_INCOMPATIBLE);
    // 草稿头：**先认 dflash 命名的**，没有再回落到任意 .hfq。
    // 原来的 `/\.hfq$/i` 太宽 —— 它会把同目录下的**主模型**（也是 .hfq）挑成
    // 草稿头。回落保留旧行为当兜底：选错了 hipfire 会明确报错退出（它要求
    // registry 登记的模型，按路径给的文件拿不到登记信息），不会静默出错。
    else if (p.id === 'hf_draft') cfg[p.id] = pickHf(/dflash.*\.hfq$/i) || pickHf(/\.hfq$/i);
    else if (p.type === 'mmproj') cfg[p.id] = pickName('mmproj-Qwen3.8-27B-BF16.gguf')
      || path.join(modelDir, 'mmproj-Qwen3.8-27B-BF16.gguf');
    else cfg[p.id] = p.optional ? (p.default ?? '') : (p.default ?? '');
  }
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

// 保存前过一遍值域。分两档：
//   · hf_* 是 hipfire 专属参数 ⇒ **永远**校验（存进去的坏值会在切换引擎时炸）
//   · 共用参数（top_k / penalty / timeout…）只在 hipfire 是当前引擎时校验，
//     否则会把 llama.cpp 侧的合法值也拒掉
// 违反时**拒绝保存**并逐条说明，不静默钳制（静默改值是最难查的一类 bug）。
class ConfigError extends Error {
  constructor(errors) {
    super(errors.map((e) => e.message).join('\n'));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 生效诊断：把"我发出去了"与"它生效了"分开
//
// 病根：面板过去只保证"参数发出去了"。三轮实测里它连续以三种形式失败，而面板
// 每次都显示"已开启"：
//   · 分层三个参数都发了 ⇒ 多槽没开 ⇒ slot 引擎没建 ⇒ 一个都没被读到
//   · 池子填了 65536 看着挺大 ⇒ 准入需求虚高（max_tokens 被计进去）⇒ 被拒
//   · 推测解码选了 mtp ⇒ 请求 temperature>0 ⇒ 引擎强制关闭投机 ⇒ 28 tok/s
// 这三件事**不是错误**（引擎行为合法），所以保存时的校验永远抓不到它们。唯一能
// 说清的是引擎自己 —— 它的日志里已经有全部事实，面板解析即可，不用猜。
// ═══════════════════════════════════════════════════════════════════════════

// 显存红线。超过它就会溢出到共享显存，prefill 与 decode 一起塌。
// 这是用户给的实测经验值（专用 25.8 GiB 的卡上留的余量），不是显卡标称容量。
const VRAM_CLIFF_GIB = 26;

// 每条对应引擎的一行日志，注释里写明是哪一行、由谁打印。
const ENGINE_FACT_PATTERNS = {
  // serve_engine.rs `planned VRAM:` —— 引擎自己算的显存账单。
  plannedVram: /planned VRAM: weights ([\d.]+) GiB \+ KV (\d+) pages x (\d+) FA layers x (\d+) B\/pos = ([\d.]+) GiB \+ ([\d.]+) GiB = ([\d.]+) GiB/,
  // serve_engine.rs `prefix cache ceiling:` —— 跨会话前缀缓存的 checkpoint 池。
  // **它不在上面那条账单里**：池按 capture 惰性 malloc，一路长到自己的字节上限。
  // 漏算它的后果是实测过的：24 GiB 卡上 8 GiB 上限把峰值从 22.3 推到 27.8 GiB，
  // 而上面那条 `planned VRAM` 全程稳稳写着 15.60 GiB —— 红线判据只看得见 15.60，
  // 于是永远不会报红。引擎按「设备总容量减去账单、再取一个份额」收口，档位取 effective。
  cacheCeiling: /prefix cache ceiling: configured ([\d.]+) GiB, effective ([\d.]+) GiB \(([\d.]+)% of ([\d.]+) GiB spare after plan ([\d.]+) GiB \+ ([\d.]+) GiB late-load reserve, on a ([\d.]+) GiB device\); worst-case device total ([\d.]+) GiB/,
  // serve_engine.rs `paged KV pool:` —— 分页池的实际容量（用户设的页数）。
  pagedPool: /paged KV pool: (\d+) slots x cap (\d+) tokens over (\d+) physical pages/,
  // serve_engine.rs `KV tiering:` —— 只有 pool.is_paged() 才打这两条之一。
  // 两条都不在 = 分层没生效（要么没开多槽，要么池不是分页的）。
  tierWindow: /KV tiering: window of (\d+) pages per slot/,
  tierNoWindow: /KV tiering: enabled, no window set/,
  // serve_engine.rs 那条"开了 tier 但池不是分页的"警告（字面量里有连续空格，
  // 因为它在源码里是跨行续写的，所以这里用 \s+ 而不是单个空格）。
  poolLegacy: /HIPFIRE_KVMEM_TIER=1 but the KV pool is\s+legacy/,
  // dflash_slot / serve_engine 的草稿头装载行。带 `(slots)` 的是多槽路径。
  dflash: /DFlash2 draft loaded(?: \(slots\))?: .*\(B=(\d+), ctx_cap=(\d+)\)/,
  // 准入被拒（serve_engine.rs 三处 needed_pages 之一）。
  rejection: /page demand exceeds pool: need (\d+) pages, (\d+) free/,
  // `KVMEM_TIERS` / `KVMEM_CAPACITY_*` —— 分层的开机清单（参考 kvmem 的
  // `KVMEM_TIERS cpu_bytes=… slot_bytes=…` 风格，kvmem_runtime.cpp:44）。
  //
  // 这两条是**「装不装得下」唯一可靠的答案**：`KVMEM_CAPACITY_OK/SHORT` 直接
  // 给出 capacity vs slot_ctx 的对比，不用面板自己乘一遍（面板算的话要引引擎
  // 常量，而且 per_pos 随 KV 档变，算错会给出错误的安全感）。
  kvmemTiers: /KVMEM_TIERS block_bytes=(\d+) layers=(\d+) per_pos_k=(\d+) per_pos_v=(\d+) gpu_window=(\d+)pages\/(\d+)tok host_tier=(\d+)slots\/(\d+)tok capacity=(\d+)tok slot_ctx=(\d+)tok/,
  kvmemCapacityOk: /KVMEM_CAPACITY_OK capacity=(\d+) tok >= slot_ctx=(\d+) tok/,
  kvmemCapacityShort: /KVMEM_CAPACITY_SHORT capacity=(\d+) tok < slot_ctx=(\d+) tok \(short (\d+) tok\)/,
  // 准入门拒绝（新增的 can_append 通路）—— 与 `rejection`（池页不足）是两回事：
  // 这条是"整段历史装不下"，不是"这一步的页不够"。
  historyNotResident: /history_not_resident: (\d+) blocks of context at block_tokens=(\d+) but the window holds (\d+) and the host tier holds (\d+) \((\d+) short\)/,
  listening: /native serve listening/,
  // 每步的行数。这是**投机到底有没有起草**的地面真值：
  // 起草成功时这一步是 spec_rows 行（mtp_k+1，或 DFlash 的 B），退化时是 1 行。
  // 光看配置推不出来 —— 请求期的 temperature 不在面板手里，所以必须看日志。
  stepRows: /\[serve\] \+\d+s step \d+: rows=(\d+)/g,
};

/**
 * 从引擎日志里解析出**事实**。只认最后一次出现（日志是滚动追加的，一次运行可能
 * 重启过，最后一份才是当前生效的）。
 *
 * 输入是原始日志文本（面板 /api/log 返回的 log 字段），输出是结构化事实；
 * 认不出来的项一律 null —— 调用方必须把 null 当成"未知"而不是"没问题"。
 */
function parseEngineFacts(logText) {
  const text = String(logText ?? '');
  const lastMatch = (re) => {
    let m = null;
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (let x = g.exec(text); x; x = g.exec(text)) m = x;
    return m;
  };

  const vram = lastMatch(ENGINE_FACT_PATTERNS.plannedVram);
  const pool = lastMatch(ENGINE_FACT_PATTERNS.pagedPool);
  const win = lastMatch(ENGINE_FACT_PATTERNS.tierWindow);
  const draft = lastMatch(ENGINE_FACT_PATTERNS.dflash);
  const rej = lastMatch(ENGINE_FACT_PATTERNS.rejection);
  const ceiling = lastMatch(ENGINE_FACT_PATTERNS.cacheCeiling);
  const tiers = lastMatch(ENGINE_FACT_PATTERNS.kvmemTiers);
  const capOk = lastMatch(ENGINE_FACT_PATTERNS.kvmemCapacityOk);
  const capShort = lastMatch(ENGINE_FACT_PATTERNS.kvmemCapacityShort);
  const hnr = lastMatch(ENGINE_FACT_PATTERNS.historyNotResident);

  // 解码每一步的行数序列。这是**投机到底有没有起草**的地面真值：起草成功时
  // 这一步是 spec_rows 行（DFlash 的 B，或 MTP 的 mtp_k+1），退化时是 1 行。
  //
  // ⚠️ 不能用"行数 > 1"当判据 —— prefill 步的行数是提示词块大小（实测见过 85），
  // 也 > 1，而且**每个新请求开头都有一记**，会落在窗口的任意位置（不是只在开头）。
  // 可靠的签名是**连续性**：验证批会让连续多步取同一个 spec_rows（16,16,…），
  // 而 prefill 是单步、紧接着就掉回 1。
  //
  // 这一层只负责**解析**，不下判断 —— 判"这个行数算不算验证批"要用到配置里的
  // spec 模式与 mtp_k，那是 effectDiagnostics 的活。事实与推断分开放。
  const rowsSeq = [];
  for (const m of text.matchAll(ENGINE_FACT_PATTERNS.stepRows)) rowsSeq.push(Number(m[1]));

  return {
    listening: ENGINE_FACT_PATTERNS.listening.test(text),
    // 前缀缓存开着这条才会出现（关掉时引擎整行不打）。
    prefixCacheOn: /prefix cache enabled:/.test(text),
    recentRows: rowsSeq.slice(-40),
    plannedVram: vram && {
      weightsGiB: Number(vram[1]),
      kvPages: Number(vram[2]),
      faLayers: Number(vram[3]),
      bytesPerPos: Number(vram[4]),
      kvGiB: Number(vram[5]),
      reserveGiB: Number(vram[6]),
      totalGiB: Number(vram[7]),
    },
    pagedPool: pool && {
      slots: Number(pool[1]),
      capTokens: Number(pool[2]),
      pages: Number(pool[3]),
    },
    cacheCeiling: ceiling && {
      configuredGiB: Number(ceiling[1]),
      effectiveGiB: Number(ceiling[2]),
      sharePct: Number(ceiling[3]),
      spareGiB: Number(ceiling[4]),
      planGiB: Number(ceiling[5]),
      lateReserveGiB: Number(ceiling[6]),
      deviceGiB: Number(ceiling[7]),
      worstTotalGiB: Number(ceiling[8]),
    },
    tierWindowPages: win ? Number(win[1]) : null,
    tierEnabledNoWindow: ENGINE_FACT_PATTERNS.tierNoWindow.test(text),
    // 只要出现过就用最后一次的语义：警告是运行期一次性打印的，出现过即事实。
    poolLegacy: ENGINE_FACT_PATTERNS.poolLegacy.test(text),
    dflash: draft && { block: Number(draft[1]), ctxCap: Number(draft[2]) },
    lastRejection: rej && { needPages: Number(rej[1]), freePages: Number(rej[2]) },
    // 分层的开机清单（KVMEM_TIERS / KVMEM_CAPACITY_*）。这些是**引擎实报**，
    // 不是面板推算 —— per_pos 随 KV 档变，面板算会给出错误的安全感。
    kvmemTiers: tiers && {
      blockBytes: Number(tiers[1]),
      layers: Number(tiers[2]),
      perPosK: Number(tiers[3]),
      perPosV: Number(tiers[4]),
      windowPages: Number(tiers[5]),
      windowTokens: Number(tiers[6]),
      hostSlots: Number(tiers[7]),
      hostTokens: Number(tiers[8]),
      capacityTokens: Number(tiers[9]),
      slotCtxTokens: Number(tiers[10]),
    },
    // 三态：够 / 不够 / 未知（引擎还没跑到那一步）。**未知必须与"够"分开**，
    // 否则"还没起来"会读成"没问题"，而这正是该看这一栏的时刻。
    capacityVerdict: capOk
      ? { ok: true, capacity: Number(capOk[1]), slotCtx: Number(capOk[2]) }
      : capShort
        ? { ok: false, capacity: Number(capShort[1]), slotCtx: Number(capShort[2]), short: Number(capShort[3]) }
        : null,
    historyNotResident: hnr && {
      needBlocks: Number(hnr[1]),
      blockTokens: Number(hnr[2]),
      windowBlocks: Number(hnr[3]),
      hostBlocks: Number(hnr[4]),
      short: Number(hnr[5]),
    },
  };
}

/**
 * 生效诊断。返回一组行，UI 直接渲染成顶部那条常驻状态条。
 *
 * state:
 *   'ok'   确实在跑（有引擎侧证据）
 *   'warn' 配置成立，但请求期/客户端会让它失效，或引擎还没重启
 *   'err'  配置本身不成立，不可能生效
 *   'off'  用户明确关掉了 —— 不是问题
 *
 * 每条 detail 都要能回答"我怎么知道的"：写清依据是面板配置还是引擎日志。
 */
function effectDiagnostics(cfg, facts) {
  const f = facts ?? {};
  const rows = [];

  // ── 验证批的地面真值（要用到配置，所以放在这一层，不放解析层）──────────
  // 起草案会让**连续多步**取同一个 spec_rows（16,16,…），而 prefill 是单步
  // （行数 = 提示词块大小，实测见过 85），紧接着就掉回 1。所以判据是"连续同值"，
  // 不是"行数 > 1" —— 后者会被每一记 prefill 骗到。
  const wantRows = String(cfg.hf_spec) === 'dflash' ? (f.dflash ? f.dflash.block : null)
                 : String(cfg.hf_spec) === 'mtp' ? clampInt(cfg.hf_mtp_k, 1, 10, 3) + 1
                 : null;
  const rowsSeq = Array.isArray(f.recentRows) ? f.recentRows : [];
  // 判据：wantRows 在窗口里出现**≥2 次**。引擎每 64 步才打一行，所以一个几百
  // token 的生成只会留下几条；要求"连续两步"在这时就抓不到。而 wantRows 是
  // 精确值（DFlash 的 B、MTP 的 mtp_k+1），提示词块恰好等于它的概率很低。
  // 残余边界：连着两次提示词长度正好等于 wantRows 的请求 —— 已知，接受。
  const hits = rowsSeq.filter((n) => n === wantRows).length;
  // wantRows 未知（ngram/auto 模式）时的兜底：连续两步同值**且 ≤ 64**。
  // 那个上界是必需的 —— 否则连着两次长度相同的请求（prefill 行数一样）会被
  // 当成验证批，实测正是这么被自己骗过一次（128,128）。投机窗口最大也就
  // ngram_k=32 / DFlash B≈16 这个量级，64 足够宽且把 prefill 挡在外面。
  let fallback = null;
  for (let i = 1; i < rowsSeq.length; i++) {
    const n = rowsSeq[i];
    if (n > 1 && n <= 64 && n === rowsSeq[i - 1]) { fallback = n; break; }
  }
  const specEvidence = wantRows != null ? (hits >= 2 ? wantRows : null) : fallback;
  const specDrafted = specEvidence != null;
  const specAllOne = rowsSeq.length > 0 && rowsSeq.every((n) => n === 1);

  // ── 投机解码 ────────────────────────────────────────────────────────────
  // 引擎侧两个门（serve_engine.rs：`request_sampled` / `request_penalized`）：
  //   temperature > 0            ⇒ 关
  //   repeat_penalty > 1 / presence > 0 / frequency > 0 ⇒ 关
  // 实测（散文，384 tok，mtp 模式）：全默认 28.8 ｜ 只压 temperature=0 **52.9**
  // ｜ temperature=0 + repeat_penalty=1.05 28.6 ｜ temperature=1 28.8。
  // 注意引擎 `generation.temperature` 的默认值是 0.3 —— 不传就等于在采样。
  const specMode = String(cfg.hf_spec ?? '');
  const hipfireOn = activeEngine(cfg) === 'hipfire';
  if (specMode === 'off' || specMode === '') {
    rows.push({ id: 'spec', label: '投机解码', state: 'off', headline: '已关闭',
      detail: '纯自回归。散文实测约 40 tok/s（其余模式 52~104）。' });
  } else if (specAllOne) {
    // **地面真值优先**。日志里最近每一个解码步都是 1 行 ⇒ 引擎确实没有起草，
    // 不管配置怎么写的。这一条必须排在最前面：从配置推测出来的"应该生效"
    // 曾经把一次真实的失效显示成 ✓ —— 那正是这个面板要消灭的东西。
    rows.push({ id: 'spec', label: '投机解码', state: 'err',
      headline: '没有起草 —— 日志里最近每一步都是 rows=1',
      detail: `模式选了 ${specMode}${f.dflash ? `（草稿头已加载，B=${f.dflash.block}）` : ''}，` +
              '但引擎最近的解码步全是 1 行，说明投机根本没启动。最常见的成因是**请求体里的 temperature > 0**：' +
              '引擎在 temperature>0 或任一惩罚>0 时强制关掉投机（合法取舍，不是 bug）。' +
              '本机实测：不带 temperature 28.9 tok/s（rows=1）｜ 带 temperature=0 → 66.5 tok/s（rows=16）。' +
              (hipfireOn
                ? '面板的「采样参数（默认值）」会写进**每模型**配置（models.toml）—— ' +
                  '那是唯一能充当请求默认的层（全局 config.toml 被引擎刻意排除）。' +
                  '把 temperature 设成 0、惩罚清零，然后点「保存并重启生效」。'
                : '请检查发起请求的客户端传的 temperature 与惩罚值。') });
  } else if (specDrafted) {
    rows.push({ id: 'spec', label: '投机解码', state: 'ok',
      headline: `生效 —— 日志里出现 ${specEvidence} 行验证批`,
      detail: `模式 ${specMode}${f.dflash ? `，草稿头 B=${f.dflash.block}` : ''}。` +
              '验证批的行数大于 1，说明起草与验证都在跑（这是引擎侧的行为证据，不是配置推断）。' });
  } else {
    // 没有日志证据时的**推断** —— 必须自己说清是推断，不能冒充已生效。
    const temp = Number(cfg.temperature);
    const penalized = Number(cfg.repeat_penalty) > 1 || Number(cfg.presence_penalty) > 0 ||
                      Number(cfg.frequency_penalty) > 0;
    const sampled = Number.isFinite(temp) && temp > 0;
    if (hipfireOn) {
      rows.push({ id: 'spec', label: '投机解码', state: 'warn', headline: `${specMode}（尚无引擎侧证据）`,
        detail: '还没看到投机生效的日志证据（要等引擎起来并跑过一次请求）。' +
                '采样参数在「采样参数（默认值）」——面板会把它们写进**每模型**配置，' +
                '改完点「保存并重启生效」。投机要求 temperature=0 且惩罚全为 0。' });
    } else if (sampled || penalized) {
      rows.push({ id: 'spec', label: '投机解码', state: 'warn',
        headline: '会被请求期关闭',
        detail: '引擎在 temperature > 0 或任一惩罚 > 0 时强制关掉投机（合法取舍，不是 bug）。' });
    } else {
      rows.push({ id: 'spec', label: '投机解码', state: 'warn', headline: `${specMode}（尚无引擎侧证据）`,
        detail: '配置按推断可以生效，但还没有日志证据。等引擎起来并跑过一次请求后这里会变成实测结论。' });
    }
  }

  // ── KV 分层 ─────────────────────────────────────────────────────────────
  // 分层跑在 slot 引擎里，而 slot 引擎只在 `experimental_multi_slot` 为真时才被
  // 创建（hipfire-daemon/src/main.rs:1201）。不开多槽 ⇒ 走另一套模型所有者 ⇒
  // `Rig::build` 根本不执行 ⇒ 分层三个参数一个都读不到，且**日志里连
  // planned VRAM 都不会打印**。
  if (!cfg.hf_kvmem_tier) {
    rows.push({ id: 'tier', label: 'KV 分层', state: 'off', headline: '未启用',
      detail: 'KV 按「hipfire 每槽上下文」全量分配。长上下文下这是显存的主要开销。' +
              '（面板会把 `memory.kvmem.enabled` 显式写成 false —— 旧面板只在"开"的那半写，' +
              '"关"这半什么都不写，于是 config.toml 里的 true 继续说话、分层照旧在跑。）' });
  } else if (!cfg.hf_multi_slot) {
    rows.push({ id: 'tier', label: 'KV 分层', state: 'err', headline: '不生效 —— 多槽未开',
      detail: '分层跑在多槽引擎里；多槽不开就不会创建 slot 引擎，' +
              '窗口与池子两个参数**一个都不会被读到**，KV 会按每槽上下文全量铺开。' });
  } else if (f.capacityVerdict && !f.capacityVerdict.ok) {
    // **最该第一眼看到的一条**：分层跑起来了，但装不下这个上下文。
    //
    // 以前这种情况完全静默：块被悄悄丢弃、模型在残缺历史上生成、最后吐一个
    // 与分层毫无关系的 malformed 协议错误。现在引擎会拒（history_not_resident），
    // 这里提前把账摊开。
    const cv = f.capacityVerdict;
    const t = f.kvmemTiers;
    rows.push({ id: 'tier', label: 'KV 分层', state: 'err',
      headline: `装不下 —— 能力 ${cv.capacity} token < 上下文 ${cv.slotCtx} token`,
      detail: `差 ${cv.short} token。**超过 ${cv.capacity} 的历史会被拒绝**（引擎回 ` +
              `history_not_resident），不会拿一段被截断的历史去回答。\n` +
              (t ? `引擎实报：块 ${t.blockBytes} B，窗口 ${t.windowPages} 页 = ${t.windowTokens} token，` +
                   `主机层 ${t.hostSlots} 槽 = ${t.hostTokens} token。\n` : '') +
              `**改哪个**：把「hipfire KV 主机层容量」提到 ≥ ` +
              `${Math.ceil((cv.short / 1024) * 1.6)} GB（按当前块大小估），` +
              `或把「hipfire KV 检索窗口」提到接近 ${cv.slotCtx}（窗口在显存里），` +
              `或把「hipfire 每槽上下文」降下来。` });
  } else if (f.tierWindowPages != null) {
    const pages = f.tierWindowPages;
    const pool = f.pagedPool ? `，池 ${f.pagedPool.pages} 页（${f.pagedPool.slots} 槽共享）` : '';
    // 能力够时把三个数也带上 —— 「够」是个有前提的断言，用户有权看前提。
    const cap = f.capacityVerdict && f.capacityVerdict.ok
      ? ` 能力 ${f.capacityVerdict.capacity} token ≥ 上下文 ${f.capacityVerdict.slotCtx} token。`
      : '';
    rows.push({ id: 'tier', label: 'KV 分层', state: 'ok',
      headline: `生效，窗口 ${pages} 页/槽`, detail: `引擎日志已确认${pool}。${cap}` });
  } else if (f.poolLegacy) {
    rows.push({ id: 'tier', label: 'KV 分层', state: 'err', headline: '不生效 —— 池不是分页的',
      detail: '引擎打了 "KV pool is legacy (not paged)" 警告。分层要改写块表，而只有分页池有块表。' });
  } else if (f.listening) {
    rows.push({ id: 'tier', label: 'KV 分层', state: 'warn', headline: '引擎在跑，但日志里没有分层生效行',
      detail: '配置成立（多槽已开 + 槽位会被钉成 1）但引擎日志里既没有 "KV tiering: window of N" ' +
              '也没有池信息 —— 多半是引擎还没重启，参数尚未下发。' +
              '**另有一个已知的静默失效点**：引擎在 n_slots > 1 时会打印' +
              '「kvmem 致命：分层在多槽引擎上尚未支持」并把分层整个关掉，' +
              '那一行**不是** "KV tiering" 开头，所以上面的匹配抓不到它。' +
              '面板已把槽位数钉成 1 来避开，但若你在别处手改过 config.toml，先搜这条。' });
  } else {
    rows.push({ id: 'tier', label: 'KV 分层', state: 'warn', headline: '已配置，等待引擎启动',
      detail: '配置成立（多槽已开 + 槽位 1）。启动后这里会显示引擎确认的窗口与池大小。' });
  }

  // ── 显存预算 ────────────────────────────────────────────────────────────
  if (f.plannedVram) {
    const v = f.plannedVram;
    const cc = f.cacheCeiling;
    // 判定用的是**最坏设备总量**：计划 + 缓存上限。只看 `planned VRAM` 正是
    // 当初漏掉 5.5 GiB 的原因 —— 那条账单一路上限都写着 15.60 GiB。
    const totalGiB = cc ? cc.worstTotalGiB : v.totalGiB;
    const over = totalGiB > VRAM_CLIFF_GIB;
    const parts = `权重 ${v.weightsGiB.toFixed(2)} + KV ${v.kvPages} 页 × ${v.faLayers} FA 层 = ` +
                  `${v.kvGiB.toFixed(2)} + 预留 ${v.reserveGiB.toFixed(2)} GiB`;
    let detail;
    if (cc) {
      const clamped = cc.effectiveGiB < cc.configuredGiB - 0.01;
      detail = `${parts} = 计划 ${cc.planGiB.toFixed(2)}，加前缀缓存上限 ` +
               `${cc.effectiveGiB.toFixed(2)} GiB（${cc.deviceGiB.toFixed(1)} GiB 卡上余量份额 ` +
               `${cc.sharePct.toFixed(0)}%${clamped ? `；你设的 ${cc.configuredGiB.toFixed(2)} 已被下调` : ''}）` +
               `，最坏 ${cc.worstTotalGiB.toFixed(2)} GiB。`;
    } else if (f.prefixCacheOn) {
      detail = `${parts} = ${v.totalGiB.toFixed(2)} GiB，**未计前缀缓存** —— ` +
               '它不在引擎的 planned VRAM 里，能再吃掉一整个上限。引擎重启后这里会补上。';
    } else {
      detail = `${parts} = ${v.totalGiB.toFixed(2)} GiB（引擎自报）。`;
    }
    if (over) detail += '超过红线会溢出到共享显存，prefill 与 decode 一起塌。';
    rows.push({ id: 'vram', label: '显存预算', state: over ? 'err' : 'ok',
      headline: `${totalGiB.toFixed(2)} GiB${over ? ` —— 超过 ${VRAM_CLIFF_GIB} GiB 红线` : ''}`,
      detail });
  } else if (f.lastRejection) {
    const r = f.lastRejection;
    rows.push({ id: 'vram', label: '显存预算', state: 'err', headline: '上次请求被准入拒绝',
      detail: `引擎报 "need ${r.needPages} pages, ${r.freePages} free"。` +
              '池子装不下这次请求的需求 —— 按设计里的公式调大「分页 KV 池总量」。' });
  } else {
    rows.push({ id: 'vram', label: '显存预算', state: 'off', headline: '未知（引擎尚未自报）',
      detail: `引擎启动并首次建 slot 引擎后，会打印 planned VRAM。红线 ${VRAM_CLIFF_GIB} GiB。` });
  }

  return rows;
}

function validateConfig(cfg) {
  const errors = [];
  const hipfireOn = activeEngine(cfg) === 'hipfire';
  // hf_* 就是 hipfire 专属的全部参数（前缀即约定），用它做判据而不是硬编码一份清单 ——
  // 清单会漏：新加一个 hf_ 参数就会自动获得"永远校验"，不需要记得回来改这里。
  const isHipfireOnly = (id) => id.startsWith('hf_');
  const shared = new Set(['top_k', 'presence_penalty', 'frequency_penalty',
                          'repeat_penalty', 'top_p', 'timeout']);
  for (const [id, v] of Object.entries(cfg)) {
    if (!isHipfireOnly(id) && !(hipfireOn && shared.has(id))) continue;
    const msg = validateHipfireField(id, v);
    if (msg) errors.push({ id, message: `${id}：${msg}` });
  }

  // ── 跨字段：KV 分层的前置条件 ─────────────────────────────────────────
  // 分层跑在 **slot 引擎** 里（`Rig::build`），而 slot 引擎只有在
  // `experimental_multi_slot` 为真时才被创建 —— daemon 在
  // `crates/hipfire-daemon/src/main.rs:1201` 用 `if experimental_multi_slot`
  // 分叉，不开它走的是**普通稠密路径**（另一套模型所有者，没有块表）。
  //
  // 后果不是"分层没生效"那么轻：`HIPFIRE_KVMEM_TIER` /
  // `HIPFIRE_KVMEM_WINDOW_PAGES` / `HIPFIRE_SLOTS_PAGED_PAGES` 三个键
  // **一个都不会被读到**，KV 改按 `memory.max_seq`（=「hipfire 上下文窗口」）
  // 全量分配。262144 上下文 × 16 个带 KV 的层的开销足以把设备顶穿 ——
  // 一旦溢出到共享显存，prefill 与 decode 会一起塌掉。
  //
  // 所以这里**显式拒绝**而不是自动帮用户打开多槽：多槽会把模型所有者整个换掉
  // （见 daemon 的注释："an alternate model owner, not a batch-mode switch"），
  // 那是用户该自己做的决定，不该由开分层顺带改掉。
  if (hipfireOn && cfg.hf_kvmem_tier === true && cfg.hf_multi_slot !== true) {
    errors.push({ id: 'hf_kvmem_tier', message:
      'hipfire KV 分层：分层跑在多槽引擎里，而多槽引擎只在「hipfire 多槽并发」打开时才创建。' +
      '不开它的话分层参数一个都不会被读到，KV 会按「hipfire 上下文窗口」全量分配，' +
      '很容易顶穿显存（溢出到共享显存后 prefill 与 decode 都会塌）。' +
      '请先打开「hipfire 多槽并发」，并把「hipfire 每槽上下文」设为你要的上下文长度。' +
      '（「hipfire 槽位数」会被自动钉成 1：引擎在 n_slots > 1 时直接把分层关掉 —— ' +
      '多槽只是让 SlotEngine 存在的通道，分层目前是单序列语义。）' });
  }

  // 池子装不下「每槽一个完整窗口」是**必然**耗尽，不是概率问题：分页池是所有槽
  // 共享的，而每个活动槽至少要能放下自己的窗口。这不是保守估计，是下界。
  //
  // **槽位数一律按 1 算**：发射器会把 `serve.multi_slot_slots` 钉成 1（引擎在
  // n_slots > 1 时直接把分层关掉，见发射器里那段），所以按面板填的 4 去算池子
  // 会拒绝一个实际上完全够用的池 —— 拿一个不存在的并发度去卡用户。
  if (hipfireOn && cfg.hf_kvmem_tier === true && cfg.hf_multi_slot === true &&
      cfg.hf_kvmem_pool_tokens !== '' && cfg.hf_kvmem_pool_tokens != null) {
    const slots = 1;
    // 窗口留空 = 发射器显式写成每槽上下文（不淘汰任何页），所以这里也要照那个值算。
    const ctxTok = clampInt(cfg.hf_multi_slot_ctx, 512, 1048576, 8192);
    const winBlank = cfg.hf_kvmem_window_tokens === '' || cfg.hf_kvmem_window_tokens == null;
    const winTok = winBlank ? ctxTok : clampInt(cfg.hf_kvmem_window_tokens, 256, 1048576, ctxTok);
    const winPages = Math.max(1, Math.ceil(winTok / 128));
    // 引擎的准入需求是 `窗口 + 一个 prefill 块 + 1`（serve_engine.rs 三处
    // needed_pages，tier 分支）。prefill 块取 `serve.multi_slot_prefill_chunk`
    // 的默认值 1024 token = 8 页 —— 面板没有暴露它，所以这里是常数。
    // 预留输出（generation.max_tokens）**不计入**：tick 每步都在写前沿之前压实、
    // 生成是一步一个 token，所以它不会在表里累积（早先把它计进去，
    // 会让需求随 max_tokens 增长到和扁平缓存一样大，详见引擎侧注释）。
    const needPages = slots * (winPages + 8 + 1);
    const poolPages = Math.ceil(clampInt(cfg.hf_kvmem_pool_tokens, 256, 4194304, 65536) / 128);
    if (poolPages < needPages) {
      errors.push({ id: 'hf_kvmem_pool_tokens', message:
        `hipfire 分页 KV 池总量：${poolPages} 页装不下 ${slots} 槽 × (窗口 ${winPages} 页 + prefill 8 页 + 1 页余量) = ${needPages} 页；` +
        `池耗尽时该步会失败关闭。请把池总量提到至少 ${needPages * 128} token。` });
    }
  }
  return errors;
}

// ═══════════════════════════════════════════════════════════════════════════
// 预设：一套命名的参数组合。
//
// 与 LM Studio 有一处**有意的偏离**：它把 load 参数排除在 Preset 之外（它的
// Preset 是聊天级的，load 参数归属「每模型默认」）。我们不是那个场景 —— 这个
// 面板是单操作者的调参台，用户真正想存下来的恰恰是**整套装备**：
// "长文 256k + 分层"必须同时含上下文、槽位数、池子、窗口，否则它表达不了任何东西。
// 所以预设收全部参数，但每套都标出"其中 N 项需要重启"，让代价可见而不是瞒着。
// ═══════════════════════════════════════════════════════════════════════════
const PRESET_DIR = path.join(ROOT, 'presets');

const BUILTIN_PRESETS = [
  { name: '长文 256k + 分层', note: '单槽 264064 上下文 / 窗口 36864 / 池 40960；需重启', cfg: {
      engine: 'hipfire', hf_spec: 'dflash', hf_multi_slot: true, hf_multi_slot_slots: 1,
      hf_multi_slot_ctx: 264064, hf_kvmem_tier: true, hf_kvmem_window_tokens: 36864,
      hf_kvmem_pool_tokens: 40960, hf_prefix_cache: true, hf_max_seq: 262144 } },
  { name: '散文最快', note: 'dflash；还要在聊天页把 temperature 压到 0 才生效', cfg: {
      engine: 'hipfire', hf_spec: 'dflash', temperature: 0 } },
  { name: '贪心基准', note: 'temperature 0 且无惩罚，其余全默认 —— 对照用', cfg: {
      engine: 'hipfire', temperature: 0, repeat_penalty: 1, presence_penalty: 0, frequency_penalty: 0 } },
  { name: '采样对话', note: 'temperature 0.7；注意投机解码会被引擎关闭', cfg: {
      engine: 'hipfire', temperature: 0.7, top_p: 0.95, top_k: 20 } },
];

// 预设名来自用户输入，直接当文件名就是路径穿越。只留字母数字、中文、点、连字符，
// 并把 "." 与 ".." 单独挡掉（它们能通过字符过滤但仍是目录项）。
function presetFile(name) {
  const safe = String(name ?? '').trim().replace(/[^\w一-龥.-]/g, '_').slice(0, 64);
  if (!safe || safe === '.' || safe === '..') throw new Error(`非法的预设名：${name}`);
  return path.join(PRESET_DIR, safe + '.json');
}

function listPresets() {
  try { fs.mkdirSync(PRESET_DIR, { recursive: true }); } catch {}
  const read = () => { try { return fs.readdirSync(PRESET_DIR).filter((f) => f.endsWith('.json')); } catch { return []; } };
  let names = read();
  if (!names.length) {
    // 只在目录为空时铺一次；之后用户删了就是删了，不再自动长回来。
    for (const p of BUILTIN_PRESETS) { try { fs.writeFileSync(presetFile(p.name), JSON.stringify(p, null, 2), 'utf8'); } catch {} }
    names = read();
  }
  return names.map((f) => {
    try { const o = JSON.parse(fs.readFileSync(path.join(PRESET_DIR, f), 'utf8')); return o && o.name ? o : null; }
    catch { return null; }
  }).filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
}

// 只收面板认识的键 —— 预设文件可能被手改，不能让一个幽灵键写进 config.json。
const KNOWN_IDS = new Set(SCHEMA.flatMap((g) => g.params).map((p) => p.id));

function savePreset(name, cfg) {
  const subset = {};
  for (const [k, v] of Object.entries(cfg || {})) if (KNOWN_IDS.has(k)) subset[k] = v;
  const rec = { name: String(name), note: '', savedAt: new Date().toISOString(), cfg: subset };
  fs.mkdirSync(PRESET_DIR, { recursive: true });
  fs.writeFileSync(presetFile(name), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

function deletePreset(name) {
  try { fs.unlinkSync(presetFile(name)); return true; } catch { return false; }
}

// 预设里的哪些项需要重启引擎才生效（§2 的分组表）。界面用它标出代价。
//
// ⚠️ 分组归属要从 `ALL_PARAMS` 取，不能从 `SCHEMA[].params` 取：后者是**原始**定义，
// 里面的项根本没有 `group` 字段（那是 ALL_PARAMS 摊平时补上的）。从那里读会得到
// 一个恒为 undefined 的组名，于是**每一项**都被判成"需重启" —— 实测把只有 1 项
// 需要重启的预设报成了 4 项。这类"恒真/恒假"的量最容易混过去。
function presetRestartCount(preset) {
  const live = Object.fromEntries(SCHEMA.map((x) => [x.group, x.live]));
  const groupOf = Object.fromEntries(ALL_PARAMS.map((p) => [p.id, p.group]));
  let n = 0;
  for (const k of Object.keys(preset?.cfg || {})) {
    const grp = groupOf[k];
    if (grp === undefined) continue;      // 面板不认识的键不参与计数
    if (!live[grp]) n++;
  }
  return n;
}

// 落盘前先快照。参数改坏了要能退回去 —— 这一轮里已经出现过一次"改到某个组合
// 引擎起不来、却又说不清上一版是什么"的情况。保留最近 5 份：够用，也不会把
// 目录堆成垃圾堆（更早的快照没有任何回滚价值，只会让人挑花眼）。
const SNAP_DIR = path.join(ROOT, 'snapshots');
const SNAP_KEEP = 5;

function snapshotConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(CONFIG_FILE, path.join(SNAP_DIR, `config-${stamp}.json`));
    const all = fs.readdirSync(SNAP_DIR).filter((f) => f.startsWith('config-')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - SNAP_KEEP))) {
      try { fs.unlinkSync(path.join(SNAP_DIR, old)); } catch {}
    }
    return true;
  } catch { return null; }
}

function listSnapshots() {
  try {
    return fs.readdirSync(SNAP_DIR).filter((f) => f.startsWith('config-')).sort().reverse()
      .map((f) => {
        const st = fs.statSync(path.join(SNAP_DIR, f));
        return { file: f, mtime: st.mtime.toISOString(), bytes: st.size };
      });
  } catch { return []; }
}

// 文件名必须来自 listSnapshots 的产出 —— 直接拼用户传来的名字就是路径穿越。
function restoreSnapshot(file) {
  const known = listSnapshots().find((s) => s.file === file);
  if (!known) throw new Error(`找不到快照：${file}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, known.file), 'utf8'));
  snapshotConfig();                       // 回滚本身也可回滚
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

function saveConfig(cfg) {  const clean = {};
  for (const p of ALL_PARAMS) if (cfg[p.id] !== undefined) clean[p.id] = cfg[p.id];
  const errors = validateConfig(clean);
  if (errors.length) throw new ConfigError(errors);
  snapshotConfig();
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

    // hipfire 子引擎专属参数：不传给 llama.cpp（它们没有对应旗标，误传会让服务拒绝启动）
    if (HIPFIRE_PARAM_IDS.has(p.id)) continue;

    // The sidecar drafter path is meaningful only for draft-dflash. Passing it in
    // MTP mode makes the MTP init try to open the drafter GGUF and fail.
    if (p.id === 'model_draft') {
      if (isDflash) args.push('--model-draft', String(v));
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
// hipfire 子引擎：环境变量与启动描述
//
// hipfire 的 serve 只有 --model / --kv-mode / --kv-backend 等少数旗标；
// 推测解码、草稿头、前缀缓存**没有对应的 CLI 旗标**，只能经它的配置体系。
// 而它的配置每一项都有环境变量覆盖（见 hipfire-config 的 field! 宏），
// 所以这里全部走 env —— 不改它的 config.toml，也不影响用户手跑的 hipfire。
//
// 变量名逐个在源码里核过（hipfire-config/src/lib.rs + hipfire-cli/src/main.rs）：
//   HIPFIRE_PORT                       serve.port
//   HIPFIRE_HOST                       serve.host
//   HIPFIRE_SPECULATION                speculation.mode          off/auto/ngram/dflash/mtp/dspark
//   HIPFIRE_DFLASH_MODE                speculation.dflash        off/on/auto
//   HIPFIRE_MTP_MODE                   speculation.mtp           off/on/auto
//   HIPFIRE_MTP_NGRAM                  speculation.mtp_ngram     on/off/auto
//   HIPFIRE_KV_MODE                    memory.kv_cache
//   HIPFIRE_SERVE_PREFIX_CACHE         serve.prefix_cache        bool
//   HIPFIRE_DFLASH_DRAFT               草稿头路径（serve 无 --model-draft，daemon 专门读这个）
//   HIPFIRE_NGRAM_MOD_N_MATCH/_N_MIN/_N_MAX   MTP takeover 三元组
//
// ⚠️ 推测解码**用规范键 HIPFIRE_SPECULATION，不要用那三个旧布尔位**：
//    hipfire-cli/src/main.rs:3671 先按配置把 dflash_mode/mtp_mode/ngram_draft 填好，
//    紧接着调 apply_speculation_selector()（同文件 3973）**覆盖**它们 ——
//    选 "auto" 时它只置 dspark_mode，其余保持配置值。所以三个旧位只在 mode 恰为
//    auto 时才说了算。直接写 mode 才是唯一有确定语义的做法。
//
// 优先级已实测：**环境变量 > config.toml > 内置默认**
//   （`hipfire config list` 把 env 层标为 "override legacy env HIPFIRE_*"，
//     文件层标为 "override global user (config.toml)"，冲突时 env 胜）。
const HIPFIRE_PARAM_IDS = new Set([
  'engine', 'hf_model', 'hf_draft', 'hf_spec', 'hf_mtp_ngram', 'hf_mtp_k', 'hf_loop_guard', 'hf_kv_cache', 'hf_kv_k', 'hf_kv_v',
  'hf_prefix_cache', 'hf_prefix_cache_gb', 'hf_multi_slot', 'hf_multi_slot_slots',
  'hf_multi_slot_ctx', 'hf_max_seq', 'hf_kvmem_tier', 'hf_kvmem_window_tokens',
  'hf_kvmem_pool_tokens',
]);

// speculation.mode 的合法值（hipfire-config/src/lib.rs:549 SPECULATION_MODES，逐字抄）。
const HIPFIRE_SPEC_MODES = ['off', 'auto', 'ngram', 'dflash', 'mtp', 'dspark'];

// hipfire 的 memory.max_seq **没有环境变量覆盖**（field! 宏里 env_compat 是 None），
// 所以只能写它的 config.toml。用它的官方 `config set` 而不是自己拼 TOML ——
// 那样既保留其它键，也不会写坏格式。config set 是纯 CLI 操作、不碰 GPU、毫秒级。
//
// 实测不设它时 hipfire 只拿到 legacy 默认 4096，症状是长文报
//   "prompt+max_tokens exceeds ctx_capacity 4096 (raise max_seq or shorten the request)"
const HIPFIRE_EXE = path.join(HIPFIRE_ROOT, '.hipfire', 'bin', 'hipfire.exe');

function applyHipfireConfig(emit, logFd) {
  if (!emit.configSets.length) return;
  const log = (s) => { if (logFd !== undefined) fs.writeSync(logFd, s + '\n'); };
  if (!fs.existsSync(HIPFIRE_EXE)) {
    log(`# 跳过 hipfire config set：找不到 ${HIPFIRE_EXE}`);
    return;
  }
  // ⚠️ **必须传 HOME/USERPROFILE**：hipfire 从 HOME 解析它的 home 目录，
  // 不设的话 config set 会写到别处（实测症状：命令打印出了值，但
  // H:\hipfire-home\.hipfire\config.toml 仍是空的，max_seq 照旧）。
  const env = { ...process.env, HOME: HIPFIRE_ROOT, USERPROFILE: HIPFIRE_ROOT };
  // Request 作用域的键必须写**每模型**层（`config <模型> set`），否则静默无效 ——
  // 原因见 HIPFIRE_REQUEST_SCOPE 的注释。模型串用 --model 传进去的原样值
  // （反斜杠路径），它与 models.toml 的键必须逐字一致。
  const modelArg = (() => {
    const i = emit.args.indexOf('--model');
    return i >= 0 ? emit.args[i + 1] : null;
  })();
  for (const [key, value] of emit.configSets) {
    const scoped = key.startsWith('generation.') && modelArg;
    const base = scoped ? ['config', modelArg] : ['config'];
    try {
      execFileSync(HIPFIRE_EXE, [...base, 'set', key, String(value)], { encoding: 'utf8', timeout: 30000, env });
      // 读回来确认真的落盘了。**这一步不能省**：键名写错时 hipfire 只在 stdout
      // 打一行 "unknown configuration key" 并且**退码 0** —— 不看回读，"写成功"
      // 和"根本没这个键"完全无法区分。
      const back = execFileSync(HIPFIRE_EXE, [...base, 'get', key], { encoding: 'utf8', timeout: 30000, env }).trim();
      if (/unknown configuration key/i.test(back)) {
        log(`# ⚠️ hipfire 不认识配置键 ${key}（本次未写入）`);
      } else if (back !== String(value)) {
        log(`# ⚠️ hipfire config set ${key}=${value} 未生效：回读为 ${JSON.stringify(back)}`);
      } else {
        log(`# hipfire config set ${key}=${value} ✓`);
      }
    } catch (e) {
      log(`# hipfire config set ${key} 失败：${e.message}`);
    }
  }
}

// 由 verbosity + kvmem_trace 合成**唯一一条** EnvFilter 串。
// 两个面板参数写同一个 env，各自 set 会互相覆盖 ⇒ 必须合成一处（碰撞表 C7）。
function hipfireLogDirective(cfg) {
  const lvl = { '0': 'error', '1': 'warn', '2': 'info', '3': 'info', '4': 'debug', '5': 'trace' };
  // ⚠️ 面板的枚举本身是非单调的（4=trace、5=debug），这里**按语义**取：
  // 数值越大越啰嗦 ⇒ 4→debug、5→trace（与面板标签一致，而不是照抄历史倒挂）。
  const base = lvl[String(Number(cfg.verbosity))] || null;
  const parts = [];
  if (base) parts.push(base);
  if (cfg.kvmem_trace === true) parts.push('hipfire_runtime=debug', 'hipfire_daemon=debug');
  return parts.length ? parts.join(',') : null;
}

// **唯一发射点**：所有会写给 hipfire 的东西都在这里产生。
// 返回 { env, args, configSets, notices }。任何不在 HIPFIRE_KEY_OWNER 里的键都不会被写。
function hipfireEmit(cfg, port) {
  const env = { ...process.env };
  const args = ['serve', '--model', String(cfg.hf_model || ''), '--ui'];
  const configSets = [];
  const notices = [];
  const disabled = new Set(Object.keys(HIPFIRE_EXCLUSIVE));

  // 先清掉外部带进来的 hipfire 变量，避免与面板选择打架
  for (const k of Object.keys(env)) if (k.startsWith('HIPFIRE_') || k === 'RAYON_NUM_THREADS') delete env[k];

  // ── 端口/主机 ──────────────────────────────────────────────────────────
  // 值一律经 owner 表查出来取，不直接读 cfg.<字段>：这样表一旦和代码不一致，
  // 测试里的「非 owner 改动不影响输出」会立刻变红，而不是悄悄分叉。
  const ownerOf = (key) => HIPFIRE_KEY_OWNER[key];
  env[HIPFIRE_PORT_ENV] = String(port);
  if (ownerOf('serve.host') === 'host' && cfg.host) env.HIPFIRE_HOST = String(cfg.host);

  // ── 推测解码：走**规范键** HIPFIRE_SPECULATION（= speculation.mode）──────
  // 面板的 hf_spec 恰好一一对应 SPECULATION_MODES，直接透传即可。
  // 不用三个旧布尔位的原因见本文件顶部的说明（会被 apply_speculation_selector 覆盖）。
  const spec = String(cfg.hf_spec || 'auto');
  if (ownerOf('speculation.mode') !== 'hf_spec') {
    throw new Error('internal: speculation.mode 的 owner 表项被改动，发射器与表格已分叉');
  }
  if (!HIPFIRE_SPEC_MODES.includes(spec)) {
    throw new Error(`hipfire 不接受推测解码模式 "${spec}"；合法值：${HIPFIRE_SPEC_MODES.join(' / ')}`);
  }
  env.HIPFIRE_SPECULATION = spec;

  // MTP n-gram takeover 是**正交**于 mode 的开关（speculation.mtp_ngram），
  // 所以它单独走。off 要显式写 0：env 比 config.toml 强，但只有"写出来"才压得住
  // 上一轮留下的文件值；auto 则**不写**，让引擎按 arch 自己判。
  if (ownerOf('speculation.mtp_ngram') !== 'hf_mtp_ngram') {
    throw new Error('internal: speculation.mtp_ngram 的 owner 表项被改动');
  }
  if (String(cfg.hf_mtp_ngram || '') === 'on') {
    env.HIPFIRE_MTP_NGRAM = '1';
    // 三元组默认按 arch 选：只有 model_arch==16 且 GPU 是 gfx1151/gfx1201 才是 5/3/3，
    // 其余一律 24/48/64（hipfire-config/src/lib.rs:4075 ngram_mod_arch_admitted）。
    // 我们 gfx1100 拿不到那组甜点参数，散文场景几乎不可能命中 ⇒ 手动指定 5/3/3。
    // 实测散文 τ 1.41 → 1.84（52.2 → 66.6 tok/s）。
    env.HIPFIRE_NGRAM_MOD_N_MATCH = '5';
    env.HIPFIRE_NGRAM_MOD_N_MIN   = '3';
    env.HIPFIRE_NGRAM_MOD_N_MAX   = '3';
  } else if (String(cfg.hf_mtp_ngram || '') === 'off') {
    env.HIPFIRE_MTP_NGRAM = '0';
  }

  // MTP 草稿窗口（speculation.mtp_k）。这是**加载期**参数：它的 scope 是 ModelLoad，
  // 内核按 `mtp_k + 1` 行组验证批，改完必须重启引擎才生效（分组标题挂着「重启生效」）。
  // 留空 = 不写，用引擎默认 3。
  if (ownerOf('speculation.mtp_k') !== 'hf_mtp_k') {
    throw new Error('internal: speculation.mtp_k 的 owner 表项被改动');
  }
  if (cfg.hf_mtp_k !== '' && cfg.hf_mtp_k != null) {
    const k = clampInt(cfg.hf_mtp_k, 1, 10, 3);
    configSets.push(['speculation.mtp_k', String(k)]);
    if (k !== Number(cfg.hf_mtp_k)) {
      notices.push(`MTP 草稿窗口钳到 ${k}（引擎允许 1–10）。`);
    }
  }

  // ── 采样参数：写**每模型**层（HIPFIRE_REQUEST_SCOPE 的说明见文件上方）────
  // 这几个键的 scope 是 Request，全局层到不了请求默认，只有 ModelUser 层能。
  // 留空 = 不写，让引擎按自己的默认走。
  for (const [key, id] of Object.entries(HIPFIRE_REQUEST_SCOPE)) {
    if (ownerOf(key) !== id) throw new Error(`internal: ${key} 的 owner 表项被改动`);
    const v = cfg[id];
    if (v === '' || v === null || v === undefined) continue;
    configSets.push([key, String(v)]);
  }

  // 重复环断路器。**环境变量**：hipfire_runtime::config 直接读这个变量。
  // 留空 = 不写，用引擎默认（0 = 关闭）。
  if (ownerOf('HIPFIRE_NGRAM_LOOP_THRESHOLD') !== 'hf_loop_guard') {
    throw new Error('internal: HIPFIRE_NGRAM_LOOP_THRESHOLD 的 owner 表项被改动');
  }
  if (cfg.hf_loop_guard !== '' && cfg.hf_loop_guard != null) {
    const n = clampInt(cfg.hf_loop_guard, 0, 64, 8);
    env.HIPFIRE_NGRAM_LOOP_THRESHOLD = String(n);
    if (n !== Number(cfg.hf_loop_guard)) {
      notices.push(`重复环断路器阈值钳到 ${n}（允许 0–64；0 = 关闭）。`);
    }
  }

  // ── 按 owner 表出值：owner 之外的面板参数一概不写 ─────────────────────
  if (HIPFIRE_KEY_OWNER['developer.dflash_draft'] === 'hf_draft' && cfg.hf_draft) {
    env.HIPFIRE_DFLASH_DRAFT = String(cfg.hf_draft);
  }
  if (HIPFIRE_KEY_OWNER['memory.kv_cache'] === 'hf_kv_cache' && cfg.hf_kv_cache) {
    env.HIPFIRE_KV_MODE = String(cfg.hf_kv_cache);
    args.push('--kv-mode', String(cfg.hf_kv_cache));
  }
  // K/V 两轴单独覆盖（memory.kv_k / memory.kv_v）。留空 = 不写，让模式预设说了算。
  // scope 是 ModelLoad ⇒ 全局 config.toml 生效（Request 作用域的 generation.* 不行）。
  //
  // **多槽引擎不接受这两项。** `hipfire-daemon` 在 `experimental_multi_slot` 下对非空的
  // `params.kv_k` / `params.kv_v` 直接 fail-closed（"slots do not support --kv-k/--kv-v"），
  // 而网关会把 config.toml 里**显式写过**的轴原样转发到 load 消息里
  //（`hipfire-cli/src/main.rs:3649` 的 `authored_kv_axis`）。于是"写进去"等于"引擎起不来"，
  // 而失败发生在模型加载阶段，现场只剩一句 daemon error。
  //
  // 多槽的 KV 档位由 `hf_kv_cache` 决定（→ `HIPFIRE_KV_MODE` / `--kv-mode`），按轴覆盖
  // 在那边没有对应物，所以这里**不写**，并且出声——静默丢弃用户显式填的值是另一类错误。
  const multiSlotEngine = cfg.hf_multi_slot === true;
  for (const [key, id] of [['memory.kv_k', 'hf_kv_k'], ['memory.kv_v', 'hf_kv_v']]) {
    if (ownerOf(key) !== id) throw new Error(`internal: ${key} 的 owner 表项被改动`);
    const v = cfg[id];
    if (v === '' || v === null || v === undefined) continue;
    if (multiSlotEngine) {
      notices.push(
        `${key} = ${v} 未写入：多槽引擎不支持按轴覆盖 KV（引擎会 fail-closed 拒绝加载）。` +
        `档位由 KV 模式（${cfg.hf_kv_cache}）决定；要按轴覆盖请关掉多槽引擎。`
      );
      continue;
    }
    configSets.push([key, String(v)]);
  }
  // 对话模板：owner = chat_template_file（它是**路径**，与 hipfire 的
  // ValueRule::PathOrEmpty 对应）。面板的 chat_template 是内联文本，hipfire 不收，
  // 那条碰撞由 hf_kv_cache 那种"禁用另一栏"以外的方式解决 —— 见 HIPFIRE_EXCLUSIVE。
  if (HIPFIRE_KEY_OWNER['prompt.chat_template'] === 'chat_template_file' && cfg.chat_template_file) {
    configSets.push(['prompt.chat_template', String(cfg.chat_template_file)]);
  }
  if (ownerOf('serve.prefix_cache') === 'hf_prefix_cache' && cfg.hf_prefix_cache === true) {
    env.HIPFIRE_SERVE_PREFIX_CACHE = '1';
    // max_bytes=0 时 hipfire **启动即拒**（serve_engine.rs:1464 的硬检查），
    // 所以上限由面板的 GB 值算出来，不允许是 0。
    const gb = Number(cfg.hf_prefix_cache_gb);
    const bytes = Number.isFinite(gb) && gb >= 1 ? Math.round(gb * 1024 * 1024 * 1024) : 8 * 1024 * 1024 * 1024;
    env.HIPFIRE_SERVE_PREFIX_CACHE_MAX_BYTES = String(bytes);
    // 检查点间隔。引擎侧默认 4096；这里显式发出来，让面板的值而不是引擎默认值说话。
    // 未设/非法一律回落到 4096 —— 引擎也认 0（=每个页对齐边界都抓，旧行为），
    // 但那是留给 A/B 的，不是给用户点着玩的，所以面板的 min 允许 0 但默认给 4096。
    const step = Number(cfg.hf_prefix_cache_min_step);
    env.HIPFIRE_SERVE_PREFIX_CACHE_MIN_STEP = String(
      Number.isFinite(step) && step >= 0 ? Math.floor(step) : 4096);
  }
  // 多槽：**只有它开着，会话换出（SwapManager 把闲置会话的 KV 挪到主机内存在按需换回）才可能发生**。
  // serve 路径确实认这个键：complete.rs:2379 会往 generate 请求里塞 experimental_multi_slot。
  if (ownerOf('serve.multi_slot') === 'hf_multi_slot' && cfg.hf_multi_slot === true) {
    env.HIPFIRE_SERVE_MULTI_SLOT = '1';
    if (ownerOf('serve.multi_slot_slots') === 'hf_multi_slot_slots' && cfg.hf_multi_slot_slots !== '' && cfg.hf_multi_slot_slots != null) {
      env.HIPFIRE_SERVE_MULTI_SLOT_SLOTS = String(clampInt(cfg.hf_multi_slot_slots, 1, 64, 4));
    }
    if (ownerOf('serve.multi_slot_ctx') === 'hf_multi_slot_ctx' && cfg.hf_multi_slot_ctx !== '' && cfg.hf_multi_slot_ctx != null) {
      env.HIPFIRE_SERVE_MULTI_SLOT_CTX = String(clampInt(cfg.hf_multi_slot_ctx, 512, 1048576, 8192));
    }
  }
  // ── KV 分层 ────────────────────────────────────────────────────────────
  //
  // **2026-10-16 修正。** 这段以前发的是 `HIPFIRE_KVMEM_TIER` 与
  // `HIPFIRE_KVMEM_WINDOW_PAGES` —— 两个**全仓零读取点**的名字。现场后果三条，
  // 都是"面板显示的状态与引擎里的状态不是一回事"：
  //
  //   ① **关不掉**。旧代码只在 `cfg.hf_kvmem_tier === true` 分支里写东西，"关"
  //      这一半什么都不写 ⇒ config.toml 里的 `enabled = true` 继续说话，引擎
  //      照旧跑分层。用户以为自己在做 A/B 对照，其实两臂是同一个配置。
  //   ② **窗口滑条无效**。窗口的真实键是 `memory.kvmem.select_budget`（token），
  //      面板填的值从来没到过引擎；引擎读的是 config.toml 的 38912（304 页）。
  //   ③ **必备前提正好是杀开关**（最要命的一条，见下面 slots=1 那段）。
  //
  // 所以现在**全部显式双向写**，并且写 config.toml 的**真键**而不是任何环境变量
  // 别名 —— 别名与真键不一致时，只有真键能在回读里被验出来。
  if (ownerOf('memory.kvmem.enabled') !== 'hf_kvmem_tier') {
    throw new Error('internal: memory.kvmem.enabled 的 owner 表项被改动');
  }
  if (ownerOf('memory.kvmem.select_budget') !== 'hf_kvmem_window_tokens') {
    throw new Error('internal: memory.kvmem.select_budget 的 owner 表项被改动');
  }
  // ① 开关：**两个方向都写**。不写 false 就等于没关（见上面 ①）。
  configSets.push(['memory.kvmem.enabled', cfg.hf_kvmem_tier === true ? 'true' : 'false']);
  if (cfg.hf_kvmem_tier === true) {
    env.HIPFIRE_SLOTS_PAGED = '1';
    notices.push('hipfire KV 分层要求分页 KV 池：已同时设置 HIPFIRE_SLOTS_PAGED=1。');

    // ③ ── 槽位数必须钉成 1 ──────────────────────────────────────────────
    //
    // 引擎在 `n_slots > 1` 时**把分层整个关掉**（serve_engine.rs:1803，打印
    // 「kvmem 致命：分层在多槽引擎上尚未支持」）。而 daemon 的 `n_slots` 就是
    // `experimental_multi_slot_slots`，缺省 **4**
    // （hipfire-daemon/src/main.rs:1369 的 `unwrap_or(4)`）。
    //
    // 于是旧面板的组合（多槽开 + 槽位 4）**正是分层被关掉的那个组合**：用户按
    // 面板要求配齐了，引擎却一声「致命」把分层丢开，KV 按每槽上下文全量铺开 ——
    // 而这正是面板警告用户"会顶穿显存"的那种状态。面板的必备前提与引擎的杀开关
    // 是同一个条件。
    //
    // 多槽本身仍**必需**：分层跑在 `Rig::build` 里，而 daemon 只在多槽路由上创建
    // SlotEngine。所以唯一能跑分层的组合是「多槽开 + 槽位 1」。
    const wantSlots = clampInt(cfg.hf_multi_slot_slots, 1, 64, 4);
    configSets.push(['serve.multi_slot_slots', '1']);
    if (wantSlots !== 1) {
      notices.push(
        `hipfire KV 分层：槽位数已由 ${wantSlots} 钉成 **1** —— 引擎在 n_slots > 1 时` +
        `直接把分层关掉（"分层在多槽引擎上尚未支持"）。多槽只是让 SlotEngine 存在的` +
        `通道，不是让分层并发跑多个会话；分层目前是单序列语义。`
      );
    }

    // ② ── 窗口：语义预算（token），**单位就是面板标称的 token** ───────────
    //
    // 换算**取消**：旧代码做 token→页，而真键的单位本来就是 token。
    // 留空**不等于**"没有窗口" —— config.toml 里的 38912 会继续说话，那是 304 页。
    // 要"不淘汰任何页"就得显式给一个 ≥ 每槽上下文的预算。
    const ctxTok = clampInt(cfg.hf_multi_slot_ctx, 512, 1048576, 8192);
    const winBlank = cfg.hf_kvmem_window_tokens === '' || cfg.hf_kvmem_window_tokens == null;
    const winTok = winBlank
      ? ctxTok
      : clampInt(cfg.hf_kvmem_window_tokens, 256, 1048576, ctxTok);
    // 引擎要求整块（`validate_runtime_select_budget`），向上取整到 128 的倍数。
    // 向上是"多留"而不是"少留" —— 少留会静默丢历史。
    const winBlocks = Math.max(1, Math.ceil(winTok / 128));
    configSets.push(['memory.kvmem.select_budget', String(winBlocks * 128)]);
    if (winBlank) {
      notices.push(
        `KV 窗口留空 ⇒ 已显式写成 ${winBlocks * 128} token（= 每槽上下文），即**不淘汰` +
        `任何页**。留空不再是"什么都不写"：config.toml 里还留着 38912，不显式覆盖` +
        `就会落回它（= 304 页），与面板显示的"未设窗口"完全不是一回事。`
      );
    } else if (winBlocks * 128 !== winTok) {
      notices.push(`KV 窗口按 128-token 块对齐：${winTok} token → ${winBlocks * 128} token。`);
    }
    // ── 窗口 vs 上下文 ───────────────────────────────────────────────────
    //
    // 修正前的文案说被淘汰的页"永久丢失"。**那是旧实现**。移植后的分层有主机层
    // ── 窗口 vs 上下文 vs 主机层：**容量必须自己算清** ────────────────────
    //
    // 修正前的文案说"被换出的块进主机层，不是永久丢失"。**那是半真话，而且是
    // 危险的那一半**：只有当主机层装得下「总上下文 − 窗口」的全部块时才成立。
    // 装不下时 `place_block_evicting` 会淘汰 LRU，而被淘汰者在本移植里
    // **直接消失**（没有 NVMe 第三层接住）—— 模型此后在残缺历史上生成，
    // 现场表现是奇怪的输出或 `malformed_protocol`，报错完全不指向这一栏。
    //
    // 本机实测到的正是这个：256k 上下文需要 2063 块，窗口只留 285，
    // 主机层 1 GiB 仅 352 块，差额 1426 块**无处可放**，最后吐坏协议。
    // 所以这里不再只提醒"窗口 < 上下文"，而是把三个数摆出来让用户自己看。
    if (winBlocks * 128 < ctxTok) {
      // 引擎的块大小 = 16 层 × 每 pos 字节 × 128 token。fwht3 是 1488 B/pos、
      // q8 是 2176 B/pos（K 400/1088 + V 恒为 1088）。面板不引引擎常量，
      // 用一个保守的 2176（q8 上界）估值 —— 宁可高估需求，也不要低报。
      const BYTES_PER_POS_EST = 2176;
      const BLOCK_BYTES_EST = 16 * BYTES_PER_POS_EST * 128;
      const totalBlocks = Math.ceil(ctxTok / 128);
      const spillBlocks = Math.max(0, totalBlocks - winBlocks);
      const needGib = (spillBlocks * BLOCK_BYTES_EST) / (1024 ** 3);
      const haveGb = (() => {
        const g = Number(cfg.hf_kvmem_cpu_gb);
        return Number.isFinite(g) && g >= 1 ? g : 1; // 留空时 config.toml 的旧值 ≈ 1 GiB
      })();
      const short = spillBlocks * BLOCK_BYTES_EST / (1024 ** 3) > haveGb;
      notices.push(
        `⚠️ KV 窗口 ${winBlocks * 128} token **小于**每槽上下文 ${ctxTok} token。` +
        `常驻窗口只覆盖 ${((winBlocks * 128 / ctxTok) * 100).toFixed(1)}%，其余要靠主机层接住 —— ` +
        `请核对这一栏够不够：\n` +
        `    总块数 ceil(${ctxTok}/128) = ${totalBlocks}，减窗口 ${winBlocks} ⇒ 主机层需装 ${spillBlocks} 块\n` +
        `    q8 档估需 ≈ ${needGib.toFixed(1)} GiB，当前主机层 = ${haveGb} GB\n` +
        (short
          ? `    ❌ **装不下**：超出部分会被丢弃（没有 NVMe 层接住），模型将在残缺历史上生成。` +
            `把「hipfire KV 主机层容量」提到 ≥ ${Math.ceil(needGib)} GB，或把窗口提到接近 ${ctxTok}。`
          : `    ✅ 按 q8 上界估算够用（fwht3 档实际只需约 ${(needGib * 1488 / 2176).toFixed(1)} GiB，更宽裕）。`)
      );
    }

    // ── 选择策略与检索规模：分层掉速的两个主旋钮 ─────────────────────────
    //
    // `select_method = retrieval` 时每步给候选块打余弦分；`recency` 只看新旧。
    // **但两者在短上下文下都不花钱**：`pick_topk_blocks` 有早退
    // （`n <= budget` 直接返回全部块，hipfire-kvmem-tier/src/store.rs:750），
    // 所以窗口比上下文宽时选择器根本不启动。窗口设小了才会开始真打分。
    // ── 选择策略：**总是显式写** ────────────────────────────────────────
    //
    // 早先这里是 `&& cfg.hf_kvmem_method`，于是留空 = 什么都不写。那是错的，
    // 而且错得很难查：`hipfire config set` 只写 config.toml，所以**一旦有人
    // 设过 `recency`，之后面板留空并不会让它回退到 `retrieval` —— 残留值继续
    // 生效**。
    //
    // 真机踩到过：我做 A/B 时把它设成 `recency`，后来面板改回空，引擎却一直在
    // 跑 `recency`。`recency` 只保留 sink + 最近几块，**中间整段丢弃** ——
    // harness 的工具定义在中段，于是模型看不到任何工具，只能靠猜名字
    // （"let me try a range of common shell tool names"），一路 `unknown tool`
    // 失败。表面像模型/协议问题，实际是这一栏的残留值。
    //
    // 与 `serve.idle_timeout_seconds` 同一条规则：**默认值必须显式下发**，
    // 否则「面板显示的值」与「引擎生效的值」会分叉。
    if (ownerOf('memory.kvmem.select_method') === 'hf_kvmem_method') {
      const method = cfg.hf_kvmem_method || 'retrieval';
      configSets.push(['memory.kvmem.select_method', String(method)]);
      if (!cfg.hf_kvmem_method) {
        notices.push(
          'KV 选择策略留空 ⇒ 已显式写成 **retrieval**（引擎默认）。' +
          '不再"留空就不写"：那样会让 config.toml 里的残留值（例如 `recency`）继续生效。'
        );
      }
    }
    // 检索查询长度：同 `select_method` 的规则 —— **总是显式写**。
    // 留空 = 不写会让 config.toml 的残留值存活（我 A/B 时用过 131），
    // 而 131 与 512 对选择结果的影响是实打实的。
    if (ownerOf('memory.kvmem.query_max_tokens') === 'hf_kvmem_query_tokens') {
      const blank = cfg.hf_kvmem_query_tokens === '' || cfg.hf_kvmem_query_tokens == null;
      const v = blank ? 512 : clampInt(cfg.hf_kvmem_query_tokens, 1, 65536, 512);
      configSets.push(['memory.kvmem.query_max_tokens', String(v)]);
      if (blank) {
        notices.push('KV 检索查询长度留空 ⇒ 已显式写成 **512**（引擎默认），避免 config.toml 残留值生效。');
      }
    }
    // ── sink / recent / gen_budget：**总是显式写** ────────────────────────
    //
    // 与 `select_method`、`query_max_tokens` 同一条规则，理由也一样：留空不写
    // 会让 config.toml 的**残留值**继续生效，而面板显示的是"空"。这一组尤其危险，
    // 因为 `memory.kvmem.sink_tokens` 的非零值会**覆盖** `sink_blocks`
    // （桥按参考的 `sink_tokens == 0 ? 1 : max(1, sink_tokens / block_tokens)`
    // 取值，llama-memory-kvmem.cpp:294-296）：
    //
    //   用户以为自己"清空了 sink"，实际 config.toml 里的 6000 继续把工具定义
    //   钉在窗口里 —— 模型的可见历史与面板描述的不一致，而这正是
    //   `select_method = recency` 残留那次踩过的坑（工具定义整段被丢，
    //   模型开始猜工具名）。
    //
    // 留空 ⇒ 写面板默认。`sink_tokens` 默认 0（= 不按 token 覆盖），
    // `sink_blocks` 默认 1（参考里 `sink_tokens == 0` 就是一块，
    // llama-kvmem-hooks.h:24 的 `// 0 → one block`）。
    for (const [key, id, min, max, dflt] of [
      ['memory.kvmem.gen_budget',    'hf_kvmem_gen_budget',    0, 1073741824,   32768],
      ['memory.kvmem.sink_tokens',   'hf_kvmem_sink_tokens',   0, 1073741824,      0],
      ['memory.kvmem.sink_blocks',   'hf_kvmem_sink_blocks',   0, 1048576,          1],
      ['memory.kvmem.recent_blocks', 'hf_kvmem_recent_blocks', 0, 1048576,          0],
    ]) {
      if (ownerOf(key) !== id) throw new Error(`internal: ${key} 的 owner 表项被改动`);
      const v = cfg[id];
      const blank = v === '' || v === null || v === undefined;
      configSets.push([key, String(blank ? dflt : clampInt(v, min, max, dflt))]);
    }

    // ── 查询打分器与图传播强度（上游 `--kvmem-query-scorer` / `--kvmem-graph-alpha`）
    //
    // 这两个键的耦合由引擎裁决（page-softmax 不支持 LRFU、cosine 不支持图传播），
    // 面板只负责把用户的选择原样写进去。打分器是**枚举字符串**、alpha 是 [0,1]
    // 浮点，所以不走上面的整型循环。
    //
    // 默认 `meanq-cosine`：本机 40 轮实测里它与 `page-softmax`（上游源码默认的 C 档）
    // 稳定性相同，但答案长度中位 738 vs 518、末尾 740 vs 23，且解码 29.9 vs 12.3 tok/s。
    if (ownerOf('memory.kvmem.query_scorer') !== 'hf_kvmem_query_scorer') {
      throw new Error('internal: memory.kvmem.query_scorer 的 owner 表项被改动');
    }
    {
      const v = String(cfg.hf_kvmem_query_scorer || 'meanq-cosine');
      const allowed = ['meanq-cosine', 'page-softmax'];
      const pick = allowed.includes(v) ? v : 'meanq-cosine';
      if (pick !== v) {
        notices.push(`query_scorer = ${v} 不在 ${allowed.join(' / ')} 内，按 ${pick} 写入。`);
      }
      configSets.push(['memory.kvmem.query_scorer', pick]);
    }
    if (ownerOf('memory.kvmem.graph_alpha') !== 'hf_kvmem_graph_alpha') {
      throw new Error('internal: memory.kvmem.graph_alpha 的 owner 表项被改动');
    }
    {
      const raw = cfg.hf_kvmem_graph_alpha;
      const blank = raw === '' || raw === null || raw === undefined;
      const a = blank ? 0 : Math.min(1, Math.max(0, Number(raw) || 0));
      configSets.push(['memory.kvmem.graph_alpha', String(a)]);
    }
    // page-softmax 的主机侧行预算：0 = 用引擎默认（8）。上游没有这个选项
    // （它在 GPU 上按 64 行一块遍历全部 query token），所以这里是 hipfire 独有
    // 的降采样旋钮，面板只做范围收敛（0..64 = QUERY_ROW_CAP）。
    if (ownerOf('memory.kvmem.page_softmax_rows') !== 'hf_kvmem_page_softmax_rows') {
      throw new Error('internal: memory.kvmem.page_softmax_rows 的 owner 表项被改动');
    }
    {
      const raw = cfg.hf_kvmem_page_softmax_rows;
      const blank = raw === '' || raw === null || raw === undefined;
      const n = blank ? 0 : Math.min(64, Math.max(0, Math.trunc(Number(raw) || 0)));
      configSets.push(['memory.kvmem.page_softmax_rows', String(n)]);
    }
    // ── 主机层容量：面板收 GB，引擎收字节 ────────────────────────────────
    //
    // 面板收字节是**不可用**的：这一栏的实际量级是 10^10，用户要心算
    // `12884901888` 是不是 12 GiB —— 而这正是本机踩过的那类错误
    // （`kvmem_cpu_gb` 留 0 被当成"不限制"，实际是"禁用"）。
    // 与 `hf_prefix_cache_gb` 同一套换算，只此一处。
    //
    // **下限 1 GB 而不是 0**：0 在引擎里是"禁用主机层"（
    // `pinned_kv_tier` 的 `slot_count = total_bytes / slot_bytes` ⇒ 0 槽），
    // 而禁用之后被换出的块**直接消失**（没有 NVMe 层接）—— 现场表现是模型
    // 在残缺历史上生成，最后吐 malformed 协议，报错完全不指向这一栏。
    if (ownerOf('memory.kvmem.cpu_bytes') !== 'hf_kvmem_cpu_gb') {
      throw new Error('internal: memory.kvmem.cpu_bytes 的 owner 表项被改动');
    }
    {
      const gbRaw = cfg.hf_kvmem_cpu_gb;
      if (gbRaw !== '' && gbRaw !== null && gbRaw !== undefined) {
        const gb = Number(gbRaw);
        if (!Number.isFinite(gb)) {
          throw new Error(`hf_kvmem_cpu_gb 不是数字：${JSON.stringify(gbRaw)}`);
        }
        // 上界 1024 GiB 只是防手滑；真正的边界是系统内存，且这一层是 pinned
        // （不可换页），超了会把系统压垮 —— 操作者的判断。
        const gbClamped = Math.min(1024, Math.max(1, gb));
        configSets.push(['memory.kvmem.cpu_bytes', String(Math.round(gbClamped * 1024 * 1024 * 1024))]);
        if (gbClamped !== gb) {
          notices.push(`hipfire KV 主机层容量钳到 ${gbClamped} GB（允许 1–1024）。`);
        }
      }
    }
    if (ownerOf('memory.kvmem.trace') === 'hf_kvmem_trace' && cfg.hf_kvmem_trace === true) {
      configSets.push(['memory.kvmem.trace', 'true']);
      // ── 注意力跳度探针（跟随同一个跟踪开关）────────────────────────────
      //
      // 2026-10-23：性能档压测里 decode 出现两态断崖 —— 窗口同为 288 页、
      // 同深度（81k vs 82.6k）时 forward 从 38 ms 跳到 159 ms，4.2×，平顶，
      // 且在同一进程内来回翻。已排除：深度、窗口页数、碎块数、换页量
      // （全程 +0 in）、reselect（1.5 ms）、打分（整场只 1 次）、显存（恒
      // 3.97 GiB）、并发（单实例）。
      //
      // 剩下的分叉只有两条，而它俩的**唯一分界**就是注意力实际跳度：
      //   A) 跳度被绕过（位置没做窗口翻译）⇒ 注意力从窗口长度涨到绝对位置
      //      甚至 physical_cap，q8_0 跳度在 gfx1100 上还是 ALU 受限；
      //   B) 跳度没变 ⇒ 代价在权重流带宽，属于外部/驱动侧，与移植无关。
      //
      // `HIPFIRE_ATTN_SPAN=1` 让 `windowed_positions` 每 32 次 forward 打一行
      // `[attn-span] rows=… max_pos_plus_1=… translated=…`。纯只读探针，
      // 不改任何计算、不占显存；默认关，只在跟踪开启时随行。
      env.HIPFIRE_ATTN_SPAN = '1';
    }
    // 分页池的**物理**容量是所有槽共享的，也是唯一能压显存的旋钮。留空 = 引擎默认
    // （槽位数 × ceil(每槽上下文/128) 页，即与不分页同容量、最保守），显式填了就走这里。
    if (ownerOf('HIPFIRE_SLOTS_PAGED_PAGES') === 'hf_kvmem_pool_tokens' &&
        cfg.hf_kvmem_pool_tokens !== '' && cfg.hf_kvmem_pool_tokens != null) {
      // token -> 页：这是**真**换算（分页池的环境变量确实按页计，与窗口不同 ——
      // 窗口那条换算已经取消）。
      const tokens = clampInt(cfg.hf_kvmem_pool_tokens, 256, 4194304, 65536);
      const pages = Math.min(32768, Math.max(1, Math.ceil(tokens / 128)));
      env.HIPFIRE_SLOTS_PAGED_PAGES = String(pages);
      if (pages * 128 !== tokens) {
        notices.push(`分页池按 128-token 页对齐：${tokens} token → ${pages} 页（${pages * 128} token）。`);
      }
    }
  }
  const logDir = hipfireLogDirective(cfg);
  if (logDir) env.HIPFIRE_LOG = logDir;

  // ── 空闲卸载延迟：**总是显式写** ──────────────────────────────────────
  //
  // 这一栏必须无条件下发，不能"留空就不写"：引擎的默认是 300 秒，而
  // `hipfire config set` 只写 config.toml —— 一旦某次写过一个非 0 值，
  // 之后"留空"会落回那个残留值，而不是默认。压测被卸载打断过一次就够烦了。
  //
  // 0 是合法且**语义明确**的值：引擎 `if !idle_timeout.is_zero()` 才 spawn
  // 监视线程（`serve/mod.rs:1597`），所以 0 = 线程根本不启动 = 真禁用。
  if (HIPFIRE_KEY_OWNER['serve.idle_timeout_seconds'] === 'hf_idle_timeout') {
    const raw = cfg.hf_idle_timeout;
    const secs = Number.isFinite(Number(raw)) ? Math.min(86400, Math.max(0, Number(raw))) : 0;
    configSets.push(['serve.idle_timeout_seconds', String(secs)]);
    if (secs === 0) {
      notices.push('模型空闲卸载**已禁用**（serve.idle_timeout_seconds=0）：引擎不会因为空闲而卸载权重。');
    }
  }
  // ── queue timeout：面板 timeout → serve.queue_timeout_ms ───────────────
  if (cfg.timeout !== '' && cfg.timeout !== null && cfg.timeout !== undefined) {
    const t = hipfireQueueTimeout(cfg.timeout);
    if (t) {
      configSets.push(['serve.queue_timeout_ms', String(t.ms)]);
      notices.push(t.notice);
    }
  }
  // ── max_seq：owner = hf_max_seq，且在发射器里就 clamp（防越界）──────────
  if (HIPFIRE_KEY_OWNER['memory.max_seq'] === 'hf_max_seq') {
    const n = Number(cfg.hf_max_seq);
    if (Number.isFinite(n) && n > 0) {
      const clamped = Math.min(1048576, Math.max(512, n));
      if (clamped !== n) notices.push(`上下文窗口已按 hipfire 的范围（512–1048576）调整为 ${clamped}。`);
      configSets.push(['memory.max_seq', String(clamped)]);
    }
  }
  // ── max_tokens：owner = n_predict ─────────────────────────────────────
  if (HIPFIRE_KEY_OWNER['generation.max_tokens'] === 'n_predict') {
    const n = Number(cfg.n_predict);
    if (Number.isFinite(n)) {
      if (n === -1) {
        configSets.push(['generation.max_tokens', '393216']);
        notices.push('hipfire 的「不限」上限是 393216；-1 已按该上限生效。');
      } else if (n > 393216) {
        configSets.push(['generation.max_tokens', '393216']);
        notices.push('单轮输出上限已钳到 hipfire 的最大值 393216。');
      } else if (n >= 1) {
        configSets.push(['generation.max_tokens', String(n)]);
      }
    }
  }

  // ── 引擎互斥参数：**断言它们一个都没进输出** ───────────────────────────
  for (const id of disabled) {
    if (configSets.some(([k]) => HIPFIRE_KEY_OWNER[k] === id)) {
      throw new Error(`internal: 引擎互斥参数 ${id} 不应产生 hipfire 输出`);
    }
  }
  return { env, args, configSets, notices, disabled };
}

// hipfire 的启动三元组。**每次都调 hipfireEmit**，不要另写一份 args/env ——
// 之前 buildHipfireArgs 是第二份发射点，hf_kv_cache 因此写了两遍（args 一份、
// env 一份），改一处漏一处就是静默分叉。
// --ui：hipfire 自带的聊天页面挂在 /ui（不是 /）。不给它这个旗标的话 18200
// 只提供 OpenAI 接口，根路径返回 404 —— 前端"聊天窗口"就点不进去。
function hipfireCmd(cfg, port) {
  const emit = hipfireEmit(cfg, port);
  // 经 cmd.exe 走 hipfire.bat：它负责 call vcvars64 + 从 INCLUDE 里剔除 VC98。
  // 直接 spawn hipfire.exe 会在运行期 JIT 编译内核时报 VC98 的 typedef 冲突。
  return { exe: 'cmd.exe', args: ['/c', HIPFIRE_BAT, ...emit.args], env: emit.env, emit };
}

// ---------------------------------------------------------------------------
// 服务进程管理
// ---------------------------------------------------------------------------
let serverProc = null;
let lastStartAt = 0;
let lastError = '';
let starting = false;

function activeEngine(cfg) {
  return String((cfg && cfg.engine) || 'kvmem') === 'hipfire' ? 'hipfire' : 'kvmem';
}

// 监听地址：面板的「监听地址」两个引擎共用同一个语义，之前只接到了 llama.cpp 上
// （hipfire 那侧完全没读），改 host 对 hipfire 是零作用。
function engineHost(cfg) {
  const h = String((cfg && cfg.host) || '').trim();
  return h || '127.0.0.1';
}

// **探测**地址：0.0.0.0 / :: 是「监听所有接口」，不能拿来当连接目标用
// （Windows 上连 0.0.0.0 有时通有时不通）。探测一律换成回环。
function probeHost(cfg) {
  const h = engineHost(cfg);
  return (h === '0.0.0.0' || h === '::' || h === '*') ? '127.0.0.1' : h;
}

// 该引擎的启动前置条件；返回错误串表示不可启动（前端直接显示，不要静默）
function enginePrecheck(cfg) {
  // 两个引擎共用的检查
  const hosts = cfg && cfg.host !== undefined ? String(cfg.host) : '';
  if (hosts && !/^(\d{1,3}(\.\d{1,3}){3}|::1|0\.0\.0\.0|localhost)$/.test(hosts)) {
    return `监听地址 "${hosts}" 看起来不是 IP（支持 127.0.0.1 / 0.0.0.0 / ::1 / localhost）。`;
  }
  if (activeEngine(cfg) === 'hipfire') {
    if (!fs.existsSync(HIPFIRE_BAT)) return `未找到 hipfire 启动器：${HIPFIRE_BAT}`;
    if (!cfg.hf_model) return 'hipfire 引擎需要选择主模型（HFQM 格式，在 J:\\hipfiremodels）';
    if (!fs.existsSync(String(cfg.hf_model))) return `hipfire 主模型不存在：${cfg.hf_model}`;
    // 推测解码模式必须是 hipfire 的枚举（老配置里可能存着别的值）
    if (cfg.hf_spec && !HIPFIRE_SPEC_MODES.includes(String(cfg.hf_spec))) {
      return `hipfire 不认识推测解码模式 "${cfg.hf_spec}"。合法值：${HIPFIRE_SPEC_MODES.join(' / ')}`;
    }
    // dflash 模式**必须**有草稿头：serve 没有 --model-draft，只能靠 HIPFIRE_DFLASH_DRAFT，
    // 缺了 hipfire 会以 "DFlash draft required ... not a registry-managed artifact" 退出。
    if (String(cfg.hf_spec || '') === 'dflash') {
      if (!cfg.hf_draft) return 'hipfire 选 dflash 模式时必须指定草稿头（hf_draft）';
      if (!fs.existsSync(String(cfg.hf_draft))) return `hipfire 草稿头不存在：${cfg.hf_draft}`;
    }
    // KV 精度必须是 hipfire 自己的枚举值。老配置里可能存着 llama.cpp 的 dtype
    // （q4_0/q5_0 之类），那样 hipfire 会以退码 1 静默退出，日志只有一行
    // "invalid value for memory.kv_cache"。这里提前拦下来并说清。
    if (cfg.hf_kv_cache && !HIPFIRE_KV_MODES.includes(String(cfg.hf_kv_cache))) {
      return `hipfire 不接受 KV 精度 "${cfg.hf_kv_cache}"（这是 hipfire 私有枚举，与 llama.cpp 的 --kv-dtype 不通用）。合法值：${HIPFIRE_KV_MODES.join(' / ')}`;
    }
    // 前缀缓存的上限必须 >0 —— hipfire 自己是硬拒的（serve_engine.rs:1464），
    // 但提前说清楚比让它在启动日志里丢一行要好。
    if (cfg.hf_prefix_cache === true) {
      const gb = Number(cfg.hf_prefix_cache_gb);
      if (!Number.isFinite(gb) || gb < 1) {
        return 'hipfire 开启前缀缓存时必须给它一个 >0 的保留上限（serve.prefix_cache requires prefix_cache_max_bytes > 0）。把「hipfire 前缀缓存上限 (GB)」填成 ≥1。';
      }
    }
    return null;
  }
  if (!fs.existsSync(SERVER_EXE)) return '未找到服务程序：' + SERVER_EXE;
  // ── llama 侧的模型校验（2026-10-25）────────────────────────────────────
  //
  // 原来这里只查服务程序、不查模型：配置里的 `model` 指向一个不存在的路径时，
  // 面板照样放行，然后 spawn 出去的服务在启动阶段退码，控制台只看到一句笼统的
  // 报错。真机现场：`model` 还指着 `H:\dshworkspace\KVMem\models\…gguf`
  // （该目录早已不存在，模型实际在 `G:\models\…`），于是"切换成 llama 引擎"
  // 每次都失败。这里提前拦下并说清缺的是哪个文件。
  if (!cfg.model) return 'llama 引擎需要选择主模型（.gguf）';
  if (!fs.existsSync(String(cfg.model))) {
    return `llama 主模型不存在：${cfg.model}（配置里的路径过期了，请重新选模型）`;
  }
  if (cfg.mmproj && !fs.existsSync(String(cfg.mmproj))) {
    return `llama 视觉投影文件不存在：${cfg.mmproj}（不用视觉就把这一栏留空）`;
  }
  return null;
}

function cleanPath() {
  const parts = (process.env.PATH || '').split(';').filter((p) => p && !/TheRock/i.test(p) && !/AMD.ROCm/i.test(p));
  // The locally built binary needs the standard ROCm 7.2 runtime DLLs.
  // 发行包把 ROCm 7.x 的 DLL 和 llama 服务放在同一目录（`<包根>\llama\`），
  // 而系统 ROCm 只在开发机上才有 —— 所以服务程序所在目录必须进 PATH，
  // 否则发行包里的 llama 引擎会因为找不到 amdhip64.dll 而直接起不来。
  return USE_BUILT ? [path.dirname(SERVER_EXE), ROCM_RUNTIME_BIN, ...parts].join(';')
                   : [path.dirname(SERVER_EXE), BIN_DIR, ...parts].join(';');
}

function serverArgsPreview(cfg) {
  if (activeEngine(cfg) === 'hipfire') {
    const port = Number(cfg.port) || CHAT_PORT_DEFAULT;
    const e = hipfireEmit(cfg, port);
    const shown = ['HIPFIRE_PORT', 'HIPFIRE_HOST', 'HIPFIRE_SPECULATION', 'HIPFIRE_MTP_NGRAM',
                   'HIPFIRE_DFLASH_DRAFT', 'HIPFIRE_KV_MODE', 'HIPFIRE_SERVE_PREFIX_CACHE',
                   'HIPFIRE_SERVE_PREFIX_CACHE_MAX_BYTES', 'HIPFIRE_SERVE_MULTI_SLOT',
                   'HIPFIRE_SERVE_MULTI_SLOT_SLOTS', 'HIPFIRE_SERVE_MULTI_SLOT_CTX',
                   'HIPFIRE_KVMEM_TIER', 'HIPFIRE_SLOTS_PAGED', 'HIPFIRE_KVMEM_WINDOW_PAGES',
                   'HIPFIRE_SLOTS_PAGED_PAGES',
                   'HIPFIRE_LOG']
      .filter((k) => e.env[k] !== undefined).map((k) => `${k}=${e.env[k]}`).join(' ');
    const sets = e.configSets.map(([k, v]) => `hipfire config set ${k} ${v}`).join('\n#   ');
    // ⚠️ 是 e.args，**不是** e.args.slice(2)：e.args 本身就从 'serve' 开始。
    // slice(2) 是上一版从 ['/c', BAT, ...] 上切时留下的，照抄到这里会把
    // "serve --model" 切掉 —— 而这一栏是用户拿去复制粘贴的，切了就跑了别的东西。
    const argv = e.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
    return `cmd /c "${HIPFIRE_BAT}" ${argv}\n# 环境：${shown}` +
           (sets ? `\n# 运行前还会写入：\n#   ${sets}` : '') +
           (e.notices.length ? `\n# 提示：${e.notices.join(' ')}` : '');
  }
  return ['"' + SERVER_EXE + '"', ...buildArgs(cfg).map((a) => (a.includes(' ') ? `"${a}"` : a))].join(' ');
}

async function isUp(port, host = '127.0.0.1', timeoutMs = 2500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`http://${host}:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

// 端口是否被占用（不判断是谁占的）。
// 绑定到 `host`：判的就是"服务要绑的那个地址"是否已被人占了。
function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, host);
  });
}

function stopServer() {
  const killed = [];
  if (serverProc && serverProc.pid) {
    try { execFileSync('taskkill', ['/f', '/pid', String(serverProc.pid), '/t'], { stdio: 'ignore' }); killed.push(serverProc.pid); } catch {}
    serverProc = null;
  }
  // ⚠️ 不能只看 runningEngine：它只在内存里，控制台重启后就不知道上一任
  // 起的是哪个引擎了（实测症状：hipfire 还在 18200 上跑，但 stop 走了 kvmem
  // 分支，什么都没杀掉）。三个进程名都试一遍 —— taskkill 对不存在的进程是
  // 幂等失败，代价可忽略。
  for (const exe of ['llama-kvmem-server.exe', 'hipfire.exe', 'daemon.exe']) {
    try { execFileSync('taskkill', ['/f', '/im', exe], { stdio: 'ignore' }); killed.push(exe); } catch {}
  }
  // hipfire 的 GPU 锁文件残留会让下次启动报 "already reserved by holder PID"。
  try {
    const lockDir = 'C:\\ProgramData\\hipfire\\locks';
    if (fs.existsSync(lockDir)) {
      for (const f of fs.readdirSync(lockDir)) {
        if (f.endsWith('.lock')) { try { fs.unlinkSync(path.join(lockDir, f)); } catch {} }
      }
    }
  } catch {}
  return killed;
}

function startServer(cfg) {
  const eng = activeEngine(cfg);
  const pre = enginePrecheck(cfg);
  if (pre) throw new Error(pre);

  const logFd = fs.openSync(LOG_FILE, 'w');
  fs.writeSync(logFd, `# ${eng === 'hipfire' ? 'hipfire 子引擎' : 'KVMem 主引擎'} 启动 ${new Date().toLocaleString('zh-CN')}\n# 命令行：${serverArgsPreview(cfg)}\n\n`);

  if (eng === 'hipfire') {
    const port = Number(cfg.port) || CHAT_PORT_DEFAULT;
    const c = hipfireCmd(cfg, port);
    // 上下文窗口/队列超时这些键**没有环境变量**（field! 里 env_compat 是 None），
    // 必须在 spawn 前写进 hipfire 的 config.toml。configSet（纯 CLI，不碰 GPU）
    // 已经由发射器算好，这里逐个落盘并回读校验。
    applyHipfireConfig(c.emit, logFd);
    for (const n of c.emit.notices) fs.writeSync(logFd, `# 提示：${n}\n`);
    serverProc = spawn(c.exe, c.args, {
      cwd: HIPFIRE_ROOT,
      env: c.env,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      detached: false,
    });
    fs.closeSync(logFd);
    lastStartAt = Date.now();
    lastError = '';
    serverProc.on('exit', (code) => { lastError = `hipfire 进程退出，代码 ${code}`; serverProc = null; });
    serverProc.on('error', (e) => { lastError = 'hipfire 启动失败：' + e.message; serverProc = null; });
    return c.args;
  }

  const args = buildArgs(cfg);
  serverProc = spawn(SERVER_EXE, args, {
    cwd: RUN_DIR,
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

async function waitReady(port, host = '127.0.0.1', timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await isUp(port, host)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function listModels() {
  // 模型的规定位置就是**发行包内的 `models\`**（README 与 models\README.txt 都这么写）。
  // 这里以包内目录为主，同时按 HIPFIRE_MODELS_DIRS 兜底（模型被搬到别处时仍能找到），
  // 并且递归一层 —— 很多人按仓库/量化方分子文件夹放。
  const dirs = [path.join(ROOT, 'models'), ...HIPFIRE_MODELS_DIRS];
  const main = [];
  const mmproj = [];
  for (const d of dirs) {
    for (const full of modelFilesIn(d)) {
      const f = path.basename(full);
      let mb = 0; try { mb = Math.round(fs.statSync(full).size / 1048576); } catch {}
      if (/\.gguf$/i.test(f)) {
        if (/mmproj/i.test(f)) mmproj.push({ path: full, name: f, mb });
        else main.push({ path: full, name: f, mb });
      }
    }
  }
  const hf = [];
  const hfdraft = [];
  for (const d of dirs) {
    for (const full of modelFilesIn(d)) {
      const f = path.basename(full);
      let mb = 0; try { mb = Math.round(fs.statSync(full).size / 1048576); } catch {}
      if (/\.hfq$/i.test(f)) hfdraft.push({ path: full, name: f, mb });
      else if (/\.mq[0-9]/i.test(f)) hf.push({ path: full, name: f, mb });
    }
  }
  for (const [key, arr] of [['hf_model', hf], ['hf_draft', hfdraft]]) {
    const v = loadConfig()[key];
    if (v && fs.existsSync(v) && !arr.some((x) => x.path.toLowerCase() === v.toLowerCase())) {
      let mb = 0; try { mb = Math.round(fs.statSync(v).size / 1048576); } catch {}
      arr.push({ path: v, name: path.basename(v), mb });
    }
  }
  // 同一个文件可能被多个候选目录命中（包内 models + 兜底列表），按路径去重后再排序。
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((x) => {
      const k = path.resolve(x.path).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => a.name.localeCompare(b.name));
  };
  return { main: dedupe(main), mmproj: dedupe(mmproj), hf: dedupe(hf), hfdraft: dedupe(hfdraft) };
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
  const host = probeHost(cfg);
  const up = await isUp(port, host, 1500);
  if (up) {
    try {
      const j = await fetchJson(`http://${host}:${port}/v1/models`, 1500);
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
    // 聊天页面路径**两个引擎不一样**：llama.cpp 挂在根路径（--webui），
    // hipfire 挂在 /ui（serve --ui）。给错路径的症状是"聊天窗口链接不上"。
    // 用 host（不是回环）拼链接：监听了 0.0.0.0 时 127.0.0.1 仍然能开，
    // 但反过来（只监听某个具体网卡地址）就不行了。
    chatUrl: `http://${host}:${port}/${activeEngine(cfg) === 'hipfire' ? 'ui' : ''}`,
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
    // exclusive 一并下发：界面要据此把「引擎互斥」的参数置灰并给出理由。
    // 不下发的话 UI 只能硬编码一份副本，那份副本一定会和这里的表漂移。
    if (p === '/api/schema') {
      return send(res, 200, { groups: SCHEMA, defaults: defaultConfig(), exclusive: HIPFIRE_EXCLUSIVE });
    }
    // ⚠️ 必须带 method 检查：这一条排在下面的 POST 分支之前，不加的话
    // POST /api/config 会被这个 GET 处理器吃掉（返回当前配置而不是保存）。
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, loadConfig());
    if (p === '/api/models') return send(res, 200, listModels());
    if (p === '/api/status') return send(res, 200, await status());
    if (p === '/api/log') return send(res, 200, { log: tailLog(Number(url.searchParams.get('tail')) || 150) });
    // 生效诊断。刻意读**整份**日志而不是 tail：`planned VRAM` / `DFlash draft loaded`
    // 这些关键行只在一轮启动时打一次，早被后面几百行 `[serve] +Ns step` 冲走了；
    // 用 tail 会让诊断在长跑之后开始"忘记"引擎已经确认过的事实。
    if (p === '/api/diagnose') {
      let text = '';
      try { text = fs.readFileSync(LOG_FILE, 'utf8'); } catch { /* 还没有日志 */ }
      const facts = parseEngineFacts(text);
      // 日志是**追加**的，跨重启会把上一轮的事实一起带进来；而 running 是当下的。
      // 两者矛盾时以 running 为准，否则"引擎已停"会被上一轮的 listening 行盖掉。
      const st = await status();
      facts.listening = st.running === true;
      return send(res, 200, { rows: effectDiagnostics(loadConfig(), facts), facts, running: st.running === true });
    }
    if (p === '/api/command') return send(res, 200, { command: serverArgsPreview(loadConfig()) });

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, { ok: true, config: saveConfig(body) });
    }

    // 内联护栏：把保存时那一套规则提前给界面用，让用户**边改边知道**，
    // 而不是点了保存才被拒绝。规则只有一处（validateConfig），前端不抄副本 ——
    // 抄一份的结局一定是两边漂移，然后用户看到互相矛盾的两种说法。
    // 预设：列出 / 保存 / 删除。应用（合并进当前配置）放在前端 —— 它要的是
    // "填进表单让我看一眼再保存"，而不是直接落盘，否则用户没法先核对。
    if (p === '/api/presets' && req.method === 'GET') {
      const presets = listPresets().map((x) => ({ ...x, restartCount: presetRestartCount(x) }));
      return send(res, 200, { presets });
    }
    if (p === '/api/presets' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !String(body.name || '').trim()) return send(res, 400, { error: '预设名不能为空' });
      try { savePreset(String(body.name).trim(), body.cfg || loadConfig()); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
      return send(res, 200, { ok: true, presets: listPresets() });
    }
    if (p === '/api/presets/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const okDel = deletePreset(String(body?.name || ''));
      return send(res, 200, { ok: okDel, presets: listPresets() });
    }
    // 配置快照：每次落盘前自动存一份，这里列出与回滚。
    if (p === '/api/snapshots' && req.method === 'GET') {
      return send(res, 200, { snapshots: listSnapshots(), keep: SNAP_KEEP });
    }
    if (p === '/api/snapshots/restore' && req.method === 'POST') {
      const body = await readBody(req);
      try { const cfg = restoreSnapshot(String(body?.file || '')); return send(res, 200, { ok: true, config: cfg }); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }
    if (p === '/api/validate' && req.method === 'POST') {
      const body = await readBody(req);
      const merged = { ...loadConfig(), ...(body || {}) };
      return send(res, 200, { errors: validateConfig(merged) });
    }

    if (p === '/api/apply' && req.method === 'POST') {
      const body = await readBody(req);
      if (body && Object.keys(body).length) saveConfig(body);
      const cfg = loadConfig();
      const port = Number(cfg.port) || 18200;
      const host = probeHost(cfg);
      stopServer();
      await new Promise((r) => setTimeout(r, 2000));
      // 端口被**别的**进程占着时，直接说清楚；否则 waitReady 会安静地空转 180 秒，
      // 用户最后只看到一句"重启失败"。
      if (await portInUse(port, host)) {
        return send(res, 409, { ok: false, error: `端口 ${port} 已被其它进程占用（不是本控制台启动的服务）。先释放它再试。` });
      }
      starting = true;
      let args;
      try { args = startServer(cfg); } catch (e) { starting = false; return send(res, 500, { ok: false, error: e.message }); }
      const ok = await waitReady(port, host);
      starting = false;
      return send(res, 200, { ok, command: serverArgsPreview(cfg), args });
    }

    if (p === '/api/restart' && req.method === 'POST') {
      const cfg = loadConfig();
      const port = Number(cfg.port) || 18200;
      const host = probeHost(cfg);
      stopServer();
      await new Promise((r) => setTimeout(r, 2000));
      if (await portInUse(port, host)) {
        return send(res, 409, { ok: false, error: `端口 ${port} 已被其它进程占用（不是本控制台启动的服务）。先释放它再试。` });
      }
      starting = true;
      try { startServer(cfg); } catch (e) { starting = false; return send(res, 500, { ok: false, error: e.message }); }
      const ok = await waitReady(port, host);
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
      const port = Number(cfg.port) || 18200;
      const host = probeHost(cfg);
      if (await isUp(port, host)) return send(res, 200, { ok: true, note: '已在运行' });
      if (await portInUse(port, host)) {
        return send(res, 409, { ok: false, error: `端口 ${port} 已被其它进程占用（不是本控制台启动的服务）。先释放它再试。` });
      }
      starting = true;
      try { startServer(cfg); } catch (e) { starting = false; return send(res, 500, { ok: false, error: e.message }); }
      const ok = await waitReady(port, host);
      starting = false;
      return send(res, 200, { ok });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      return send(res, 200, { ok: true, config: saveConfig(defaultConfig()) });
    }

    return send(res, 404, { error: '未知接口：' + p });
  } catch (e) {
    // 值域校验失败是**用户的输入问题**（400 + 逐条原因），不是服务端故障（500）。
    // 前端会把这个 error 直接 toast 出来，所以文案必须是给用户看的人话。
    if (e && e.name === 'ConfigError') return send(res, 400, { ok: false, error: e.message, errors: e.errors });
    return send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
// 单元测试开关：置 1 则只加载函数、不起 HTTP 服务、**不注册退出钩子**。
// 这个门必须有：下面的 process.on('exit') 会调 stopServer()，而 stopServer 会
// taskkill 三个进程名 —— 测试进程带着这个副作用跑，会把用户正在用的引擎杀掉。
const NOBOOT = process.env.KVMEM_PANEL_NOBOOT === '1';

if (!NOBOOT) {
// 端口被占用时不要抛未捕获异常（那样控制台会直接闪退，用户只看到窗口关闭）
server.on('error', async (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[错误] 控制台端口 ${CONTROL_PORT} 已被占用。`);
    console.error('');
    const bootCfg = loadConfig();
    const bootHost = probeHost(bootCfg);
    if (await isUp(CHAT_PORT_DEFAULT, bootHost)) {
      console.error('       看起来 KVMem 控制台/服务已经在运行了，无需重复启动。');
      // ⚠️ 这里**不能写 activeEngine(cfg)**：本回调里没有 cfg（它是请求处理器作用域里的
      // 局部量）。写成 cfg 会在端口冲突时抛 ReferenceError —— 本来是要给用户一句
      // "已经在运行了" 的友好提示，结果变成崩溃。实测只在 EADDRINUSE 触发，正常测试
      // 走不到，所以是个很容易漏掉的 bug。
      console.error(`       聊天界面：http://${bootHost}:${CHAT_PORT_DEFAULT}/${activeEngine(bootCfg) === 'hipfire' ? 'ui' : ''}`);
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
  const host = probeHost(cfg);
  const eng = activeEngine(cfg) === 'hipfire' ? 'hipfire' : 'KVMem';
  if (await isUp(port, host)) {
    console.log(`检测到服务已在端口 ${port} 运行，直接接管（不会重复启动）。`);
    return;
  }
  // 端口有主但不是本控制台起的：别去抢，也别空等 180 秒。
  if (await portInUse(port, host)) {
    console.error(`端口 ${port} 已被其它进程占用（不是本控制台启动的服务）。请先释放它，或改配置里的端口。`);
    return;
  }
  console.log(`正在按 config.json 启动 ${eng} 服务...`);
  starting = true;
  try { startServer(cfg); } catch (e) { console.error('启动失败：' + e.message); starting = false; return; }
  const ok = await waitReady(port, host);
  starting = false;
  if (ok) {
    console.log(`${eng} 服务已就绪：http://${host}:${port}/${activeEngine(cfg) === 'hipfire' ? 'ui' : ''}`);
  } else {
    // 把服务端日志的关键行回显到控制台，便于用户直接看到原因
    const lines = tailLog(60).split(/\r?\n/).filter((l) => /error|fail|invalid|out of memory|assert|terminate|too large|unknown configuration/i.test(l));
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
}  // if (!NOBOOT)

// 供 tests/panel-parity.test.mjs 使用。生产路径不会 import 这个模块（它是入口脚本），
// 这些导出对运行时零影响。
export {
  SCHEMA, ALL_PARAMS, defaultConfig, buildArgs, saveConfig, loadConfig, validateConfig,
  parseEngineFacts, effectDiagnostics, VRAM_CLIFF_GIB,
  presetRestartCount, BUILTIN_PRESETS,
  pickHf, HF_MODEL_SLOT_INCOMPATIBLE,
  HIPFIRE_KEY_OWNER, HIPFIRE_EXCLUSIVE, HIPFIRE_KV_MODES, HIPFIRE_SPEC_MODES,
  HIPFIRE_PARAM_IDS, HIPFIRE_PORT_ENV,
  hipfireEmit, hipfireCmd, hipfireLogDirective, hipfireQueueTimeout, serverArgsPreview,
  validateHipfireField, enginePrecheck, activeEngine, engineHost, probeHost,
};
