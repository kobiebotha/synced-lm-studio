import { createClient } from "@supabase/supabase-js";
import { webConfig } from "./config";

export const supabase = createClient(webConfig.supabaseUrl, webConfig.supabaseAnonKey);

export const sharedSupabase = createClient(webConfig.supabaseUrl, webConfig.supabaseAnonKey, {
  auth: {
    storageKey: "synced-lm-studio:shared-auth"
  }
});
