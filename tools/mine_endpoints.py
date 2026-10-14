"""Mine the extracted Quark PC client JS for API surface evidence."""
import os, re, collections, json, sys

ROOT = r"C:\Users\USER\Documents\qck\reference\quark_asar\dist"
OUT = r"C:\Users\USER\Documents\qck\reference\MINED_ENDPOINTS.md"

PATTERNS = {
    "clouddrive": re.compile(r"/(?:1/)?clouddrive/[A-Za-z0-9_\-/]+"),
    "account": re.compile(r"/account/[A-Za-z0-9_\-/]+"),
    "api_hosts": re.compile(r"https?://[a-zA-Z0-9\.\-]*(?:quark|uc\.cn|aliyuncs|alicdn|myqcloud|pds)[a-zA-Z0-9\.\-]*"),
    "auth_paths": re.compile(r"/(?:oauth|user|passport|login|qrcode|device|token)[A-Za-z0-9_\-/]*"),
    "cookie_names": re.compile(r"__(?:puus|pus|kuus|uus|kp|uid|uidc|itrace_wid|wpkreporterwid_|pu|pc|kp1|kp2)|b-user-id|ctoken|\b_isg\b|isg=|tfstk|_c_WBKFRo|_UP_RI_|broccoli-user-id"),
    "task": re.compile(r"[A-Za-z0-9_]*task[A-Za-z0-9_]*"),
}

hits = {k: collections.Counter() for k in PATTERNS}
where = {k: {} for k in PATTERNS}

for dirpath, dirnames, filenames in os.walk(ROOT):
    for fn in filenames:
        if not fn.endswith((".js", ".mjs", ".cjs", ".json")):
            continue
        fp = os.path.join(dirpath, fn)
        rel = os.path.relpath(fp, ROOT)
        try:
            if os.path.getsize(fp) > 40 * 1024 * 1024:
                continue
            txt = open(fp, "r", encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        for key, pat in PATTERNS.items():
            for m in pat.finditer(txt):
                s = m.group(0)
                hits[key][s] += 1
                if s not in where[key]:
                    where[key][s] = rel

with open(OUT, "w", encoding="utf-8") as f:
    for key in PATTERNS:
        f.write(f"\n## {key}  ({len(hits[key])} distinct)\n\n")
        for s, c in hits[key].most_common(400):
            f.write(f"- `{s}`  x{c}   ← {where[key][s]}\n")

print("wrote", OUT)
for key in PATTERNS:
    print(f"{key}: {len(hits[key])} distinct")
print("\n--- top clouddrive ---")
for s, c in hits["clouddrive"].most_common(120):
    print(f"  {c:5d}  {s}")
