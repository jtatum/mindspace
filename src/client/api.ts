import type { Identity } from '../shared/types';

const identityKey = 'mindspace.identity.v1';
export function readIdentity(): Identity | null {
  try {
    const value = JSON.parse(localStorage.getItem(identityKey) ?? 'null');
    return value?.id && value?.token && value?.name ? value : null;
  } catch { return null; }
}
export function saveIdentity(identity: Identity) { localStorage.setItem(identityKey, JSON.stringify(identity)); }
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

export async function withIdentityRecovery<T>(identity: Identity | null, getCurrentIdentity: () => Identity | null, invalidateIdentity: () => void, request: () => Promise<T>): Promise<T> {
  const isCurrent = () => !identity || getCurrentIdentity()?.token === identity.token;
  const staleIdentity = () => new DOMException('The browser identity has changed.', 'AbortError');
  if (!isCurrent()) throw staleIdentity();
  let value: T;
  try { value = await request(); }
  catch (failure) {
    if (identity && isCurrent() && failure instanceof ApiError && failure.status === 401) {
      // Another tab may already have saved a replacement identity.
      if (readIdentity()?.token === identity.token) {
        localStorage.removeItem(identityKey);
        localStorage.removeItem('mindspace.session');
      }
      invalidateIdentity();
    }
    throw failure;
  }
  // An old response must not restore session state after the identity changes.
  if (!isCurrent()) throw staleIdentity();
  return value;
}

export async function api<T>(path: string, identity: Identity | null, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options, credentials: 'same-origin', headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(identity ? { Authorization: `Bearer ${identity.token}` } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ApiError(typeof error?.error === 'string' ? error.error : error?.message ?? `Request failed (${response.status})`, response.status);
  }
  return response.json();
}
export async function downloadSession(sessionId: string, title: string, identity: Identity) {
  const response = await fetch(`/api/sessions/${sessionId}/export`, { credentials: 'same-origin', headers: { Authorization: `Bearer ${identity.token}` } });
  if (!response.ok) throw new ApiError('The session could not be exported. Please try again.', response.status);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = `${title.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'mindspace'}-export.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
