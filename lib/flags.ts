/**
 * Runtime feature flags via Vercel Edge Config.
 * Toggle values in the Vercel dashboard — no redeploy needed.
 * Falls back to false if Edge Config is not configured.
 */

let edgeConfig: typeof import('@vercel/edge-config') | null = null;

async function getEdgeConfig() {
  if (!process.env.EDGE_CONFIG) return null;
  if (!edgeConfig) edgeConfig = await import('@vercel/edge-config');
  return edgeConfig;
}

export async function getFlag(key: string, defaultValue = false): Promise<boolean> {
  try {
    const cfg = await getEdgeConfig();
    if (!cfg) return defaultValue;
    const value = await cfg.get<boolean>(key);
    return value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}
