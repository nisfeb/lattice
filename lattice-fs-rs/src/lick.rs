//! LickTransport: the lick (unix-socket IPC) transport. Same request shape as
//! Eyre — `[verb path query body]` in, `[status body]` out — but over the
//! grubbery lick port instead of HTTP. Auth is filesystem-presence: the socket
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

#[allow(dead_code)]
pub fn num(n: u64) -> Noun {
    Noun::Atom(trim(n.to_le_bytes().to_vec()))
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

/// jam a noun. No backreference compression on write (valid, just non-optimal —
/// the nexus cue handles it); cue below decodes backrefs the nexus may emit.
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
    fn bit(&mut self) -> u8 {
        let byte = self.pos / 8;
        let b = if byte < self.data.len() {
            (self.data[byte] >> (self.pos % 8)) & 1
        } else {
            0
        };
        self.pos += 1;
        b
    }
    fn bits(&mut self, n: usize) -> u64 {
        let mut v = 0u64;
        for i in 0..n {
            v |= (self.bit() as u64) << i;
        }
        v
    }
    fn atom(&mut self, nbits: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; nbits.div_ceil(8)];
        for i in 0..nbits {
            if self.bit() == 1 {
                bytes[i / 8] |= 1 << (i % 8);
            }
        }
        trim(bytes)
    }
}

fn rub(r: &mut BitReader) -> Vec<u8> {
    let mut c = 0usize;
    while r.bit() == 0 {
        c += 1;
    }
    if c == 0 {
        return Vec::new(); // atom 0
    }
    let low = r.bits(c - 1);
    let b = (low | (1u64 << (c - 1))) as usize;
    r.atom(b)
}

pub fn cue(data: &[u8]) -> Result<Noun, TErr> {
    let mut r = BitReader { data, pos: 0 };
    let mut memo: HashMap<usize, Noun> = HashMap::new();
    cue_go(&mut r, &mut memo)
}

fn cue_go(r: &mut BitReader, memo: &mut HashMap<usize, Noun>) -> Result<Noun, TErr> {
    let at = r.pos;
    let n = if r.bit() == 0 {
        Noun::Atom(rub(r))
    } else if r.bit() == 0 {
        let h = cue_go(r, memo)?;
        let t = cue_go(r, memo)?;
        cell(h, t)
    } else {
        let k = rub(r);
        let mut b = [0u8; 8];
        for (i, x) in k.iter().take(8).enumerate() {
            b[i] = *x;
        }
        let idx = u64::from_le_bytes(b) as usize;
        return memo
            .get(&idx)
            .cloned()
            .ok_or_else(|| TErr::new(500, "cue: bad backref"));
    };
    memo.insert(at, n.clone());
    Ok(n)
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
    // framed = [mark payload]; return payload
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
    /// `sock_path` is the pier-relative socket (…/.urb/dev/grubbery/lattice/fs);
    /// `our` is the ship @p (the caller knows it — e.g. from a one-time scry).
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
    // watch: a future enhancement — the nexus can lick-spit change frames on a
    // second port. For now freshness rides the core's TTL poll (no-op default).
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
