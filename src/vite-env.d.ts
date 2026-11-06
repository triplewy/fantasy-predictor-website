/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL; edge function URLs are built from it. */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
