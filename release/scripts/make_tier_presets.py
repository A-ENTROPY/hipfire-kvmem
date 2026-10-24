#!/usr/bin/env python3
# 建两个档位预设：性能档（升级前的余弦档）与质量档（今天的 page-softmax + 图召回）。
# 只放档位相关的键 —— 预设是"合并进当前配置"的语义，塞进温度之类会让换档连带改采样。
import json, os, re, time, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PRESET_DIR = os.path.join(ROOT, 'presets')


def get(url):
    return json.loads(urllib.request.urlopen(url, timeout=15).read())


def walk(o):
    if isinstance(o, dict):
        if isinstance(o.get('id'), str):
            yield o
        for v in o.values():
            yield from walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk(v)


schema = get('http://127.0.0.1:18201/api/schema')
known = {f['id'] for f in walk(schema) if isinstance(f.get('id'), str)}
cfg_now = get('http://127.0.0.1:18201/api/config')
cfg_now = cfg_now.get('config', cfg_now) if isinstance(cfg_now, dict) else cfg_now

# 两档共用的骨架：引擎、多槽、分层、选择策略、保留带 —— 这些与档位无关但必须一致，
# 否则换档时会连带动到窗口之外的东西。
shared = {
    'engine': 'hipfire',
    'hf_multi_slot': cfg_now.get('hf_multi_slot', True),
    'hf_kvmem_tier': cfg_now.get('hf_kvmem_tier', True),
    'hf_kvmem_method': cfg_now.get('hf_kvmem_method', 'retrieval'),
    'hf_kvmem_sink_tokens': cfg_now.get('hf_kvmem_sink_tokens', 16384),
    'hf_kvmem_recent_blocks': cfg_now.get('hf_kvmem_recent_blocks', 8),
}

PERF = dict(shared, **{
    'hf_kvmem_query_scorer': 'meanq-cosine',
    'hf_kvmem_graph_alpha': 0,
    'hf_kvmem_page_softmax_rows': 0,
    'hf_kvmem_window_tokens': 36864,
})
QUALITY = dict(shared, **{
    'hf_kvmem_query_scorer': 'page-softmax',
    'hf_kvmem_graph_alpha': 0.2,
    'hf_kvmem_page_softmax_rows': 0,
    'hf_kvmem_window_tokens': 44032,
})

NOTE_PERF = (
    '【2026-10-23 之前的默认档】meanq-cosine + LRFU + GQA-max（上游 0.18 发布版配置），'
    '窗口 36864 = 288 页，不做图召回。\n'
    '实测（40 轮到 25 万 token）：解码中位 29.9 tok/s、墙钟 24.3 s —— **两档里最快**。\n'
    '代价：历史内容不在窗口里时要靠换页，问旧内容的召回比质量档慢约 38%。\n'
    '耦合：meanq-cosine ⇒ max 聚合 / 开 LRFU / 图传播 α 自动归零（引擎裁决，改 α 无效）。'
)
NOTE_QUALITY = (
    '【2026-10-23 起】page-softmax + 单跳图召回 α=0.2 + 窗口 44032 = 344 页（仍留 137 空槽）。\n'
    '实测（同深度同脚本、只换问题指向）：**问开头（旧内容）12.2 → 19.6 tok/s，+61%**；'
    '浅深度 35.1 → 38.1；代价是深上下文每步多读 13% 的 KV，40 轮解码中位 26.0、墙钟 28.5 s。\n'
    '两档稳定性同量级：40/40 成功、0 退化、0 错误；答案长度差异落在采样噪声内（738 vs 673–774）。\n'
    '耦合：page-softmax ⇒ 均值聚合 / 关 LRFU / α=0.2（α 填 0 在这一档会被解释成 0.2）。'
)


def safe(name):
    return re.sub(r'[^\w\u4e00-\u9fff.-]', '_', name).strip()[:64]


def write(name, note, cfg):
    bad = sorted(set(cfg) - known)
    if bad:
        raise SystemExit('%s 含未知 id：%s' % (name, bad))
    rec = {'name': name, 'note': note,
           'savedAt': time.strftime('%Y-%m-%dT%H:%M:%S+08:00'), 'cfg': cfg}
    path = os.path.join(PRESET_DIR, safe(name) + '.json')
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(rec, fh, ensure_ascii=False, indent=2)
    print('  写入 %-8s -> %s  (%d 项键)' % (name, os.path.basename(path), len(cfg)))


os.makedirs(PRESET_DIR, exist_ok=True)
print('合法 id 共 %d 个' % len(known))
write('性能档', NOTE_PERF, PERF)
write('质量档', NOTE_QUALITY, QUALITY)

listed = get('http://127.0.0.1:18201/api/presets')['presets']
print('\n面板列出的预设：')
for p in listed:
    print('  · %-28s cfg=%d 项  note=%s' %
          (p['name'], len(p.get('cfg') or {}), (p.get('note') or '').split('\n')[0][:40] or '(空)'))
