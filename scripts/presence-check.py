#!/usr/bin/env python3
"""Who is on a page, as the ship says it: windows join by opening a stream, one posts
where it is, one says it has left, two stay quiet for two minutes, and one closes its
connection without a word.

A fake ship only. Reads the session cookie from the file COOKIE names and asks the
ship on PORT (8481). Prints each step with its time, to be read by a person. A window
should appear when its stream opens, with no post. A post that changes a place should
reach the other streams within about a tenth of a second. A comment (`:`) should come
every 30 seconds and nothing else while nobody moves. The window that closed without a
word should be gone from the table within about a minute and a half."""
import http.client, threading, time, os, socket, json
PORT = int(os.environ.get('PORT', '8481')); ck = open(os.environ['COOKIE']).read().strip(); t0 = time.perf_counter(); out = []
conns={}
def stream(tag, client):
    c=http.client.HTTPConnection('127.0.0.1',PORT,timeout=200); conns[tag]=c
    c.request('GET','/apps/lattice/presence-stream?page=idle%2Ftest&client='+client,headers={'Cookie':ck,'Accept':'text/event-stream'})
    r=c.getresponse(); out.append((time.perf_counter(),tag,'status %d'%r.status))
    try:
        while True:
            line=r.readline()
            if not line: out.append((time.perf_counter(),tag,'stream ended by the ship')); break
            line=line.decode().rstrip('\n')
            if line and not line.startswith('event'): out.append((time.perf_counter(),tag,line))
    except Exception as e: out.append((time.perf_counter(),tag,'ended: %s'%type(e).__name__))
def post(q):
    c=http.client.HTTPConnection('127.0.0.1',PORT,timeout=30); t=time.perf_counter(); c.request('POST','/apps/lattice/presence?page=idle%2Ftest&'+q,headers={'Cookie':ck}); r=c.getresponse(); r.read(); c.close()
    out.append((t,'POST','%s -> %d'%(q,r.status)))
def names(line):
    try: d=json.loads(line[6:]); return 'seq %d: '%d['seq']+', '.join('%s %s%s'%(x['who'].split('/')[1],x['mode'],(' @'+x['block']) if x['block'] else '') for x in d['here'])
    except Exception: return line
threading.Thread(target=stream,args=('A','a'),daemon=True).start(); time.sleep(1.5)
threading.Thread(target=stream,args=('B','b'),daemon=True).start(); time.sleep(1.5)
post('client=b&mode=edit&block=s2'); time.sleep(1.5)
threading.Thread(target=stream,args=('C','c'),daemon=True).start(); time.sleep(1.5)
post('client=c&mode=gone'); time.sleep(2)                 # C says it left: the ship ends its stream
out.append((time.perf_counter(),'--','two streams open, nothing said for 125 s'))
time.sleep(125)
conns['B'].sock.shutdown(socket.SHUT_RDWR); conns['B'].close()   # B's window vanishes without a word
out.append((time.perf_counter(),'--','B closes its connection, saying nothing'))
time.sleep(125)
for t,tag,line in sorted(out): print('%7.2f %-4s %s'%(t-t0,tag,names(line) if line.startswith('data:') else line[:120]))
