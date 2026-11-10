//  viewer.js: a small WebGL viewer for one mesh. No three.js: orbit, pan,
//  zoom, fit to view, a millimetre grid on the build plate, flat or smooth
//  shading, and a PNG of the view. OpenSCAD is Z up, and so is this.
//
//  Mouse: drag to orbit, right drag or shift drag to pan, wheel to zoom,
//  double click to fit. Touch: one finger orbits, two pan and pinch.

import { smoothNormals } from './stl.js';

const VS = `attribute vec3 p;attribute vec3 n;uniform mat4 mvp;uniform mat4 mv;varying vec3 vn;varying vec3 vp;
void main(){vn=mat3(mv)*n;vp=(mv*vec4(p,1.0)).xyz;gl_Position=mvp*vec4(p,1.0);}`;
const FS = `precision mediump float;varying vec3 vn;varying vec3 vp;uniform vec3 col;
void main(){vec3 N=normalize(vn);if(!gl_FrontFacing)N=-N;vec3 L=normalize(vec3(0.4,0.6,1.0));vec3 V=normalize(-vp);
float d=max(dot(N,L),0.0);float s=pow(max(dot(N,normalize(L+V)),0.0),40.0)*0.25;float r=0.35+0.65*max(dot(N,normalize(vec3(-0.5,-0.3,0.4))),0.0)*0.3;
gl_FragColor=vec4(col*(0.32+0.68*d)+col*r*0.2+vec3(s),1.0);}`;
const LVS = `attribute vec3 p;uniform mat4 mvp;void main(){gl_Position=mvp*vec4(p,1.0);}`;
const LFS = `precision mediump float;uniform vec4 col;void main(){gl_FragColor=col;}`;

//  column-major 4x4 helpers
const mul = (a, b) => {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    o[i * 4 + j] = s;
  }
  return o;
};
const persp = (fov, asp, near, far) => {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([f / asp, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
};
const lookAt = (e, c, up) => {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
};

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(t);
    gl.shaderSource(sh, s); gl.compileShader(sh);
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  return p;
}

export function makeViewer(canvas, { onChange } = {}) {
  const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: false })
    || canvas.getContext('experimental-webgl');
  if (!gl) return null;
  const P = program(gl, VS, FS), L = program(gl, LVS, LFS);
  const buf = { p: gl.createBuffer(), n: gl.createBuffer(), g: gl.createBuffer() };
  let mesh = null, count = 0, gridCount = 0, axisAt = 0, smooth = false, smoothNor = null;
  //  the camera: spherical about a target
  const cam = { th: -Math.PI / 4, ph: Math.PI / 3.2, r: 100, t: [0, 0, 0] };
  let dark = false, raf = 0, lost = false;

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });

  function grid(m) {
    //  a plate a bit past the part, in 10 mm squares, with 1 mm lines when
    //  the part is small
    const span = Math.max(m ? Math.max(m.max[0] - m.min[0], m.max[1] - m.min[1]) : 50, 10);
    const step = span < 30 ? 1 : span < 300 ? 10 : 100;
    const half = Math.ceil((span * 0.75 + step) / step) * step;
    const cx = m ? Math.round((m.min[0] + m.max[0]) / 2 / step) * step : 0;
    const cy = m ? Math.round((m.min[1] + m.max[1]) / 2 / step) * step : 0;
    const v = [];
    for (let x = -half; x <= half + 1e-9; x += step) v.push(cx + x, cy - half, 0, cx + x, cy + half, 0);
    for (let y = -half; y <= half + 1e-9; y += step) v.push(cx - half, cy + y, 0, cx + half, cy + y, 0);
    axisAt = v.length / 3;
    v.push(0, 0, 0, half / 2, 0, 0, 0, 0, 0, 0, half / 2, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.g);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gridCount = v.length / 3;
  }
  grid(null);

  function fit() {
    if (!mesh || !mesh.tris) { cam.t = [0, 0, 0]; cam.r = 100; return draw(); }
    const c = [0, 1, 2].map((a) => (mesh.min[a] + mesh.max[a]) / 2);
    const rad = Math.hypot(mesh.max[0] - mesh.min[0], mesh.max[1] - mesh.min[1], mesh.max[2] - mesh.min[2]) / 2 || 10;
    cam.t = c;
    cam.r = rad / Math.sin(Math.PI / 8) * 1.05;
    draw();
  }

  function setMesh(m, { keepView } = {}) {
    const first = !mesh;
    mesh = m; smoothNor = null;
    count = m.tris * 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.p);
    gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
    upNormals();
    grid(m);
    if (first || !keepView) fit(); else draw();
  }
  function upNormals() {
    if (!mesh) return;
    let n = mesh.nor;
    if (smooth && mesh.tris <= 300000) n = smoothNor || (smoothNor = smoothNormals(mesh));
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.n);
    gl.bufferData(gl.ARRAY_BUFFER, n, gl.STATIC_DRAW);
  }

  function frame() {
    raf = 0;
    if (lost) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    const bg = dark ? [0.11, 0.11, 0.12] : [0.96, 0.96, 0.95];
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const e = [cam.t[0] + cam.r * Math.sin(cam.ph) * Math.cos(cam.th), cam.t[1] + cam.r * Math.sin(cam.ph) * Math.sin(cam.th), cam.t[2] + cam.r * Math.cos(cam.ph)];
    const mv = lookAt(e, cam.t, [0, 0, 1]);
    const pr = persp(Math.PI / 4, w / h, Math.max(cam.r / 1000, 0.01), cam.r * 20 + 1000);
    const mvp = mul(pr, mv);
    //  the plate, then the part
    gl.useProgram(L);
    gl.uniformMatrix4fv(gl.getUniformLocation(L, 'mvp'), false, mvp);
    const lp = gl.getAttribLocation(L, 'p');
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.g);
    gl.enableVertexAttribArray(lp);
    gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0);
    gl.uniform4fv(gl.getUniformLocation(L, 'col'), dark ? [1, 1, 1, 0.13] : [0, 0, 0, 0.12]);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.LINES, 0, axisAt);
    gl.uniform4fv(gl.getUniformLocation(L, 'col'), [0.85, 0.25, 0.2, 0.9]);
    gl.drawArrays(gl.LINES, axisAt, 2);
    gl.uniform4fv(gl.getUniformLocation(L, 'col'), [0.25, 0.65, 0.3, 0.9]);
    gl.drawArrays(gl.LINES, axisAt + 2, 2);
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(lp);
    if (count) {
      gl.useProgram(P);
      gl.uniformMatrix4fv(gl.getUniformLocation(P, 'mvp'), false, mvp);
      gl.uniformMatrix4fv(gl.getUniformLocation(P, 'mv'), false, mv);
      gl.uniform3fv(gl.getUniformLocation(P, 'col'), dark ? [0.95, 0.8, 0.35] : [0.93, 0.72, 0.2]);
      const ap = gl.getAttribLocation(P, 'p'), an = gl.getAttribLocation(P, 'n');
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.p);
      gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.n);
      gl.enableVertexAttribArray(an); gl.vertexAttribPointer(an, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, count);
      gl.disableVertexAttribArray(ap); gl.disableVertexAttribArray(an);
    }
    if (onChange) onChange();
  }
  function draw() { if (!raf) raf = requestAnimationFrame(frame); }

  //  ── input ──
  const pts = new Map();
  let last = null;
  const orbit = (dx, dy) => {
    cam.th -= dx * 0.008;
    cam.ph = Math.min(Math.PI - 0.01, Math.max(0.01, cam.ph - dy * 0.008));
  };
  const pan = (dx, dy) => {
    const s = cam.r * 0.0016;
    const rx = -Math.sin(cam.th), ry = Math.cos(cam.th);
    const ux = -Math.cos(cam.ph) * Math.cos(cam.th), uy = -Math.cos(cam.ph) * Math.sin(cam.th), uz = Math.sin(cam.ph);
    cam.t = [cam.t[0] - (dx * rx - dy * ux) * s, cam.t[1] - (dx * ry - dy * uy) * s, cam.t[2] + dy * uz * s];
  };
  canvas.style.touchAction = 'none';
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button, s: e.shiftKey });
    last = null;
  });
  const up = (e) => { pts.delete(e.pointerId); last = null; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (pts.size === 1) {
      if (p.b === 2 || p.s || e.buttons === 4) pan(dx, dy); else orbit(dx, dy);
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const d1 = Math.hypot(a.x - b.x, a.y - b.y);
      if (last !== null && d0 > 0) cam.r = Math.max(0.1, cam.r * d0 / d1);
      last = d1;
      pan(dx / 2, dy / 2);
      draw();
      return;
    }
    p.x = e.clientX; p.y = e.clientY;
    draw();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.r = Math.max(0.1, cam.r * Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
    draw();
  }, { passive: false });
  canvas.addEventListener('dblclick', fit);
  const ro = new ResizeObserver(draw);
  ro.observe(canvas);

  return {
    setMesh,
    fit,
    draw,
    clear: () => { mesh = null; count = 0; grid(null); draw(); },
    setSmooth: (on) => { smooth = !!on; upNormals(); draw(); },
    setDark: (on) => { dark = !!on; draw(); },
    //  a PNG of what is on screen: drawn now, read before the frame ends
    snapshot: () => { frame(); return canvas.toDataURL('image/png'); },
    mesh: () => mesh,
    destroy: () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); const x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); },
  };
}
