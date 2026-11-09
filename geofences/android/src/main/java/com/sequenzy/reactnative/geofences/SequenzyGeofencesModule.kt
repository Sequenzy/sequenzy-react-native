package com.sequenzy.reactnative.geofences

import android.content.Context
import com.sequenzy.geofences.bridge.SequenzyGeofenceBridge
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JavaScript API of `@sequenzy/react-native-geofences` over the native
 * bridge. Transitions are handled by the bridge's broadcast receiver, which
 * needs no JavaScript.
 */
class SequenzyGeofencesModule : Module() {
    private val context: Context
        get() = requireNotNull(appContext.reactContext) { "React context is not available" }.applicationContext

    override fun definition() = ModuleDefinition {
        Name("SequenzyGeofences")

        Events("identityRejected")

        OnCreate {
            SequenzyGeofenceBridge.onIdentityRejected = { sendEvent("identityRejected", emptyMap<String, Any>()) }
        }

        OnDestroy {
            SequenzyGeofenceBridge.onIdentityRejected = null
        }

        AsyncFunction("configure") { apiBaseUrl: String, companyId: String, publicKey: String, appId: String, userAgent: String ->
            SequenzyGeofenceBridge.configure(context, apiBaseUrl, companyId, publicKey, appId, userAgent)
        }

        // Resolves true when the native side holds this token as rejected.
        AsyncFunction("setIdentity") { email: String?, identityToken: String?, externalId: String?, promise: Promise ->
            SequenzyGeofenceBridge.setIdentity(context, email, identityToken, externalId) { rejected ->
                promise.resolve(rejected)
            }
        }

        AsyncFunction("authorization") { SequenzyGeofenceBridge.authorization(context) }

        AsyncFunction("requestAuthorization") { promise: Promise -> requestAuthorization(promise) }

        AsyncFunction("enable") { maxRegions: Int? -> SequenzyGeofenceBridge.enable(context, maxRegions) }

        AsyncFunction("disable") { SequenzyGeofenceBridge.disable(context) }

        AsyncFunction("refresh") { SequenzyGeofenceBridge.refresh(context, force = true) }

        AsyncFunction("resume") { SequenzyGeofenceBridge.resume(context) }

        AsyncFunction("status") {
            mapOf(
                "enabled" to SequenzyGeofenceBridge.isEnabled(context),
                "authorization" to SequenzyGeofenceBridge.authorization(context),
                "preciseLocation" to SequenzyGeofenceBridge.hasPreciseLocation(context),
                "regionIds" to SequenzyGeofenceBridge.registeredRegionIds(context),
                "queuedEvents" to SequenzyGeofenceBridge.queuedEventCount(context),
                "maxRegions" to SequenzyGeofenceBridge.maxRegions(context),
            )
        }
    }

    /** Foreground location first, then background location in a second request (Android 10+). */
    private fun requestAuthorization(promise: Promise, step: Int = 0) {
        val permissions = SequenzyGeofenceBridge.permissionsToRequest(context)
        val manager = appContext.permissions
        if (permissions.isEmpty() || manager == null || step > 1) {
            promise.resolve(SequenzyGeofenceBridge.authorization(context))
            return
        }
        SequenzyGeofenceBridge.markPermissionAsked(context)
        manager.askForPermissions(
            PermissionsResponseListener { _ ->
                val next = SequenzyGeofenceBridge.permissionsToRequest(context)
                if (next.isNotEmpty() && !next.contentEquals(permissions)) {
                    requestAuthorization(promise, step + 1)
                } else {
                    val authorization = SequenzyGeofenceBridge.authorization(context)
                    if (authorization == "always") SequenzyGeofenceBridge.refresh(context, force = true)
                    promise.resolve(authorization)
                }
            },
            *permissions,
        )
    }
}
