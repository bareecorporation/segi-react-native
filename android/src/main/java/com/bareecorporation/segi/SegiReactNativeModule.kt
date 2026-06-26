package com.bareecorporation.segi

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Captures uncaught JVM (Java/Kotlin) crashes on Android, persists them to disk, and
 * replays them to JS on the next launch via [getStoredCrashesAndClear].
 *
 * Native C/C++ (NDK) signal crashes are out of scope; the default uncaught-exception
 * handler covers the large majority of React Native Android crashes.
 */
@ReactModule(name = SegiReactNativeModule.NAME)
class SegiReactNativeModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  @Volatile
  private var installed = false

  @Volatile
  private var watchdogThread: Thread? = null

  @Volatile
  private var mainTick: Long = 0L

  private val mainHandler = Handler(Looper.getMainLooper())

  override fun getName(): String = NAME

  private fun crashDir(): File {
    val dir = File(reactContext.filesDir, "segi-crashes")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  @ReactMethod
  fun install() {
    if (installed) return
    installed = true

    // 1) JVM (Java/Kotlin) uncaught exceptions.
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      try {
        persist(thread, throwable)
      } catch (t: Throwable) {
        Log.w(NAME, "failed to persist crash", t)
      }
      // Chain to the previous handler so RN's red box / OS crash reporting still runs.
      previous?.uncaughtException(thread, throwable)
    }

    // 2) Native (NDK / C++) signal crashes — SIGSEGV, SIGABRT, SIGBUS, ...
    if (nativeAvailable) {
      try {
        installNdkSignalHandlers(crashDir().absolutePath)
      } catch (t: Throwable) {
        Log.w(NAME, "failed to install NDK signal handlers", t)
      }
    }
  }

  /** Installs POSIX signal handlers in native code (implemented in segi_ndk.cpp). */
  private external fun installNdkSignalHandlers(crashDir: String)

  @ReactMethod
  fun startAppHangWatchdog(thresholdMs: Double) {
    if (watchdogThread != null) return
    val threshold = thresholdMs.toLong().coerceAtLeast(1000L)
    val t = Thread {
      while (!Thread.currentThread().isInterrupted) {
        val scheduled = mainTick
        mainHandler.post { mainTick++ } // runs on the main (UI) thread
        try {
          Thread.sleep(threshold)
        } catch (e: InterruptedException) {
          break
        }
        if (mainTick == scheduled) {
          // Main thread did not process the ping within the window → ANR.
          try {
            persistAppHang(threshold, Looper.getMainLooper().thread.stackTrace)
          } catch (e: Throwable) {
            Log.w(NAME, "failed to persist ANR", e)
          }
          // Wait for the main thread to recover so we report each hang once.
          while (mainTick == scheduled && !Thread.currentThread().isInterrupted) {
            try {
              Thread.sleep(threshold)
            } catch (e: InterruptedException) {
              break
            }
          }
        }
      }
    }
    t.isDaemon = true
    t.name = "segi-anr-watchdog"
    watchdogThread = t
    t.start()
  }

  @ReactMethod
  fun stopAppHangWatchdog() {
    watchdogThread?.interrupt()
    watchdogThread = null
  }

  private fun persistAppHang(thresholdMs: Long, mainStack: Array<StackTraceElement>) {
    val stack = StringBuilder("ApplicationNotResponding: main thread blocked for >${thresholdMs}ms\n")
    for (el in mainStack) stack.append("  at ").append(el.toString()).append('\n')
    val json = JSONObject().apply {
      put("platform", "native-android")
      put("name", "ApplicationNotResponding")
      put("message", "Main thread unresponsive for >${thresholdMs}ms")
      put("stack", stack.toString())
      put("timestamp", System.currentTimeMillis())
      put("extra", JSONObject().apply {
        put("kind", "anr")
        put("durationMs", thresholdMs)
        put("thread", "main")
      })
    }
    File(crashDir(), "anr-${System.currentTimeMillis()}.json").writeText(json.toString())
  }

  private fun persist(thread: Thread, throwable: Throwable) {
    val json = JSONObject().apply {
      put("platform", "native-android")
      put("name", throwable.javaClass.name)
      put("message", throwable.message ?: "")
      put("stack", Log.getStackTraceString(throwable))
      put("timestamp", System.currentTimeMillis())
      put("extra", JSONObject().apply { put("thread", thread.name) })
    }
    val file = File(crashDir(), "${System.currentTimeMillis()}-${thread.id}.json")
    file.writeText(json.toString())
  }

  // Returns a JSON-encoded array string (see the codegen spec) so the marshalling
  // surface is identical across both architectures.
  @ReactMethod
  fun getStoredCrashesAndClear(promise: Promise) {
    try {
      val result = JSONArray()
      // .json = JVM crashes, .crash = NDK (SEGI1 text format).
      val files = crashDir().listFiles { f ->
        f.name.endsWith(".json") || f.name.endsWith(".crash")
      } ?: emptyArray()
      // Oldest first.
      files.sortedBy { it.name }.forEach { file ->
        try {
          val obj = if (file.name.endsWith(".crash")) {
            parseNdkCrash(file.readText())
          } else {
            parseJvmCrash(file.readText())
          }
          result.put(obj)
        } catch (t: Throwable) {
          Log.w(NAME, "failed to parse crash file ${file.name}", t)
        } finally {
          file.delete()
        }
      }
      promise.resolve(result.toString())
    } catch (t: Throwable) {
      promise.reject("segi_read_error", t.message, t)
    }
  }

  private fun parseJvmCrash(text: String): JSONObject {
    val obj = JSONObject(text)
    return JSONObject().apply {
      put("platform", obj.optString("platform", "native-android"))
      put("name", obj.optString("name", "NativeError"))
      put("message", obj.optString("message", ""))
      put("stack", obj.optString("stack", ""))
      put("timestamp", obj.optLong("timestamp", 0L))
      put("extra", obj.optJSONObject("extra") ?: JSONObject())
    }
  }

  // SEGI1 text format written by the NDK signal handler (segi_ndk.cpp):
  //   SEGI1
  //   name=<signal>
  //   message=<text>
  //   timestamp=<epoch millis>
  //   ---STACK---
  //   <frames>
  private fun parseNdkCrash(text: String): JSONObject {
    var name = "SIGNAL"
    var message = ""
    var timestamp = 0L
    val stack = StringBuilder()
    var inStack = false
    text.split("\n").forEach { line ->
      when {
        inStack -> if (line.isNotEmpty()) stack.append(line).append('\n')
        line == "---STACK---" -> inStack = true
        line.startsWith("name=") -> name = line.substring(5)
        line.startsWith("message=") -> message = line.substring(8)
        line.startsWith("timestamp=") -> timestamp = line.substring(10).toLongOrNull() ?: 0L
      }
    }
    return JSONObject().apply {
      put("platform", "native-android")
      put("name", name)
      put("message", message)
      put("stack", "$name: $message\n$stack")
      put("timestamp", timestamp)
      put("extra", JSONObject().apply { put("kind", "ndk-signal") })
    }
  }

  companion object {
    const val NAME = "SegiReactNative"

    // Loaded once per process. If the .so is missing (e.g. NDK build skipped),
    // NDK signal capture is disabled but JVM capture still works.
    private val nativeAvailable: Boolean =
      try {
        System.loadLibrary("segi-ndk")
        true
      } catch (t: Throwable) {
        false
      }
  }
}
