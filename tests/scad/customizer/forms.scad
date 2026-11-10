// lattice's own fixture: every widget form OpenSCAD's customizer reads
plain = 4;

step = 5; // 0.5

spaced = 7;    //   2

slider = 20; // [10:100]

stepped = 15; // [0:5:50]

maxonly = 3; // [12]

broken = 2; // [1:12

notlist = 6; // [1 12]

twice = 1; // [1:12] // [12:34]

empty = 9; //

labelled = 20; // [10:Small, 20:Medium, 30:Large]

numlist = 2; // [0, 1, 2, 3]

missing = 10; // [0, 1, 2]

word = "hello"; // just a note

maxlen = "abc"; // 8

choice = "bar"; // [foo, bar, baz]

pick = "M"; // [S:Small, M:Medium, L:Large]

flag = true;

vec2 = [12, 34]; // [1:100]

vec4 = [1, 2, 3, 4];

vec6 = [1, 2, 3, 4, 5, 6];

neg = -12.5;

sci = 1e3;

computed = 2 * plain;

notb = !true;

names = ["a", "b"];

a1 = 1; b1 = "two"; // [1:34]

/* [Shape] */
// how round the corners are
round = 2; // [0:0.5:10]

// a description
//
described = 3;

// a description with a blank line after it

notdescribed = 4;

/* [Hidden] */
secret = 99;

/* [Global] */
everywhere = 1; // [0:1]

/* [Last] */
last = "x";

module part() {
  inside = 5;
  cube(inside);
}

after = 7;
