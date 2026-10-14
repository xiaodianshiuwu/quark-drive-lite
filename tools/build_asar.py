#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把应用源码打包成 Electron 的 app.asar。

为何自己写：electron-builder 在本机会因解析 pnpm 输出失败（PnpmNodeModulesCollector:
No JSON content found in output）。而本项目主进程**零第三方依赖**（只用 Node 内置模块
+ electron），因此完全可以绕开依赖收集，直接手工组装，更可控。

asar 文件格式（与 Electron 官方一致）：
    偏移 0    : uint32 LE = 4                      (pickle 的 size 字段本身占 4 字节)
    偏移 4    : uint32 LE = header_pickle_size
    偏移 8..  : header_pickle
                 pickle 内: [0:4]   uint32 LE = json_len
                            [4:4+n] json 字符串（UTF-8）
    数据区     : 从 8 + header_pickle_size 开始，各文件按其 offset 顺序拼接

    目录节点: { "files": { <子节点名>: <节点> } }
    文件节点: { "size": N, "offset": M }   # offset 相对数据区起点
"""
import os
import sys
import json
import struct


def build_tree(root, rel=''):
    """构建 asar 目录树，返回 (tree, file_list)；file_list 为 [(abs_path, rel_path)]。"""
    tree = {}
    files = []
    base = os.path.join(root, rel) if rel else root
    for name in sorted(os.listdir(base)):
        if name in ('.git', 'node_modules', 'dist', 'build'):
            continue
        p = os.path.join(base, name)
        r = os.path.join(rel, name) if rel else name
        if os.path.isdir(p):
            sub, subfiles = build_tree(root, r)
            if sub:  # 跳过空目录
                tree[name] = {'files': sub}
                files.extend(subfiles)
        elif os.path.isfile(p):
            tree[name] = {'size': os.path.getsize(p), 'offset': None}  # offset 稍后填
            files.append((p, r))
    return tree, files


def assign_offsets(tree, files):
    """按 files 顺序分配 offset，并写回树中。"""
    off_map = {}
    cur = 0
    for abs_path, rel in files:
        off_map[rel] = cur
        cur += os.path.getsize(abs_path)

    def fill(node, prefix=''):
        for name, meta in node.items():
            p = os.path.join(prefix, name) if prefix else name
            if 'files' in meta:
                fill(meta['files'], p)
            else:
                meta['offset'] = str(off_map[p])  # Electron 规范：offset 为字符串
                meta['size'] = os.path.getsize(os.path.join(SRC_ROOT, p)) if False else meta['size']
    fill(tree)
    return cur


def pack(src_dir, out_asar):
    global SRC_ROOT
    SRC_ROOT = src_dir
    tree, files = build_tree(src_dir)

    # 分配 offset
    off = {}
    cur = 0
    for abs_path, rel in files:
        off[rel] = cur
        cur += os.path.getsize(abs_path)

    def fill(node, prefix=''):
        for name, meta in node.items():
            p = os.path.join(prefix, name) if prefix else name
            if 'files' in meta:
                fill(meta['files'], p)
            else:
                meta['offset'] = str(off[p])
    fill(tree)

    header = {'files': tree}
    json_bytes = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode('utf-8')

    # pickle 内容: [uint32 json_len][json]
    # 注意：文件头还要再包一层 Chromium Pickle 头，共 16 字节 + pickle：
    #   [u0=4][u1=pickle总大小][u2=4+json_len][u3=json_len][pickle]
    # 官方 asar 实测：u0=4, u1=pickle size, u2=4+json_len, u3=json_len
    pickle = struct.pack('<I', len(json_bytes)) + json_bytes
    header_pickle_size = len(pickle)

    with open(out_asar, 'wb') as f:
        f.write(struct.pack('<I', 4))                          # u0
        f.write(struct.pack('<I', header_pickle_size))          # u1 = pickle 大小
        f.write(struct.pack('<I', 4 + len(json_bytes)))         # u2
        f.write(struct.pack('<I', len(json_bytes)))             # u3
        f.write(pickle)
        for abs_path, rel in files:
            with open(abs_path, 'rb') as src:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
    return len(files), cur


if __name__ == '__main__':
    src = sys.argv[1]
    out = sys.argv[2]
    n, size = pack(src, out)
    print('已打包: %s' % out)
    print('  文件数: %d   数据区: %.2f MB   asar 总大小: %.2f MB' % (n, size / 1024 / 1024, os.path.getsize(out) / 1024 / 1024))
