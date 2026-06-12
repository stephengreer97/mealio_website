import { NextRequest } from 'next/server';

type Options = {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
};

/** Build a NextRequest the way clients hit the API: JSON body + Bearer token. */
export function jsonRequest(path: string, opts: Options = {}): NextRequest {
  const { method = 'POST', body, token, headers = {}, cookies = {} } = opts;
  const h = new Headers({ 'content-type': 'application/json', ...headers });
  if (token) h.set('authorization', `Bearer ${token}`);
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) h.set('cookie', cookie);
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: h,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
