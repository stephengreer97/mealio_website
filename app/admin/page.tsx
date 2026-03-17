'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Tab = 'applications' | 'meals' | 'stats' | 'broadcast' | 'storage';

interface Application {
  id: string;
  display_name: string;
  phone: string | null;
  find_us: string | null;
  status: string;
  created_at: string;
  user_profiles: { email: string } | null;
}

interface Meal {
  id: string;
  name: string;
  author: string;
  creator_name: string | null;
  difficulty: number | null;
  trending_score: number;
}

interface AvailableQuarter { year: number; q: number; label: string }

interface Stats {
  isCurrent: boolean;
  quarterLabel: string;
  availableQuarters: AvailableQuarter[];
  totals: {
    saves30d: number | null;
    savesQtr: number;
    savesAll: number | null;
    totalCreatorQtrSaves: number;
    totalCreatorAlltimeSaves: number | null;
    signups30d: number | null;
    signupsQtr: number;
    signupsAll: number | null;
    subsStarted30d: number | null;
    subsStartedQtr: number;
    subsStartedAll: number | null;
    subsCancelled30d: number | null;
    subsCancelledQtr: number;
    subsCancelledAll: number | null;
    netNewPaid30d: number | null;
    netNewPaidQtr: number;
    netNewPaidAll: number | null;
  };
  leaderboard: {
    name: string;
    qtrSaves: number;
    alltimeSaves: number;
    qtrPct: number;
    alltimePct: number;
    combinedSharePct: number;
  }[] | null;
  leaderboardQtr: { name: string; saves: number; pct: number }[];
  leaderboardAlltime: { name: string; saves: number; pct: number }[] | null;
}

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('applications');

  const [applications, setApplications] = useState<Application[]>([]);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selectedQuarter, setSelectedQuarter] = useState<AvailableQuarter | null>(null);

  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcastSaving, setBroadcastSaving] = useState(false);
  const [broadcastStatus, setBroadcastStatus] = useState('');

  const [storageLoading, setStorageLoading] = useState(false);
  const [storageDryRunResult, setStorageDryRunResult] = useState<{ orphanCount: number; estimatedBytes: number; paths: string[] } | null>(null);
  const [storageDeleteResult, setStorageDeleteResult] = useState<{ deleted: number; estimatedBytes: number } | null>(null);
  const [storageError, setStorageError] = useState('');
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillResult, setBackfillResult] = useState<{ processed: number; skipped: number; errors: number; total: number } | null>(null);
  const [photoBackfillLoading, setPhotoBackfillLoading] = useState(false);
  const [photoBackfillResult, setPhotoBackfillResult] = useState<{ total: number; processed: number; skipped: number; errors: number } | null>(null);

  useEffect(() => {
    verifyAdmin();
  }, []);

  const token = () => localStorage.getItem('accessToken');

  const verifyAdmin = async () => {
    try {
      const t = token();
      if (!t) { router.push('/signin'); return; }

      const res = await fetch('/api/auth/verify', {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!res.ok) { localStorage.clear(); router.push('/signin'); return; }

      const data = await res.json();
      if (!data.user?.isAdmin) { router.push('/discover'); return; }

      setLoading(false);
      loadApplications();
    } catch {
      router.push('/signin');
    }
  };

  const loadApplications = async () => {
    const res = await fetch('/api/admin/applications', {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (res.ok) {
      const data = await res.json();
      setApplications(data.applications);
    }
  };

  const loadMeals = async () => {
    const res = await fetch('/api/admin/meals', {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (res.ok) {
      const data = await res.json();
      setMeals(data.meals);
    }
  };

  const loadStats = async (qtr?: AvailableQuarter) => {
    const q = qtr ?? selectedQuarter;
    const params = q ? `?year=${q.year}&q=${q.q}` : '';
    const res = await fetch(`/api/admin/stats${params}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (res.ok) {
      const data = await res.json();
      setStats(data);
    }
  };

  const switchTab = (t: Tab) => {
    setTab(t);
    if (t === 'meals' && meals.length === 0) loadMeals();
    if (t === 'stats' && !stats) loadStats();
    if (t === 'broadcast') loadBroadcast();
  };

  const loadBroadcast = async () => {
    const res = await fetch('/api/broadcast');
    if (res.ok) {
      const data = await res.json();
      setBroadcastMessage(data.message ?? '');
    }
  };

  const saveBroadcast = async () => {
    setBroadcastSaving(true);
    setBroadcastStatus('');
    const res = await fetch('/api/admin/broadcast', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ message: broadcastMessage }),
    });
    setBroadcastSaving(false);
    setBroadcastStatus(res.ok ? 'Saved.' : 'Failed to save.');
  };

  const handleApplication = async (id: string, action: 'approve' | 'reject') => {
    setActionLoading(id + action);
    const res = await fetch('/api/admin/applications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ id, action }),
    });
    if (res.ok) {
      setApplications(prev =>
        prev.map(a => a.id === id ? { ...a, status: action === 'approve' ? 'approved' : 'rejected' } : a)
      );
    }
    setActionLoading(null);
  };

  const handleDeleteMeal = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setActionLoading('meal' + id);
    const res = await fetch('/api/admin/meals', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setMeals(prev => prev.filter(m => m.id !== id));
    }
    setActionLoading(null);
  };

  const runStorageDryRun = async () => {
    setStorageLoading(true);
    setStorageError('');
    setStorageDryRunResult(null);
    setStorageDeleteResult(null);
    const res = await fetch('/api/admin/storage/cleanup-orphans?dryRun=true', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}` },
    });
    setStorageLoading(false);
    if (res.ok) {
      const data = await res.json();
      setStorageDryRunResult(data);
    } else {
      setStorageError('Dry run failed.');
    }
  };

  const runStorageDelete = async () => {
    if (!confirm(`Delete ${storageDryRunResult?.orphanCount} orphaned files? This cannot be undone.`)) return;
    setStorageLoading(true);
    setStorageError('');
    const res = await fetch('/api/admin/storage/cleanup-orphans', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}` },
    });
    setStorageLoading(false);
    if (res.ok) {
      const data = await res.json();
      setStorageDeleteResult(data);
      setStorageDryRunResult(null);
    } else {
      setStorageError('Delete failed.');
    }
  };

  const runPhotoBackfill = async () => {
    if (!confirm('This will re-download and permanently store all Pixabay proxy photos in meals and preset_meals. May take several minutes. Continue?')) return;
    setPhotoBackfillLoading(true);
    setPhotoBackfillResult(null);
    const res = await fetch('/api/admin/storage/backfill-photos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}` },
    });
    setPhotoBackfillLoading(false);
    if (res.ok) setPhotoBackfillResult(await res.json());
  };

  const runBackfill = async () => {
    if (!confirm('This will download and hash all storage files not yet in photo_hashes. This may take several minutes. Continue?')) return;
    setBackfillLoading(true);
    setBackfillResult(null);
    const res = await fetch('/api/admin/storage/backfill-hashes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}` },
    });
    setBackfillLoading(false);
    if (res.ok) {
      const data = await res.json();
      setBackfillResult(data);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
        <p style={{ color: '#888' }}>Loading…</p>
      </div>
    );
  }

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: '8px 20px',
    border: 'none',
    borderBottom: tab === t ? '2px solid #dd0031' : '2px solid transparent',
    background: 'none',
    fontWeight: tab === t ? 700 : 400,
    color: tab === t ? '#dd0031' : '#666',
    cursor: 'pointer',
    fontSize: '14px',
  });

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(160deg, #c40029 0%, #dd0031 55%, #e8193a 100%)', color: 'white', padding: '20px 24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button onClick={() => router.push('/discover')} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '14px', opacity: 0.8 }}>
          ← Dashboard
        </button>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>Admin</h1>
      </div>

      {/* Tabs */}
      <div style={{ background: 'white', borderBottom: '1px solid #e0e0e0', display: 'flex', paddingLeft: '24px' }}>
        <button style={tabStyle('applications')} onClick={() => switchTab('applications')}>Applications</button>
        <button style={tabStyle('meals')} onClick={() => switchTab('meals')}>Meals</button>
        <button style={tabStyle('stats')} onClick={() => switchTab('stats')}>Stats</button>
        <button style={tabStyle('broadcast')} onClick={() => switchTab('broadcast')}>Broadcast</button>
        <button style={tabStyle('storage')} onClick={() => switchTab('storage')}>Storage</button>
      </div>

      <div style={{ maxWidth: '1000px', margin: '32px auto', padding: '0 20px' }}>

        {/* Applications Tab */}
        {tab === 'applications' && (
          <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#222' }}>Creator Applications</h2>
            </div>
            {applications.length === 0 ? (
              <p style={{ padding: '32px 24px', color: '#888', textAlign: 'center' }}>No applications yet.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '600px' }}>
                <thead>
                  <tr style={{ background: '#fafafa', borderBottom: '1px solid #e0e0e0' }}>
                    {['Email', 'Display Name', 'Phone', 'How to find them', 'Applied', 'Status', ''].map(h => (
                      <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#555' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {applications.map(app => (
                    <tr key={app.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '12px 16px', color: '#333' }}>{app.user_profiles?.email ?? '—'}</td>
                      <td style={{ padding: '12px 16px', fontWeight: 500 }}>{app.display_name}</td>
                      <td style={{ padding: '12px 16px', color: '#555' }}>{app.phone || '—'}</td>
                      <td style={{ padding: '12px 16px', color: '#555', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.find_us || '—'}</td>
                      <td style={{ padding: '12px 16px', color: '#888' }}>{new Date(app.created_at).toLocaleDateString()}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <span style={{
                          padding: '3px 8px', borderRadius: '99px', fontSize: '12px', fontWeight: 600,
                          background: app.status === 'approved' ? '#e6f9ed' : app.status === 'rejected' ? '#fff0f0' : '#fff8e1',
                          color: app.status === 'approved' ? '#1a7a3a' : app.status === 'rejected' ? '#c40029' : '#b45309',
                        }}>
                          {app.status}
                        </span>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        {app.status === 'pending' && (
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              onClick={() => handleApplication(app.id, 'approve')}
                              disabled={actionLoading === app.id + 'approve'}
                              style={{ padding: '5px 12px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => handleApplication(app.id, 'reject')}
                              disabled={actionLoading === app.id + 'reject'}
                              style={{ padding: '5px 12px', background: '#fff0f0', color: '#c40029', border: '1px solid #ffcccc', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
        )}

        {/* Meals Tab */}
        {tab === 'meals' && (
          <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#222' }}>All Preset Meals</h2>
            </div>
            {meals.length === 0 ? (
              <p style={{ padding: '32px 24px', color: '#888', textAlign: 'center' }}>Loading…</p>
            ) : (
              <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '600px' }}>
                <thead>
                  <tr style={{ background: '#fafafa', borderBottom: '1px solid #e0e0e0' }}>
                    {['Name', 'Author', 'Difficulty', 'Trending Score', ''].map(h => (
                      <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#555' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {meals.map(meal => (
                    <tr key={meal.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '12px 16px', fontWeight: 500 }}>{meal.name}</td>
                      <td style={{ padding: '12px 16px', color: '#555' }}>{meal.creator_name || meal.author || '—'}</td>
                      <td style={{ padding: '12px 16px', color: '#555' }}>{meal.difficulty ?? '—'}</td>
                      <td style={{ padding: '12px 16px', color: '#555' }}>{Number(meal.trending_score).toFixed(1)}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <button
                          onClick={() => handleDeleteMeal(meal.id, meal.name)}
                          disabled={actionLoading === 'meal' + meal.id}
                          style={{ padding: '5px 12px', background: '#fff0f0', color: '#c40029', border: '1px solid #ffcccc', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
        )}

        {/* Stats Tab */}
        {tab === 'stats' && (
          <>
            {!stats ? (
              <p style={{ textAlign: 'center', color: '#888', padding: '32px' }}>Loading…</p>
            ) : (
              <>
                {/* Quarter selector */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                  <label style={{ fontSize: '13px', fontWeight: 600, color: '#555' }}>Quarter:</label>
                  <select
                    value={`${(selectedQuarter ?? stats.availableQuarters[0]).year}-${(selectedQuarter ?? stats.availableQuarters[0]).q}`}
                    onChange={e => {
                      const [year, q] = e.target.value.split('-').map(Number);
                      const qtr = stats.availableQuarters.find(x => x.year === year && x.q === q)!;
                      setSelectedQuarter(qtr);
                      loadStats(qtr);
                    }}
                    style={{ padding: '7px 12px', border: '1px solid #ddd', borderRadius: '8px', fontSize: '14px', background: 'white', cursor: 'pointer' }}
                  >
                    {stats.availableQuarters.map(qtr => (
                      <option key={`${qtr.year}-${qtr.q}`} value={`${qtr.year}-${qtr.q}`}>
                        {qtr.label}{qtr === stats.availableQuarters[0] ? ' (current)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Platform totals */}
                {stats.isCurrent ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '12px' }}>
                      {[
                        { label: 'Meals (30d)',      value: stats.totals.saves30d ?? 0 },
                        { label: `Meals (${stats.quarterLabel})`, value: stats.totals.savesQtr },
                        { label: 'Meals (all time)', value: stats.totals.savesAll ?? 0 },
                      ].map(s => (
                        <div key={s.label} style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                          <div style={{ fontSize: '32px', fontWeight: 700, color: '#dd0031' }}>{s.value.toLocaleString()}</div>
                          <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>{s.label}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '24px' }}>
                      {[
                        { label: `Creator saves (${stats.quarterLabel})`, value: stats.totals.totalCreatorQtrSaves },
                        { label: 'Creator saves (all time)',               value: stats.totals.totalCreatorAlltimeSaves ?? 0 },
                      ].map(s => (
                        <div key={s.label} style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                          <div style={{ fontSize: '32px', fontWeight: 700, color: '#555' }}>{s.value.toLocaleString()}</div>
                          <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>{s.label}</div>
                        </div>
                      ))}
                    </div>

                    {/* User signups — current quarter view */}
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>User Signups</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '24px' }}>
                      {[
                        { label: 'Signups (30d)',      value: stats.totals.signups30d ?? 0 },
                        { label: `Signups (${stats.quarterLabel})`, value: stats.totals.signupsQtr },
                        { label: 'Signups (all time)', value: stats.totals.signupsAll ?? 0 },
                      ].map(s => (
                        <div key={s.label} style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                          <div style={{ fontSize: '32px', fontWeight: 700, color: '#2563eb' }}>{s.value.toLocaleString()}</div>
                          <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>{s.label}</div>
                        </div>
                      ))}
                    </div>

                    {/* Net new paid — current quarter view */}
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Net New Paid</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '32px' }}>
                      {[
                        { label: 'Net new paid (30d)',      started: stats.totals.subsStarted30d ?? 0,  cancelled: stats.totals.subsCancelled30d ?? 0,  net: stats.totals.netNewPaid30d ?? 0 },
                        { label: `Net new paid (${stats.quarterLabel})`, started: stats.totals.subsStartedQtr, cancelled: stats.totals.subsCancelledQtr, net: stats.totals.netNewPaidQtr },
                        { label: 'Net new paid (all time)', started: stats.totals.subsStartedAll ?? 0,  cancelled: stats.totals.subsCancelledAll ?? 0,  net: stats.totals.netNewPaidAll ?? 0 },
                      ].map(s => (
                        <div key={s.label} style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                          <div style={{ fontSize: '32px', fontWeight: 700, color: s.net >= 0 ? '#16a34a' : '#c40029' }}>{s.net >= 0 ? '+' : ''}{s.net.toLocaleString()}</div>
                          <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>{s.label}</div>
                          <div style={{ fontSize: '11px', color: '#aaa', marginTop: '6px' }}>+{s.started} started · −{s.cancelled} cancelled</div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '24px' }}>
                    {[
                      { label: `Meals (${stats.quarterLabel})`,         value: stats.totals.savesQtr,              highlight: true },
                      { label: `Creator saves (${stats.quarterLabel})`, value: stats.totals.totalCreatorQtrSaves,  highlight: false },
                    ].map(s => (
                      <div key={s.label} style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                        <div style={{ fontSize: '32px', fontWeight: 700, color: s.highlight ? '#dd0031' : '#555' }}>{s.value.toLocaleString()}</div>
                        <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>{s.label}</div>
                      </div>
                    ))}
                  </div>

                  {/* User signups — historical quarter view */}
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>User Signups</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px', marginBottom: '24px' }}>
                    <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                      <div style={{ fontSize: '32px', fontWeight: 700, color: '#2563eb' }}>{stats.totals.signupsQtr.toLocaleString()}</div>
                      <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>Signups ({stats.quarterLabel})</div>
                    </div>
                  </div>

                  {/* Net new paid — historical quarter view */}
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Net New Paid</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px', marginBottom: '32px' }}>
                    <div style={{ background: 'white', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                      <div style={{ fontSize: '32px', fontWeight: 700, color: stats.totals.netNewPaidQtr >= 0 ? '#16a34a' : '#c40029' }}>
                        {stats.totals.netNewPaidQtr >= 0 ? '+' : ''}{stats.totals.netNewPaidQtr.toLocaleString()}
                      </div>
                      <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>Net new paid ({stats.quarterLabel})</div>
                      <div style={{ fontSize: '11px', color: '#aaa', marginTop: '6px' }}>+{stats.totals.subsStartedQtr} started · −{stats.totals.subsCancelledQtr} cancelled</div>
                    </div>
                  </div>
                  </>
                )}

                {/* Combined leaderboard — current quarter only */}
                {stats.isCurrent && stats.leaderboard && (
                  <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden', marginBottom: '24px' }}>
                    <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
                      <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#222' }}>Combined Leaderboard</h2>
                      <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>50% quarterly + 50% all-time — sorted by combined share</p>
                    </div>
                    {stats.leaderboard.length === 0 ? (
                      <p style={{ padding: '32px 24px', color: '#888', textAlign: 'center' }}>No creator saves yet.</p>
                    ) : (
                      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '600px' }}>
                        <thead>
                          <tr style={{ background: '#fafafa', borderBottom: '1px solid #e0e0e0' }}>
                            {['#', 'Creator', 'Qtr Saves', 'Qtr %', 'All-time Saves', 'All-time %', 'Combined Share'].map(h => (
                              <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#555' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {stats.leaderboard.map((c, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                              <td style={{ padding: '12px 16px', color: '#aaa', fontWeight: 600 }}>{i + 1}</td>
                              <td style={{ padding: '12px 16px', fontWeight: 500 }}>{c.name}</td>
                              <td style={{ padding: '12px 16px', color: '#555' }}>{c.qtrSaves.toLocaleString()}</td>
                              <td style={{ padding: '12px 16px', color: '#555' }}>{c.qtrPct.toFixed(1)}%</td>
                              <td style={{ padding: '12px 16px', color: '#555' }}>{c.alltimeSaves.toLocaleString()}</td>
                              <td style={{ padding: '12px 16px', color: '#555' }}>{c.alltimePct.toFixed(1)}%</td>
                              <td style={{ padding: '12px 16px', fontWeight: 700, color: '#dd0031' }}>{c.combinedSharePct.toFixed(1)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table></div>
                    )}
                  </div>
                )}

                {/* Quarterly leaderboard */}
                <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden', marginBottom: '24px' }}>
                  <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
                    <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#222' }}>{stats.quarterLabel} Leaderboard</h2>
                    <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>Creator saves during {stats.quarterLabel}</p>
                  </div>
                  {stats.leaderboardQtr.length === 0 ? (
                    <p style={{ padding: '32px 24px', color: '#888', textAlign: 'center' }}>No creator saves this quarter.</p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '600px' }}>
                      <thead>
                        <tr style={{ background: '#fafafa', borderBottom: '1px solid #e0e0e0' }}>
                          {['#', 'Creator', `Saves (${stats.quarterLabel})`, 'Share of qtr'].map(h => (
                            <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#555' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {stats.leaderboardQtr.map((c, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                            <td style={{ padding: '12px 16px', color: '#aaa', fontWeight: 600 }}>{i + 1}</td>
                            <td style={{ padding: '12px 16px', fontWeight: 500 }}>{c.name}</td>
                            <td style={{ padding: '12px 16px', color: '#555' }}>{c.saves.toLocaleString()}</td>
                            <td style={{ padding: '12px 16px', color: '#555' }}>{c.pct.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  )}
                </div>

                {/* All-time leaderboard — current quarter only */}
                {stats.isCurrent && stats.leaderboardAlltime && (
                  <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
                    <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
                      <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#222' }}>All-time Leaderboard</h2>
                      <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#888' }}>Total saves since creator joined</p>
                    </div>
                    {stats.leaderboardAlltime.length === 0 ? (
                      <p style={{ padding: '32px 24px', color: '#888', textAlign: 'center' }}>No creator saves yet.</p>
                    ) : (
                      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '600px' }}>
                        <thead>
                          <tr style={{ background: '#fafafa', borderBottom: '1px solid #e0e0e0' }}>
                            {['#', 'Creator', 'Saves (all time)', 'All-time %'].map(h => (
                              <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#555' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {stats.leaderboardAlltime.map((c, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                              <td style={{ padding: '12px 16px', color: '#aaa', fontWeight: 600 }}>{i + 1}</td>
                              <td style={{ padding: '12px 16px', fontWeight: 500 }}>{c.name}</td>
                              <td style={{ padding: '12px 16px', color: '#555' }}>{c.saves.toLocaleString()}</td>
                              <td style={{ padding: '12px 16px', color: '#555' }}>{c.pct.toFixed(1)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table></div>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* Storage Tab */}
        {tab === 'storage' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

            {/* Orphan Cleanup */}
            <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '24px' }}>
              <h2 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 600, color: '#222' }}>Orphan Cleanup</h2>
              <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#888' }}>
                Finds storage files in the meal-photos bucket that are not referenced by any meal, preset meal, creator, or application.
                Run a dry run first to preview what would be deleted.
              </p>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  onClick={runStorageDryRun}
                  disabled={storageLoading}
                  style={{ background: '#2563eb', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '14px', fontWeight: 600, cursor: storageLoading ? 'not-allowed' : 'pointer', opacity: storageLoading ? 0.7 : 1 }}
                >
                  {storageLoading ? 'Running…' : 'Dry Run'}
                </button>
                {storageDryRunResult && storageDryRunResult.orphanCount > 0 && (
                  <button
                    onClick={runStorageDelete}
                    disabled={storageLoading}
                    style={{ background: '#c40029', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '14px', fontWeight: 600, cursor: storageLoading ? 'not-allowed' : 'pointer', opacity: storageLoading ? 0.7 : 1 }}
                  >
                    Delete {storageDryRunResult.orphanCount} Orphans
                  </button>
                )}
                {storageError && <span style={{ fontSize: '13px', color: '#c40029' }}>{storageError}</span>}
              </div>
              {storageDryRunResult && (
                <div style={{ marginTop: '16px', padding: '14px 16px', background: '#f8f9fa', borderRadius: '8px', fontSize: '13px' }}>
                  <div style={{ fontWeight: 600, color: '#222', marginBottom: '6px' }}>
                    Dry run: {storageDryRunResult.orphanCount} orphan{storageDryRunResult.orphanCount !== 1 ? 's' : ''} found
                    — ~{(storageDryRunResult.estimatedBytes / 1024 / 1024).toFixed(2)} MB
                  </div>
                  {storageDryRunResult.orphanCount === 0 ? (
                    <div style={{ color: '#16a34a' }}>No orphans — storage is clean.</div>
                  ) : (
                    <div style={{ maxHeight: '160px', overflowY: 'auto', marginTop: '8px' }}>
                      {storageDryRunResult.paths.map(p => (
                        <div key={p} style={{ color: '#555', fontFamily: 'monospace', fontSize: '12px', padding: '2px 0' }}>{p}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {storageDeleteResult && (
                <div style={{ marginTop: '16px', padding: '14px 16px', background: '#e6f9ed', borderRadius: '8px', fontSize: '13px', color: '#1a7a3a', fontWeight: 600 }}>
                  Deleted {storageDeleteResult.deleted} file{storageDeleteResult.deleted !== 1 ? 's' : ''} (~{(storageDeleteResult.estimatedBytes / 1024 / 1024).toFixed(2)} MB freed)
                </div>
              )}
            </div>

            {/* Photo URL Backfill */}
            <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '24px' }}>
              <h2 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 600, color: '#222' }}>Backfill Proxy Photos</h2>
              <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#888' }}>
                Finds all meals and preset meals whose <code>photo_url</code> is still a Pixabay proxy URL (these expire ~24h after generation),
                re-downloads each image, and saves it permanently to Supabase Storage. Run this once to fix missing photos.
              </p>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <button
                  onClick={runPhotoBackfill}
                  disabled={photoBackfillLoading}
                  style={{ background: '#7c3aed', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '14px', fontWeight: 600, cursor: photoBackfillLoading ? 'not-allowed' : 'pointer', opacity: photoBackfillLoading ? 0.7 : 1 }}
                >
                  {photoBackfillLoading ? 'Backfilling…' : 'Backfill Proxy Photos'}
                </button>
              </div>
              {photoBackfillResult && (
                <div style={{ marginTop: '16px', padding: '14px 16px', background: '#f5f3ff', borderRadius: '8px', fontSize: '13px', color: '#5b21b6', fontWeight: 600 }}>
                  Done — {photoBackfillResult.processed} resolved, {photoBackfillResult.skipped} skipped (already permanent or unchanged), {photoBackfillResult.errors} errors
                  {' '}({photoBackfillResult.total} proxy URLs found)
                </div>
              )}
            </div>

            {/* Hash Backfill */}
            <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '24px' }}>
              <h2 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 600, color: '#222' }}>Backfill Photo Hashes</h2>
              <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#888' }}>
                One-time operation: downloads and SHA-256 hashes all existing storage files not yet in the photo_hashes table.
                This enables deduplication for files uploaded before the feature was added. May take several minutes.
              </p>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <button
                  onClick={runBackfill}
                  disabled={backfillLoading}
                  style={{ background: '#555', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '14px', fontWeight: 600, cursor: backfillLoading ? 'not-allowed' : 'pointer', opacity: backfillLoading ? 0.7 : 1 }}
                >
                  {backfillLoading ? 'Backfilling…' : 'Backfill Hashes'}
                </button>
              </div>
              {backfillResult && (
                <div style={{ marginTop: '16px', padding: '14px 16px', background: '#e6f9ed', borderRadius: '8px', fontSize: '13px', color: '#1a7a3a', fontWeight: 600 }}>
                  Done — {backfillResult.processed} hashed, {backfillResult.skipped} skipped, {backfillResult.errors} errors (of {backfillResult.total} total files)
                </div>
              )}
            </div>

          </div>
        )}

        {/* Broadcast Tab */}
        {tab === 'broadcast' && (
          <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: '24px' }}>
            <h2 style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 600, color: '#222' }}>Extension Broadcast Message</h2>
            <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#888' }}>
              If set, this message is shown at the top of the extension for all users. Clear the field and save to remove it.
            </p>
            <textarea
              value={broadcastMessage}
              onChange={e => { setBroadcastMessage(e.target.value); setBroadcastStatus(''); }}
              placeholder="Enter a message to broadcast… (leave empty to clear)"
              rows={4}
              style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #e0e0e0', borderRadius: '8px', padding: '10px 12px', fontSize: '14px', fontFamily: 'inherit', resize: 'vertical', outline: 'none' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px' }}>
              <button
                onClick={saveBroadcast}
                disabled={broadcastSaving}
                style={{ background: '#dd0031', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 20px', fontSize: '14px', fontWeight: 600, cursor: broadcastSaving ? 'not-allowed' : 'pointer', opacity: broadcastSaving ? 0.7 : 1 }}
              >
                {broadcastSaving ? 'Saving…' : 'Save'}
              </button>
              {broadcastMessage && (
                <button
                  onClick={() => { setBroadcastMessage(''); setBroadcastStatus(''); }}
                  style={{ background: 'none', border: '1px solid #e0e0e0', borderRadius: '8px', padding: '8px 16px', fontSize: '14px', color: '#666', cursor: 'pointer' }}
                >
                  Clear
                </button>
              )}
              {broadcastStatus && (
                <span style={{ fontSize: '13px', color: broadcastStatus === 'Saved.' ? '#16a34a' : '#dd0031' }}>
                  {broadcastStatus}
                </span>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
