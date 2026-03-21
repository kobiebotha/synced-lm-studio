import { createClient } from "@supabase/supabase-js";
import { webConfig } from "./config";

export const supabase = createClient(webConfig.supabaseUrl, webConfig.supabaseAnonKey);
