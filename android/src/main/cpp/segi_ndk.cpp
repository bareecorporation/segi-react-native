// NDK (native C/C++) crash capture for Android.
//
// The JVM `Thread.setDefaultUncaughtExceptionHandler` only sees Java/Kotlin crashes.
// Native crashes (Hermes engine, native libs, JNI) arrive as POSIX signals and must be
// caught with sigaction. The handler runs in an async-signal-limited context, so it only
// uses low-level write()/open() and an unwind walk, then persists a crash file in the same
// `SEGI1` text format the iOS signal handler uses. Files are replayed to Segi on next launch.

#include <dlfcn.h>
#include <fcntl.h>
#include <jni.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <unwind.h>

#define SEGI_MAX_FRAMES 64

static char g_crash_dir[1024] = {0};
static int g_installed = 0;
static volatile sig_atomic_t g_handling = 0;

static const int kSignals[] = {SIGSEGV, SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGTRAP, SIGSYS};
static const int kSignalCount = (int)(sizeof(kSignals) / sizeof(kSignals[0]));
static struct sigaction g_prev[7];
static stack_t g_alt_stack;

// ---- async-signal-safe writers -------------------------------------------------

static void writeStr(int fd, const char *s) {
  if (s) {
    size_t len = strlen(s);
    ssize_t off = 0;
    while ((size_t)off < len) {
      ssize_t w = write(fd, s + off, len - (size_t)off);
      if (w <= 0) break;
      off += w;
    }
  }
}

static void writeNum(int fd, long n) {
  char buf[32];
  int i = 30;
  buf[31] = '\0';
  if (n == 0) {
    writeStr(fd, "0");
    return;
  }
  int neg = n < 0;
  unsigned long u = neg ? (unsigned long)(-n) : (unsigned long)n;
  while (u && i > 0) {
    buf[i--] = (char)('0' + (u % 10));
    u /= 10;
  }
  if (neg) buf[i--] = '-';
  write(fd, buf + i + 1, (size_t)(30 - i));
}

static void writeHex(int fd, uintptr_t a) {
  static const char *hx = "0123456789abcdef";
  char buf[20];
  int i = 18;
  buf[19] = '\0';
  writeStr(fd, "0x");
  if (a == 0) {
    writeStr(fd, "0");
    return;
  }
  while (a && i > 0) {
    buf[i--] = hx[a & 0xf];
    a >>= 4;
  }
  write(fd, buf + i + 1, (size_t)(18 - i));
}

static const char *sigName(int s) {
  switch (s) {
    case SIGSEGV: return "SIGSEGV";
    case SIGABRT: return "SIGABRT";
    case SIGBUS: return "SIGBUS";
    case SIGFPE: return "SIGFPE";
    case SIGILL: return "SIGILL";
    case SIGTRAP: return "SIGTRAP";
    case SIGSYS: return "SIGSYS";
    default: return "SIGNAL";
  }
}

// ---- stack unwind (libgcc/llvm _Unwind, available on all Android ABIs) ----------

struct BacktraceState {
  void **current;
  void **end;
};

static _Unwind_Reason_Code unwindCallback(struct _Unwind_Context *ctx, void *arg) {
  struct BacktraceState *st = (struct BacktraceState *)arg;
  uintptr_t pc = _Unwind_GetIP(ctx);
  if (pc) {
    if (st->current == st->end) return _URC_END_OF_STACK;
    *st->current++ = (void *)pc;
  }
  return _URC_NO_REASON;
}

static size_t captureBacktrace(void **buffer, size_t max) {
  struct BacktraceState st = {buffer, buffer + max};
  _Unwind_Backtrace(unwindCallback, &st);
  return (size_t)(st.current - buffer);
}

// ---- signal handler ------------------------------------------------------------

static void restoreAndReraise(int sig) {
  for (int i = 0; i < kSignalCount; i++) {
    if (kSignals[i] == sig) {
      sigaction(sig, &g_prev[i], NULL);
      break;
    }
  }
  raise(sig);
}

static void segiSignalHandler(int sig, siginfo_t *info, void *uc) {
  (void)info;
  (void)uc;

  // Re-entrancy guard: a crash inside the handler must chain out, not recurse.
  if (g_handling) {
    restoreAndReraise(sig);
    return;
  }
  g_handling = 1;

  if (g_crash_dir[0]) {
    long t = (long)time(NULL);
    char path[1200];
    snprintf(path, sizeof(path), "%s/ndk-%ld-%d.crash", g_crash_dir, t, sig);

    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd >= 0) {
      writeStr(fd, "SEGI1\nname=");
      writeStr(fd, sigName(sig));
      writeStr(fd, "\nmessage=Fatal native signal ");
      writeNum(fd, sig);
      writeStr(fd, " (");
      writeStr(fd, sigName(sig));
      writeStr(fd, ")\ntimestamp=");
      writeNum(fd, t);
      writeStr(fd, "000\n---STACK---\n");

      // ndk-stack / addr2line friendly frames:
      //   #NN pc <module-relative offset>  <lib path> (<symbol>+<sym offset>)
      // The module-relative offset (pc - load base) is what addr2line needs against
      // the unstripped .so; absolute runtime addresses alone are not symbolicatable.
      void *frames[SEGI_MAX_FRAMES];
      size_t n = captureBacktrace(frames, SEGI_MAX_FRAMES);
      for (size_t i = 0; i < n; i++) {
        Dl_info dlinfo;
        writeStr(fd, "  #");
        if (i < 10) writeStr(fd, "0");
        writeNum(fd, (long)i);
        writeStr(fd, " pc ");
        if (dladdr(frames[i], &dlinfo) && dlinfo.dli_fbase) {
          uintptr_t offset = (uintptr_t)frames[i] - (uintptr_t)dlinfo.dli_fbase;
          writeHex(fd, offset);
          writeStr(fd, "  ");
          writeStr(fd, dlinfo.dli_fname ? dlinfo.dli_fname : "<unknown>");
          if (dlinfo.dli_sname) {
            writeStr(fd, " (");
            writeStr(fd, dlinfo.dli_sname);
            if (dlinfo.dli_saddr) {
              writeStr(fd, "+");
              writeHex(fd, (uintptr_t)frames[i] - (uintptr_t)dlinfo.dli_saddr);
            }
            writeStr(fd, ")");
          }
        } else {
          writeHex(fd, (uintptr_t)frames[i]);
          writeStr(fd, "  <unknown>");
        }
        writeStr(fd, "\n");
      }
      close(fd);
    }
  }

  // Restore the previous disposition and re-raise so ART/Tombstone still records it.
  restoreAndReraise(sig);
}

// ---- JNI entry -----------------------------------------------------------------

extern "C" JNIEXPORT void JNICALL
Java_com_bareecorporation_segi_SegiReactNativeModule_installNdkSignalHandlers(
    JNIEnv *env, jobject thiz, jstring crashDir) {
  (void)thiz;
  if (g_installed) return;

  const char *dir = env->GetStringUTFChars(crashDir, NULL);
  if (dir) {
    strncpy(g_crash_dir, dir, sizeof(g_crash_dir) - 1);
    g_crash_dir[sizeof(g_crash_dir) - 1] = '\0';
    env->ReleaseStringUTFChars(crashDir, dir);
  }

  // Alternate stack so SIGSEGV from stack overflow can still be handled.
  size_t altSize = (size_t)(SIGSTKSZ > 65536 ? SIGSTKSZ : 65536);
  g_alt_stack.ss_sp = malloc(altSize);
  g_alt_stack.ss_size = altSize;
  g_alt_stack.ss_flags = 0;
  if (g_alt_stack.ss_sp) {
    sigaltstack(&g_alt_stack, NULL);
  }

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_SIGINFO | SA_ONSTACK;
  sa.sa_sigaction = segiSignalHandler;
  for (int i = 0; i < kSignalCount; i++) {
    sigaction(kSignals[i], &sa, &g_prev[i]);
  }
  g_installed = 1;
}
