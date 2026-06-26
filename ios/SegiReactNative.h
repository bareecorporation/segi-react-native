#import <React/RCTBridgeModule.h>

// On the New Architecture, conform to the codegen-generated TurboModule protocol
// so the module registers under bridgeless. On the old architecture, a plain
// RCTBridgeModule is enough.
#ifdef RCT_NEW_ARCH_ENABLED
#import <SegiReactNativeSpec/SegiReactNativeSpec.h>
@interface SegiReactNative : NSObject <NativeSegiReactNativeSpec>
#else
@interface SegiReactNative : NSObject <RCTBridgeModule>
#endif
@end
