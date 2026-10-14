#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
第六步：执行二进制补丁（等长替换 .rdata 中的服务名字符串）。

原理：Chromium Mojo 服务按名字符串精确匹配分发。
把服务名字符串改成等长的无效名后：
  - 客户端请求该服务时找不到注册名 → 服务进程不会被拉起
不改任何代码字节、不改文件长度、不动 PE 结构 → 崩溃风险最小。

补丁前已自动备份原 DLL（.work/quark.dll.bak），可随时还原。
"""
import shutil
import sys

DLL = r"C:\Users\USER\AppData\Local\Programs\Quark\7.3.5.1009\quark.dll"
BAK = r"C:\Users\USER\Documents\qck\.work\quark.dll.bak"

# (偏移, 原始串字节, 说明)
PATCHES = [
    (0x10dcdb78, b"passage_embeddings.mojom.PassageEmbeddingsService\x00", "AI 向量嵌入"),
    (0x10b42df0, b"uc.wpk.mojom.WpkService\x00", "埋点统计"),
    (0x10811178, b"node.quantum.mojom.NodeService\x00", "量子桥"),
]

def main():
    apply_it = '--apply' in sys.argv
    data = bytearray(open(DLL, 'rb').read())
    print('DLL 大小: %.1f MB' % (len(data) / 1024 / 1024))

    changed = 0
    for off, orig, label in PATCHES:
        cur = bytes(data[off:off + len(orig)])
        if cur == orig:
            print('[待改] 0x%08x  %s (%s)' % (off, orig.decode().rstrip(chr(0)), label))
            rep = b'x' * (len(orig) - 1) + b'\x00'
            if apply_it:
                data[off:off + len(orig)] = rep
                changed += 1
                print('        → 已替换为无效名')
        elif cur == b'x' * (len(orig) - 1) + b'\x00':
            print('[已改] 0x%08x  %s（之前已打过补丁）' % (off, label))
        else:
            print('[跳过] 0x%08x  内容与预期不符: %r' % (off, cur[:40]))

    if apply_it and changed:
        open(DLL, 'wb').write(bytes(data))
        print('\n✓ 已写入 %d 处补丁到 quark.dll' % changed)
        print('  原始 DLL 备份: %s' % BAK)
    elif apply_it:
        print('\n无改动（可能已打过补丁）')
    else:
        print('\n（预览模式，加 --apply 才会真正写入）')

if __name__ == '__main__':
    main()
