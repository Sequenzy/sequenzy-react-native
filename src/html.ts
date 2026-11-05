/**
 * Custom HTML in-app messages: the calls the Sequenzy JS bridge (injected by
 * the server into every document) sends to the app, and the links a message
 * may open. Wire shape (protocol v1):
 * `{ "__sequenzyInApp": 1, "method": ..., "args": {...} }`.
 */

import type { JsonValue } from "./types";

export type InAppHtmlBridgeMessage =
  | { method: "close" }
  | { method: "openUrl"; url: string; external: boolean; buttonId?: string }
  | { method: "logClick"; buttonId?: string }
  | { method: "track"; name: string; properties: Record<string, JsonValue> }
  | { method: "setAttributes"; attributes: Record<string, JsonValue> }
  | { method: "setName"; firstName?: string; lastName?: string };

/** Messages larger than this are dropped, as the bridge itself does. */
export const IN_APP_HTML_MAX_MESSAGE_BYTES = 32 * 1024;
/** Bridge calls honored per display; the rest are dropped. */
export const IN_APP_HTML_MAX_CALLS_PER_DISPLAY = 50;
/**
 * Where custom HTML documents load: a fixed https origin Sequenzy owns, so
 * the document has a real origin (local storage works for survey scripts)
 * that is never the app's own web content.
 */
export const IN_APP_HTML_BASE_URL = "https://in-app.sequenzy.com/";

const BUTTON_ID = /^[A-Za-z0-9 _-]{1,255}$/;
const BLOCKED_SCHEMES = new Set([
  "http",
  "javascript",
  "data",
  "vbscript",
  "file",
  "blob",
  "about",
  "filesystem",
]);

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Braze's logClick id rule: 1-255 letters, numbers, spaces, dashes or underscores. */
export function isValidInAppButtonId(id: string): boolean {
  return BUTTON_ID.test(id);
}

/** https, or an app scheme (myapp://, mailto:, tel:); never script, data, file or plain-http URLs. */
export function isAllowedInAppUrl(url: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  if (!match) return false;
  const scheme = (match[1] ?? "").toLowerCase();
  return scheme === "https" || !BLOCKED_SCHEMES.has(scheme);
}

/** Parses one bridge message (the WebView's `onMessage` data); null drops it. */
export function parseInAppHtmlBridgeMessage(
  raw: string
): InAppHtmlBridgeMessage | null {
  if (raw.length > IN_APP_HTML_MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value["__sequenzyInApp"] !== 1) return null;
  const args = isRecord(value["args"]) ? value["args"] : {};
  const string = (key: string, max = 255) => {
    const candidate = args[key];
    return typeof candidate === "string" && candidate !== ""
      ? candidate.slice(0, max)
      : undefined;
  };
  const buttonId = string("buttonId");
  const button = buttonId && isValidInAppButtonId(buttonId) ? { buttonId } : {};
  switch (value["method"]) {
    case "close":
      return { method: "close" };
    case "openUrl": {
      const url = string("url", 2048);
      return url
        ? {
            method: "openUrl",
            url,
            external: args["external"] === true,
            ...button,
          }
        : null;
    }
    case "logClick":
      return { method: "logClick", ...button };
    case "track": {
      const name = string("name");
      if (!name) return null;
      const properties = args["properties"];
      return {
        method: "track",
        name,
        properties: isRecord(properties) ? properties : {},
      };
    }
    case "setAttributes": {
      const attributes = args["attributes"];
      return isRecord(attributes)
        ? { method: "setAttributes", attributes }
        : null;
    }
    case "setName": {
      const firstName = string("firstName");
      const lastName = string("lastName");
      if (!firstName && !lastName) return null;
      return {
        method: "setName",
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {}),
      };
    }
    default:
      return null;
  }
}
