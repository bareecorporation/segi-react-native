#import "SegiReactNative.h"

#import <execinfo.h>
#import <signal.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <fcntl.h>
#import <unistd.h>
#import <time.h>

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

static const int kSegiSignals[] = {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP};
static const int kSegiSignalCount = (int)(sizeof(kSegiSignals) / sizeof(kSegiSignals[0]));
static struct sigaction gPreviousActions[6];

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
    default: return "SIGNAL";
  }
}

static void SegiSignalHandler(int sig, siginfo_t *info, void *uap) {
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

  struct sigaction action;
  memset(&action, 0, sizeof(action));
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_SIGINFO | SA_ONSTACK;
  action.sa_sigaction = &SegiSignalHandler;
  for (int i = 0; i < kSegiSignalCount; i++) {
    sigaction(kSegiSignals[i], &action, &gPreviousActions[i]);
  }
}

RCT_EXPORT_METHOD(getStoredCrashesAndClear
                  : (RCTPromiseResolveBlock)resolve
                  : (RCTPromiseRejectBlock)reject) {
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
  } @catch (NSException *e) {
    reject(@"segi_read_error", e.reason, nil);
    return;
  }
  resolve(result);
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

@end
