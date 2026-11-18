// the web client's own vault.js, run against the same ship, its archive written to a file
import fs from 'node:fs';
const [,, src, url, cookie, out] = process.argv;
const realFetch = globalThis.fetch;
globalThis.window = globalThis;
globalThis.location = { search: '' };
globalThis.fetch = (u, o = {}) => realFetch(url + u, { ...o, headers: { ...(o.headers || {}), cookie, origin: url } });
let blob = null;
globalThis.URL.createObjectURL = (b) => { blob = b; return 'blob:x'; };
globalThis.URL.revokeObjectURL = () => {};
globalThis.document = { createElement: () => ({ click() {} }) };
const st = globalThis.setTimeout; globalThis.setTimeout = (f, ms) => (ms === 30000 ? 0 : st(f, ms));
(0, eval)(fs.readFileSync(src, 'utf8'));
window.LatticeVault.configure({ status: (m) => console.error('web:', m) });
await window.LatticeVault.exportVault();
fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
