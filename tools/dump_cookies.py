"""Step A (robust): copy cookie DBs to temp, then dump rows + encrypted blobs."""
import sqlite3, os, json, sys, base64, shutil, tempfile


def _connect(db, name):
    """Prefer an immutable read-only handle (works while the browser is running)."""
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True, timeout=5)
        con.execute("SELECT count(*) FROM cookies").fetchone()
        return con, None
    except Exception:
        pass
    tmp = os.path.join(tempfile.gettempdir(), f"ckcopy_{name}.db")
    last = None
    for _ in range(3):
        try:
            shutil.copy2(db, tmp)
            return sqlite3.connect(tmp, timeout=10), tmp
        except Exception as e:
            last = e
    raise RuntimeError(f"cannot open {db}: {last}")


def dump(name, profile_dir):
    db = os.path.join(profile_dir, "Network", "Cookies")
    if not os.path.exists(db):
        return {"error": "no cookies db", "path": db}
    try:
        con, tmp = _connect(db, name)
    except Exception as e:
        return {"error": str(e)}
    rows = con.execute(
        "SELECT host_key,name,value,encrypted_value,path,is_secure,is_httponly,expires_utc FROM cookies"
    ).fetchall()
    con.close()
    if tmp and os.path.exists(tmp):
        os.remove(tmp)
    data = []
    for h, n, v, ev, p, sec, ho, exp in rows:
        data.append({
            "host": h, "name": n, "value": v,
            "enc": base64.b64encode(ev or b"").decode(),
            "path": p, "secure": sec, "httponly": ho, "expires": exp,
        })
    out = os.path.join(tempfile.gettempdir(), f"ck_{name}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return {"count": len(data), "out": out, "snapshot": bool(tmp)}


if __name__ == "__main__":
    with open(sys.argv[1], "r", encoding="utf-8-sig") as fh:
        targets = json.load(fh)
    res = {name: dump(name, prof) for name, prof in targets.items()}
    print(json.dumps(res, ensure_ascii=False, indent=2))
