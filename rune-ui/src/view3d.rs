//! A part drawn in 3D: the web client's `ui-src/scad/viewer.js` without
//! a graphics card. The same camera (a sphere about a target, Z up), the
//! same fit, orbit, pan and zoom, the same plate under the part and the
//! same light, worked out for each triangle and drawn into a picture
//! with a depth for every pixel.
//!
//! The picture's ground is clear, so it sits on either theme, and the
//! plate's lines are a grey that shows on both.

use crate::scadrun::Mesh;

/// The camera: where it looks, how far from there it stands, and the two angles it stands at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cam {
    pub th: f32,
    pub ph: f32,
    pub r: f32,
    pub t: [f32; 3],
}

impl Default for Cam {
    fn default() -> Cam {
        Cam { th: -std::f32::consts::FRAC_PI_4, ph: std::f32::consts::PI / 3.2, r: 100.0, t: [0.0; 3] }
    }
}

impl Cam {
    /// Looks at the middle of the part from far enough to hold all of it.
    pub fn fit(&mut self, m: &Mesh) {
        if m.tris == 0 {
            (self.t, self.r) = ([0.0; 3], 100.0);
            return;
        }
        let size = [m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]];
        let rad = (size[0] * size[0] + size[1] * size[1] + size[2] * size[2]).sqrt() / 2.0;
        self.t = [(m.min[0] + m.max[0]) / 2.0, (m.min[1] + m.max[1]) / 2.0, (m.min[2] + m.max[2]) / 2.0];
        self.r = if rad > 0.0 { rad } else { 10.0 } / (std::f32::consts::PI / 8.0).sin() * 1.05;
    }

    /// Turns about the target by a drag of so many points.
    pub fn orbit(&mut self, dx: f32, dy: f32) {
        self.th -= dx * 0.008;
        self.ph = (self.ph - dy * 0.008).clamp(0.01, std::f32::consts::PI - 0.01);
    }

    /// Slides the target across the view by a drag of so many points.
    pub fn pan(&mut self, dx: f32, dy: f32) {
        let s = self.r * 0.0016;
        let (rx, ry) = (-self.th.sin(), self.th.cos());
        let (ux, uy, uz) = (-self.ph.cos() * self.th.cos(), -self.ph.cos() * self.th.sin(), self.ph.sin());
        self.t = [self.t[0] - (dx * rx - dy * ux) * s, self.t[1] - (dx * ry - dy * uy) * s, self.t[2] + dy * uz * s];
    }

    /// Steps nearer (`dy` below nothing) or further, as the web client's wheel does.
    pub fn zoom(&mut self, dy: f32) {
        self.r = (self.r * (dy * 0.0015).exp()).max(0.1);
    }

    fn eye(&self) -> [f32; 3] {
        [self.t[0] + self.r * self.ph.sin() * self.th.cos(), self.t[1] + self.r * self.ph.sin() * self.th.sin(), self.t[2] + self.r * self.ph.cos()]
    }
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn unit(a: [f32; 3]) -> [f32; 3] {
    let l = dot(a, a).sqrt();
    if l > 0.0 { [a[0] / l, a[1] / l, a[2] / l] } else { a }
}

/// The plate's lines and the two axes, as the web client lays them: a
/// plate a bit past the part, in squares that grow tenfold with it.
/// Each is two ends and its colour with how strong it is.
fn plate(m: &Mesh) -> Vec<([f32; 3], [f32; 3], [f32; 4])> {
    let has = m.tris > 0;
    let span = if has { (m.max[0] - m.min[0]).max(m.max[1] - m.min[1]) } else { 50.0 }.max(10.0);
    let step = if span < 30.0 { 1.0 } else { 10f32.powf((span / 3.0).log10().floor()) };
    let half = ((span * 0.75 + step) / step).ceil() * step;
    let mid = |a: usize| if has { ((m.min[a] + m.max[a]) / 2.0 / step).round() * step } else { 0.0 };
    let (cx, cy) = (mid(0), mid(1));
    let grey = [0.5, 0.5, 0.5, 0.3];
    let mut out = Vec::new();
    // a part near the largest number there is makes the plate's own size overflow: no more lines than a plate has
    let n = if (half / step).is_finite() { ((half / step).round() as i32).clamp(0, 200) } else { 0 };
    for i in -n..=n {
        let at = i as f32 * step;
        out.push(([cx + at, cy - half, 0.0], [cx + at, cy + half, 0.0], grey));
        out.push(([cx - half, cy + at, 0.0], [cx + half, cy + at, 0.0], grey));
    }
    out.push(([0.0; 3], [half / 2.0, 0.0, 0.0], [0.85, 0.25, 0.2, 0.9]));
    out.push(([0.0; 3], [0.0, half / 2.0, 0.0], [0.25, 0.65, 0.3, 0.9]));
    out
}

/// How many times over the whole picture a frame may be tested, pixel by
/// pixel. A part of thousands of triangles that each fill the view was
/// thousands of whole pictures of work, ten seconds a frame. An ordinary
/// part, fitted or looked at closely, is a few pictures' worth: this many
/// faces one behind another all over the view is no ordinary part.
const LAYERS: f64 = 32.0;

/// A box narrower than this is tested whole: finding the part of a row a
/// triangle covers costs more than testing so few pixels.
const NARROW: usize = 8;

/// The pixels of row `py` that a triangle can cover, of those from `x0`
/// to `x1`, or nothing when it can cover none. A long thin triangle
/// lying aslant has a box round it many times its own size, and each row
/// of that box holds only a few of its pixels. The answer is wide by a
/// pixel or two each way, and every pixel in it is still tested as
/// before, so what is drawn is what was always drawn.
fn span(s: &[[f32; 3]; 3], py: usize, x0: usize, x1: usize) -> Option<(usize, usize)> {
    if x1 - x0 < NARROW {
        return Some((x0, x1));
    }
    let cy = py as f64 + 0.5;
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for (a, b) in [(0, 1), (1, 2), (2, 0)] {
        let ([ax, ay], [bx, by]) = ([f64::from(s[a][0]), f64::from(s[a][1])], [f64::from(s[b][0]), f64::from(s[b][1])]);
        // the piece of this side that lies within a pixel of the row, above or below
        if ay.max(by) < cy - 1.0 || ay.min(by) > cy + 1.0 {
            continue;
        }
        let ends = if ay == by { [ax, bx] } else { [cy - 1.0, cy + 1.0].map(|y| ax + ((y - ay) / (by - ay)).clamp(0.0, 1.0) * (bx - ax)) };
        (lo, hi) = (lo.min(ends[0]).min(ends[1]), hi.max(ends[0]).max(ends[1]));
    }
    // no side near the row, or sides that are not numbers: the whole row is tested
    if !(lo <= hi) {
        return Some((x0, x1));
    }
    let (from, to) = ((lo - 2.0).floor().max(x0 as f64), (hi + 2.0).ceil().min(x1 as f64));
    (from <= to).then_some((from as usize, to as usize))
}

/// How the camera sees a picture `w` by `h`: a place of the part as the
/// camera sees it, and that as a place in the picture with its nearness.
struct Lens {
    eye: [f32; 3],
    axes: [[f32; 3]; 3],
    f: f32,
    near: f32,
    wf: f32,
    hf: f32,
}

impl Lens {
    fn new(cam: &Cam, w: usize, h: usize) -> Lens {
        let eye = cam.eye();
        let z = unit(sub(eye, cam.t));
        let x = unit(cross([0.0, 0.0, 1.0], z));
        Lens { eye, axes: [x, cross(z, x), z], f: 1.0 / (std::f32::consts::PI / 8.0).tan(), near: (cam.r / 1000.0).max(0.01), wf: w as f32, hf: h as f32 }
    }

    fn view(&self, p: [f32; 3]) -> [f32; 3] {
        let d = sub(p, self.eye);
        [dot(self.axes[0], d), dot(self.axes[1], d), dot(self.axes[2], d)]
    }

    fn screen(&self, v: [f32; 3]) -> [f32; 3] {
        [(v[0] * self.f / (self.wf / self.hf) / -v[2] + 1.0) / 2.0 * self.wf, (1.0 - v[1] * self.f / -v[2]) / 2.0 * self.hf, 1.0 / -v[2]]
    }

    /// A triangle in the picture, as the camera sees it and as it lies in the picture, with the
    /// box of pixels round it. Nothing for one that is behind the camera, flat, or out of the picture.
    #[allow(clippy::type_complexity)]
    fn triangle(&self, t: &[f32]) -> Option<([[f32; 3]; 3], [[f32; 3]; 3], f32, [usize; 4])> {
        let v = [self.view([t[0], t[1], t[2]]), self.view([t[3], t[4], t[5]]), self.view([t[6], t[7], t[8]])];
        // ponytail: a triangle that reaches behind the camera is left out whole. Cut at the near plane if looking from inside a part matters
        if v.iter().any(|p| -p[2] < self.near) {
            return None;
        }
        let s = [self.screen(v[0]), self.screen(v[1]), self.screen(v[2])];
        let area = (s[1][0] - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (s[1][1] - s[0][1]);
        if area == 0.0 || !area.is_finite() {
            return None;
        }
        let (x0, x1) = (s.iter().map(|p| p[0]).fold(f32::INFINITY, f32::min).floor().max(0.0), s.iter().map(|p| p[0]).fold(f32::NEG_INFINITY, f32::max).ceil().min(self.wf - 1.0));
        let (y0, y1) = (s.iter().map(|p| p[1]).fold(f32::INFINITY, f32::min).floor().max(0.0), s.iter().map(|p| p[1]).fold(f32::NEG_INFINITY, f32::max).ceil().min(self.hf - 1.0));
        if x0 > x1 || y0 > y1 {
            return None;
        }
        Some((v, s, area, [x0 as usize, x1 as usize, y0 as usize, y1 as usize]))
    }
}

/// How coarsely a part is drawn in a picture `w` by `h` so that a frame
/// is bounded work: 1 for the picture as it is, which is every ordinary
/// part, and `n` for one drawn in dots `n` pixels a side. The pixels a
/// frame would test are counted first, a sum over the triangles, and a
/// part that asks for more than `LAYERS` pictures' worth is drawn small
/// enough to fit that and shown at full size.
pub fn coarse(m: &Mesh, cam: &Cam, w: usize, h: usize) -> usize {
    if w == 0 || h == 0 {
        return 1;
    }
    let lens = Lens::new(cam, w, h);
    // the box round each triangle, or for a wide one its own size and something for each of its rows (`span`)
    let tests: f64 = m
        .pos
        .chunks_exact(9)
        .filter_map(|t| lens.triangle(t))
        .map(|(_, _, area, b)| {
            let (wide, high) = ((b[1] - b[0] + 1) as f64, (b[3] - b[2] + 1) as f64);
            if b[1] - b[0] < NARROW { wide * high } else { (wide * high).min(f64::from(area.abs()) / 2.0 + 8.0 * high) }
        })
        .sum();
    let over = tests / (LAYERS * w as f64 * h as f64);
    if over <= 1.0 { 1 } else { (over.sqrt().ceil() as usize).clamp(2, w.max(h)) }
}

/// The part as a picture `w` by `h`: straight RGBA, clear where nothing is.
/// A part too heavy to draw at that size in bounded work is drawn in
/// larger dots (`coarse` says how large, for a caller that would tell
/// the reader): all of it is still there, with every face before or
/// behind another as it should be.
pub fn render(m: &Mesh, cam: &Cam, w: usize, h: usize) -> Vec<u8> {
    let dot = coarse(m, cam, w, h);
    if dot <= 1 {
        return draw(m, cam, w, h);
    }
    let (sw, sh) = (w.div_ceil(dot), h.div_ceil(dot));
    let small = draw(m, cam, sw, sh);
    let mut px = vec![0u8; w * h * 4];
    for (y, row) in px.chunks_exact_mut(w * 4).enumerate() {
        for (x, p) in row.chunks_exact_mut(4).enumerate() {
            let at = ((y / dot) * sw + x / dot) * 4;
            p.copy_from_slice(&small[at..at + 4]);
        }
    }
    px
}

/// The part drawn pixel by pixel into a picture `w` by `h`.
fn draw(m: &Mesh, cam: &Cam, w: usize, h: usize) -> Vec<u8> {
    let mut px = vec![0u8; w * h * 4];
    if w == 0 || h == 0 {
        return px;
    }
    // how near each pixel's surface is: one over its distance, so more is nearer
    let mut depth = vec![0f32; w * h];
    let lens = Lens::new(cam, w, h);
    let (view, screen) = (|p: [f32; 3]| lens.view(p), |v: [f32; 3]| lens.screen(v));
    let (near, wf, hf) = (lens.near, lens.wf, lens.hf);
    // the plate first, then the part over it
    for (a, b, col) in plate(m) {
        let (mut a, mut b) = (view(a), view(b));
        // a line that passes behind the camera is cut where it does
        if -a[2] < near && -b[2] < near {
            continue;
        }
        for (p, q) in [(0, 1), (1, 0)] {
            let (pv, qv) = if p == 0 { (a, b) } else { (b, a) };
            if -pv[2] < near {
                let t = (-near - pv[2]) / (qv[2] - pv[2]);
                let cut = [pv[0] + (qv[0] - pv[0]) * t, pv[1] + (qv[1] - pv[1]) * t, -near];
                if p == 0 { a = cut } else { b = cut }
            }
            let _ = q;
        }
        let (sa, sb) = (screen(a), screen(b));
        let steps = (sb[0] - sa[0]).abs().max((sb[1] - sa[1]).abs()).ceil().clamp(1.0, 16_384.0) as usize;
        for i in 0..=steps {
            let t = i as f32 / steps as f32;
            let (sx, sy, d) = (sa[0] + (sb[0] - sa[0]) * t, sa[1] + (sb[1] - sa[1]) * t, sa[2] + (sb[2] - sa[2]) * t);
            if sx < 0.0 || sy < 0.0 || sx >= wf || sy >= hf {
                continue;
            }
            let at = sy as usize * w + sx as usize;
            if d > depth[at] {
                depth[at] = d;
                px[at * 4..at * 4 + 4].copy_from_slice(&[(col[0] * 255.0) as u8, (col[1] * 255.0) as u8, (col[2] * 255.0) as u8, (col[3] * 255.0) as u8]);
            }
        }
    }
    let base = [0.93f32, 0.72, 0.2];
    let (light, fill) = (unit([0.4, 0.6, 1.0]), unit([-0.5, -0.3, 0.4]));
    for t in m.pos.chunks_exact(9) {
        let Some((v, s, area, [x0, x1, y0, y1])) = lens.triangle(t) else { continue };
        // one light for the whole face, from its own slope: both sides are lit, as the web client lights them
        let centre = [(v[0][0] + v[1][0] + v[2][0]) / 3.0, (v[0][1] + v[1][1] + v[2][1]) / 3.0, (v[0][2] + v[1][2] + v[2][2]) / 3.0];
        let mut n = unit(cross(sub(v[1], v[0]), sub(v[2], v[0])));
        let toward = unit([-centre[0], -centre[1], -centre[2]]);
        if dot(n, toward) < 0.0 {
            n = [-n[0], -n[1], -n[2]];
        }
        let d = dot(n, light).max(0.0);
        let shine = dot(n, unit([light[0] + toward[0], light[1] + toward[1], light[2] + toward[2]])).max(0.0).powi(40) * 0.25;
        let rim = 0.35 + 0.65 * dot(n, fill).max(0.0) * 0.3;
        let ink: Vec<u8> = base.iter().map(|c| ((c * (0.32 + 0.68 * d) + c * rim * 0.2 + shine).clamp(0.0, 1.0) * 255.0) as u8).collect();
        for py in y0..=y1 {
            let Some((x0, x1)) = span(&s, py, x0, x1) else { continue };
            for pxl in x0..=x1 {
                let (cx, cy) = (pxl as f32 + 0.5, py as f32 + 0.5);
                let w0 = ((s[1][0] - cx) * (s[2][1] - cy) - (s[2][0] - cx) * (s[1][1] - cy)) / area;
                let w1 = ((s[2][0] - cx) * (s[0][1] - cy) - (s[0][0] - cx) * (s[2][1] - cy)) / area;
                let w2 = 1.0 - w0 - w1;
                if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                    continue;
                }
                let dz = w0 * s[0][2] + w1 * s[1][2] + w2 * s[2][2];
                let at = py * w + pxl;
                if dz > depth[at] {
                    depth[at] = dz;
                    px[at * 4..at * 4 + 4].copy_from_slice(&[ink[0], ink[1], ink[2], 255]);
                }
            }
        }
    }
    px
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A box from the origin, as twelve triangles.
    fn cube(sx: f32, sy: f32, sz: f32) -> Mesh {
        let c = |i: usize| [if i & 1 > 0 { sx } else { 0.0 }, if i & 2 > 0 { sy } else { 0.0 }, if i & 4 > 0 { sz } else { 0.0 }];
        let faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
        let mut pos = Vec::new();
        for f in faces {
            for tri in [[f[0], f[1], f[2]], [f[0], f[2], f[3]]] {
                pos.extend(tri.iter().flat_map(|i| c(*i)));
            }
        }
        Mesh { tris: 12, pos, min: [0.0; 3], max: [sx, sy, sz] }
    }

    /// How many pixels of a part's triangles pass the test of being inside one, with every pixel of each
    /// triangle's box tested, and how many of those `span` would leave out.
    fn covered(m: &Mesh, cam: &Cam, w: usize, h: usize) -> (usize, usize) {
        let lens = Lens::new(cam, w, h);
        let (mut inside, mut lost) = (0, 0);
        for t in m.pos.chunks_exact(9) {
            let Some((_, s, area, [x0, x1, y0, y1])) = lens.triangle(t) else { continue };
            for py in y0..=y1 {
                let row = span(&s, py, x0, x1);
                for pxl in x0..=x1 {
                    let (cx, cy) = (pxl as f32 + 0.5, py as f32 + 0.5);
                    let w0 = ((s[1][0] - cx) * (s[2][1] - cy) - (s[2][0] - cx) * (s[1][1] - cy)) / area;
                    let w1 = ((s[2][0] - cx) * (s[0][1] - cy) - (s[0][0] - cx) * (s[2][1] - cy)) / area;
                    if w0 >= 0.0 && w1 >= 0.0 && 1.0 - w0 - w1 >= 0.0 {
                        inside += 1;
                        lost += usize::from(!row.is_some_and(|(a, z)| (a..=z).contains(&pxl)));
                    }
                }
            }
        }
        (inside, lost)
    }

    fn at(px: &[u8], w: usize, x: usize, y: usize) -> [u8; 4] {
        [px[(y * w + x) * 4], px[(y * w + x) * 4 + 1], px[(y * w + x) * 4 + 2], px[(y * w + x) * 4 + 3]]
    }

    #[test]
    fn a_fitted_part_fills_the_middle_and_leaves_the_corners_clear() {
        let m = cube(30.0, 20.0, 10.0);
        let mut cam = Cam::default();
        cam.fit(&m);
        assert_eq!(cam.t, [15.0, 10.0, 5.0]);
        assert!((cam.r - (1400f32.sqrt() / 2.0) / (std::f32::consts::PI / 8.0).sin() * 1.05).abs() < 1e-3);
        let (w, h) = (240, 160);
        let px = render(&m, &cam, w, h);
        assert_eq!(px.len(), w * h * 4);
        // the part is its own colour in the middle, solid, and three faces show three different lights
        let mid = at(&px, w, w / 2, h / 2);
        assert_eq!(mid[3], 255);
        assert!(mid[0] > mid[2], "the part is the warm colour: {mid:?}");
        let solid: std::collections::HashSet<[u8; 4]> = px.chunks_exact(4).filter(|p| p[3] == 255).map(|p| [p[0], p[1], p[2], p[3]]).collect();
        assert_eq!(solid.len(), 3, "three faces are seen from the corner it starts at");
        assert_eq!(at(&px, w, 0, 0)[3], 0);
        // all of it is in the picture: no solid pixel on the border
        assert!((0..w).all(|x| at(&px, w, x, 0)[3] != 255 && at(&px, w, x, h - 1)[3] != 255));
        assert!((0..h).all(|y| at(&px, w, 0, y)[3] != 255 && at(&px, w - 1, y, y.min(h - 1))[3] != 255));
        // the plate shows beside it
        assert!(px.chunks_exact(4).any(|p| p[3] > 0 && p[3] < 255));
    }

    #[test]
    fn turning_and_zooming_move_the_camera_as_the_web_client_does() {
        let mut cam = Cam::default();
        cam.orbit(100.0, 0.0);
        assert!((cam.th - (-std::f32::consts::FRAC_PI_4 - 0.8)).abs() < 1e-6);
        // it never goes over the top or under the plate's own axis
        cam.orbit(0.0, 10_000.0);
        assert_eq!(cam.ph, 0.01);
        cam.orbit(0.0, -100_000.0);
        assert_eq!(cam.ph, std::f32::consts::PI - 0.01);
        cam.zoom(-1000.0);
        assert!(cam.r < 100.0 * 0.23 && cam.r > 100.0 * 0.22);
        cam.zoom(-1e9);
        assert_eq!(cam.r, 0.1);
        let mut cam = Cam::default();
        cam.pan(10.0, 0.0);
        assert!(cam.t[2] == 0.0 && cam.t[0] != 0.0, "a slide sideways stays level");
        // nearer, the part is bigger in the picture
        let m = cube(10.0, 10.0, 10.0);
        let count = |cam: &Cam| render(&m, cam, 120, 80).chunks_exact(4).filter(|p| p[3] == 255).count();
        let mut near = Cam::default();
        near.fit(&m);
        let far = count(&near);
        near.zoom(-400.0);
        assert!(count(&near) > far * 2);
    }

    #[test]
    fn odd_parts_and_sizes_do_not_panic() {
        let m = cube(1.0, 1.0, 1.0);
        let empty = Mesh { tris: 0, pos: Vec::new(), min: [0.0; 3], max: [0.0; 3] };
        let mut inside = Cam::default();
        inside.r = 0.1;
        for (mesh, cam, w, h) in [(&m, Cam::default(), 0, 0), (&m, Cam::default(), 1, 1), (&empty, Cam::default(), 40, 30), (&m, inside, 40, 30), (&m, Cam { th: f32::NAN, ..Cam::default() }, 40, 30)] {
            assert_eq!(render(mesh, &cam, w, h).len(), w * h * 4);
        }
        let mut cam = Cam::default();
        cam.fit(&empty);
        assert_eq!((cam.t, cam.r), ([0.0; 3], 100.0));
        let flat = Mesh { tris: 1, pos: vec![0.0; 9], min: [0.0; 3], max: [0.0; 3] };
        cam.fit(&flat);
        assert!(cam.r.is_finite() && cam.r > 0.0);
    }

    #[test]
    fn a_part_of_thousands_of_faces_that_fill_the_view_is_drawn_in_bounded_work() {
        // 8,000 triangles, each wider than the view, one behind another: once 8,000 whole pictures of work
        let mut pos = Vec::new();
        for i in 0..8000 {
            let z = i as f32 * 0.001;
            pos.extend([-30.0, -30.0, z, 30.0, -30.0, z, 0.0, 45.0, z]);
        }
        let heavy = Mesh { tris: 8000, pos, min: [-30.0, -30.0, 0.0], max: [30.0, 45.0, 8.0] };
        let cam = Cam { r: 60.0, ..Cam::default() };
        let (w, h) = (320, 200);
        let t = std::time::Instant::now();
        let dot = coarse(&heavy, &cam, w, h);
        let px = render(&heavy, &cam, w, h);
        assert!(t.elapsed().as_millis() < 1500, "{:?}", t.elapsed());
        assert!((4..=20).contains(&dot), "drawn in dots {dot} a side");
        // the picture is whole and the part is in it, in dots that size
        assert_eq!(px.len(), w * h * 4);
        assert_eq!(at(&px, w, w / 2, h / 2)[3], 255);
        let (x, y) = ((w / 2 / dot) * dot, (h / 2 / dot) * dot);
        assert!((0..dot).all(|d| at(&px, w, x + d, y + d) == at(&px, w, x, y)));
        // an ordinary part is drawn pixel by pixel, as it always was, close up too
        let m = cube(30.0, 20.0, 10.0);
        let mut near = Cam::default();
        near.fit(&m);
        assert_eq!(coarse(&m, &near, w, h), 1);
        assert_eq!(render(&m, &near, w, h), draw(&m, &near, w, h));
        near.zoom(-1500.0);
        assert_eq!(coarse(&m, &near, w, h), 1);
        // finding the part of each row a triangle covers leaves no pixel out: long thin triangles lying
        // aslant, and a part seen from many sides, are drawn as they are when every pixel of the box is tested
        let mut pos = Vec::new();
        for i in 0..40 {
            let a = i as f32 * 0.7;
            pos.extend([a.cos() * 20.0, a.sin() * 20.0, a, -a.cos() * 20.0 + 0.3, -a.sin() * 20.0, 12.0 - a * 0.3, a.sin() * 3.0, a.cos() * 3.0, a * 0.5]);
        }
        let thin = Mesh { tris: 40, pos, min: [-20.0, -20.0, 0.0], max: [20.0, 20.0, 28.0] };
        let mut all = 0;
        let some = Mesh { tris: 20, pos: heavy.pos[..180].to_vec(), ..cube(1.0, 1.0, 1.0) };
        for mesh in [&thin, &m, &some] {
            let mut cam = Cam::default();
            cam.fit(mesh);
            for turn in 0..9 {
                cam.orbit(37.0, 11.0 * turn as f32 - 40.0);
                cam.zoom(-120.0);
                let (inside, lost) = covered(mesh, &cam, 200, 130);
                assert_eq!(lost, 0, "turn {turn}");
                all += inside;
            }
        }
        assert!(all > 100_000, "{all}");
        // nothing to draw, or no picture to draw in, is no work
        assert_eq!((coarse(&m, &near, 0, 0), coarse(&Mesh { tris: 0, pos: Vec::new(), min: [0.0; 3], max: [0.0; 3] }, &near, w, h)), (1, 1));
    }
}
