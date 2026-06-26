import { useState } from 'react';
import { StatusTiles } from './components/StatusTiles.js';
import { FiltersBar } from './components/Filters.js';
import { DeliveryTable } from './components/DeliveryTable.js';
import { DetailPanel } from './components/DetailPanel.js';
import { DlqView } from './components/DlqView.js';
import type { Filters } from './types.js';

const EMPTY_FILTERS: Filters = { statuses: [], endpoint_id: '', from: '', to: '' };
type Tab = 'deliveries' | 'dlq';

export function App() {
  const [tab, setTab] = useState<Tab>('deliveries');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: '5px 16px',
    border: 'none',
    borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
    background: 'none',
    color: tab === t ? 'var(--text)' : 'var(--text2)',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'var(--font)',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', height: 36, flexShrink: 0 }}>
        <span style={{ fontWeight: 600, fontSize: 13, marginRight: 24 }}>webhook-delivery</span>
        <button style={tabStyle('deliveries')} onClick={() => setTab('deliveries')}>deliveries</button>
        <button style={tabStyle('dlq')} onClick={() => setTab('dlq')}>DLQ</button>
      </div>

      <div style={{ flexShrink: 0 }}>
        <StatusTiles />
      </div>

      {tab === 'deliveries' && (
        <div style={{ flexShrink: 0 }}>
          <FiltersBar value={filters} onChange={(f) => { setFilters(f); setSelectedId(null); }} />
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {tab === 'deliveries' && (
          <>
            <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
              <DeliveryTable
                filters={filters}
                selectedId={selectedId}
                onSelect={setSelectedId}
                pollMs={2_000}
              />
            </div>
            {selectedId && (
              <DetailPanel
                key={selectedId}
                deliveryId={selectedId}
                onClose={() => setSelectedId(null)}
              />
            )}
          </>
        )}
        {tab === 'dlq' && <DlqView />}
      </div>
    </div>
  );
}
