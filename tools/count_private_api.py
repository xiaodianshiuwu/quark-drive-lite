import re, os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "reference" / "quark_asar" / "dist"
if not ROOT.is_dir():
    raise SystemExit(f"未找到官方解包材料：{ROOT}")

# 只存在于官方定制环境里的私有/原生 API
pats = {
    "quantum.<x>": re.compile(r'\bquantum\s*\.\s*[A-Za-z_$][\w$]*'),
    "chrome.<private>": re.compile(r'\bchrome\s*\.\s*(?:quark|quantum)[A-Za-z]*\s*\.\s*[A-Za-z_$][\w$]*'),
    "chrome.account": re.compile(r'\bchrome\s*\.\s*account\b'),
    "process.quantum<X>": re.compile(r'\bprocess\s*\.\s*quantum[A-Za-z]*'),
    "netLib/unet": re.compile(r'\b(?:unet|netLib)\b'),
    "xdrive": re.compile(r'\bxdrive\b'),
}

total = {}
files_scanned = 0
for dp, dn, fns in os.walk(ROOT):
    for fn in fns:
        if not fn.endswith((".js", ".mjs", ".cjs")):
            continue
        p = os.path.join(dp, fn)
        try:
            if os.path.getsize(p) > 40 * 1024 * 1024:
                continue
            t = open(p, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        files_scanned += 1
        for k, pat in pats.items():
            n = len(pat.findall(t))
            total[k] = total.get(k, 0) + n

print("扫描 JS 文件数:", files_scanned)
print("\n私有/原生 API 调用计数：")
grand = 0
for k, v in sorted(total.items(), key=lambda x: -x[1]):
    print(f"  {k:<20} {v:>8,}")
    grand += v
print(f"\n  合计                {grand:>8,}")
