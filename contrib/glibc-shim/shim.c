/*
 * glibc-only symbols that libsignal's linux prebuild needs and gcompat lacks.
 *
 * On a musl system (postmarketOS, Alpine) the prebuild loads through gcompat
 * (/lib/libgcompat.so.0) only when this library is LD_PRELOADed: it supplies the *64 names and
 * __res_init by forwarding to the musl calls (off_t is 64-bit there). Build it with
 * dev/build-glibc-shim.sh; install it as lib/curlew/libcurlew-glibc-shim.so.
 */
#include <stdio.h>
#include <dirent.h>
#include <fcntl.h>
#include <stdarg.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <resolv.h>
FILE *fopen64(const char *p, const char *m) { return fopen(p, m); }
int fstat64(int fd, struct stat *st) { return fstat(fd, st); }
int stat64(const char *p, struct stat *st) { return stat(p, st); }
off_t lseek64(int fd, off_t o, int w) { return lseek(fd, o, w); }
void *mmap64(void *a, size_t l, int p, int f, int fd, off_t o) { return mmap(a, l, p, f, fd, o); }
int open64(const char *p, int f, ...) { mode_t m = 0; if (f & O_CREAT) { va_list ap; va_start(ap, f); m = va_arg(ap, mode_t); va_end(ap); } return open(p, f, m); }
struct dirent *readdir64(DIR *d) { return readdir(d); }
int __res_init(void) { return res_init(); }
