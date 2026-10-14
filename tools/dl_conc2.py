import re, os

ROOT = r"C:\Users\USER\Documents\qck\reference\quark_asar\dist"
p = os.path.join(ROOT, "renderer", "index.js")
t = open(p, encoding="utf-8", errors="ignore").read()

for needle in ["downloadParallel", "downloadPart", "downloadAtomicity"]:
    print("=" * 90)
    print("NEEDLE:", needle)
    idx = 0
    n = 0
    while n < 5:
        i = t.find(needle, idx)
        if i < 0:
            break
        print("\n--- #%d (offset %d) ---" % (n, i))
        print(t[max(0, i - 500):i + 500].replace("\n", "\\n"))
        idx = i + len(needle)
        n += 1
