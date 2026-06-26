package com.bareecorporation.segi

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import org.json.JSONObject
import java.io.File

/**
 * Captures uncaught JVM (Java/Kotlin) crashes on Android, persists them to disk, and
 * replays them to JS on the next launch via [getStoredCrashesAndClear].
 *
 * Native C/C++ (NDK) signal crashes are out of scope; the default uncaught-exception
 * handler covers the large majority of React Native Android crashes.
 */
class SegiReactNativeModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  @Volatile
  private var installed = false

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

  @ReactMethod
  fun getStoredCrashesAndClear(promise: Promise) {
    try {
      val result: WritableArray = Arguments.createArray()
      val files = crashDir().listFiles { f -> f.name.endsWith(".json") } ?: emptyArray()
      // Oldest first.
      files.sortedBy { it.name }.forEach { file ->
        try {
          val obj = JSONObject(file.readText())
          val map: WritableMap = Arguments.createMap().apply {
            putString("platform", obj.optString("platform", "native-android"))
            putString("name", obj.optString("name", "NativeError"))
            putString("message", obj.optString("message", ""))
            putString("stack", obj.optString("stack", ""))
            putDouble("timestamp", obj.optLong("timestamp", 0L).toDouble())
            val extra = Arguments.createMap()
            obj.optJSONObject("extra")?.let { ex ->
              extra.putString("thread", ex.optString("thread", "unknown"))
            }
            putMap("extra", extra)
          }
          result.pushMap(map)
        } catch (t: Throwable) {
          Log.w(NAME, "failed to parse crash file ${file.name}", t)
        } finally {
          file.delete()
        }
      }
      promise.resolve(result)
    } catch (t: Throwable) {
      promise.reject("segi_read_error", t.message, t)
    }
  }

  companion object {
    const val NAME = "SegiReactNative"
  }
}
