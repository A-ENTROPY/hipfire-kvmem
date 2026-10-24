#!/usr/bin/env python3
# 档位预设的端到端回环：完全照前端 `applyPreset()` 的语义
# （Object.assign(CFG, p.cfg) → 整体 POST），验证：
#   1. 档位键真的改了
#   2. 其余键一个没丢（saveConfig 只写 POST 带的键，直接 POST 预设会洗掉 90 个键）
#   3. 结束时回到质量档，与 config.toml 一致
import json, urllib.request

API = 'http://127.0.0.1:18201/api'


def get(path):
    return json.loads(urllib.request.urlopen(API + path, timeout=20).read())


def post(path, obj):
    req = urllib.request.Request(API + path, data=json.dumps(obj).encode(),
                                 headers={'Content-Type': 'application/json'})
    try:
        return urllib.request.urlopen(req, timeout=20).read().decode()
    except urllib.error.HTTPError as e:
        return 'HTTP %d: %s' % (e.code, e.read().decode()[:300])


def show(tag, c, keys_before):
    ks = set(c)
    miss = keys_before - ks
    print('  %-10s scorer=%-14s alpha=%-4s rows=%-3s window=%-6s sink=%-6s 键数=%d%s' %
          (tag, c.get('hf_kvmem_query_scorer'), c.get('hf_kvmem_graph_alpha'),
           c.get('hf_kvmem_page_softmax_rows'), c.get('hf_kvmem_window_tokens'),
           c.get('hf_kvmem_sink_tokens'), len(ks),
           ('  **丢失键 %d 个: %s**' % (len(miss), sorted(miss)[:5])) if miss else ''))


original = get('/config')
original = original.get('config', original) if isinstance(original, dict) else original
keys_before = set(original)
presets = {p['name']: p for p in get('/presets')['presets']}
print('当前配置键数 = %d\n' % len(original))
show('当前', original, keys_before)

print('\n--- 套用「性能档」（前端语义：合并 + 整体保存）---')
perf = {**original, **presets['性能档']['cfg']}
print('  post →', post('/config', perf)[:80])
after_perf = get('/config'); after_perf = after_perf.get('config', after_perf)
show('性能档', after_perf, keys_before)

print('\n--- 套用「质量档」---')
qual = {**original, **presets['质量档']['cfg']}
print('  post →', post('/config', qual)[:80])
after_q = get('/config'); after_q = after_q.get('config', after_q)
show('质量档', after_q, keys_before)

print('\n--- 与原始配置的差异（质量档应当只差档位键）---')
diff = {k: (original.get(k), after_q.get(k)) for k in keys_before | set(after_q)
        if original.get(k) != after_q.get(k)}
for k, (a, b) in sorted(diff.items()):
    print('  %-34s %r → %r' % (k, a, b))
if not diff:
    print('  完全一致（质量档 = 当前生效配置）')
print('\n最终键数 = %d（起始 %d）' % (len(after_q), len(original)))
