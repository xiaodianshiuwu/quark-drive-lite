"""Print context around needles found in the extracted Quark client JS."""
import os, re, sys, json

ROOT = r"C:\Users\USER\Documents\qck\reference\quark_asar\dist"
FILES = [
    "renderer/index.js",
    "renderer/common-842530.entry.js",
    "main/main.js",
]


def load(rel):
    p = os.path.join(ROOT, rel.replace("/", os.sep))
    if not os.path.exists(p):
        return None
    return open(p, "r", encoding="utf-8", errors="ignore").read()


def ctx(txt, needle, before=300, after=700, limit=3):
    out = []
    start = 0
    while len(out) < limit:
        i = txt.find(needle, start)
        if i < 0:
            break
        s = max(0, i - before)
        e = min(len(txt), i + len(needle) + after)
        out.append(txt[s:e])
        start = i + len(needle)
    return out


if len(sys.argv) > 1:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        NEEDLES = [ln.strip() for ln in fh if ln.strip()]
else:
    NEEDLES = []

cache = {}
for rel in FILES:
    t = load(rel)
    if t:
        cache[rel] = t
        print(f"# loaded {rel} ({len(t)} chars)")

for needle in NEEDLES:
    print("\n" + "=" * 100)
    print(f"### NEEDLE: {needle}")
    print("=" * 100)
    found = False
    for rel, txt in cache.items():
        for i, c in enumerate(ctx(txt, needle)):
            found = True
            print(f"\n--- {rel} #{i} ---")
            print(c.replace("\n", "\\n"))
    if not found:
        print("  (not found)")
