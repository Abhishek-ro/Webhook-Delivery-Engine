import { useEffect, useState } from 'react';
import { apiGet } from '../api.js';
import type { Filters, Endpoint } from '../types.js';

const ALL_STATUSES = ['PENDING', 'DELIVERING', 'DELIVERED', 'FAILED', 'DLQ'];

interface Props {
  value: Filters;
  onChange: (f: Filters) => void;
}

export function FiltersBar({ value, onChange }: Props) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);

  useEffect(() => {
    apiGet<{ data: Endpoint[] }>('/endpoints')
      .then((r) => setEndpoints(r.data))
      .catch(() => {});
  }, []);

  function toggleStatus(s: string) {
    const next = value.statuses.includes(s)
      ? value.statuses.filter((x) => x !== s)
      : [...value.statuses, s];
    onChange({ ...value, statuses: next });
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', background: 'var(--bg2)' }}>
      <span style={{ color: 'var(--text2)', fontSize: 11 }}>STATUS</span>
      {ALL_STATUSES.map((s) => (
        <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12 }} className={'status-' + s}>
          <input
            type="checkbox"
            checked={value.statuses.includes(s)}
            onChange={() => toggleStatus(s)}
            style={{ accentColor: 'currentColor', width: 12, height: 12 }}
          />
          {s}
        </label>
      ))}

      <span style={{ color: 'var(--text2)', fontSize: 11, marginLeft: 8 }}>ENDPOINT</span>
      <select
        value={value.endpoint_id}
        onChange={(e) => onChange({ ...value, endpoint_id: e.target.value })}
        style={{ width: 220 }}
      >
        <option value="">— all endpoints —</option>
        {endpoints.map((ep) => (
          <option key={ep.id} value={ep.id}>{ep.url}</option>
        ))}
      </select>

      <span style={{ color: 'var(--text2)', fontSize: 11, marginLeft: 8 }}>FROM</span>
      <input type="datetime-local" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} style={{ width: 160 }} />
      <span style={{ color: 'var(--text2)', fontSize: 11 }}>TO</span>
      <input type="datetime-local" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} style={{ width: 160 }} />

      <button onClick={() => onChange({ statuses: [], endpoint_id: '', from: '', to: '' })} style={{ marginLeft: 4 }}>
        clear
      </button>
    </div>
  );
}
