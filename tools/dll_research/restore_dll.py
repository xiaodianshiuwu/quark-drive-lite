#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
还原 quark.dll：把被替换成 'xxx...' 的 3 个服务名字符串恢复为官方原始值。

原始字符串（与补丁时逐字节一致，来源：补丁前取证）：
  0x10dcdb78  passage_embeddings.mojom.PassageEmbeddingsService
  0x10b42df0  uc.wpk.mojom.WpkService
  0x10811178  node.quantum.mojom.NodeService
"""
DLL = r"C:\Users\USER\AppData\Local\Programs\Quark\7.3.5.1009\quark.dll"

RESTORE = [
    (0x10dcdb78, b"passage_embeddings.mojom.PassageEmbeddingsService\x00"),
    (0x10b42df0, b"uc.wpk.mojom.WpkService\x00"),
    (0x10811178, b"node.quantum.mojom.NodeService\x00"),
]

data = bytearray(open(DLL, 'rb').read())
print('DLL: %.1f MB' % (len(data) / 1024 / 1024))

fixed = 0
for off, orig in RESTORE:
    cur = bytes(data[off:off + len(orig)])
    if cur == orig:
        print('[本已正确] 0x%08x %s' % (off, orig.decode().rstrip(chr(0))))
        continue
    # 校验当前内容确实是 x 串（我们的补丁特征），避免误写
    if cur == b'x' * (len(orig) - 1) + b'\x00':
        data[off:off + len(orig)] = orig
        fixed += 1
        print('[已还原] 0x%08x → %s' % (off, orig.decode().rstrip(chr(0))))
    else:
        print('[异常] 0x%08x 当前内容非预期: %r' % (off, cur[:50]))

if fixed:
    open(DLL, 'wb').write(bytes(data))
    print('\n✓ 已还原 %d 处' % fixed)
else:
    print('\n无需改动')

# 校验
verify = open(DLL, 'rb').read()
h = __import__('hashlib').sha256(verify).hexdigest().upper()[:16]
print('还原后 SHA256 前16位: ' + h)
print('官方原版参考        : 47579001A3707413')
print('结果: ' + ('一致 ✓ 完全还原' if h == '47579001A3707413' else '仍不一致 ✗'))
