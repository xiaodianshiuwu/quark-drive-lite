#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
第五步：定位待修改的服务名字符串在 quark.dll 中的精确偏移，
并验证"等长替换为无效服务名"这一二进制补丁方案的可行性。

策略：Mojo 服务按名字符串匹配分发。把服务名字符串改成**等长但不会匹配**的
无害名字（例如全改为 'x'），服务查找失败 → 子进程不会被拉起。
不动任何代码字节，只改只读数据段（.rdata）里的字符串，风险最小。

同时打印 PE 头信息确认该偏移所在节区（应位于 .rdata）。
"""
import struct

DLL = r"C:\Users\USER\AppData\Local\Programs\Quark\7.3.5.1009\quark.dll"
BAK = r"C:\Users\USER\Documents\qck\.work\quark.dll.bak"

TARGETS = [
    b"passage_embeddings.mojom.PassageEmbeddingsService\x00",
    b"uc.wpk.mojom.WpkService\x00",
    b"node.quantum.mojom.NodeService\x00",   # 第二个量子进程（若可行）
]

def main():
    data = open(DLL, 'rb').read()
    size_mb = len(data) / 1024 / 1024
    print('DLL: %.1f MB' % size_mb)

    # ---- 解析 PE，列出节区表 ----
    pe_off = struct.unpack('<I', data[0x3C:0x40])[0]
    assert data[pe_off:pe_off + 4] == b'PE\0\0', '不是有效 PE'
    num_sections = struct.unpack('<H', data[pe_off + 6:pe_off + 8])[0]
    opt_size = struct.unpack('<H', data[pe_off + 20:pe_off + 22])[0]
    sec_off = pe_off + 24 + opt_size
    print('\n节区表（%d 个）:' % num_sections)
    sections = []
    for i in range(num_sections):
        s = data[sec_off + i * 40: sec_off + (i + 1) * 40]
        name = s[0:8].rstrip(b'\0').decode('ascii', 'ignore')
        vsize, vaddr, rsize, raddr = struct.unpack('<IIII', s[8:24])
        sections.append((name, vaddr, raddr, rsize))
        chars = struct.unpack('<I', s[36:40])[0]
        print('  %-8s VA=0x%08x  RAW=0x%08x  大小=%.1fMB  特征=0x%08x%s'
              % (name, vaddr, raddr, rsize / 1024 / 1024, chars,
                 '  [可写]' if chars & 0x80000000 else ''))

    def rva_to_off(rva):
        for name, vaddr, raddr, rsize in sections:
            if vaddr <= rva < vaddr + rsize:
                return raddr + (rva - vaddr)
        return None

    # ---- 定位目标字符串的文件偏移 ----
    print('\n目标字符串定位:')
    plan = []
    for tgt in TARGETS:
        # 可能出现多次；全部列出
        positions = []
        start = 0
        while True:
            i = data.find(tgt, start)
            if i < 0:
                break
            positions.append(i)
            start = i + 1
        for pos in positions:
            # 反推 RVA（粗略：用节区映射）
            rva = None
            for name, vaddr, raddr, rsize in sections:
                if raddr <= pos < raddr + rsize:
                    rva = vaddr + (pos - raddr)
                    sec = name
                    break
            print('  %s' % tgt.decode().rstrip('\0'))
            print('    文件偏移 = 0x%08x   RVA = %s   节区 = %s'
                  % (pos, ('0x%08x' % rva) if rva else '?', sec if rva else '?'))
            plan.append((pos, len(tgt), tgt))

    # ---- 备份 ----
    import shutil
    shutil.copy2(DLL, BAK)
    print('\n已备份原 DLL 到: %s' % BAK)

    # ---- 输出补丁方案（先不写入，等确认）----
    print('\n补丁方案（等长替换，不改文件长度）:')
    for pos, ln, tgt in plan:
        name = tgt.decode().rstrip('\0')
        # 等长无害替换：全部换成 'x'，保留结尾 \0
        replacement = b'x' * (ln - 1) + b'\x00'
        print('  偏移 0x%08x: %r' % (pos, name))
        print('      → %r' % replacement.decode().rstrip('\0'))
    print('\n共 %d 处待改。待确认后写入。' % len(plan))

if __name__ == '__main__':
    main()
