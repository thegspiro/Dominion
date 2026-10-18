export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    const name = index < 0 ? '' : part.slice(0, index).trim();
    if (name === '') {
      continue;
    }
    const raw = part.slice(index + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      continue;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}
