/**
 * Stands in for `jsonwebtoken` in the browser bundle of the Circle Web SDK
 * (scripts/circle-client.js), which only ever calls decode(): read a JWT's
 * payload without verifying it. Returns null for anything that isn't one.
 */
export function decode(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const text = decodeURIComponent(Array.from(atob(b64), (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export default { decode };
