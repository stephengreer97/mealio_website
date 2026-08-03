import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Credentials for the differential contract suite.
 *
 * Deliberately NOT read from `.env.local` or from whatever `tests/setup.ts`
 * stuffed into `process.env` — those point at a fake host on purpose, and a
 * contract suite that silently ran against `http://supabase.invalid` would pass
 * by proving nothing. The file is separate, gitignored, and its absence is the
 * signal to skip.
 */
export interface ContractEnv {
  url: string;
  serviceRoleKey: string;
  anonKey: string;
  /** Project ref, taken from the URL host — the management API is keyed by it. */
  projectRef: string;
  /** Supabase CLI personal access token, for DDL. */
  managementToken: string;
}

const ENV_FILE = join(process.cwd(), '.env.contract');
const TOKEN_FILE = join(process.env.HOME ?? '', '.supabase', 'access-token');

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function load(): { env: ContractEnv | null; reason: string } {
  if (!existsSync(ENV_FILE)) {
    return { env: null, reason: 'no .env.contract in the repo root' };
  }
  const raw = parseEnvFile(ENV_FILE);
  const url = raw.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = raw.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = raw.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const missing = [
    ['NEXT_PUBLIC_SUPABASE_URL', url],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', anonKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    return { env: null, reason: `.env.contract is missing ${missing.join(', ')}` };
  }
  if (!existsSync(TOKEN_FILE)) {
    // DDL goes through the management API, so the suite cannot create its own
    // tables without this. Skipping beats falling back to a real table.
    return { env: null, reason: `no Supabase access token at ${TOKEN_FILE} (run \`supabase login\`)` };
  }
  return {
    env: {
      url,
      serviceRoleKey,
      anonKey,
      projectRef: new URL(url).hostname.split('.')[0],
      managementToken: readFileSync(TOKEN_FILE, 'utf8').trim(),
    },
    reason: '',
  };
}

const loaded = load();

export const contractEnv: ContractEnv | null = loaded.env;
export const skipReason: string = loaded.reason;
