"""Extract an Electron app.asar archive (read-only inspection of an installed app)."""
import json, os, struct, sys

ASAR = r"C:\Users\USER\AppData\Local\Programs\Quark\7.3.5.1009\Resources\app.asar"
OUT = r"C:\Users\USER\Documents\qck\reference\quark_asar"

# Electron asar layout:
#   [0:4]   uint32 = 4                     (pickle size-of-size)
#   [4:8]   uint32 = headerPickleSize
#   [8:8+headerPickleSize]  pickle: [0:4] uint32 jsonLen, [4:4+jsonLen] json
#   data starts at 8 + headerPickleSize; file offsets in json are relative to that
with open(ASAR, "rb") as f:
    u0, u1 = struct.unpack("<II", f.read(8))
    header_pickle = f.read(u1)
    # pickle: [0:4] payload size, [4:8] json length, [8:8+json_len] json
    json_len = struct.unpack("<I", header_pickle[4:8])[0]
    header_json = header_pickle[8:8 + json_len].decode("utf-8", "replace")
    data_start = 8 + u1
    tree = json.loads(header_json)
    print(f"asar header: u0={u0} pickle={u1} jsonLen={json_len} dataStart={data_start}")

TEXT_EXT = {".js", ".mjs", ".cjs", ".json", ".jsx", ".ts", ".html", ".css", ".txt", ".md"}
MAX_FILE = 24 * 1024 * 1024

written = []
skipped = []
f = open(ASAR, "rb")


def walk(node, prefix):
    for name, meta in (node.get("files") or {}).items():
        path = prefix + "/" + name
        if "files" in meta:
            walk(meta, path)
            continue
        size = meta.get("size", 0)
        if meta.get("unpacked"):
            skipped.append((path, size, "unpacked"))
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in TEXT_EXT:
            skipped.append((path, size, "ext"))
            continue
        if size > MAX_FILE:
            skipped.append((path, size, "toolarge"))
            continue
        f.seek(data_start + int(meta["offset"]))
        blob = f.read(size)
        dest = os.path.join(OUT, path.lstrip("/").replace("/", os.sep))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as out:
            out.write(blob)
        written.append((path, size))


os.makedirs(OUT, exist_ok=True)
walk(tree, "")

total = sum(s for _, s in written)
print(f"\nwrote {len(written)} files, {total/1024/1024:.1f} MB -> {OUT}")
print(f"skipped {len(skipped)} entries")
big = sorted(written, key=lambda x: -x[1])[:25]
print("\n-- largest extracted --")
for p, s in big:
    print(f"  {s/1024/1024:8.2f} MB  {p}")
print("\n-- top-level --")
for n in sorted((tree.get("files") or {}).keys()):
    print("   ", n)
