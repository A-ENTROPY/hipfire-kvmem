#!/usr/bin/env python3
# 回召对照实验：同一深度下，问"开头的内容"（需要召回很旧、非常驻的页）
# 与问"结尾的内容"（近期、常驻）的 decode 速度对比。
#
# 判据取 server.log 里最后一次 `[serve] decode now`——它是**最近 N 个已提交
# token** 的瞬时速率，不受累计口径污染。
import argparse, json, os, re, time, urllib.request

BASE = 'http://127.0.0.1:18200'
CHAT = BASE + '/v1/chat/completions'
MODELS = BASE + '/v1/models'
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server.log')

FILLER = ("The maintenance subsystem records events with a bounded ring buffer. "
          "Each entry carries a monotonic counter, a subsystem id, and a severity. ") * 12


def msg(round_no, approx_tokens):
    head = "Log excerpt r%d. Read it and answer later.\n\n" % round_no
    body = FILLER * (int(approx_tokens * 2.6) // len(FILLER) + 1)
    return head + body[: int(approx_tokens * 2.6)]


def ask(mid, msgs, max_tokens, label):
    body = json.dumps({'model': mid, 'messages': msgs, 'max_tokens': max_tokens,
                       'temperature': 1.0, 'stream': False,
                       'chat_template_kwargs': {'enable_thinking': False}}).encode()
    req = urllib.request.Request(CHAT, data=body,
                                 headers={'Content-Type': 'application/json'})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=1800) as resp:
        data = json.loads(resp.read())
    wall = time.time() - t0
    u = data.get('usage', {}) or {}
    ans = (data.get('choices') or [{}])[0].get('message', {}).get('content', '') or ''
    # 取日志里最近一次瞬时 decode
    rate, pos = None, None
    try:
        tail = open(LOG, encoding='utf-8', errors='replace').read()[-400000:]
        m = re.findall(r'decode now: ([\d.]+) tok/s over the last \d+ committed tokens', tail)
        p = re.findall(r'max_pos=(\d+)', tail)
        if m: rate = float(m[-1])
        if p: pos = int(p[-1])
    except Exception:
        pass
    print('%-10s wall=%6.1fs prompt=%7d completion=%4d anslen=%5d 深度=%7s decode_now=%s' %
          (label, wall, u.get('prompt_tokens', 0), u.get('completion_tokens', 0),
           len(ans), pos, ('%.1f' % rate) if rate else 'n/a'), flush=True)
    return rate, len(ans)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chunk', type=int, default=20000)
    ap.add_argument('--build', type=int, default=4, help='建深度的轮数')
    ap.add_argument('--asks', type=int, default=2, help='每种问题问几遍')
    ap.add_argument('--max-tokens', type=int, default=320)
    a = ap.parse_args()

    mid = json.loads(urllib.request.urlopen(MODELS, timeout=15).read())['data'][0]['id']
    msgs = [{'role': 'system', 'content': 'You are a precise engineering assistant.'}]

    print('=== 建深度 %d × %d token ===' % (a.build, a.chunk), flush=True)
    for r in range(a.build):
        msgs.append({'role': 'user', 'content': msg(r + 1, a.chunk)})
        ask(mid, msgs, 16, 'build%d' % (r + 1))

    old, new = [], []
    for i in range(a.asks):
        # 问第一轮的内容（很旧，肯定不在常驻窗口里）
        msgs.append({'role': 'user', 'content':
                     'In at least 180 words, recount in detail every distinct fact you can recall '
                     'from the FIRST log excerpt you were given, including its exact opening sentence.'})
        r1, l1 = ask(mid, msgs, a.max_tokens, 'ask-OLD%d' % (i + 1))
        if r1: old.append(r1)
        # 问最后一轮的内容（近期，常驻）
        msgs.append({'role': 'user', 'content':
                     'In at least 180 words, recount in detail every distinct fact you can recall '
                     'from the MOST RECENT log excerpt you were given, including its exact opening sentence.'})
        r2, l2 = ask(mid, msgs, a.max_tokens, 'ask-NEW%d' % (i + 1))
        if r2: new.append(r2)

    if old and new:
        import statistics as st
        print('\n=== 对照 ===')
        print('  问开头(旧内容, 非常驻): decode 中位 %.1f tok/s  n=%d' % (st.median(old), len(old)))
        print('  问结尾(近期, 常驻):     decode 中位 %.1f tok/s  n=%d' % (st.median(new), len(new)))
        print('  比值 新/旧 = %.2f' % (st.median(new) / max(st.median(old), 0.01)))


if __name__ == '__main__':
    main()
