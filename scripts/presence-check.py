#!/usr/bin/env python3
"""Two streams on one page, two windows posting: what each stream is sent and when.

A fake ship only. Reads the session cookie from the file COOKIE names, beside this script
unless it is a whole path, and asks the ship on PORT (8481). Prints each post and each
frame with its time, to be read by a person: a frame should follow a post that changed
something by about a tenth of a second, and a post that changed nothing should send none."""
import http.client, threading, time, os, sys, urllib.parse
D = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('PORT', '8481')); ck = open(os.path.join(D, os.environ.get('COOKIE', 'zod.cookie'))).read().strip()
PAGE = urllib.parse.quote(os.environ.get('PAGE', 'notes/plan'), safe='')
t0 = time.perf_counter()
def stream(tag, out):
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=40)
    c.request('GET', '/apps/lattice/presence-stream?page=' + PAGE, headers={'Cookie': ck, 'Accept': 'text/event-stream'})
    r = c.getresponse(); out.append((time.perf_counter(), tag, 'status %d %s' % (r.status, r.getheader('content-type'))))
    try:
        while True:
            line = r.readline()
            if not line: break
            line = line.decode().rstrip('\n')
            if line: out.append((time.perf_counter(), tag, line))
    except Exception as e:
        out.append((time.perf_counter(), tag, 'ended: %r' % e))
def post(q):
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=30); t = time.perf_counter()
    c.request('POST', '/apps/lattice/presence?page=%s&%s' % (PAGE, q), headers={'Cookie': ck}); r = c.getresponse(); r.read(); c.close()
    return t, r.status, time.perf_counter() - t
if __name__ == '__main__':
    out = []
    for tag in ('s1', 's2'): threading.Thread(target=stream, args=(tag, out), daemon=True).start()
    time.sleep(2)
    steps = [('client=a&mode=read', 1.5), ('client=b&mode=edit&block=s3', 1.5), ('client=b&mode=edit&block=s3', 0.1), ('client=b&mode=edit&block=s4', 2.0), ('client=a&mode=gone', 3.0)]
    for q, wait in steps:
        t, st, dt = post(q); out.append((t, 'POST', '%s -> %d in %.0f ms' % (q, st, dt * 1000))); time.sleep(wait)
    for t, tag, line in sorted(out): print('%7.3f %-4s %s' % (t - t0, tag, line[:230]))
