import re, os

ROOT = r"C:\Users\USER\Documents\qck\reference\quark_asar\dist"

# 找 UC_PARAMS_STR / UC_PARAM_STR 常量的字面值
pat = re.compile(r'UC_PARAMS_STR\s*=\s*["\x27]([^"\x27]{5,200})["\x27]|UC_PARAM_STR\s*=\s*["\x27]([^"\x27]{5,200})["\x27]')

for dp, dn, fns in os.walk(ROOT):
    for fn in fns:
        if not fn.endswith((".js", ".json")):
            continue
        p = os.path.join(dp, fn)
        try:
            if os.path.getsize(p) > 40 * 1024 * 1024:
                continue
            t = open(p, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        for m in pat.finditer(t):
            val = m.group(1) or m.group(2)
            print("文件:", os.path.relpath(p, ROOT))
            print("  值:", val)
            # 打印相邻上下文
            print("  上下文:", t[max(0, m.start() - 150):m.end() + 150].replace("\n", " ")[:400])
            print()
