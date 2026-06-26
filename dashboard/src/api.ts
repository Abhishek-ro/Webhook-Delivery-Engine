import { useEffect, useRef, useState, useCallback } from 'react';

const BASE = '/api/v1';

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    const err = (body as { error?: { message?: string; code?: string; details?: unknown } }).error;
    throw Object.assign(new Error(err?.message ?? res.statusText), {
      status: res.status,
      code: err?.code,
      details: err?.details,
    });
  }
  return res.json() as Promise<T>;
}

export function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return apiFetch<T>(path + qs);
}

export function apiPost<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: 'POST' });
}

export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number,
): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(() => {
    if (document.visibilityState === 'hidden') return;
    fnRef.current()
      .then((d) => { setData(d); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    run();
    const id = setInterval(run, intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [run, intervalMs]);

  return { data, error, refresh: run };
}
