import re, os

ROOT = r"C:\Users\USER\Documents\qck\reference\quark_asar\dist"
FILES = ["renderer/index.js", "main/main.js", "renderer/common-842530.entry.js"]

# 找出 uc_param_str 的值是如何构造的（官方是否携带设备参数）
pats = [
    (r'uc_param_str', 'uc_param_str'),
    (r'_uc_param', '_uc_param'),
    (r'getUcParam\w*', 'getUcParam*'),
    (r'ucParam\w*', 'ucParam*'),
]

for fn in FILES:
    p = os.path.join(ROOT, fn.replace("/", os.sep))
    if not os.path.exists(p):
        continue
    t = open(p, encoding="utf-8", errors="ignore").read()
    for pat, label in pats:
        seen = set()
        for m in re.finditer(pat, t):
            s = t[max(0, m.start() - 260):m.start() + 260].replace("\n", " ")
            key = s[:70]
            if key in seen:
                continue
            seen.add(key)
            print("--- %s [%s] offset=%d" % (fn, label, m.start()))
            print("   ", s[:520])
            if len(seen) >= 4:
                break
