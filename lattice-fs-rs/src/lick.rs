//! LickTransport: the lick (unix-socket IPC) transport. Same request shape as
//! Eyre (`[verb path query body]` in, `[status body]` out) but over the
//! grubbery lick port instead of HTTP. Auth is filesystem-presence. The socket
//! lives in the pier, so reaching it IS authorization (no cookie, no +code).
//!
//! Wire format (verified against vere 4.5, per gub/man/lick-echo): each frame,
//! both directions, is `0x00` + 4-byte LE length + `jam([mark noun])`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Mutex;

use crate::transport::{TErr, Transport};

// ---------- nouns ----------

#[derive(Clone, Debug, PartialEq)]
pub enum Noun {
    Atom(Vec<u8>), // little-endian, trailing zero bytes trimmed
    Cell(Box<Noun>, Box<Noun>),
}

pub fn cord(s: &str) -> Noun {
    Noun::Atom(trim(s.as_bytes().to_vec()))
}

pub fn cell(h: Noun, t: Noun) -> Noun {
    Noun::Cell(Box::new(h), Box::new(t))
}

impl Noun {
    pub fn as_string(&self) -> String {
        match self {
            Noun::Atom(a) => String::from_utf8_lossy(a).into_owned(),
            _ => String::new(),
        }
    }
    pub fn as_u64(&self) -> u64 {
        match self {
            Noun::Atom(a) => {
                let mut b = [0u8; 8];
                for (i, x) in a.iter().take(8).enumerate() {
                    b[i] = *x;
                }
                u64::from_le_bytes(b)
            }
            _ => 0,
        }
    }
    /// Cell accessors for the fixed reply shape `[status body]`.
    pub fn head(&self) -> Option<&Noun> {
        match self {
            Noun::Cell(h, _) => Some(h),
            _ => None,
        }
    }
    pub fn tail(&self) -> Option<&Noun> {
        match self {
            Noun::Cell(_, t) => Some(t),
            _ => None,
        }
    }
}

fn trim(mut v: Vec<u8>) -> Vec<u8> {
    while v.last() == Some(&0) {
        v.pop();
    }
    v
}

fn bit_len(a: &[u8]) -> usize {
    for i in (0..a.len()).rev() {
        if a[i] != 0 {
            return i * 8 + (8 - a[i].leading_zeros() as usize);
        }
    }
    0
}

// ---------- jam ----------

struct BitWriter {
    buf: Vec<u8>,
    nbits: usize,
}

impl BitWriter {
    fn new() -> Self {
        BitWriter { buf: Vec::new(), nbits: 0 }
    }
    fn bit(&mut self, b: u8) {
        let byte = self.nbits / 8;
        if byte >= self.buf.len() {
            self.buf.push(0);
        }
        if b & 1 == 1 {
            self.buf[byte] |= 1 << (self.nbits % 8);
        }
        self.nbits += 1;
    }
    fn bits(&mut self, val: u64, n: usize) {
        for i in 0..n {
            self.bit(((val >> i) & 1) as u8);
        }
    }
    fn atom_bits(&mut self, a: &[u8], n: usize) {
        for i in 0..n {
            let byte = i / 8;
            let b = if byte < a.len() { (a[byte] >> (i % 8)) & 1 } else { 0 };
            self.bit(b);
        }
    }
}

fn mat(w: &mut BitWriter, a: &[u8]) {
    let b = bit_len(a);
    if b == 0 {
        w.bit(1);
        return;
    }
    let c = 64 - (b as u64).leading_zeros() as usize; // b.bit_length()
    w.bits(1u64 << c, c + 1);
    w.bits((b as u64) & ((1u64 << (c - 1)) - 1), c - 1);
    w.atom_bits(a, b);
}

/// jam a noun. No backreference compression on write (valid, just non-optimal,
/// and the nexus cue handles it). cue below decodes backrefs the nexus may emit.
pub fn jam(n: &Noun) -> Vec<u8> {
    let mut w = BitWriter::new();
    jam_into(&mut w, n);
    if w.buf.is_empty() {
        w.buf.push(0);
    }
    w.buf
}

fn jam_into(w: &mut BitWriter, n: &Noun) {
    match n {
        Noun::Atom(a) => {
            w.bit(0);
            mat(w, a);
        }
        Noun::Cell(h, t) => {
            w.bit(1);
            w.bit(0);
            jam_into(w, h);
            jam_into(w, t);
        }
    }
}

// ---------- cue ----------

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BitReader<'a> {
    fn remaining(&self) -> usize {
        self.data.len() * 8 - self.pos
    }
    /// A read past the end is a truncated/corrupt frame, never a phantom zero
    /// bit. Treating it as zero made `rub`'s zero-run scan loop forever on a
    /// malformed frame (any byte stream, e.g. a single 0x00, hung the mount).
    fn bit(&mut self) -> Result<u8, TErr> {
        if self.pos >= self.data.len() * 8 {
            return Err(TErr::new(500, "cue: truncated stream"));
        }
        let b = (self.data[self.pos / 8] >> (self.pos % 8)) & 1;
        self.pos += 1;
        Ok(b)
    }
    fn bits(&mut self, n: usize) -> Result<u64, TErr> {
        let mut v = 0u64;
        for i in 0..n {
            v |= (self.bit()? as u64) << i;
        }
        Ok(v)
    }
    fn atom(&mut self, nbits: usize) -> Result<Vec<u8>, TErr> {
        let mut bytes = vec![0u8; nbits.div_ceil(8)];
        for i in 0..nbits {
            if self.bit()? == 1 {
                bytes[i / 8] |= 1 << (i % 8);
            }
        }
        Ok(trim(bytes))
    }
}

fn rub(r: &mut BitReader) -> Result<Vec<u8>, TErr> {
    let mut c = 0usize;
    while r.bit()? == 0 {
        c += 1;
    }
    if c == 0 {
        return Ok(Vec::new()); // atom 0
    }
    // c-1 low bits + an implicit top bit encode the atom's bit length. A run
    // past 64 can't name a length that fits in any real frame, and shifting by
    // it overflowed (a panic on a corrupt frame). Same for a length exceeding
    // the bits actually present: it used to allocate for the claim, not the data.
    if c > 64 {
        return Err(TErr::new(500, "cue: atom length overflow"));
    }
    let low = r.bits(c - 1)?;
    let b = (low | (1u64 << (c - 1))) as usize;
    if b > r.remaining() {
        return Err(TErr::new(500, "cue: truncated atom"));
    }
    r.atom(b)
}

pub fn cue(data: &[u8]) -> Result<Noun, TErr> {
    let mut r = BitReader { data, pos: 0 };
    let mut memo: HashMap<usize, Noun> = HashMap::new();
    // An explicit work stack instead of recursion: cells nest as deep as the
    // frame says, and recursing per cell overflowed the thread stack on a
    // deeply nested (or malicious) frame. Combine pops [tail, head] off `done`.
    enum Op {
        Decode,
        Combine(usize),
    }
    let mut ops = vec![Op::Decode];
    let mut done: Vec<Noun> = Vec::new();
    while let Some(op) = ops.pop() {
        match op {
            Op::Decode => {
                let at = r.pos;
                if r.bit()? == 0 {
                    let n = Noun::Atom(rub(&mut r)?);
                    memo.insert(at, n.clone());
                    done.push(n);
                } else if r.bit()? == 0 {
                    ops.push(Op::Combine(at));
                    ops.push(Op::Decode); // tail, decoded second (LIFO)
                    ops.push(Op::Decode); // head, decoded first
                } else {
                    let k = rub(&mut r)?;
                    let mut b = [0u8; 8];
                    for (i, x) in k.iter().take(8).enumerate() {
                        b[i] = *x;
                    }
                    let idx = u64::from_le_bytes(b) as usize;
                    let n = memo
                        .get(&idx)
                        .cloned()
                        .ok_or_else(|| TErr::new(500, "cue: bad backref"))?;
                    done.push(n);
                }
            }
            Op::Combine(at) => {
                let t = done.pop();
                let h = done.pop();
                let (Some(h), Some(t)) = (h, t) else {
                    return Err(TErr::new(500, "cue: bad stream"));
                };
                let n = cell(h, t);
                memo.insert(at, n.clone());
                done.push(n);
            }
        }
    }
    done.pop().ok_or_else(|| TErr::new(500, "cue: empty stream"))
}

// ---------- framing ----------

fn send_frame(sock: &mut UnixStream, mark: &str, noun: &Noun) -> std::io::Result<()> {
    let body = jam(&cell(cord(mark), noun.clone()));
    let mut frame = Vec::with_capacity(5 + body.len());
    frame.push(0u8);
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    sock.write_all(&frame)
}

/// Read one frame, returning the payload noun (strips the outer `[mark noun]`).
fn recv_frame(sock: &mut UnixStream) -> Result<Noun, TErr> {
    let mut hdr = [0u8; 5];
    sock.read_exact(&mut hdr)
        .map_err(|e| TErr::new(0, format!("lick read: {e}")))?;
    if hdr[0] != 0 {
        return Err(TErr::new(500, "lick: bad frame version"));
    }
    let len = u32::from_le_bytes([hdr[1], hdr[2], hdr[3], hdr[4]]) as usize;
    let mut body = vec![0u8; len];
    sock.read_exact(&mut body)
        .map_err(|e| TErr::new(0, format!("lick read body: {e}")))?;
    let framed = cue(&body)?;
    // framed = [mark payload]. Return payload
    framed
        .tail()
        .cloned()
        .ok_or_else(|| TErr::new(500, "lick: frame not a cell"))
}

// ---------- transport ----------

pub struct LickTransport {
    sock_path: String,
    our: String,
    conn: Mutex<Option<UnixStream>>,
}

impl LickTransport {
    /// `sock_path` is the pier-relative socket (…/.urb/dev/grubbery/lattice/fs).
    /// `our` is the ship @p (the caller knows it, e.g. from a one-time scry).
    pub fn new(sock_path: &str, our: &str) -> Self {
        LickTransport {
            sock_path: sock_path.to_string(),
            our: our.to_string(),
            conn: Mutex::new(None),
        }
    }

    /// One request/response round-trip. Reconnects once on a dropped socket.
    fn call(&self, req: &Noun, retry: bool) -> Result<Noun, TErr> {
        let mut guard = self.conn.lock().unwrap();
        if guard.is_none() {
            let s = UnixStream::connect(&self.sock_path)
                .map_err(|e| TErr::new(0, format!("lick connect {}: {e}", self.sock_path)))?;
            //  Without a deadline a nexus that accepts the connection but never
            //  replies wedges the mount FOREVER: this mutex is held across
            //  send+recv, and refresh runs on the FUSE path, so every later
            //  operation queues behind the stuck read. Generous on purpose. A
            //  request can trigger a remote peek, which the nexus bounds at
            //  ~s30, and a loaded pier has been measured answering in ~12s.
            //  This is a wedge-breaker, not a latency budget: on expiry the
            //  caller drops the socket and reconnects once.
            let d = Some(std::time::Duration::from_secs(120));
            let _ = s.set_read_timeout(d);
            let _ = s.set_write_timeout(d);
            *guard = Some(s);
        }
        let sock = guard.as_mut().unwrap();
        let r: Result<Noun, TErr> = (|| {
            send_frame(sock, "req", req).map_err(|e| TErr::new(0, format!("lick send: {e}")))?;
            recv_frame(sock)
        })();
        match r {
            Ok(reply) => Ok(reply),
            Err(_) if retry => {
                *guard = None; // drop + reconnect once
                drop(guard);
                self.call(req, false)
            }
            Err(e) => Err(e),
        }
    }

    /// Build `[verb path query body]` and unpack the `[status body]` reply.
    fn exchange(&self, verb: &str, path: &str, query: &[(&str, &str)], body: &[u8]) -> Result<Vec<u8>, TErr> {
        // The nexus splits the query on raw '&'/'=' (no url-decoding, since page
        // names are @ta and can't contain them). A value carrying either would
        // silently retarget the op (`rm 'a&b.md'` becoming a delete of page `a`),
        // so refuse it here. The server would reject the name anyway.
        if query.iter().any(|(_, v)| v.contains('&') || v.contains('=')) {
            return Err(TErr::new(400, "lick: '&'/'=' not allowed in a page name"));
        }
        let qs = query
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&");
        let req = cell(
            cord(verb),
            cell(cord(path), cell(cord(&qs), Noun::Atom(trim(body.to_vec())))),
        );
        let reply = self.call(&req, true)?;
        let status = reply.head().map(|h| h.as_u64()).unwrap_or(500);
        let rbody = reply.tail().map(|t| t.as_string()).unwrap_or_default();
        if (200..300).contains(&status) {
            Ok(rbody.into_bytes())
        } else {
            Err(TErr::new(status as u16, rbody))
        }
    }
}

impl Transport for LickTransport {
    fn get_bytes(&self, path: &str, query: &[(&str, &str)]) -> Result<Vec<u8>, TErr> {
        self.exchange("GET", path, query, b"")
    }
    fn post(&self, path: &str, query: &[(&str, &str)], body: &[u8]) -> Result<Vec<u8>, TErr> {
        self.exchange("POST", path, query, body)
    }
    fn ship(&self) -> Result<String, TErr> {
        Ok(self.our.clone())
    }
    // watch: a future enhancement. The nexus can lick-spit change frames on a
    // second port. For now freshness rides the core's TTL poll (no-op default).
}

#[cfg(test)]
mod tests {
    use super::*;

    fn num(n: u64) -> Noun {
        Noun::Atom(trim(n.to_le_bytes().to_vec()))
    }

    fn atom(n: u64) -> Noun {
        num(n)
    }

    #[test]
    fn jam_vectors() {
        // verified against gub/man/lick-echo's reference impl
        assert_eq!(jam(&atom(0)), vec![2]);
        assert_eq!(jam(&atom(1)), vec![12]);
        assert_eq!(jam(&cord("a")), vec![240, 48]);
        assert_eq!(jam(&cell(atom(1), atom(1))), vec![49, 3]);
        assert_eq!(
            jam(&cell(cord("req"), cord("hi"))),
            vec![1, 79, 174, 44, 14, 30, 45, 13]
        );
        assert_eq!(
            jam(&cell(cord("GET"), cord("/x"))),
            vec![1, 239, 168, 136, 10, 254, 5, 15]
        );
    }

    #[test]
    fn cue_roundtrips() {
        let cases = vec![
            atom(0),
            atom(1),
            atom(1_000_000),
            cord("hello world"),
            cell(cord("res"), num(200)),
            cell(num(200), cord("# a markdown page\n\nwith body\n")),
            cell(cord("GET"), cell(cord("/apps/lattice/page-tree"), cell(cord(""), cord("")))),
        ];
        for n in cases {
            assert_eq!(cue(&jam(&n)).unwrap(), n, "roundtrip {n:?}");
        }
    }

    #[test]
    fn cue_large_atom() {
        // a KB-scale cord must survive jam/cue (page bodies)
        let big = "x".repeat(4096);
        let n = cell(num(200), cord(&big));
        let back = cue(&jam(&n)).unwrap();
        assert_eq!(back.tail().unwrap().as_string(), big);
    }

    #[test]
    fn cue_rejects_malformed_frames() {
        // each of these was a production defect on a corrupt/hostile frame:
        assert!(cue(&[]).is_err()); // infinite loop (phantom zero bits)
        assert!(cue(&[0x00]).is_err()); // infinite loop in rub's zero-run scan
        let mut long_run = vec![0u8; 9]; // 72 zero bits then ones:
        long_run.push(0xFF); // shift-overflow panic in rub
        assert!(cue(&long_run).is_err());
        // 0x55 = LSB-first bits 1,0,1,0… = an endless nest of cell tags:
        // stack overflow in the recursive cue
        assert!(cue(&vec![0x55; 200_000]).is_err());
    }

    #[test]
    fn lick_query_refuses_metacharacters() {
        // the nexus splits the query on raw '&'/'=', so a name carrying either
        // would silently retarget the op. The guard fires before any I/O.
        let t = LickTransport::new("/nonexistent/lattice/sock", "~zod");
        for bad in ["a&b", "a=b", "x&", "=y"] {
            let e = t.get_bytes("/x", &[("name", bad)]).unwrap_err();
            assert_eq!(e.code, 400, "{bad} must be refused with 400");
        }
    }

    #[test]
    fn frame_roundtrip_over_a_socketpair() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        // recv_frame has no timeout of its own, so give the test one: a frame
        // that never arrives must fail this test, not hang it.
        b.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let n = cell(num(200), cord("# a page body\n"));
        send_frame(&mut a, "res", &n).unwrap();
        assert_eq!(recv_frame(&mut b).unwrap(), n);
        // and a wrong version byte is rejected, not misread as a length
        a.write_all(&[1, 0, 0, 0, 0]).unwrap();
        assert!(recv_frame(&mut b).is_err());
    }

    #[test]
    fn noun_accessors_read_the_reply_shape() {
        // exchange() takes the status from head() and the body from tail(). A
        // status read as 0 (or as a constant) turns a rejected save into a
        // reported success, and the user's bytes are gone.
        let reply = cell(num(404), cord("no such page"));
        assert_eq!(reply.head().unwrap().as_u64(), 404);
        assert_eq!(reply.tail().unwrap().as_string(), "no such page");
        assert_eq!(num(200).as_u64(), 200);
        assert_eq!(num(u64::MAX).as_u64(), u64::MAX);
        assert_eq!(atom(0).as_u64(), 0);
        // an atom has no head/tail, and a cell is neither a number nor a cord
        assert!(atom(7).head().is_none() && atom(7).tail().is_none());
        assert_eq!(cell(num(1), num(2)).as_u64(), 0);
        assert_eq!(cell(num(1), num(2)).as_string(), "");
    }

    #[test]
    fn cue_rejects_an_atom_length_it_cannot_represent() {
        // cue eats bit 0 as the atom/cell tag, so bits 1..=65 are rub's zero
        // run: 65 long, claiming a bit-length that overflows the u64 shift used
        // to rebuild it. That claim must be rejected on its own merits, not
        // merely because the frame also happens to run out of bits.
        let mut frame = vec![0u8; 8]; // bits 0..63 zero
        frame.push(0x04); // bits 64,65 zero; bit 66 = 1  ->  a 65-long run
        frame.extend_from_slice(&[0xFF; 9]); // and plenty of payload behind it
        assert!(cue(&frame).is_err());
    }

    #[test]
    fn lick_reconnects_once_when_the_socket_is_dropped() {
        // the nexus restarts and the pooled connection dies mid-mount. One
        // silent reconnect keeps the mount alive; without it every FUSE op
        // after a ship restart fails until remount.
        let dir = std::env::temp_dir().join(format!("lattice-fs-lick-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fs");
        let l = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        std::thread::spawn(move || {
            let mut it = l.incoming();
            // first connection: read the request, then die without replying
            if let Some(Ok(mut s)) = it.next() {
                s.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
                if let Ok(req) = recv_frame(&mut s) {
                    sink.lock().unwrap().push(req);
                }
            }
            // second and third: answer properly
            for _ in 0..2 {
                if let Some(Ok(mut s)) = it.next() {
                    s.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
                    if let Ok(req) = recv_frame(&mut s) {
                        sink.lock().unwrap().push(req);
                    }
                    let _ = send_frame(&mut s, "res", &cell(num(200), cord("the body")));
                }
            }
        });

        let t = LickTransport::new(path.to_str().unwrap(), "~zod");
        assert_eq!(t.ship().unwrap(), "~zod");
        assert_eq!(t.get_bytes("/apps/lattice/page-source", &[("name", "n")]).unwrap(), b"the body");
        // a POST carries its body over the same exchange
        assert_eq!(t.post("/apps/lattice/page-save", &[("name", "n")], b"# page").unwrap(), b"the body");

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3, "the dropped connection must be retried exactly once");
        let post = &seen[2];
        assert_eq!(post.head().unwrap().as_string(), "POST");
        assert_eq!(post.tail().unwrap().tail().unwrap().tail().unwrap().as_string(), "# page");
        // and the request shape is [verb path query body]
        let q = &seen[1];
        assert_eq!(q.head().unwrap().as_string(), "GET");
        let rest = q.tail().unwrap();
        assert_eq!(rest.head().unwrap().as_string(), "/apps/lattice/page-source");
        assert_eq!(rest.tail().unwrap().head().unwrap().as_string(), "name=n");
        drop(seen);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lick_retries_at_most_once_before_giving_up() {
        // the reconnect is ONE retry, not a loop. A nexus that is down must
        // surface an error; retrying forever would spin holding the connection
        // mutex and wedge every FUSE op behind it.
        let dir = std::env::temp_dir().join(format!("lattice-fs-lick-dead-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fs");
        let l = std::os::unix::net::UnixListener::bind(&path).unwrap();
        // accept and immediately hang up, every time
        std::thread::spawn(move || {
            for s in l.incoming() {
                drop(s);
            }
        });
        let t = LickTransport::new(path.to_str().unwrap(), "~zod");
        let e = t.get_bytes("/x", &[("name", "n")]).unwrap_err();
        assert_ne!(e.code, 400, "not the query guard: a real transport failure");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- property tests ----------

    use proptest::prelude::*;

    fn noun_strategy() -> impl Strategy<Value = Noun> {
        let leaf = proptest::collection::vec(any::<u8>(), 0..48).prop_map(|v| Noun::Atom(trim(v)));
        leaf.prop_recursive(6, 64, 4, |inner| {
            (inner.clone(), inner).prop_map(|(h, t)| cell(h, t))
        })
    }

    proptest! {
        // the round-trip law: every noun survives jam -> cue byte-identically
        #[test]
        fn jam_cue_roundtrip(n in noun_strategy()) {
            prop_assert_eq!(cue(&jam(&n)).unwrap(), n);
        }

        // total on ANY byte string: a corrupt frame may error, never
        // panic, hang, overflow a shift, or overflow the stack
        #[test]
        fn cue_is_total_on_arbitrary_bytes(data in proptest::collection::vec(any::<u8>(), 0..512)) {
            let _ = cue(&data);
        }

        // a name is refused iff it carries a query metacharacter
        #[test]
        fn lick_name_guard_is_exact(name in ".*") {
            let t = LickTransport::new("/nonexistent/lattice/sock", "~zod");
            let e = t.get_bytes("/x", &[("name", &name)]).unwrap_err();
            if name.contains('&') || name.contains('=') {
                prop_assert_eq!(e.code, 400);
            } else {
                // reaches the (dead) socket: a connect error, never the guard
                prop_assert_ne!(e.code, 400);
            }
        }
    }
}
