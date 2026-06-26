import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../api.js';
import type { DeliveryListItem, DeliveryListResponse, Filters } from '../types.js';

function shortId(id: string) { return id.slice(0, 8); }
function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  return Math.floor(diff / 3_600_000) + 'h ago';
}

interface Props {
  filters: Filters;
  selectedId: string | null;
  onSelect: (id: string) => void;
  pollMs: number;
}

export function DeliveryTable({ filters, selectedId, onSelect, pollMs }: Props) {
  const [rows, setRows] = useState<DeliveryListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);

  function buildParams(cursor?: string): Record<string, string> {
    const p: Record<string, string> = { limit: '50' };
    if (filters.statuses.length > 0) p['status'] = filters.statuses.join(',');
    if (filters.endpoint_id) p['endpoint_id'] = filters.endpoint_id;
    if (filters.from) p['from'] = new Date(filters.from).toISOString();
    if (filters.to) p['to'] = new Date(filters.to).toISOString();
    if (cursor) p['cursor'] = cursor;
    return p;
  }

  useEffect(() => {
    let cancelled = false;
    cursorRef.current = null;

    function fetch1() {
      if (cancelled) return;
      apiGet<DeliveryListResponse>('/deliveries', buildParams())
        .then((r) => {
          if (cancelled) return;
          setRows(r.data);
          setNextCursor(r.next_cursor);
          setError(null);
        })
        .catch((e: unknown) => { if (!cancelled) setError((e as Error).message); });
    }

    fetch1();
    const id = setInterval(fetch1, pollMs);
    const onVisible = () => { if (document.visibilityState === 'visible') fetch1(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [filters.statuses.join(','), filters.endpoint_id, filters.from, filters.to, pollMs]);

  async function loadMore() {
    if (!nextCursor || loading) return;
    setLoading(true);
    try {
      const r = await apiGet<DeliveryListResponse>('/deliveries', buildParams(nextCursor));
      setRows((prev) => [...prev, ...r.data]);
      setNextCursor(r.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (error) return <div style={{ padding: 12, color: 'var(--failed)', fontSize: 12 }}>error: {error}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'auto', flex: 1 }}>
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>event_type</th>
            <th>status</th>
            <th style={{ textAlign: 'right' }}>attempts</th>
            <th>next_attempt</th>
            <th>updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => onSelect(row.id)}
              style={{ cursor: 'pointer', background: selectedId === row.id ? 'var(--bg3)' : undefined }}
            >
              <td style={{ color: 'var(--text2)', fontFamily: 'monospace' }}>{shortId(row.id)}</td>
              <td>{row.event_type}</td>
              <td className={'status-' + row.status}>{row.status}</td>
              <td style={{ textAlign: 'right' }}>{row.attempt_count}</td>
              <td style={{ color: 'var(--text2)' }}>{row.next_attempt_at ? relTime(row.next_attempt_at) : '—'}</td>
              <td style={{ color: 'var(--text2)' }}>{relTime(row.updated_at)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>no deliveries</td></tr>
          )}
        </tbody>
      </table>
      {nextCursor && (
        <div style={{ padding: '8px 12px' }}>
          <button onClick={() => void loadMore()} disabled={loading}>
            {loading ? 'loading…' : 'load more'}
          </button>
        </div>
      )}
    </div>
  );
}
