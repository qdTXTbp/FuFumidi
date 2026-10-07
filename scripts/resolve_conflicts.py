# -*- coding: utf-8 -*-
"""通用冲突块解决器：按块序号应用策略（ours/theirs/union/自定义融合文本）。"""
import io, sys

def load(p):
    return io.open(p, encoding='utf-8', newline='').read()

def split_blocks(src):
    lines = src.splitlines(keepends=True)
    marks = [i for i, l in enumerate(lines) if l.startswith(('<<<<<<<', '=======', '>>>>>>>'))]
    blocks, i = [], 0
    while i < len(marks):
        blocks.append((marks[i], marks[i+1], marks[i+2])); i += 3
    return lines, blocks

def side_lines(lines, b, which):
    s, m, e = b
    seg = lines[s+1:m] if which == 'ours' else lines[m+1:e]
    return [l for l in seg if not l.lstrip().startswith(('<<<<<<<', '=======', '>>>>>>>'))]

def apply(p, strategies):
    """strategies: {block_index: 'ours'|'theirs'|'union'|callable(ours,theirs,CRLF)->[lines]}"""
    src = load(p)
    lines, blocks = split_blocks(src)
    assert len(blocks) == len(strategies), (len(blocks), len(strategies))
    out, prev = [], 0
    for bi, b in enumerate(blocks):
        s, m, e = b
        out.extend(lines[prev:s])
        ours = side_lines(lines, b, 'ours')
        theirs = side_lines(lines, b, 'theirs')
        strat = strategies[bi]
        if callable(strat):
            merged = strat(ours, theirs, lines[s].endswith('\r\n') and '\r\n' or '\n')
        elif strat == 'ours':
            merged = ours
        elif strat == 'theirs':
            merged = theirs
        else:
            merged = ours + theirs
        out.extend(merged)
        prev = e + 1
    out.extend(lines[prev:])
    s2 = ''.join(out)
    assert '<<<<<<<' not in s2 and '>>>>>>>' not in s2, '残留冲突标记'
    io.open(p, 'w', encoding='utf-8', newline='').write(s2)
    return len(blocks)

if __name__ == '__main__':
    p = sys.argv[1]
    strats = [a for a in sys.argv[2:]]
    n = apply(p, strats)
    print('resolved', n, 'blocks:', strats)
