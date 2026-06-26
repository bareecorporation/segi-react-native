#import "SegiReactNative.h"

#import <execinfo.h>
#import <signal.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <fcntl.h>
#import <unistd.h>
#import <time.h>
#import <dlfcn.h>
#import <mach/mach.h>
#import <pthread.h>

// One crash = one file under <Caches>/segi-crashes/. Text format:
//   SEGI1
//   name=<exception class or signal>
//   message=<reason>
//   timestamp=<epoch millis>
//   ---STACK---
//   <call stack, one frame per line>

static NSString *const kSegiDirName = @"segi-crashes";
static NSString *const kSegiStackSep = @"---STACK---";

static NSUncaughtExceptionHandler *gPreviousExceptionHandler = NULL;
static char gCrashDirCPath[1024] = {0};
static volatile sig_atomic_t gCrashCounter = 0;
// Re-entrancy guard: a crash while handling a crash must not recurse forever.
static volatile sig_atomic_t gHandlingCrash = 0;
// Set after the NSException path writes a file, so the follow-up SIGABRT (from the
// runtime calling abort()) doesn't record a duplicate.
static volatile sig_atomic_t gExceptionWritten = 0;
static stack_t gSegiAltStack;

static const int kSegiSignals[] = {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP, SIGSYS};
static const int kSegiSignalCount = (int)(sizeof(kSegiSignals) / sizeof(kSegiSignals[0]));
static struct sigaction gPreviousActions[7];

// App-hang (ANR) watchdog state.
static volatile bool gWatchdogRunning = false;
static thread_t gMainMachThread = MACH_PORT_NULL;
static volatile int64_t gMainTick = 0;

#pragma mark - Paths

static NSString *SegiCrashDir(void) {
  NSArray<NSString *> *paths =
      NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
  NSString *base = paths.firstObject ?: NSTemporaryDirectory();
  return [base stringByAppendingPathComponent:kSegiDirName];
}

static void SegiEnsureDir(void) {
  NSString *dir = SegiCrashDir();
  [[NSFileManager defaultManager] createDirectoryAtPath:dir
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];
  const char *c = dir.fileSystemRepresentation;
  if (c) {
    strncpy(gCrashDirCPath, c, sizeof(gCrashDirCPath) - 1);
    gCrashDirCPath[sizeof(gCrashDirCPath) - 1] = '\0';
  }
}

#pragma mark - NSException handler (Foundation-safe)

static void SegiHandleException(NSException *exception) {
  @try {
    NSString *name = exception.name ?: @"NSException";
    NSString *reason = exception.reason ?: @"";
    NSArray<NSString *> *frames = exception.callStackSymbols ?: @[];
    long long ms = (long long)([[NSDate date] timeIntervalSince1970] * 1000.0);

    NSMutableString *out = [NSMutableString string];
    [out appendString:@"SEGI1\n"];
    [out appendFormat:@"name=%@\n", [name stringByReplacingOccurrencesOfString:@"\n" withString:@" "]];
    [out appendFormat:@"message=%@\n", [reason stringByReplacingOccurrencesOfString:@"\n" withString:@" "]];
    [out appendFormat:@"timestamp=%lld\n", ms];
    [out appendFormat:@"%@\n", kSegiStackSep];
    [out appendString:[frames componentsJoinedByString:@"\n"]];

    NSString *file = [SegiCrashDir()
        stringByAppendingPathComponent:[NSString stringWithFormat:@"%lld.crash", ms]];
    [out writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
    gExceptionWritten = 1;
  } @catch (__unused NSException *ignored) {
  }

  if (gPreviousExceptionHandler) {
    gPreviousExceptionHandler(exception);
  }
}

#pragma mark - Signal handler (async-signal-safe)

static void SegiWriteAll(int fd, const char *buf) {
  size_t len = strlen(buf);
  ssize_t off = 0;
  while ((size_t)off < len) {
    ssize_t w = write(fd, buf + off, len - (size_t)off);
    if (w <= 0) break;
    off += w;
  }
}

static const char *SegiSignalName(int sig) {
  switch (sig) {
    case SIGABRT: return "SIGABRT";
    case SIGBUS: return "SIGBUS";
    case SIGFPE: return "SIGFPE";
    case SIGILL: return "SIGILL";
    case SIGSEGV: return "SIGSEGV";
    case SIGTRAP: return "SIGTRAP";
    case SIGSYS: return "SIGSYS";
    default: return "SIGNAL";
  }
}

static void SegiSignalHandler(int sig, siginfo_t *info, void *uap) {
  // Re-entrancy / duplicate guard. If the NSException path already wrote a file, the
  // ensuing abort()/SIGABRT must not record a second crash for the same event.
  if (gHandlingCrash || gExceptionWritten) {
    for (int i = 0; i < kSegiSignalCount; i++) {
      if (kSegiSignals[i] == sig) {
        sigaction(sig, &gPreviousActions[i], NULL);
        break;
      }
    }
    raise(sig);
    return;
  }
  gHandlingCrash = 1;

  // Build file path: <dir>/sig-<time>-<n>.crash
  char path[1200];
  long now = (long)time(NULL);
  int n = (int)(++gCrashCounter);
  snprintf(path, sizeof(path), "%s/sig-%ld-%d.crash", gCrashDirCPath, now, n);

  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd >= 0) {
    char header[256];
    const char *name = SegiSignalName(sig);
    snprintf(header, sizeof(header),
             "SEGI1\nname=%s\nmessage=Fatal signal %d (%s)\ntimestamp=%ld000\n---STACK---\n",
             name, sig, name, now);
    SegiWriteAll(fd, header);

    void *callstack[128];
    int frames = backtrace(callstack, 128);
    // backtrace_symbols_fd writes directly to fd without malloc.
    backtrace_symbols_fd(callstack, frames, fd);
    close(fd);
  }

  // Restore + re-raise so the OS/previous handler still produces its crash report.
  for (int i = 0; i < kSegiSignalCount; i++) {
    if (kSegiSignals[i] == sig) {
      sigaction(sig, &gPreviousActions[i], NULL);
      break;
    }
  }
  raise(sig);
}

#pragma mark - App-hang (ANR) watchdog

// usleep() is undefined for >= 1s; use nanosleep for arbitrary millisecond waits.
static void SegiSleepMs(long ms) {
  struct timespec ts;
  ts.tv_sec = ms / 1000;
  ts.tv_nsec = (ms % 1000) * 1000000L;
  nanosleep(&ts, NULL);
}

// Suspends the main thread, walks its frame-pointer chain, and writes an
// ApplicationNotResponding record. Runs on the watchdog (background) thread.
static void SegiWriteAppHang(long thresholdMs) {
  if (gMainMachThread == MACH_PORT_NULL) return;
  if (thread_suspend(gMainMachThread) != KERN_SUCCESS) return;

  uintptr_t pcs[64];
  int count = 0;

#if defined(__arm64__)
  arm_thread_state64_t state;
  mach_msg_type_number_t scnt = ARM_THREAD_STATE64_COUNT;
  if (thread_get_state(gMainMachThread, ARM_THREAD_STATE64, (thread_state_t)&state, &scnt) ==
      KERN_SUCCESS) {
    pcs[count++] = (uintptr_t)__darwin_arm_thread_state64_get_pc(state);
    uintptr_t fp = (uintptr_t)__darwin_arm_thread_state64_get_fp(state);
    while (fp && count < 64) {
      uintptr_t *frame = (uintptr_t *)fp;
      uintptr_t ret = frame[1];
      uintptr_t nextFp = frame[0];
      if (!ret) break;
      pcs[count++] = ret;
      if (nextFp <= fp) break;
      fp = nextFp;
    }
  }
#elif defined(__x86_64__)
  x86_thread_state64_t state;
  mach_msg_type_number_t scnt = x86_THREAD_STATE64_COUNT;
  if (thread_get_state(gMainMachThread, x86_THREAD_STATE64, (thread_state_t)&state, &scnt) ==
      KERN_SUCCESS) {
    pcs[count++] = (uintptr_t)state.__rip;
    uintptr_t fp = (uintptr_t)state.__rbp;
    while (fp && count < 64) {
      uintptr_t *frame = (uintptr_t *)fp;
      uintptr_t ret = frame[1];
      uintptr_t nextFp = frame[0];
      if (!ret) break;
      pcs[count++] = ret;
      if (nextFp <= fp) break;
      fp = nextFp;
    }
  }
#endif

  thread_resume(gMainMachThread);

  @try {
    long long ms = (long long)time(NULL) * 1000;
    NSMutableString *out = [NSMutableString string];
    [out appendString:@"SEGI1\n"];
    [out appendString:@"name=ApplicationNotResponding\n"];
    [out appendFormat:@"message=Main thread unresponsive for >%ldms\n", thresholdMs];
    [out appendFormat:@"timestamp=%lld\n", ms];
    [out appendString:@"---STACK---\n"];
    for (int i = 0; i < count; i++) {
      Dl_info info;
      if (dladdr((void *)pcs[i], &info) && info.dli_fbase) {
        uintptr_t off = pcs[i] - (uintptr_t)info.dli_fbase;
        [out appendFormat:@"  #%d pc 0x%lx %s", i, (unsigned long)off,
                          info.dli_fname ? info.dli_fname : "?"];
        if (info.dli_sname) {
          [out appendFormat:@" (%s)", info.dli_sname];
        }
        [out appendString:@"\n"];
      } else {
        [out appendFormat:@"  #%d 0x%lx\n", i, (unsigned long)pcs[i]];
      }
    }
    NSString *file = [SegiCrashDir()
        stringByAppendingPathComponent:[NSString stringWithFormat:@"anr-%lld.crash", ms]];
    [out writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
  } @catch (__unused NSException *ignored) {
  }
}

#pragma mark - Module

@implementation SegiReactNative {
  BOOL _installed;
}

RCT_EXPORT_MODULE(SegiReactNative)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

RCT_EXPORT_METHOD(install) {
  if (_installed) {
    return;
  }
  _installed = YES;

  SegiEnsureDir();

  gPreviousExceptionHandler = NSGetUncaughtExceptionHandler();
  NSSetUncaughtExceptionHandler(&SegiHandleException);

  // Alternate signal stack so a stack-overflow SIGSEGV can still be handled
  // (SA_ONSTACK is a no-op without an installed sigaltstack).
  size_t altSize = MAX((size_t)SIGSTKSZ, (size_t)65536);
  gSegiAltStack.ss_sp = malloc(altSize);
  gSegiAltStack.ss_size = altSize;
  gSegiAltStack.ss_flags = 0;
  if (gSegiAltStack.ss_sp) {
    sigaltstack(&gSegiAltStack, NULL);
  }

  struct sigaction action;
  memset(&action, 0, sizeof(action));
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_SIGINFO | SA_ONSTACK;
  action.sa_sigaction = &SegiSignalHandler;
  for (int i = 0; i < kSegiSignalCount; i++) {
    sigaction(kSegiSignals[i], &action, &gPreviousActions[i]);
  }
}

// Returns a JSON-encoded array string (see the codegen spec) so the marshalling
// surface is identical on both architectures.
RCT_EXPORT_METHOD(getStoredCrashesAndClear
                  : (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  NSMutableArray *result = [NSMutableArray array];
  @try {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *dir = SegiCrashDir();
    NSArray<NSString *> *files = [fm contentsOfDirectoryAtPath:dir error:nil] ?: @[];

    for (NSString *fileName in files) {
      if (![fileName hasSuffix:@".crash"]) {
        continue;
      }
      NSString *full = [dir stringByAppendingPathComponent:fileName];
      NSString *content = [NSString stringWithContentsOfFile:full
                                                    encoding:NSUTF8StringEncoding
                                                       error:nil];
      [fm removeItemAtPath:full error:nil];
      if (content.length == 0) {
        continue;
      }

      NSDictionary *parsed = [SegiReactNative parseCrash:content];
      if (parsed) {
        [result addObject:parsed];
      }
    }

    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    NSString *jsonStr = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"[]";
    resolve(jsonStr ?: @"[]");
  } @catch (NSException *e) {
    reject(@"segi_read_error", e.reason, nil);
  }
}

RCT_EXPORT_METHOD(startAppHangWatchdog : (double)thresholdMs) {
  if (gWatchdogRunning) {
    return;
  }
  gWatchdogRunning = true;
  SegiEnsureDir();

  long threshold = (long)thresholdMs;
  if (threshold < 1000) {
    threshold = 1000;
  }

  // Capture the main thread's mach port from the main thread itself.
  dispatch_async(dispatch_get_main_queue(), ^{
    gMainMachThread = mach_thread_self();
  });

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_BACKGROUND, 0), ^{
    while (gWatchdogRunning) {
      int64_t scheduled = gMainTick;
      dispatch_async(dispatch_get_main_queue(), ^{
        gMainTick++;
      });
      SegiSleepMs(threshold);
      if (!gWatchdogRunning) {
        break;
      }
      if (gMainTick == scheduled && gMainMachThread != MACH_PORT_NULL) {
        // Main thread did not run the ping within the window → app hang.
        SegiWriteAppHang(threshold);
        // Report each hang once: wait until the main thread recovers.
        while (gMainTick == scheduled && gWatchdogRunning) {
          SegiSleepMs(threshold);
        }
      }
    }
  });
}

RCT_EXPORT_METHOD(stopAppHangWatchdog) {
  gWatchdogRunning = false;
}

+ (NSDictionary *)parseCrash:(NSString *)content {
  NSArray<NSString *> *lines = [content componentsSeparatedByString:@"\n"];
  NSString *name = @"NativeError";
  NSString *message = @"";
  long long ts = 0;
  NSMutableArray<NSString *> *stack = [NSMutableArray array];
  BOOL inStack = NO;

  for (NSString *line in lines) {
    if (inStack) {
      if (line.length > 0) {
        [stack addObject:line];
      }
      continue;
    }
    if ([line isEqualToString:kSegiStackSep]) {
      inStack = YES;
    } else if ([line hasPrefix:@"name="]) {
      name = [line substringFromIndex:5];
    } else if ([line hasPrefix:@"message="]) {
      message = [line substringFromIndex:8];
    } else if ([line hasPrefix:@"timestamp="]) {
      ts = [[line substringFromIndex:10] longLongValue];
    }
  }

  return @{
    @"platform": @"native-ios",
    @"name": name,
    @"message": message,
    @"timestamp": @(ts),
    @"stack": [NSString stringWithFormat:@"%@: %@\n%@", name, message,
                                         [stack componentsJoinedByString:@"\n"]],
    @"extra": @{@"thread": @"native"},
  };
}

// New Architecture: vend the codegen-generated TurboModule so the module
// registers under bridgeless. No-op on the old architecture.
#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeSegiReactNativeSpecJSI>(params);
}
#endif

@end
