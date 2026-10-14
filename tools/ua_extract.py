import re, os, sys

p = r"C:\Users\USER\Documents\qck\reference\quark_asar\dist\main\main.js"
t = open(p, encoding="utf-8", errors="ignore").read()

needles = [
    'quark-cloud-drive/' + '${',
    'QUANTUM_VERSION_FALLBACK',
    'app.isPackaged?"2.5.40"',
    'getBrowserName',
]
for needle in needles:
    print("=" * 90)
    print("NEEDLE:", needle)
    idx = 0
    n = 0
    while n < 4:
        i = t.find(needle, idx)
        if i < 0:
            break
        print("\n--- occurrence #%d (offset %d) ---" % (n, i))
        print(t[max(0, i - 420):i + 420])
        idx = i + len(needle)
        n += 1
    if n == 0:
        print("  (not found)")
