import re
from collections import Counter
p = r"C:\Users\USER\Documents\qck\.work\official_patch_test\dist\renderer\index.js"
t = open(p, encoding='utf-8', errors='ignore').read()
pairs = re.findall(r'e\.([A-Z][A-Z0-9_]+)="([^"]+)"', t)
seen = set(); out = []
for k, v in pairs:
    if v in seen: continue
    seen.add(v); out.append((k, v))
print("路由/页面枚举（前 90）:")
for k, v in out[:90]:
    print("   %-30s = %s" % (k, v))
