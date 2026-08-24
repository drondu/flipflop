import { createClient } from "@supabase/supabase-js";

/* Vite inlines these at build time; injected by CI from repo secrets/vars.
   The anon key is meant to be public — row-level security is what protects
   the data, so never put the service_role key here. */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;
