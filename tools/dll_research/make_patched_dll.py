#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成「补丁版 DLL」到 .work/quark.dll.patched（不直接覆盖官方文件）。

原理：等长替换 .rdata 段中的 Mojo 服务名字符串。
Mojo 按名字符串精确匹配分发，名字失效 → 对应服务进程不被拉起。

补丁目标（DLL 字符串取证确认）：
  - passage_embeddings.mojom.PassageEmbeddingsService  (AI 向量嵌入, 74MB)
  - uc.wpk.mojom.WpkService                            (埋点统计, 78MB)
  - node.quantum.mojom.NodeService                     (量子桥, 191+135MB)
"""
import shutil

DLL = r"C:\Users\USER\AppData\Local\Programs\Quark\7.3.5.1009\quark.dll"
OUT = r"C:\Users\USER\Documents\qck\.work\quark.dll.patched"

PATCHES = [
    (b"passage_embeddings.mojom.PassageEmbeddingsService\x00", "AI 向量嵌入"),
    (b"uc.wpk.mojom.WpkService\x00", "埋点统计"),
    (b"node.quantum.mojom.NodeService\x00", "量子桥"),
]

data = bytearray(open(DLL, 'rb').read())
print('DLL: %.1f MB' % (len(data) / 1024 / 1024))

changed = 0
for orig, label in PATCHES:
    i = bytes(data).find(orig)
    if i < 0:
        # 可能已被补丁过
        rep0 = b'x' * (len(orig) - 1) + b'\x00'
        if bytes(data).find(rep0) >= 0:
            print('[已补] %s' % label)
            changed += 1
            continue
        print('[未找到] %s' % label)
        continue
    rep = b'x' * (len(orig) - 1) + b'\x00'
    data[i:i + len(orig)] = rep
    changed += 1
    print('[已改] %s @0x%08x → 无效名' % (label, i))

open(OUT, 'wb').write(bytes(data))
print('\n✓ 补丁版 DLL 已生成: %s' % OUT)
print('  补丁 %d 处。官方原文件未被改动。' % changed)
