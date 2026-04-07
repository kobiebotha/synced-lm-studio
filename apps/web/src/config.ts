function required(name: string, value: string | undefined) {
  if (!value) {
    throw new Error(`Missing required Vite environment variable: ${name}`);
  }

  return value;
}

function optional(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export const webConfig = {
  supabaseUrl: required("VITE_SUPABASE_URL", import.meta.env.VITE_SUPABASE_URL),
  supabaseAnonKey: required("VITE_SUPABASE_ANON_KEY", import.meta.env.VITE_SUPABASE_ANON_KEY),
  powersyncUrl: optional(import.meta.env.VITE_POWERSYNC_URL),
  devEmail: import.meta.env.VITE_DEV_EMAIL ?? "",
  devPassword: import.meta.env.VITE_DEV_PASSWORD ?? ""
};
