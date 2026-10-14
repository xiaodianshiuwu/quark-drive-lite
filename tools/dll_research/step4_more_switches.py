import re
p = r"C:\Users\USER\AppData\Local\Programs\Quark\7.3.5.1009\quark.dll"
data = open(p, 'rb').read()

targets = [
    (b'passage_embeddings', 2500),
    (b'PassageEmbeddings', 2500),
    (b'uc.wpk', 2500),
    (b'disable-passage', 1200),
    (b'disable-wpk', 1200),
    (b'disable-embeddings', 1200),
]

ASCII_RE = re.compile(rb'[\x20-\x7e]{5,150}')
seen_global = set()

for tgt, radius in targets:
    positions = []
    start = 0
    while True:
        i = data.find(tgt, start)
        if i < 0 or len(positions) >= 4:
            break
        positions.append(i)
        start = i + 1
    print('===== %s  出现 %d 处' % (tgt.decode(), len(positions)))
    for pos in positions:
        lo = max(0, pos - radius)
        seg = data[lo:pos + radius]
        strs = [m.group(0).decode('ascii', 'ignore') for m in ASCII_RE.finditer(seg)]
        # 只打印像开关的：disable-/enable- 前缀，或含 Service/Feature/Embeddings 的
        for s in strs:
            if s in seen_global:
                continue
            if re.match(r'^(disable|enable)[-_]', s) or re.search(r'(Embeddings|Passage|Wpk|PassageEmbedding)', s):
                seen_global.add(s)
                print('   ', s[:140])
    print()
