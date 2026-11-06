import ExpoModulesCore

/// Attaches the location delegate at launch, including the background
/// launches iOS makes to deliver a region event, before JavaScript runs.
public class SequenzyGeofencesAppDelegateSubscriber: ExpoAppDelegateSubscriber {
    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        SequenzyGeofenceBridge.shared.start()
        return true
    }
}
