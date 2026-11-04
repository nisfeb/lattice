#!/usr/bin/env python3
"""Build an ivory pill for `vere eval` from a ship's arvo sources.

vere embeds the ivory pill that `vere eval` runs, and urbit's
bin/ivory.pill has not been rebuilt since hoon 137: its zuse has no
checksum, no cric:crypto, and grubbery's libs do not build on it. This
makes a pill from a newer sys/ (408k-2 in CI) so hoon-build-check.py
compiles against what ships run. vere built with it (ivory.c from
--c) starts `vere eval` on that kernel.

It is +ivory in urbit's lib/pill.hoon, run in the stock `vere eval`
instead of a ship's dojo, with two differences. Only the new hoon.hoon
is compiled by the old (137) compiler: every later layer, and hoon.hoon
again, is compiled by the new one, as at boot. And the runtime lib is
the eval interface at the tail of lib/vere.hoon alone: eval needs
+wish, not +dawn, so the ethereum and azimuth libs stay out.

usage: ivory-pill.py --sys SYS --out PILL [--c IVORY_C]

SYS is an arvo pkg/arvo/sys/. The stock vere binary is $VERE, else the
newest ~/software/vere-*-linux-x86_64.
"""
import argparse, glob, os, re, subprocess, sys, time

#  lib/vere.hoon's tail: +wish at axis 10, where vere's lite boot
#  looks for it. Compiled against ..zuse.
STUB = '''=/  pit  !>(.)
=>  |%
    ++  load  _[~ ..load]                                   ::   +4
    ++  peek  _~                                            ::  +22
    ++  poke  _[~ ..poke]                                   ::  +23
    ++  wish                                                ::  +10
      |=  txt=*
      q:(slap pit (ream ;;(@t txt)))
    --
|=(* .(+> +:(poke +<)))
'''


def find_vere():
    if os.environ.get('VERE'):
        return os.environ['VERE']
    found = sorted(glob.glob(os.path.expanduser('~/software/vere-*-linux-x86_64')),
                   key=lambda p: [int(x) for x in re.findall(r'\d+', os.path.basename(p))])
    if not found:
        sys.exit('ivory-pill: no vere binary: set VERE=/path/to/vere')
    return found[-1]


def cord(data):
    """bytes as a Hoon cord literal"""
    out = bytearray(b"'")
    for b in data:
        if b == 0x5c:
            out += b'\\\\'
        elif b == 0x27:
            out += b"\\'"
        elif b < 32 or b == 127:
            out += b'\\%02x' % b
        else:
            out.append(b)
    return bytes(out + b"'")


def generate(sys_dir):
    src = {f: open(os.path.join(sys_dir, f + '.hoon'), 'rb').read()
           for f in ('hoon', 'arvo', 'lull', 'zuse')}
    #  the new hoon.hoon, compiled by the old, is the subject: its
    #  +swat and +rain compile the rest
    out = [b'=>\n', src['hoon'], b'\n=>  ..ride\n']
    for f in ('hoon', 'arvo', 'lull', 'zuse'):
        out.append(f'=/  src-{f}  '.encode() + cord(src[f]) + b'\n')
    out.append(b'=/  src-stub  ' + cord(STUB.encode()) + b'\n')
    out.append(b'''=/  ver=(trap vase)
  =/  sub  *(trap vase)
  =.  sub  ~>  %slog.[0 leaf+"ivory: hoon"]  (swat sub (rain /sys/hoon/hoon src-hoon))
  =.  sub  ~>  %slog.[0 leaf+"ivory: arvo"]  (swat sub (rain /sys/arvo/hoon src-arvo))
  =.  sub  ~>  %slog.[0 leaf+"ivory: lull"]  (swat sub (rain /sys/lull/hoon src-lull))
  =.  sub  ~>  %slog.[0 leaf+"ivory: zuse"]  (swat sub (rain /sys/zuse/hoon src-zuse))
  (swat sub (rain /lib/vere/hoon src-stub))
=/  nok  !.
  =>  *[ver=(trap vase) ~]
  !=  q:$:ver
[%ivory nok ver ~]
''')
    return b''.join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--sys', required=True, help='an arvo sys/ directory')
    ap.add_argument('--out', required=True, help='the pill to write')
    ap.add_argument('--c', help="also write vere's pkg/vere/ivory/ivory.c here")
    a = ap.parse_args()
    start = time.time()
    #  eval exits without draining its stdout writes, so a pipe gets the
    #  first 64k of the jam. A regular file takes it all at once.
    tmp = a.out + '.newt'
    with open(tmp, 'wb') as f:
        r = subprocess.run([find_vere(), 'eval', '-jn'], input=generate(a.sys),
                           stdout=f, stderr=subprocess.PIPE)
    err = re.sub(r'\x1b\[[0-9;]*m', '', r.stderr.decode(errors='replace'))
    #  vere's k.135 jet tree is missing a few parents: noise, not news
    sys.stderr.write(''.join(l + '\n' for l in err.splitlines()
                             if not l.startswith('fund: ')))
    #  -n frames the jam: a version byte, then its length, 4 bytes LE
    o = open(tmp, 'rb').read()
    os.remove(tmp)
    if len(o) < 5 or o[0] != 0 or int.from_bytes(o[1:5], 'little') != len(o) - 5:
        sys.exit(f'ivory-pill: no pill from vere eval ({len(o)} bytes out)')
    pill = o[5:]
    open(a.out, 'wb').write(pill)
    if a.c:
        with open(a.c, 'w') as c:
            c.write('#include "ivory.h"\nunsigned char u3_Ivory_pill[] = {\n')
            for i in range(0, len(pill), 16):
                c.write(' ' + ''.join('0x%02x,' % x for x in pill[i:i + 16]) + '\n')
            c.write('};\nunsigned int u3_Ivory_pill_len = %d;\n' % len(pill))
    print(f'ivory-pill: {len(pill)} bytes, {time.time() - start:.0f}s in vere eval')


main()
