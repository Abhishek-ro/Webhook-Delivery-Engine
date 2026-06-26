import { usePoll, apiGet } from '../api.js';
import type { StatsResponse } from '../types.js';

const STATUSES = ['PENDING', 'DELIVERING', 'DELIVERED', 'FAILED', 'DLQ'] as const;

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function StatusTiles() {
  const { data: stats, error } = usePoll<StatsResponse>(
    () => apiGet('/stats'),
    2_000,
  );

  if (error) {
    return <div style={{ padding: '8px 12px', color: 'var(--failed)', fontSize: 12 }}>stats error: {error}</div>;
  }

  const counts = stats?.deliveries ?? {};
  const delivery = stats?.queues['webhook-delivery'] ?? {};
  const dlqQueue = stats?.queues['webhook-dlq'] ?? {};

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
      {STATUSES.map((s) => (
        <div key={s} className={'status-' + s} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 64, padding: '4px 10px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6 }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{fmt(counts[s] ?? 0)}</span>
          <span style={{ fontSize: 10, color: 'var(--text2)', marginTop: 1 }}>{s}</span>
        </div>
      ))}

      <div style={{ marginLeft: 8, padding: '4px 10px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11, color: 'var(--text2)', lineHeight: '18px' }}>
        <div>queue wait: <span style={{ color: 'var(--text)' }}>{delivery['wait'] ?? 0}</span></div>
        <div>active: <span style={{ color: 'var(--text)' }}>{delivery['active'] ?? 0}</span></div>
        <div>delayed: <span style={{ color: 'var(--text)' }}>{delivery['delayed'] ?? 0}</span></div>
        <div>dlq-q: <span style={{ color: 'var(--dlq)' }}>{dlqQueue['wait'] ?? 0}</span></div>
      </div>

      {stats?.oldest_pending_age_s != null && (
        <div style={{ fontSize: 11, color: 'var(--text2)', padding: '4px 8px' }}>
          oldest pending: <span style={{ color: 'var(--pending)' }}>{stats.oldest_pending_age_s.toFixed(1)}s</span>
        </div>
      )}

      {stats?.backpressure_active && (
        <div style={{ padding: '4px 10px', background: 'rgba(248,81,73,0.15)', border: '1px solid var(--failed)', borderRadius: 6, color: 'var(--failed)', fontSize: 12, fontWeight: 600 }}>
          BACKPRESSURE
        </div>
      )}
    </div>
  );
}
