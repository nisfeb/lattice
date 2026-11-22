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
  let wild = false;
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++) {
      const v = dv.getFloat32(o + k * 4, true);
      pos[t * 9 + k] = v;
      if (!Number.isFinite(v)) wild = true;
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
  //  cube(1e39) overflows a float32: a part with no bounds is not drawn
  if (wild) return { error: 'the part has no size the viewer can draw: a corner is not a finite number' };
  if (!n) return { tris: 0, pos, nor, min: [0, 0, 0], max: [0, 0, 0] };
  return { tris: n, pos, nor, min, max };
}

//  smooth normals: each corner gets the mean of the faces that share its
//  position, unless the faces meet at a sharp edge (over 40 degrees), so a
//  cylinder looks round and a cube keeps its edges.
//
//  Comparing every corner at a point with every other is quadratic in the
//  faces that meet there, and a cone's apex or a fan-cut cap is met by
//  all of them. So past CROWD corners at one point the faces are first
//  gathered by direction, into the cells of a coarse grid on the sphere,
//  and each corner is compared with the cells: a bounded number, whatever
//  the mesh. `tally.steps`, when asked for, is the comparisons made, for
//  the suite.
const CROWD = 64, GRID = 4;
export function smoothNormals(m, tally) {
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
  let steps = 0;
  for (const l of at.values()) {
    //  what each corner is compared with: the other corners' normals, or
    //  for a crowd the summed normal and the direction of each cell
    let sum, dir;
    if (l.length <= CROWD) {
      sum = dir = new Float32Array(l.length * 3);
      l.forEach((d, j) => { sum[j * 3] = m.nor[d * 3]; sum[j * 3 + 1] = m.nor[d * 3 + 1]; sum[j * 3 + 2] = m.nor[d * 3 + 2]; });
    } else {
      const cells = new Map();
      for (const d of l) {
        const gx = m.nor[d * 3], gy = m.nor[d * 3 + 1], gz = m.nor[d * 3 + 2];
        const k = Math.round(gx * GRID) + ',' + Math.round(gy * GRID) + ',' + Math.round(gz * GRID);
        let cell = cells.get(k);
        if (!cell) cells.set(k, (cell = [0, 0, 0]));
        cell[0] += gx; cell[1] += gy; cell[2] += gz;
      }
      sum = new Float32Array(cells.size * 3);
      dir = new Float32Array(cells.size * 3);
      let j = 0;
      for (const cell of cells.values()) {
        const len = Math.hypot(cell[0], cell[1], cell[2]) || 1;
        for (let a = 0; a < 3; a++) { sum[j * 3 + a] = cell[a]; dir[j * 3 + a] = cell[a] / len; }
        j++;
      }
    }
    const w = sum.length / 3;
    steps += l.length * w;
    for (const c of l) {
      const fx = m.nor[c * 3], fy = m.nor[c * 3 + 1], fz = m.nor[c * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      for (let j = 0; j < w; j++) {
        if (fx * dir[j * 3] + fy * dir[j * 3 + 1] + fz * dir[j * 3 + 2] >= cos) { sx += sum[j * 3]; sy += sum[j * 3 + 1]; sz += sum[j * 3 + 2]; }
      }
      //  no cell within the angle (its own may have a mean a little off):
      //  the face's own normal
      if (!sx && !sy && !sz) { sx = fx; sy = fy; sz = fz; }
      const len = Math.hypot(sx, sy, sz) || 1;
      out[c * 3] = sx / len; out[c * 3 + 1] = sy / len; out[c * 3 + 2] = sz / len;
    }
  }
  if (tally) tally.steps = steps;
  return out;
}
