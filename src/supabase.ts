import { createClient } from "@supabase/supabase-js";

export const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL ?? "https://fkhwdotwrfedwaddaalv.supabase.co";

/** The project's public anon key (safe to ship to browsers; access is enforced server-side). */
const supabaseAnonKey: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseAnonKey);

export const supabase = createClient(supabaseUrl, supabaseAnonKey ?? "missing-anon-key", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Thrown when the API rejects the signed-in user (not signed in, or not on the allowlist). */
export class AccessDeniedError extends Error {
  constructor(public readonly status: number) {
    super(
      status === 403
        ? "Your Google account doesn't have access to this site."
        : "Your session has expired. Please sign in again.",
    );
    this.name = "AccessDeniedError";
  }
}

/**
 * Headers for calling the Supabase edge functions as the signed-in user. getSession()
 * refreshes an expired access token first, so requests always carry a valid one.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AccessDeniedError(401);
  return { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey ?? "" };
}

/** Fetch an edge function as the signed-in user; 401/403 become AccessDeniedError. */
export async function fetchAsUser(url: URL | string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal, headers: await authHeaders() });
  if (response.status === 401) {
    // Token rejected (expired or revoked): sign out so the sign-in screen comes back.
    await supabase.auth.signOut();
    throw new AccessDeniedError(401);
  }
  if (response.status === 403) throw new AccessDeniedError(403);
  return response;
}
