// lattice's new scad page: a box with a lid, three customizer variables
/* [Size] */
// inside width, in mm
width = 40; // [10:200]
// inside depth, in mm
depth = 30; // [10:200]
// wall thickness, in mm
wall = 2; // [0.8:0.2:6]

/* [Hidden] */
$fn = 48;

difference() {
  cube([width + 2 * wall, depth + 2 * wall, 20]);
  translate([wall, wall, wall]) cube([width, depth, 20]);
}
