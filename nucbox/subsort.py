#!/usr/bin/env python3
"""Sits between AIOStreams and OpenSubtitles V3+ (tv/README.md, nucbox/subsort.container).

Stremio picks the first subtitle in the preferred language, and V3+ returns them in a fixed
order that ignores the file being played (no hash match exists for most debrid files). This puts
the subtitle whose name looks most like the playing file first (same release group, same source:
WEB or BluRay, "Official"/CrunchyRoll for WEB files) and gives pt-BR the code Stremio knows (pob),
since V3+ sends "Portuguese (BR)", which Stremio shows as a blank language.
When Stremio sends the file's hash and OpenSubtitles has a subtitle for that exact file (any
language), its timing is the reference: Portuguese ones are ordered by how close they follow it.

Run: subsort.py [port]   Self-check: subsort.py --test
"""
import bisect
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://opensubtitles.stremio.homes"
HASH_UPSTREAM = "https://opensubtitles-v3.strem.io"
PT = ("por", "pob")
CACHE = {}
UA = {"User-Agent": "subsort/1"}  # the official addon refuses urllib's default agent
SOURCES = {
    "web": ("web", "webrip", "webdl", "amzn", "nf", "cr", "crunchyroll", "dsnp", "hmax", "atvp", "funimation"),
    "bluray": ("bluray", "bd", "bdrip", "brrip", "bdremux"),
    "dvd": ("dvd", "dvdrip"),
    "tv": ("hdtv", "tvrip"),
}


def tokens(name):
    return set(re.findall(r"[a-z0-9]+", name.lower().replace("web-dl", "webdl")))


def source(toks):
    return next((s for s, words in SOURCES.items() if toks & set(words)), None)


def group(name):
    m = re.match(r"\s*\[([^\]]+)\]", name) or re.search(r"-([A-Za-z0-9]+)(?:\[[^\]]*\])?(?:\.\w{2,4})?$", name)
    return m.group(1).lower() if m else None


def score(sub_title, filename):
    st, ft = tokens(sub_title), tokens(filename)
    s = 0
    g = group(filename)
    if g and tokens(g) <= st:
        s += 4
    src = source(ft)
    if src and src == source(st):
        s += 2
    if src == "web" and st & {"official", "crunchyroll"}:
        s += 1
    return s + len(st & ft) / (len(st | ft) or 1)


def fix(subs, filename):
    for sub in subs:
        if sub.get("lang_code") == "pt-br" or sub.get("lang") == "Portuguese (BR)":
            sub["lang"] = "pob"
    if filename:
        subs.sort(key=lambda sub: -score(sub.get("title") or sub.get("id", ""), filename))
    return subs


def hash_subs(path, extras):
    """Subtitles made for this exact file (OpenSubtitles hash, any language), from the official addon."""
    if not extras.get("videoHash"):
        return []
    try:
        url = HASH_UPSTREAM + "/subtitles/" + path.split("/subtitles/", 1)[1]
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=8) as r:
            return [s for s in json.loads(r.read()).get("subtitles", []) if s.get("m") == "h"]
    except Exception:
        return []


def cue_starts(text):
    return sorted(int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
                  for h, m, s, ms in re.findall(r"(?:(\d+):)?(\d\d):(\d\d)[.,](\d{3}) -->", text))


def drift(ref, cues):
    """Mean distance (s) from each cue start to the nearest reference cue, best 80%: 0 = in sync."""
    if len(ref) < 20 or len(cues) < 20:
        return None
    d = sorted(min(abs(x - ref[j]) for j in (i - 1, i) if 0 <= j < len(ref))
               for x in cues for i in [bisect.bisect_left(ref, x)])
    d = d[: int(len(d) * 0.8)]
    return sum(d) / len(d)


def fetch_text(url, deadline=None):
    timeout = max(1, deadline - time.monotonic()) if deadline else 12
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
            return r.read().decode("utf-8", "ignore")
    except Exception:
        return ""


def by_sync(subs, hashed, deadline=None):
    """Portuguese hash matches first, then the Portuguese subtitles ordered by how close their
    timing is to a hash-matched subtitle in another language (the file's own timing)."""
    pt_hash = [{**s, "title": "Hash match " + s.get("subtitleFileName", "")} for s in hashed if s.get("lang") in PT]
    ref_sub = next((s for s in sorted(hashed, key=lambda s: s.get("lang") != "eng") if s.get("lang") not in PT), None)
    if not ref_sub:
        return pt_hash + subs
    pt = [s for s in subs if s.get("lang") in PT][:8]
    with ThreadPoolExecutor(len(pt) + 1) as pool:
        texts = list(pool.map(lambda url: fetch_text(url, deadline), [ref_sub["url"]] + [s["url"] for s in pt]))
    ref = cue_starts(texts[0])
    score = {id(s): drift(ref, cue_starts(t)) for s, t in zip(pt, texts[1:])}
    rank = {id(s): i for i, s in enumerate(subs)}
    subs = sorted(subs, key=lambda s: (score.get(id(s)) is None, score.get(id(s)) or 0, rank[id(s)]))
    for s in pt:
        if score[id(s)] is not None:
            print(f"  drift {score[id(s)]:.2f}s {s.get('title')}", flush=True)
    return pt_hash + subs


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # AIOStreams gives up on the subtitle addon after 20 s: answer within 17
        deadline = time.monotonic() + 17
        try:
            if self.path in CACHE:
                body = CACHE[self.path]
            elif "/subtitles/" in self.path:
                m = re.search(r"/subtitles/[^/]+/[^/]+/([^/]+)\.json$", self.path)
                extras = urllib.parse.parse_qs(urllib.parse.unquote(m.group(1))) if m else {}
                filename = extras.get("filename", [""])[0]
                with ThreadPoolExecutor(2) as pool:
                    hashed = pool.submit(hash_subs, self.path, extras)
                    with urllib.request.urlopen(UPSTREAM + self.path, timeout=15) as r:
                        data = json.loads(r.read())
                    hashed = hashed.result()
                data["subtitles"] = by_sync(fix(data.get("subtitles", []), filename), hashed, deadline)
                first = next((s.get("title") for s in data["subtitles"] if s.get("lang") == "por"), None)
                print(f"{self.path.split('/subtitles/')[1][:40]} file={filename or '-'} "
                      f"hash={extras.get('videoHash', ['-'])[0]} refs={len(hashed)} first_por={first}", flush=True)
                body = json.dumps(data).encode()
                if len(CACHE) > 500:  # ponytail: drop-all cache, an LRU if it ever matters
                    CACHE.clear()
                CACHE[self.path] = body
            else:
                with urllib.request.urlopen(UPSTREAM + self.path, timeout=15) as r:
                    body = r.read()
            self.send_response(200)
        except Exception as e:  # upstream down or bad JSON: AIOStreams shows no subtitles, as before
            body = json.dumps({"subtitles": [], "error": str(e)}).encode()
            self.send_response(502)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def test():
    subs = [
        {"title": "Ataque.dos.Titãs.S04E11.WEBRip", "lang": "por", "lang_code": "pt-pt"},
        {"title": "[Erai-raws] Shingeki no Kyojin - The Final Season - 11 [1080p]", "lang": "Portuguese (BR)", "lang_code": "pt-br"},
        {"title": "Attack.on.Titan.S04E11.CrunchyRoll.Official", "lang": "por", "lang_code": "pt-pt"},
    ]
    out = fix([dict(s) for s in subs], "Attack.On.Titan.S04E11.1080p.WEB.H264-URANiME[eztv.re].mkv")
    assert out[0]["title"].endswith("CrunchyRoll.Official"), out
    assert [s["lang"] for s in out if "Erai" in s["title"]] == ["pob"]
    assert group("[Erai-raws] Shingeki no Kyojin - 11 [1080p].mkv") == "erai-raws"
    assert group("Dune.Part.Two.2024.1080p.BluRay.DDP7.1.x264-MHYSA.mkv") == "mhysa"
    bd = fix([{"title": "Dune.Part.Two.WEB-DL"}, {"title": "Dune.Part.Two.1080p.BluRay-MHYSA"}],
             "Dune.Part.Two.2024.1080p.BluRay.DDP7.1.x264-MHYSA.mkv")
    assert bd[0]["title"].endswith("MHYSA"), bd
    assert fix([{"title": "b"}, {"title": "a"}], "")[0]["title"] == "b"  # no filename: order kept
    assert cue_starts("00:01.500 --> 00:02.000\n1:02:03,250 --> x") == [1.5, 3723.25]
    ref = [i * 3.0 for i in range(100)]
    assert drift(ref, ref) == 0 and abs(drift(ref, [x + 0.9 for x in ref]) - 0.9) < 1e-9
    assert drift(ref, ref[:5]) is None  # too few cues to judge
    assert by_sync([{"title": "x", "lang": "por"}], [])[0]["title"] == "x"  # no hash: unchanged
    print("ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--test"]:
        test()
    else:
        ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if sys.argv[1:] else 11472), Handler).serve_forever()
