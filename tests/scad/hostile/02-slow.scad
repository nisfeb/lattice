// a tail call that runs for about 15 s: the time limit stops it
function f(n, a = 0) = n == 0 ? a : f(n - 1, a + 1);
echo(f(50000000));
cube(1);
