#!/usr/bin/env python3
"""Edits Caddyfile text, reading the new block from stdin.

  caddy_edit.py site SRC DST NAME   replace or add `@NAME host ...` + `handle @NAME {...}` (tab-indented,
                                    inside the wildcard site), before the catch-all `handle {`
  caddy_edit.py security SRC DST    replace or add the `security {...}` block in the global options
"""
import re
import sys


def block_end(text, start):
    depth = 0
    for i in range(text.index('{', start), len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return text.index('\n', i) + 1
    sys.exit('unbalanced braces')


def put_site(src, name, block):
    m = re.search(rf'^\t@{re.escape(name)} host [^\n]*\n', src, re.M)
    if m:
        h = re.search(rf'^\thandle @{re.escape(name)} \{{', src[m.end():], re.M)
        if not h:
            sys.exit(f'found `@{name} host` without its `handle @{name}`: fix the Caddyfile by hand')
        return src[:m.start()] + block + src[block_end(src, m.end() + h.start()):]
    c = re.search(r'^\thandle \{', src, re.M)
    if not c:
        sys.exit(f'no catch-all handle to put {name} before')
    return src[:c.start()] + block + '\n' + src[c.start():]


def put_security(src, block):
    m = re.match(r'(?:[ \t]*(?:#[^\n]*)?\n)*(\{)', src)
    if not m:
        src = '{\n}\n\n' + src
        m = re.match(r'\{', src)
    g0 = m.end(m.lastindex or 0) - 1
    g1 = block_end(src, g0)
    glob = src[g0:g1]
    m = re.search(r'^\tsecurity \{', glob, re.M)
    if m:
        glob = glob[:m.start()] + block + glob[block_end(glob, m.start()):]
    else:
        glob = glob[:glob.rindex('}')] + block + glob[glob.rindex('}'):]
    return src[:g0] + glob + src[g1:]


if __name__ == '__main__':
    kind, src_path, dst_path, *rest = sys.argv[1:]
    src, block = open(src_path).read(), sys.stdin.read()
    out = put_site(src, rest[0], block) if kind == 'site' else put_security(src, block)
    open(dst_path, 'w').write(out)
