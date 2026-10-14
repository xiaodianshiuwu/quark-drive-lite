import re
p = r"C:\Users\USER\Documents\qck\.work\official_patch_test\dist\renderer\index.js"
t = open(p, encoding='utf-8', errors='ignore').read()

# 侧边栏导航数组：找含多个 {key:..,label/title/name:..,icon:..} 的数组
# 常见形态：[{key:"all",label:"全部文件",icon:...},{key:"recent",...},...]
# 找 "全部文件" 附近 2500 字符，看导航数组结构
for kw in ['全部文件', '"传输列表"', '传输列表', '"回收站"']:
    i = t.find(kw)
    if i < 0:
        continue
    seg = t[max(0, i - 400): i + 2200]
    print("========== 关键词 %r 附近 ==========" % kw)
    # 提取 {..} 项里的 key/label/icon
    items = re.findall(r'\{[^{}]{0,300}?(?:key|id|name|label|title)[^{}]{0,300}?\}', seg)
    for it in items[:20]:
        print("   ITEM:", it.replace(chr(10), ' ')[:220])
    print()
    break
