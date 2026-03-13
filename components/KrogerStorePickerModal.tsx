'use client';

import { useState } from 'react';

interface KrogerLocation {
  locationId: string;
  name: string;
  storeId: string;
  address?: string;
}

interface Props {
  accessToken: string;
  onSaved: (locationId: string, locationName: string, storeId: string) => void;
  onClose: () => void;
}

export default function KrogerStorePickerModal({ accessToken, onSaved, onClose }: Props) {
  const [zip, setZip] = useState('');
  const [searching, setSearching] = useState(false);
  const [locations, setLocations] = useState<KrogerLocation[]>([]);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');

  const handleSearch = async () => {
    if (!zip.trim()) return;
    setSearching(true);
    setLocations([]);
    setError('');
    try {
      const res = await fetch(`/api/kroger/locations?term=${encodeURIComponent(zip.trim())}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      const locs: KrogerLocation[] = data.locations ?? [];
      setLocations(locs);
      if (locs.length === 0) setError('No Kroger stores found near that ZIP code.');
    } catch {
      setError('Failed to search stores. Please try again.');
    } finally {
      setSearching(false);
    }
  };

  const handleSelect = async (loc: KrogerLocation) => {
    setSaving(loc.locationId);
    try {
      const res = await fetch('/api/kroger/set-location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ locationId: loc.locationId, locationName: loc.name, storeId: loc.storeId }),
      });
      if (!res.ok) { setError('Failed to save store. Please try again.'); return; }
      onSaved(loc.locationId, loc.name, loc.storeId);
    } catch {
      setError('Failed to save store. Please try again.');
    } finally {
      setSaving('');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl flex flex-col"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', maxHeight: '85vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div>
            <h2 className="text-base font-bold" style={{ color: 'var(--text-1)' }}>Select Your Store</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>Search by ZIP to find nearby Kroger-family stores</p>
          </div>
          <button onClick={onClose} className="text-xl leading-none" style={{ color: 'var(--text-3)' }}>✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              placeholder="ZIP code"
              value={zip}
              onChange={e => setZip(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
              maxLength={10}
              autoFocus
              className="flex-1 text-sm px-3 py-2 rounded-xl outline-none"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-1)' }}
            />
            <button
              onClick={handleSearch}
              disabled={searching || !zip.trim()}
              className="text-sm font-semibold px-4 py-2 rounded-xl transition-colors disabled:opacity-50 text-white"
              style={{ background: '#0063a1', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>

          {error && <p className="text-xs mb-3" style={{ color: 'var(--text-3)' }}>{error}</p>}

          {locations.length > 0 && (
            <ul className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
              {locations.map((loc, i) => (
                <li key={loc.locationId} style={{ borderBottom: i < locations.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <button
                    onClick={() => handleSelect(loc)}
                    disabled={!!saving}
                    className="w-full text-left px-4 py-3 transition-colors disabled:opacity-60"
                    style={{ background: 'var(--surface-raised)', border: 'none', cursor: 'pointer' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-raised)'; }}
                  >
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
                      {saving === loc.locationId ? 'Saving…' : loc.name}
                    </p>
                    {loc.address && <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>{loc.address}</p>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-5 py-3" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={onClose}
            className="w-full text-sm py-2 rounded-xl"
            style={{ color: 'var(--text-2)', background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer' }}
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
