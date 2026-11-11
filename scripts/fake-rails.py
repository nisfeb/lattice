#!/usr/bin/env python3
"""fake-rails.py PORT HOOK_SECRET SHIP_URL
A stand-in for the two rails passes are paid on, for scripts/pass-rails.sh:
Stripe Checkout Sessions (/v1/...) and BTCPay Server invoices
(/api/v1/stores/<store>/invoices). No dependencies, no disk. Modelled on
armillary's fake-stripe.py and fake-btcpay.py, cut to what lattice asks.

The stub routes play the buyer and the rail:
  POST /stub/stripe/pay/<id>     the card is paid; Stripe's webhook goes out
  POST /stub/btcpay/pay/<id>     the invoice settles; a signed webhook goes out
  POST /stub/btcpay/expire/<id>  the invoice expires; a signed webhook goes out
  GET  /stub/state               the store, as json
Webhooks go to SHIP_URL/apps/lattice/hooks/{stripe,btcpay}. BTCPay's is
signed with HOOK_SECRET as BTCPay-Sig: sha256=<hex hmac of the body>.
Threaded, as the ship reads the session back while a webhook is open.
"""
import hashlib, hmac, json, sys, threading, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, SECRET, SHIP = int(sys.argv[1]), sys.argv[2], sys.argv[3].rstrip('/')
STORE = {'sessions': {}, 'invoices': {}, 'n': 0}
LOCK = threading.Lock()


def nid(prefix):
    with LOCK:
        STORE['n'] += 1
        return '%s_%d' % (prefix, STORE['n'])


def hook(rail, payload, heads):
    req = urllib.request.Request('%s/apps/lattice/hooks/%s' % (SHIP, rail),
                                 data=payload, headers=heads, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:                                         # noqa: BLE001
        return 0


def btc_hook(kind, iid):
    body = json.dumps({'type': kind, 'invoiceId': iid}).encode()
    sig = 'sha256=' + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
    return hook('btcpay', body, {'content-type': 'application/json', 'btcpay-sig': sig})


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('content-length') or 0)
        return self.rfile.read(n).decode() if n else ''

    def authed(self, scheme):
        a = self.headers.get('authorization', '')
        return a.lower().startswith(scheme + ' ') and len(a) > len(scheme) + 3

    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p == '/stub/state':
            return self.send(200, STORE)
        if p.startswith('/v1/'):
            if not self.authed('bearer'):
                return self.send(401, {'error': {'message': 'no key'}})
            if p == '/v1/balance':
                return self.send(200, {'object': 'balance', 'livemode': False})
            s = STORE['sessions'].get(p.rsplit('/', 1)[-1])
            return self.send(200, s) if s else self.send(404, {'error': {'message': 'no such session'}})
        if p.startswith('/api/v1/stores/'):
            if not self.authed('token'):
                return self.send(401, {})
            i = STORE['invoices'].get(p.rsplit('/', 1)[-1])
            return self.send(200, {k: v for k, v in i.items() if k != 'checkoutLink'}) if i else self.send(404, {})
        self.send(404, {})

    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        raw = self.body()
        if p == '/v1/checkout/sessions':
            if not self.authed('bearer'):
                return self.send(401, {'error': {'message': 'no key'}})
            f = dict(urllib.parse.parse_qsl(raw))
            sid = nid('cs_test')
            STORE['sessions'][sid] = {
                'id': sid, 'url': 'http://127.0.0.1:%d/stub/stripe/page/%s' % (PORT, sid),
                'payment_status': 'unpaid', 'livemode': False,
                'amount_total': int(f.get('line_items[0][price_data][unit_amount]') or 0),
                'metadata': {'rid': f.get('metadata[rid]', '')},
                'success_url': f.get('success_url', ''),
            }
            return self.send(200, STORE['sessions'][sid])
        if p.startswith('/api/v1/stores/') and p.endswith('/invoices'):
            if not self.authed('token'):
                return self.send(401, {})
            d = json.loads(raw or '{}')
            iid = nid('inv')
            STORE['invoices'][iid] = {
                'id': iid, 'status': 'New', 'amount': d.get('amount', '0'),
                'currency': d.get('currency', ''), 'metadata': d.get('metadata', {}),
                'checkoutLink': 'http://127.0.0.1:%d/stub/btcpay/page/%s' % (PORT, iid),
                'redirectURL': d.get('checkout', {}).get('redirectURL', ''),
            }
            return self.send(200, STORE['invoices'][iid])
        if p.startswith('/stub/stripe/pay/'):
            s = STORE['sessions'].get(p.rsplit('/', 1)[-1])
            if not s:
                return self.send(404, {})
            s['payment_status'] = 'paid'
            st = hook('stripe', json.dumps({'type': 'checkout.session.completed',
                                            'data': {'object': {'id': s['id']}}}).encode(),
                      {'content-type': 'application/json'})
            return self.send(200, {'hook': st, 'return': s['success_url'].replace('{CHECKOUT_SESSION_ID}', s['id'])})
        if p.startswith('/stub/btcpay/'):
            i = STORE['invoices'].get(p.rsplit('/', 1)[-1])
            if not i:
                return self.send(404, {})
            i['status'] = 'Settled' if '/pay/' in p else 'Expired'
            st = btc_hook('InvoiceSettled' if i['status'] == 'Settled' else 'InvoiceExpired', i['id'])
            return self.send(200, {'hook': st, 'return': i['redirectURL']})
        self.send(404, {})


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
