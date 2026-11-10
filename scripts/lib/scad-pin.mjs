//  scad-pin.mjs: the OpenSCAD runtime lattice pins. build-scad.mjs says
//  where each file came from and checks app.hoon's +scad-files against it.
export const PIN = {
  version: '2026.11.10',
  upstream: {
    url: 'https://files.openscad.org/snapshots/OpenSCAD-2026.11.10-WebAssembly-web.zip',
    sha256: '0ccd0154bb37ca0865e453f033b2b9415977e90a6c9d7f69a64e0c975786ca2d',
    size: 3356388,
  },
  source: 'https://github.com/openscad/openscad/tree/bcf45a22caa954ca56ca287994cb6dbc368c67b2',
  licence: 'GPL-2.0-or-later WITH OpenSCAD CGAL exception',
  //  the unmodified files inside the upstream zip
  raw: {
    'openscad.wasm': { sha256: 'f9a227259a9d8925f6fd53866e110fafa70eb9442572c761120abfdaf887d120', size: 11009822 },
    'openscad.js': { sha256: '2f0cd6a960f91aec62a4c358d44ba957c134f1ef13cffb4ca9eddaaa8e4b1a0b', size: 99853 },
  },
  copying: {
    url: 'https://raw.githubusercontent.com/openscad/openscad/bcf45a22caa954ca56ca287994cb6dbc368c67b2/COPYING',
  },
  //  what the ship fetches, keeps and serves: [served as, release file]
  files: [
    { name: 'openscad.wasm', file: 'openscad.wasm.gz', sha256: '5df29a9d74be3b2bf0a4dc8def386d4d12257264eeb1260683f44d07f111a772', size: 3336685 },
    { name: 'openscad.js', file: 'openscad.js', sha256: '2f0cd6a960f91aec62a4c358d44ba957c134f1ef13cffb4ca9eddaaa8e4b1a0b', size: 99853 },
    { name: 'COPYING', file: 'openscad-COPYING.txt', sha256: '1805a29c3bccbc0428ce0048a1dfdeb9b1867677410e99c89c3c30932ae8c7d5', size: 18382 },
  ],
};
