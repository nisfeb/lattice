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
  //  the fonts text() draws with, from liberation-fonts 2.1.5. The release
  //  page links the tarball as an attachment of its notes, not an asset.
  fonts: {
    url: 'https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz',
    sha256: '7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0',
    size: 2385008,
    dir: 'liberation-fonts-ttf-2.1.5',
    licence: 'OFL-1.1',
    raw: {
      'LiberationSans-Regular.ttf': { sha256: '76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8', size: 410712 },
      'LiberationSans-Bold.ttf': { sha256: '788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173', size: 414456 },
      'LiberationMono-Regular.ttf': { sha256: 'f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1', size: 319508 },
      LICENSE: { sha256: '93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b', size: 4414 },
    },
  },
  copying: {
    url: 'https://raw.githubusercontent.com/openscad/openscad/bcf45a22caa954ca56ca287994cb6dbc368c67b2/COPYING',
  },
  //  what the ship fetches, keeps and serves: [served as, release file]
  files: [
    { name: 'openscad.wasm', file: 'openscad.wasm.gz', sha256: '5df29a9d74be3b2bf0a4dc8def386d4d12257264eeb1260683f44d07f111a772', size: 3336685 },
    { name: 'openscad.js', file: 'openscad.js', sha256: '2f0cd6a960f91aec62a4c358d44ba957c134f1ef13cffb4ca9eddaaa8e4b1a0b', size: 99853 },
    { name: 'COPYING', file: 'openscad-COPYING.txt', sha256: '1805a29c3bccbc0428ce0048a1dfdeb9b1867677410e99c89c3c30932ae8c7d5', size: 18382 },
    { name: 'LiberationSans-Regular.ttf', file: 'LiberationSans-Regular.ttf.gz', sha256: '25facb56b288d2a328350d954d1a9ce80e36967ca631f0938f207a1d6bebd406', size: 211540 },
    { name: 'LiberationSans-Bold.ttf', file: 'LiberationSans-Bold.ttf.gz', sha256: '46c6c8ee14971ea13375ef357513b10ccad1486468030931076eb767014bda96', size: 213078 },
    { name: 'LiberationMono-Regular.ttf', file: 'LiberationMono-Regular.ttf.gz', sha256: '504c2a932ee2a26e3a3719ea2cddebf9e9eeff9bca2873662d5f890f9fa80f0e', size: 179704 },
    { name: 'fonts-LICENSE', file: 'liberation-fonts-LICENSE.txt', sha256: '93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b', size: 4414 },
  ],
};
