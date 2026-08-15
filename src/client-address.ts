import { isIP } from "node:net";

/**
 * Reserved request header containing the TCP peer address authenticated by the Node adapter.
 * Any value supplied by the HTTP client is overwritten before application dispatch.
 */
export const CLIENT_ADDRESS_HEADER = "x-askr-client-address";

/** Normalizes the socket peer address used for the adapter-authenticated request header. */
export function normalizeClientAddress(address: string | undefined): string {
  if (!address) return "unknown";
  if (address.toLowerCase().startsWith("::ffff:")) {
    const mapped = address.slice(7);
    if (isIP(mapped) === 4) return mapped;
  }
  return address;
}
