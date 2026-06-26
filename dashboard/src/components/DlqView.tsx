import { useState, useCallback } from 'react';
import { apiGet, apiPost, usePoll } from '../api.js';
import type { DlqResponse, DlqItem } from '../types.js';

function shortId(id: string) { return id.slice(0, 8); }
function ts(iso: string) { return new Date(iso).toISOString().replace('T', ' ').slice(0, 19); }

export function DlqView() {
  const [rows, setRows] = useState<DlqItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  const fetchPage = useCallback(async (cursor?: string) => {
    const params: Record<string, string> = { limit: '50' };
    if (cursor) params['cursor'] = cursor;
    return apiGet<DlqResponse>('/dlq', params);
  }, []);

  const { error } = usePoll<DlqResponse>(
    useCallback(async () => {
      const r = await fetchPage();
      setRows(r.data);
      setNextCursor(r.next_cursor);
      return r;
    }, [fetchPage]),
    2_000,
  );

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetchPage(nextCursor);
      setRows((prev) => [...prev, ...r.data]);
      setNextCursor(r.next_cursor);
    } finally {
      setLoadingMore(false);
    }
  }

  async function retry(id: string) {
    setRetrying((s) => new Set(s).add(id));
    try {
      await apiPost('/dlq/' + id + '/retry');
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      const err = e as { code?: string; details?: { current_status?: string } };
      const msg = err.code === 'NOT_IN_DLQ'
        ? 'Not in DLQ — current status: ' + (err.details?.current_status ?? '?')
        : (e instanceof Error ? e.message : String(e));
      setToast(msg);
      setTimeout(() => setToast(null), 4_000);
    } finally {
      setRetrying((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'auto', position: 'relative' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 12, right: 12, background: 'var(--bg3)', border: '1px solid var(--failed)', borderRadius: 6, padding: '8px 14px', color: 'var(--failed)', fontSize: 12, zIndex: 100 }}>
          {toast}
        </div>
      )}

      {error && <div style={{ padding: 12, color: 'var(--failed)', fontSize: 12 }}>error: {error}</div>}

      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>event_type</th>
            <th style={{ textAlign: 'right' }}>attempts</th>
            <th>entered_dlq</th>
            <th>updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td style={{ color: 'var(--text2)', fontFamily: 'monospace' }}>{shortId(row.id)}</td>
              <td>{row.event_type}</td>
              <td style={{ textAlign: 'right' }}>{row.attempt_count}</td>
              <td style={{ color: 'var(--text2)' }}>{ts(row.dlq_entered_at)}</td>
              <td style={{ color: 'var(--text2)' }}>{ts(row.updated_at)}</td>
              <td>
                <button
                  onClick={() => void retry(row.id)}
                  disabled={retrying.has(row.id)}
                  style={{ fontSize: 11, padding: '2px 8px', color: 'var(--accent)', borderColor: 'var(--accent)' }}
                >
                  {retrying.has(row.id) ? '…' : 'retry'}
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>DLQ is empty</td></tr>
          )}
        </tbody>
      </table>

      {nextCursor && (
        <div style={{ padding: '8px 12px' }}>
          <button onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'loading…' : 'load more'}
          </button>
        </div>
      )}
    </div>
  );
}
