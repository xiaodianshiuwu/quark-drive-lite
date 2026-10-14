import re, os

ROOT = r"C:\Users\USER\Documents\qck\reference\quark_asar\dist"
FILES = ["renderer/index.js", "main/main.js"]

# 找下载相关的并发/分片常量
pat = re.compile(
    r'(?:DOWNLOAD|Download|download)[A-Za-z_]{0,20}(?:CONCURRENCY|Concurrency|concurrency|PARALLEL|Parallel|'
    r'PART|Part|part|CHUNK|Chunk|chunk|THREAD|Thread|thread)[A-Za-z_]{0,20}\s*[:=]\s*[^,;\n}]{0,40}'
)
pat2 = re.compile(r'(?:concurrency|partSize|part_size|chunkSize|CHUNK_SIZE)\s*[:=]\s*\d{1,7}')
pat3 = re.compile(r'download[A-Za-z]{0,12}\s*[:=]\s*\{[^}]{0,220}\}')

for fn in FILES:
    p = os.path.join(ROOT, fn.replace("/", os.sep))
    if not os.path.exists(p):
        continue
    t = open(p, encoding="utf-8", errors="ignore").read()
    print("=" * 90)
    print("FILE:", fn)
    for label, pp in (("download-concurrency", pat), ("generic-size", pat2), ("download-obj", pat3)):
        seen = set()
        for m in pp.finditer(t):
            s = m.group(0)[:200]
            if s in seen:
                continue
            seen.add(s)
            print(f"  [{label}] {s}")
            if len(seen) >= 8:
                break
