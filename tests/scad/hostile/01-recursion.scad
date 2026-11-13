// unbounded recursion: OpenSCAD's own stack guard ends it
function f(n) = f(n + 1) + 1;
echo(f(0));
module m(n) { m(n + 1); }
m(0);
