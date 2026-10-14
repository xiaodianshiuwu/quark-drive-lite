#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
第一步：从 quark.dll 提取与臃肿服务相关的字符串与功能开关名。

目标进程（要干掉的）：
  - node.quantum.mojom.NodeService        （量子桥，191MB+135MB）
  - uc.media_player.mojom.MediaPlayerService（播放器，32MB）
  - passage_embeddings.mojom.PassageEmbeddingsService（AI 向量，74MB）
  - uc.wpk.mojom.WpkService（埋点，84MB）

方法：
  1. 定位这些服务名字符串在 DLL 中的位置
  2. 提取它们附近的 ASCII 字符串（Chromium 的 base::Feature 名、开关名都是明文）
  3. 找出形如 CamelCase 的 feature 名，供 --disable-features 测试
"""
import re
import sys

DLL = r"C:\Users\USER\AppData\Local\Programs\Quark\7.3.5.1009\quark.dll"
OUT = r"C:\Users\USER\Documents\qck\.work\dll_strings_report.txt"

TARGET_SERVICES = [
    b"node.quantum.mojom.NodeService",
    b"uc.media_player.mojom.MediaPlayerService",
    b"passage_embeddings.mojom.PassageEmbeddingsService",
    b"uc.wpk.mojom.WpkService",
    b"mojom.QuarkNormalFeaturesService",
]

# ASCII 可打印串
ASCII_RE = re.compile(rb'[\x20-\x7e]{6,200}')


def extract_ascii_around(data, pos, radius=3000):
    """取 pos 附近 radius 字节内的所有 ASCII 字符串。"""
    lo = max(0, pos - radius)
    hi = min(len(data), pos + radius)
    seg = data[lo:hi]
    return [m.group(0).decode('ascii', 'ignore') for m in ASCII_RE.finditer(seg)]


def main():
    print('读取 DLL: %s' % DLL)
    with open(DLL, 'rb') as f:
        data = f.read()
    size_mb = len(data) / 1024 / 1024
    print('大小: %.1f MB' % size_mb)

    report = []
    for svc in TARGET_SERVICES:
        positions = []
        start = 0
        while True:
            i = data.find(svc, start)
            if i < 0:
                break
            positions.append(i)
            start = i + 1
            if len(positions) >= 6:
                break
        print('\n===== %s' % svc.decode())
        print('  出现次数(前6): %d 处' % len(positions))
        report.append('\n===== %s =====' % svc.decode())

        for idx, pos in enumerate(positions):
            strs = extract_ascii_around(data, pos)
            # 过滤出像 feature 名 / 开关名的：CamelCase、含 enable/disable、含 Service
            interesting = set()
            for s in strs:
                # feature 名通常是 CamelCase 且不含空格/路径分隔
                if re.fullmatch(r'[A-Z][a-zA-Z0-9_]{5,60}', s):
                    interesting.add(s)
                elif 'disable' in s.lower() or 'enable' in s.lower():
                    if len(s) < 120:
                        interesting.add(s)
                elif s.endswith('Service') or s.endswith('Feature'):
                    interesting.add(s)
            report.append('\n--- 出现点 #%d (offset=%d / 0x%x) ---' % (idx, pos, pos))
            for s in sorted(interesting):
                report.append('   ' + s)
            # 打印到控制台（前几个出现点）
            if idx < 2:
                print('  出现点 #%d (0x%x) 附近特征串 %d 个:' % (idx, pos, len(interesting)))
                for s in sorted(interesting)[:30]:
                    print('     ', s)

    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(report))
    print('\n完整报告: %s' % OUT)


if __name__ == '__main__':
    main()
