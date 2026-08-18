import { GoogleAuth } from "google-auth-library";

export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function defaultAuthFactory({ scope }) {
  return new GoogleAuth({ scopes: [scope] });
}

/**
 * Create a server-only token provider backed by Application Default Credentials.
 * The credential client is created lazily, so mock mode never reads credentials.
 */
export function createAdcTokenProvider({ authFactory = defaultAuthFactory } = {}) {
  let clientPromise;
  return async ({ scope = CLOUD_PLATFORM_SCOPE } = {}) => {
    clientPromise ||= Promise.resolve(authFactory({ scope })).then((auth) => auth.getClient());
    const client = await clientPromise;
    const result = await client.getAccessToken();
    const token = typeof result === "string" ? result : result?.token;
    if (!token || typeof token !== "string") throw new Error("Google ADC did not return an access token");
    return token;
  };
}
