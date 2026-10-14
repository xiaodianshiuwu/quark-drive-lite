import re, os

ROOT = r"C:\Users\USER\Documents\qck\reference\quark_asar\dist"

# 找上传目标：pds / oss / upload_url / bucket 相关主机
pats = [
    (r'pds\.quark\.cn', 'pds.quark.cn'),
    (r'oss-[a-z0-9-]+\.aliyuncs\.com', 'oss-*.aliyuncs.com'),
    (r'upload_url', 'upload_url'),
    (r'uploadUrl', 'uploadUrl'),
    (r'https?://[a-z0-9.-]*\.(?:pds|oss)[a-z0-9.-]*', 'pds/oss 主机'),
]
seen_map = {}
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
        for pat, label in pats:
            for m in re.finditer(pat, t):
                s = m.group(0)
                key = (label, s)
                if key in seen_map:
                    continue
                seen_map[key] = 1
                ctx = t[max(0, m.start() - 200):m.end() + 200].replace("\n", " ")
                print("--- [%s] %s  (%s)" % (label, s, os.path.relpath(p, ROOT)))
                print("    上下文:", ctx[:400])
                print()
