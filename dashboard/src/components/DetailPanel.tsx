import { useEffect, useState } from 'react';
import { apiGet } from '../api.js';
import type { DeliveryDetail } from '../types.js';

function truncate(s: string | null, n: number) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function ts(iso: string) { return new Date(iso).toISOString().replace('T', ' ').slice(0, 22); }

interface Props {
  deliveryId: string;
  onClose: () => void;
}

export function DetailPanel({ deliveryId, onClose }: Props) {
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    apiGet<DeliveryDetail>('/deliveries/' + deliveryId)
      .then(setDetail)
      .catch((e: unknown) => setError((e as Error).message));
  }, [deliveryId]);

  return (
    <div style={{ width: 440, minWidth: 440, borderLeft: '1px solid var(--border)', background: 'var(--bg)', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
        <span style={{ color: 'var(--text2)', fontSize: 11 }}>DELIVERY {deliveryId.slice(0, 8)}</span>
        <button onClick={onClose} style={{ padding: '2px 6px', fontSize: 11 }}>✕</button>
      </div>

      {error && <div style={{ padding: 12, color: 'var(--failed)', fontSize: 12 }}>error: {error}</div>}

      {detail && (
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 14, fontSize: 12 }}>
          <section>
            <div style={{ color: 'var(--text2)', fontSize: 10, marginBottom: 6, letterSpacing: 1 }}>DELIVERY</div>
            <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '3px 6px', lineHeight: '18px' }}>
              <span style={{ color: 'var(--text2)' }}>id</span><span style={{ fontSize: 11 }}>{detail.id}</span>
              <span style={{ color: 'var(--text2)' }}>status</span><span className={'status-' + detail.status}>{detail.status}</span>
              <span style={{ color: 'var(--text2)' }}>attempts</span><span>{detail.attempt_count}</span>
              <span style={{ color: 'var(--text2)' }}>event_type</span><span>{detail.event.event_type}</span>
              <span style={{ color: 'var(--text2)' }}>endpoint</span><span style={{ fontSize: 11 }}>{detail.endpoint.url}</span>
              {detail.next_attempt_at && <><span style={{ color: 'var(--text2)' }}>next_attempt</span><span>{ts(detail.next_attempt_at)}</span></>}
            </div>
          </section>

          <section>
            <div style={{ color: 'var(--text2)', fontSize: 10, marginBottom: 6, letterSpacing: 1 }}>ATTEMPT TIMELINE</div>
            {detail.attempts.length === 0
              ? <span style={{ color: 'var(--text3)' }}>no attempts yet</span>
              : (
                <table style={{ fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th>#</th><th>outcome</th><th>http</th><th style={{ textAlign: 'right' }}>ms</th><th>started</th><th>body</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.attempts.map((a) => (
                      <tr key={a.attempt_number}>
                        <td>{a.attempt_number}</td>
                        <td className={'outcome-' + a.outcome}>{a.outcome}</td>
                        <td>{a.http_status ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{a.latency_ms}</td>
                        <td style={{ color: 'var(--text2)' }}>{ts(a.started_at)}</td>
                        <td title={a.response_body ?? a.error_message ?? ''} style={{ color: 'var(--text2)' }}>
                          {truncate(a.response_body ?? a.error_message, 40)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </section>

          <section>
            <div style={{ color: 'var(--text2)', fontSize: 10, marginBottom: 6, letterSpacing: 1 }}>TRANSITION CHAIN</div>
            <table style={{ fontSize: 11 }}>
              <thead>
                <tr><th>from</th><th>to</th><th>actor</th><th>reason</th><th>at</th></tr>
              </thead>
              <tbody>
                {detail.transitions.map((t, i) => (
                  <tr key={i}>
                    <td style={{ color: 'var(--text2)' }}>{t.from_status ?? 'null'}</td>
                    <td className={'status-' + t.to_status}>{t.to_status}</td>
                    <td style={{ color: 'var(--text2)' }}>{t.actor}</td>
                    <td style={{ color: 'var(--text2)' }}>{t.reason ?? '—'}</td>
                    <td style={{ color: 'var(--text2)' }}>{ts(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <div style={{ color: 'var(--text2)', fontSize: 10, marginBottom: 6, letterSpacing: 1 }}>EVENT PAYLOAD</div>
            <pre style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, fontSize: 11, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(detail.event.payload, null, 2)}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}
