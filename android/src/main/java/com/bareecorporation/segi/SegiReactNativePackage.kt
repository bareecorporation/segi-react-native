package com.bareecorporation.segi

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * BaseReactPackage so the module registers under both architectures. On the New
 * Architecture (bridgeless) the ReactModuleInfo with isTurboModule=true is what
 * makes the module discoverable; on the old architecture getModule() is used.
 */
class SegiReactNativePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == SegiReactNativeModule.NAME) SegiReactNativeModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      SegiReactNativeModule.NAME to ReactModuleInfo(
        SegiReactNativeModule.NAME, // name
        SegiReactNativeModule::class.java.name, // className
        false, // canOverrideExistingModule
        false, // needsEagerInit
        false, // isCxxModule
        true, // isTurboModule
      ),
    )
  }
}
