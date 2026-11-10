//  stl.js: OpenSCAD's binary STL, read into what the viewer draws.
//
//  A binary STL is an 80-byte header, a triangle count, then 50 bytes a
//  triangle: a normal and three corners as float32, and two spare bytes.
//  OpenSCAD writes it with --export-format binstl. The normal in the file
//  is not trusted (a zero normal is legal), so each face's is worked out
//  from its corners.

//  past this many triangles a mesh is refused before it reaches WebGL. A
//  million is about 50 MB of STL and draws fine on a laptop. A model that
//  explodes past it (a hostile one, or a $fn of 10000) gets a message.
export const MAX_TRIS = 1000000;

export function parseStl(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 84) return { error: 'the STL is too short' };
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(80, true);
  if (n > MAX_TRIS) return { error: `the part has ${n.toLocaleString()} triangles, more than the viewer draws (${MAX_TRIS.toLocaleString()})`, tris: n };
  if (84 + n * 50 > u8.length) return { error: 'the STL is cut short' };
  const pos = new Float32Array(n * 9);
  const nor = new Float32Array(n * 9);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++) {
      const v = dv.getFloat32(o + k * 4, true);
      pos[t * 9 + k] = v;
      const a = k % 3;
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
    const b = t * 9;
    const ux = pos[b + 3] - pos[b], uy = pos[b + 4] - pos[b + 1], uz = pos[b + 5] - pos[b + 2];
    const vx = pos[b + 6] - pos[b], vy = pos[b + 7] - pos[b + 1], vz = pos[b + 8] - pos[b + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 3; k++) { nor[b + k * 3] = nx; nor[b + k * 3 + 1] = ny; nor[b + k * 3 + 2] = nz; }
  }
  if (!n) return { tris: 0, pos, nor, min: [0, 0, 0], max: [0, 0, 0] };
  return { tris: n, pos, nor, min, max };
}

//  smooth normals: each corner gets the mean of the faces that share its
//  position, unless the faces meet at a sharp edge (over 40 degrees), so a
//  cylinder looks round and a cube keeps its edges
export function smoothNormals(m) {
  const n = m.tris, out = new Float32Array(n * 9);
  const key = (i) => m.pos[i].toFixed(5) + ',' + m.pos[i + 1].toFixed(5) + ',' + m.pos[i + 2].toFixed(5);
  const at = new Map();
  for (let c = 0; c < n * 3; c++) {
    const k = key(c * 3);
    let l = at.get(k);
    if (!l) at.set(k, (l = []));
    l.push(c);
  }
  const cos = Math.cos(40 * Math.PI / 180);
  for (const l of at.values()) {
    for (const c of l) {
      const fx = m.nor[c * 3], fy = m.nor[c * 3 + 1], fz = m.nor[c * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      for (const d of l) {
        const gx = m.nor[d * 3], gy = m.nor[d * 3 + 1], gz = m.nor[d * 3 + 2];
        if (fx * gx + fy * gy + fz * gz >= cos) { sx += gx; sy += gy; sz += gz; }
      }
      const len = Math.hypot(sx, sy, sz) || 1;
      out[c * 3] = sx / len; out[c * 3 + 1] = sy / len; out[c * 3 + 2] = sz / len;
    }
  }
  return out;
}
