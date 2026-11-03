/*
 * Some containers (CI runners, cloud dev boxes) cap RLIMIT_NOFILE below the
 * 65535 that nearcore insists on and do not allow raising it. This LD_PRELOAD
 * shim clamps the request to the hard limit instead of failing. It is only
 * ever used for the local sandbox node (scripts/sandbox/start.ts).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/types.h>

struct rl { unsigned long cur, max; };
#define NOFILE 7

typedef int (*getfn)(int, struct rl *);
typedef int (*setfn)(int, const struct rl *);
typedef int (*prfn)(pid_t, int, const struct rl *, struct rl *);

static void clamp(int res, const struct rl *in, struct rl *out) {
  *out = *in;
  if (res != NOFILE) return;
  static getfn get = 0;
  if (!get) get = (getfn)dlsym(RTLD_NEXT, "getrlimit");
  struct rl cur;
  if (get && get(NOFILE, &cur) == 0) {
    if (out->max > cur.max) out->max = cur.max;
    if (out->cur > out->max) out->cur = out->max;
  }
}

int setrlimit(int res, const struct rl *r) {
  static setfn real = 0;
  if (!real) real = (setfn)dlsym(RTLD_NEXT, "setrlimit");
  struct rl c; clamp(res, r, &c);
  return real(res, &c);
}
int setrlimit64(int res, const struct rl *r) { return setrlimit(res, r); }

int prlimit(pid_t pid, int res, const struct rl *nw, struct rl *old) {
  static prfn real = 0;
  if (!real) real = (prfn)dlsym(RTLD_NEXT, "prlimit");
  if (!nw) return real(pid, res, nw, old);
  struct rl c; clamp(res, nw, &c);
  return real(pid, res, &c, old);
}
int prlimit64(pid_t pid, int res, const struct rl *nw, struct rl *old) { return prlimit(pid, res, nw, old); }
