import ExpoModulesCore

/// JavaScript API of `@sequenzy/react-native-geofences` over the native
/// bridge. Calls run on the main queue, where the bridge lives.
public class SequenzyGeofencesModule: Module {
    public func definition() -> ModuleDefinition {
        Name("SequenzyGeofences")

        Events("identityRejected")

        OnCreate {
            SequenzyGeofenceBridge.shared.onIdentityRejected = { [weak self] in
                self?.sendEvent("identityRejected", [:])
            }
        }

        AsyncFunction("configure") {
            (apiBaseUrl: String, companyId: String, publicKey: String, appId: String, userAgent: String) in
            SequenzyGeofenceBridge.shared.configure(
                apiBaseUrl: apiBaseUrl, companyId: companyId, publicKey: publicKey, appId: appId,
                userAgent: userAgent)
        }.runOnQueue(.main)

        /// Resolves true when the native side holds this token as rejected.
        AsyncFunction("setIdentity") { (email: String?, identityToken: String?, externalId: String?) -> Bool in
            SequenzyGeofenceBridge.shared.setIdentity(
                email: email, identityToken: identityToken, externalId: externalId)
        }.runOnQueue(.main)

        AsyncFunction("authorization") { () -> String in
            SequenzyGeofenceBridge.shared.authorization
        }.runOnQueue(.main)

        AsyncFunction("requestAuthorization") { (promise: Promise) in
            SequenzyGeofenceBridge.shared.requestAuthorization { promise.resolve($0) }
        }.runOnQueue(.main)

        AsyncFunction("enable") { (maxRegions: Int?) in
            SequenzyGeofenceBridge.shared.enable(maxRegions: maxRegions)
        }.runOnQueue(.main)

        AsyncFunction("disable") {
            SequenzyGeofenceBridge.shared.disable()
        }.runOnQueue(.main)

        AsyncFunction("refresh") {
            SequenzyGeofenceBridge.shared.refresh(force: true)
        }.runOnQueue(.main)

        // The bridge observes didBecomeActive itself.
        AsyncFunction("resume") {}

        AsyncFunction("status") { () -> [String: Any] in
            let bridge = SequenzyGeofenceBridge.shared
            return [
                "enabled": bridge.isEnabled,
                "authorization": bridge.authorization,
                "preciseLocation": bridge.hasPreciseLocation,
                "regionIds": bridge.registeredRegionIds,
                "queuedEvents": bridge.queuedEventCount,
                "maxRegions": bridge.maxRegions,
            ]
        }.runOnQueue(.main)
    }
}
