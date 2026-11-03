// fstrace: an LD_PRELOAD logger of the file calls a program makes under
// one directory, for machines without strace. scripts/fs-libreoffice.sh
// builds it with LO_TRACE=<dir> to record LibreOffice's save pattern.
// Paths are logged relative to FSTRACE_ROOT (renames in full).
// FSTRACE_ROOT=<dir> FSTRACE_LOG=<file> LD_PRELOAD=fstrace.so cmd ...
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/file.h>
#include <time.h>

static const char *root; static size_t rootn; static int logfd = -1;

extern char **environ;
static void init(void) {
  if (root || !environ) return;
  root = getenv("FSTRACE_ROOT"); if (!root) root = "/nonexistent-root";
  rootn = strlen(root);
  const char *l = getenv("FSTRACE_LOG");
  if (l) logfd = syscall(SYS_openat, AT_FDCWD, l, O_WRONLY|O_CREAT|O_APPEND, 0644);
}
static void fdpath(int dirfd, char *out, size_t n) {
  char p[64]; ssize_t r;
  if (dirfd == AT_FDCWD) { if (!getcwd(out, n)) out[0] = 0; return; }
  snprintf(p, sizeof p, "/proc/self/fd/%d", dirfd);
  r = readlink(p, out, n - 1); out[r < 0 ? 0 : r] = 0;
}
static int resolve(int dirfd, const char *path, char *out, size_t n) {
  init(); if (!root) return 0;
  if (!path) return 0;
  if (path[0] == '/') snprintf(out, n, "%s", path);
  else { char d[4096]; fdpath(dirfd, d, sizeof d); snprintf(out, n, "%s/%s", d, path); }
  return strncmp(out, root, rootn) == 0;
}
static int fdin(int fd, char *out, size_t n) { init(); if (!root) return 0; fdpath(fd, out, n); return strncmp(out, root, rootn) == 0; }
static void logf_(const char *fmt, ...) {
  char b[9000]; struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  int k = snprintf(b, sizeof b, "%ld.%03ld %d ", (long)ts.tv_sec, ts.tv_nsec / 1000000, getpid());
  va_list a; va_start(a, fmt); k += vsnprintf(b + k, sizeof b - k, fmt, a); va_end(a);
  if (k > (int)sizeof b - 2) k = sizeof b - 2;
  b[k++] = '\n'; if (logfd >= 0) syscall(SYS_write, logfd, b, k);
}
#define REAL(ret, name, ...) static ret (*r_##name)(__VA_ARGS__); if (!r_##name) r_##name = dlsym(RTLD_NEXT, #name)
static const char *rel(const char *p) { return p + rootn; }
static const char *flags(int f) {
  static __thread char s[96]; s[0] = 0;
  strcat(s, (f & O_ACCMODE) == O_RDONLY ? "R" : (f & O_ACCMODE) == O_WRONLY ? "W" : "RW");
  if (f & O_CREAT) strcat(s, "|CREAT");
  if (f & O_EXCL) strcat(s, "|EXCL");
  if (f & O_TRUNC) strcat(s, "|TRUNC");
  if (f & O_APPEND) strcat(s, "|APPEND");
  if (f & O_DIRECTORY) strcat(s, "|DIR");
  return s;
}
#define RES(r) ((r) < 0 ? -errno : (r))

#define OPENAT(name) int name(int d, const char *p, int f, ...) { \
  mode_t m = 0; if (f & (O_CREAT|O_TMPFILE)) { va_list a; va_start(a, f); m = va_arg(a, int); va_end(a); } \
  REAL(int, name, int, const char *, int, ...); char x[4096]; int in = resolve(d, p, x, sizeof x); \
  int r = r_##name(d, p, f, m); int e = errno; if (in) logf_("openat %s %s = %d", rel(x), flags(f), RES(r)); errno = e; return r; }
OPENAT(openat) OPENAT(openat64)
#define OPEN(name) int name(const char *p, int f, ...) { \
  mode_t m = 0; if (f & (O_CREAT|O_TMPFILE)) { va_list a; va_start(a, f); m = va_arg(a, int); va_end(a); } \
  REAL(int, name, const char *, int, ...); char x[4096]; int in = resolve(AT_FDCWD, p, x, sizeof x); \
  int r = r_##name(p, f, m); int e = errno; if (in) logf_("open %s %s = %d", rel(x), flags(f), RES(r)); errno = e; return r; }
OPEN(open) OPEN(open64)

#define P1(name, ...) int name(const char *p) { REAL(int, name, const char *); char x[4096]; int in = resolve(AT_FDCWD, p, x, sizeof x); \
  int r = r_##name(p); int e = errno; if (in) logf_(#name " %s = %d", rel(x), RES(r)); errno = e; return r; }
P1(unlink) P1(rmdir)
int mkdir(const char *p, mode_t m) { REAL(int, mkdir, const char *, mode_t); char x[4096]; int in = resolve(AT_FDCWD, p, x, sizeof x);
  int r = r_mkdir(p, m); int e = errno; if (in) logf_("mkdir %s = %d", rel(x), RES(r)); errno = e; return r; }
int access(const char *p, int m) { REAL(int, access, const char *, int); char x[4096]; int in = resolve(AT_FDCWD, p, x, sizeof x);
  int r = r_access(p, m); int e = errno; if (in) logf_("access %s mode=%d = %d", rel(x), m, RES(r)); errno = e; return r; }
int faccessat(int d, const char *p, int m, int fl) { REAL(int, faccessat, int, const char *, int, int); char x[4096]; int in = resolve(d, p, x, sizeof x);
  int r = r_faccessat(d, p, m, fl); int e = errno; if (in) logf_("faccessat %s mode=%d = %d", rel(x), m, RES(r)); errno = e; return r; }
int unlinkat(int d, const char *p, int fl) { REAL(int, unlinkat, int, const char *, int); char x[4096]; int in = resolve(d, p, x, sizeof x);
  int r = r_unlinkat(d, p, fl); int e = errno; if (in) logf_("unlinkat %s = %d", rel(x), RES(r)); errno = e; return r; }
int rename(const char *a, const char *b) { REAL(int, rename, const char *, const char *); char x[4096], y[4096];
  int in = resolve(AT_FDCWD, a, x, sizeof x) | resolve(AT_FDCWD, b, y, sizeof y);
  int r = r_rename(a, b); int e = errno; if (in) logf_("rename %s -> %s = %d", x, y, RES(r)); errno = e; return r; }
int renameat(int da, const char *a, int db, const char *b) { REAL(int, renameat, int, const char *, int, const char *); char x[4096], y[4096];
  int in = resolve(da, a, x, sizeof x) | resolve(db, b, y, sizeof y);
  int r = r_renameat(da, a, db, b); int e = errno; if (in) logf_("renameat %s -> %s = %d", x, y, RES(r)); errno = e; return r; }
int renameat2(int da, const char *a, int db, const char *b, unsigned fl) { REAL(int, renameat2, int, const char *, int, const char *, unsigned); char x[4096], y[4096];
  int in = resolve(da, a, x, sizeof x) | resolve(db, b, y, sizeof y);
  int r = r_renameat2(da, a, db, b, fl); int e = errno; if (in) logf_("renameat2 %s -> %s fl=%u = %d", x, y, fl, RES(r)); errno = e; return r; }
int link(const char *a, const char *b) { REAL(int, link, const char *, const char *); char x[4096], y[4096];
  int in = resolve(AT_FDCWD, a, x, sizeof x) | resolve(AT_FDCWD, b, y, sizeof y);
  int r = r_link(a, b); int e = errno; if (in) logf_("link %s -> %s = %d", x, y, RES(r)); errno = e; return r; }
int symlink(const char *a, const char *b) { REAL(int, symlink, const char *, const char *); char y[4096];
  int in = resolve(AT_FDCWD, b, y, sizeof y);
  int r = r_symlink(a, b); int e = errno; if (in) logf_("symlink %s -> %s = %d", a, rel(y), RES(r)); errno = e; return r; }
#define STAT(name, T) int name(const char *p, T *s) { REAL(int, name, const char *, T *); char x[4096]; int in = resolve(AT_FDCWD, p, x, sizeof x); \
  int r = r_##name(p, s); int e = errno; if (in) logf_(#name " %s = %d", rel(x), RES(r)); errno = e; return r; }
STAT(stat, struct stat) STAT(lstat, struct stat) STAT(stat64, struct stat64) STAT(lstat64, struct stat64)
#define FSTATAT(name, T) int name(int d, const char *p, T *s, int fl) { REAL(int, name, int, const char *, T *, int); char x[4096]; int in = resolve(d, p, x, sizeof x); \
  int r = r_##name(d, p, s, fl); int e = errno; if (in && p && *p) logf_(#name " %s = %d", rel(x), RES(r)); errno = e; return r; }
FSTATAT(fstatat, struct stat) FSTATAT(fstatat64, struct stat64)
int statx(int d, const char *p, int fl, unsigned m, struct statx *s) { REAL(int, statx, int, const char *, int, unsigned, struct statx *); char x[4096]; int in = resolve(d, p, x, sizeof x);
  int r = r_statx(d, p, fl, m, s); int e = errno; if (in && p && *p) logf_("statx %s = %d", rel(x), RES(r)); errno = e; return r; }
int utimensat(int d, const char *p, const struct timespec t[2], int fl) { REAL(int, utimensat, int, const char *, const struct timespec *, int); char x[4096]; int in;
  if (p) in = resolve(d, p, x, sizeof x); else in = fdin(d, x, sizeof x);
  int r = r_utimensat(d, p, t, fl); int e = errno; if (in) logf_("utimensat %s = %d", rel(x), RES(r)); errno = e; return r; }
int futimens(int fd, const struct timespec t[2]) { REAL(int, futimens, int, const struct timespec *); char x[4096]; int in = fdin(fd, x, sizeof x);
  int r = r_futimens(fd, t); int e = errno; if (in) logf_("futimens %s = %d", rel(x), RES(r)); errno = e; return r; }
int truncate(const char *p, off_t l) { REAL(int, truncate, const char *, off_t); char x[4096]; int in = resolve(AT_FDCWD, p, x, sizeof x);
  int r = r_truncate(p, l); int e = errno; if (in) logf_("truncate %s %ld = %d", rel(x), (long)l, RES(r)); errno = e; return r; }
#define FD1(name) int name(int fd) { REAL(int, name, int); char x[4096]; int in = fdin(fd, x, sizeof x); \
  int r = r_##name(fd); int e = errno; if (in) logf_(#name " %s (fd %d) = %d", rel(x), fd, RES(r)); errno = e; return r; }
FD1(close) FD1(fsync) FD1(fdatasync)
#define FTR(name, T) int name(int fd, T l) { REAL(int, name, int, T); char x[4096]; int in = fdin(fd, x, sizeof x); \
  int r = r_##name(fd, l); int e = errno; if (in) logf_(#name " %s %ld = %d", rel(x), (long)l, RES(r)); errno = e; return r; }
FTR(ftruncate, off_t) FTR(ftruncate64, off64_t)
ssize_t write(int fd, const void *b, size_t n) { REAL(ssize_t, write, int, const void *, size_t); char x[4096]; int in = fdin(fd, x, sizeof x);
  ssize_t r = r_write(fd, b, n); int e = errno; if (in) logf_("write %s %zu = %zd", rel(x), n, r < 0 ? -errno : r); errno = e; return r; }
ssize_t pwrite64(int fd, const void *b, size_t n, off64_t o) { REAL(ssize_t, pwrite64, int, const void *, size_t, off64_t); char x[4096]; int in = fdin(fd, x, sizeof x);
  ssize_t r = r_pwrite64(fd, b, n, o); int e = errno; if (in) logf_("pwrite %s %zu@%ld = %zd", rel(x), n, (long)o, r < 0 ? -errno : r); errno = e; return r; }
ssize_t pwrite(int fd, const void *b, size_t n, off_t o) { REAL(ssize_t, pwrite, int, const void *, size_t, off_t); char x[4096]; int in = fdin(fd, x, sizeof x);
  ssize_t r = r_pwrite(fd, b, n, o); int e = errno; if (in) logf_("pwrite %s %zu@%ld = %zd", rel(x), n, (long)o, r < 0 ? -errno : r); errno = e; return r; }
ssize_t writev(int fd, const struct iovec *v, int c) { REAL(ssize_t, writev, int, const struct iovec *, int); char x[4096]; int in = fdin(fd, x, sizeof x);
  ssize_t r = r_writev(fd, v, c); int e = errno; if (in) logf_("writev %s = %zd", rel(x), r < 0 ? -errno : r); errno = e; return r; }
int fcntl(int fd, int cmd, ...) { REAL(int, fcntl, int, int, ...); va_list a; va_start(a, cmd); void *arg = va_arg(a, void *); va_end(a);
  char x[4096]; int in = (cmd == F_SETLK || cmd == F_SETLKW || cmd == F_GETLK || cmd == F_OFD_SETLK || cmd == F_OFD_GETLK) && fdin(fd, x, sizeof x);
  int r = r_fcntl(fd, cmd, arg); int e = errno;
  if (in) { struct flock *l = arg; logf_("fcntl %s cmd=%d type=%d = %d", rel(x), cmd, l ? l->l_type : -1, RES(r)); }
  errno = e; return r; }
int fcntl64(int fd, int cmd, ...) { REAL(int, fcntl64, int, int, ...); va_list a; va_start(a, cmd); void *arg = va_arg(a, void *); va_end(a);
  char x[4096]; int in = (cmd == F_SETLK || cmd == F_SETLKW || cmd == F_GETLK || cmd == F_OFD_SETLK || cmd == F_OFD_GETLK) && fdin(fd, x, sizeof x);
  int r = r_fcntl64(fd, cmd, arg); int e = errno;
  if (in) { struct flock *l = arg; logf_("fcntl %s cmd=%d type=%d = %d", rel(x), cmd, l ? l->l_type : -1, RES(r)); }
  errno = e; return r; }
int flock(int fd, int op) { REAL(int, flock, int, int); char x[4096]; int in = fdin(fd, x, sizeof x);
  int r = r_flock(fd, op); int e = errno; if (in) logf_("flock %s op=%d = %d", rel(x), op, RES(r)); errno = e; return r; }
