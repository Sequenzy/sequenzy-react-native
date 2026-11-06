/** A circular region from `POST /api/v1/geofences/nearby`, or the refresh
 * region the SDK adds around the device. */
export interface GeofenceRegion {
  id: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export type GeofenceTransition = "enter" | "exit";

/** The nearest active geofences and how far the device can move before
 * others come into reach (null when every geofence was returned). */
export interface NearbyGeofences {
  geofences: GeofenceRegion[];
  refreshRadiusMeters: number | null;
}

/** Registered around the device to know when to fetch again; never reported. */
export const GEOFENCE_REFRESH_REGION_ID = "sequenzy.refresh";
export const DEFAULT_MAX_REGIONS_IOS = 20;
export const DEFAULT_MAX_REGIONS_ANDROID = 50;
export const GEOFENCE_DEBOUNCE_MS = 60_000;
export const GEOFENCE_MIN_REFRESH_INTERVAL_MS = 60_000;
export const GEOFENCE_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Two decimals, about 1.1 km. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

export function geofenceFetchLimit(maxRegions: number): number {
  return Math.max(1, Math.min(99, maxRegions - 1));
}

export function parseGeofenceRegion(value: unknown): GeofenceRegion | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, latitude, longitude, radiusMeters } = value as Record<
    string,
    unknown
  >;
  if (
    typeof id !== "string" ||
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    typeof radiusMeters !== "number"
  ) {
    return null;
  }
  return { id, latitude, longitude, radiusMeters };
}

export function parseNearbyGeofences(
  body: Record<string, unknown> | null
): NearbyGeofences {
  const list = body?.["geofences"];
  const radius = body?.["refreshRadiusMeters"];
  return {
    geofences: Array.isArray(list)
      ? list
          .map(parseGeofenceRegion)
          .filter((region): region is GeofenceRegion => region !== null)
      : [],
    refreshRadiusMeters: typeof radius === "number" ? radius : null,
  };
}

/** Returned geofences (at most `maxRegions - 1`) plus a refresh region on
 * the precise device position when the server says more exist. */
export function planGeofenceRegions(
  nearby: NearbyGeofences,
  position: { latitude: number; longitude: number },
  maxRegions: number
): GeofenceRegion[] {
  const regions = nearby.geofences.slice(0, geofenceFetchLimit(maxRegions));
  const radius = nearby.refreshRadiusMeters;
  if (radius !== null && radius > 0) {
    regions.push({
      id: GEOFENCE_REFRESH_REGION_ID,
      latitude: position.latitude,
      longitude: position.longitude,
      radiusMeters: radius,
    });
  }
  return regions;
}

function sameRegion(a: GeofenceRegion | undefined, b: GeofenceRegion): boolean {
  return (
    a !== undefined &&
    a.id === b.id &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.radiusMeters === b.radiusMeters
  );
}

/** Only the regions that changed. */
export function diffGeofenceRegions(
  registered: GeofenceRegion[],
  planned: GeofenceRegion[]
): { remove: string[]; add: GeofenceRegion[] } {
  const current = new Map(registered.map((region) => [region.id, region]));
  const next = new Map(planned.map((region) => [region.id, region]));
  return {
    remove: registered
      .filter((region) => !sameRegion(next.get(region.id), region))
      .map((region) => region.id),
    add: planned.filter(
      (region) => !sameRegion(current.get(region.id), region)
    ),
  };
}
