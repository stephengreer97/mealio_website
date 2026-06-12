// Env vars the lib modules read lazily. None of these reach a real service:
// Supabase and Resend are mocked per test file, and JWT signing is local.
process.env.JWT_SECRET = 'test-jwt-secret-not-production';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.RESEND_API_KEY = 're_test_key';
