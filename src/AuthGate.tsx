import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "./supabase";

/**
 * Shows a Google sign-in screen until the user has a Supabase session, then renders the app.
 * This only gates the UI; the edge functions enforce access by verifying the user's token.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setIsLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  async function signIn() {
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      // Return to this page (works on localhost and under the GitHub Pages base path).
      options: { redirectTo: window.location.origin + import.meta.env.BASE_URL },
    });
    if (signInError) setError(signInError.message);
  }

  if (!isSupabaseConfigured) {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <h1>Not configured</h1>
          <p className="auth-text">
            Set <code>VITE_SUPABASE_ANON_KEY</code> (see <code>.env.example</code>) and rebuild.
          </p>
        </div>
      </main>
    );
  }

  if (isLoading) {
    return (
      <main className="auth-screen">
        <p className="auth-text" role="status">Loading...</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <p className="eyebrow">FANTASY FOOTBALL</p>
          <h1>Player projections</h1>
          <p className="auth-text">Sign in with your Google account to continue.</p>
          <button type="button" className="google-button" onClick={signIn}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
              <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z" />
              <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
              <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.8-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
            </svg>
            Sign in with Google
          </button>
          {error && <p className="auth-text error-state" role="alert">{error}</p>}
        </div>
      </main>
    );
  }

  return (
    <>
      <div className="auth-bar">
        <span>{session.user.email}</span>
        <button type="button" className="row-action" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </div>
      {children}
    </>
  );
}
