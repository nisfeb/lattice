// includes that try to leave lattice: each is refused, none is read
include </etc/passwd>
include <../../../../etc/shadow>
use <https://example.com/evil.scad>
use <file:///etc/hosts>
include <C:\Windows\win.ini>
include <\\host\share\x.scad>
cube(2);
