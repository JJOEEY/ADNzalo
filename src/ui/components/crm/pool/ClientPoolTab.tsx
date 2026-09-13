import React, { useState, useEffect, useCallback } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { useEmployeeStore } from '@/store/employeeStore';
import { CLIENT_STAGES, type ClientStage } from '../../../../models/crm';

interface PoolEntry {
  id: number;
  contact_id: string;
  contact_type: string;
  display_name: string;
  resolved_name?: string;
  stage: ClientStage;
  owner_employee: string;
  deal_value: number;
  attributed_campaign_id?: number | null;
  phone?: string;
  last_message_time?: number;
  updated_at: number;
}

const STAGE_COLORS: Record<ClientStage, string> = {
  new: 'border-gray-500',
  consulting: 'border-blue-500',
  closed: 'border-green-500',
  nurturing: 'border-amber-500',
  lost: 'border-red-500/60',
};

const STAGE_BG: Record<ClientStage, string> = {
  new: 'bg-gray-500/10',
  consulting: 'bg-blue-500/10',
  closed: 'bg-green-500/10',
  nurturing: 'bg-amber-500/10',
  lost: 'bg-red-500/5',
};

function silentLabel(ts?: number): string | null {
  if (!ts) return 'Chưa tương tác';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return null;
  if (days === 1) return 'Im lặng 1 ngày';
  if (days < 30) return `Im lặng ${days} ngày`;
  const months = Math.floor(days / 30);
  return months <= 1 ? 'Im lặng ~1 tháng' : `Im lặng ~${months} tháng`;
}

function fmtMoney(v: number): string {
  if (!v) return '';
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(v % 1_000_000_000 === 0 ? 0 : 1)} tỷ`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}tr`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return String(v);
}

export default function ClientPoolTab({ zaloId }: { zaloId: string }) {
  const [entries, setEntries] = useState<PoolEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<{ total: number; byStage: Record<string, number>; closedValue: number }>({ total: 0, byStage: {}, closedValue: 0 });
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [silentDays, setSilentDays] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<Array<{ id: number; name: string }>>([]);
  const [variantReport, setVariantReport] = useState<Array<{
    campaign_id: number; campaign_name: string; experiment_revision: number; rules_version: number; variant_id: string; variant_label: string; rules_snapshot: string;
    sample_size: number; sent: number; replied: number; consulting: number; closed: number; revenue: number;
  }>>([]);
  const [showVariantReport, setShowVariantReport] = useState(true);
  const [closingContact, setClosingContact] = useState<PoolEntry | null>(null);
  const [attributionCampaignId, setAttributionCampaignId] = useState('');
  const [closingError, setClosingError] = useState('');
  // Preset lọc đã lưu (localStorage theo nick)
  const [presets, setPresets] = useState<{ name: string; owner: string; silent: number }[]>([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`clientpool_presets_${zaloId}`);
      if (raw) setPresets(JSON.parse(raw));
    } catch { setPresets([]); }
  }, [zaloId]);
  const savePreset = () => {
    const name = window.prompt('Tên preset lọc (VD: NV Ngân + im lặng 30 ngày):');
    if (!name?.trim()) return;
    const next = [...presets.filter((p) => p.name !== name.trim()), { name: name.trim(), owner: ownerFilter, silent: silentDays }];
    setPresets(next);
    try { localStorage.setItem(`clientpool_presets_${zaloId}`, JSON.stringify(next)); } catch {}
  };
  const deletePreset = (name: string) => {
    const next = presets.filter((p) => p.name !== name);
    setPresets(next);
    try { localStorage.setItem(`clientpool_presets_${zaloId}`, JSON.stringify(next)); } catch {}
  };
  const employees = useEmployeeStore((s) => s.employees || []);
  const empName = useCallback((id: string) => {
    if (!id) return 'Chưa gán';
    return employees.find((e: any) => e.employee_id === id)?.display_name || id;
  }, [employees]);

  const load = useCallback(async () => {
    if (!zaloId) return;
    setLoading(true);
    try {
      const [res, st] = await Promise.all([
        DataAccessor.getClientPool({ zaloId, opts: { search: search.trim() || undefined, ownerEmployee: ownerFilter || undefined, silentDays: silentDays || undefined, limit: 500 } }),
        DataAccessor.getClientPoolStats({ zaloId }),
      ]);
      if (res?.success) { setEntries(res.entries || []); setTotal(res.total || 0); }
      if (st?.success) setStats({ total: st.total || 0, byStage: st.byStage || {}, closedValue: st.closedValue || 0 });
    } catch { /* ignore */ }
    setLoading(false);
  }, [zaloId, search, ownerFilter, silentDays]);

  useEffect(() => { load(); }, [load]);
  const loadCampaignAnalytics = useCallback(async () => {
    if (!zaloId) return;
    try {
      const [campaignRes, reportRes] = await Promise.all([
        DataAccessor.getCRMCampaigns({ zaloId }), DataAccessor.getCampaignVariantReport(zaloId),
      ]);
      if (campaignRes?.success) setCampaigns(campaignRes.campaigns || []);
      if (reportRes?.success) setVariantReport(reportRes.data || []);
    } catch { setCampaigns([]); setVariantReport([]); }
  }, [zaloId]);
  useEffect(() => {
    loadCampaignAnalytics();
    const unsubscribe = (ipc as any).on?.('crm:campaignChanged', () => loadCampaignAnalytics());
    return () => { try { (unsubscribe as any)?.(); } catch {} };
  }, [loadCampaignAnalytics]);
  useEffect(() => {
    const unsub = (ipc as any).on?.('crm:clientPoolChanged', () => load());
    return () => { try { (unsub as any)?.(); } catch {} };
  }, [load]);

  const changeStage = async (contactId: string, stage: ClientStage) => {
    if (stage === 'closed') {
      const contact = entries.find(entry => entry.contact_id === contactId);
      if (!contact) return;
      setClosingContact(contact);
      setAttributionCampaignId(contact.attributed_campaign_id ? String(contact.attributed_campaign_id) : '');
      setClosingError('');
      return;
    }
    await DataAccessor.setClientStage({ zaloId, contactId, stage });
    load();
  };

  const saveClosedAttribution = async () => {
    if (!closingContact || !attributionCampaignId) return;
    const res = await DataAccessor.saveClientPool({ zaloId, entry: {
      contact_id: closingContact.contact_id,
      stage: 'closed',
      attributed_campaign_id: Number(attributionCampaignId),
    } });
    if (res?.success && res.id) {
      setClosingContact(null);
      setClosingError('');
      load();
      const report = await DataAccessor.getCampaignVariantReport(zaloId);
      if (report?.success) setVariantReport(report.data || []);
    } else setClosingError(res?.error || 'Không thể lưu kết quả sale.');
  };

  const changeOwner = async (contactId: string, ownerEmployee: string) => {
    await DataAccessor.saveClientPool({ zaloId, entry: { contact_id: contactId, owner_employee: ownerEmployee } });
    load();
  };

  const changeDeal = async (contactId: string, dealValue: number) => {
    if (!Number.isFinite(dealValue) || dealValue < 0) return;
    await DataAccessor.saveClientPool({ zaloId, entry: { contact_id: contactId, deal_value: dealValue } });
    load();
  };

  const removeEntry = async (contactId: string, name: string) => {
    if (!window.confirm(`Xóa "${name}" khỏi Client Pool? (không xóa liên hệ gốc)`)) return;
    await DataAccessor.removeClientPool({ zaloId, contactId });
    load();
  };

  const byStage = (s: ClientStage) => entries.filter((e) => e.stage === s);
  const recommendationByExperiment = new Map<string, { enoughData: boolean; leaders: Set<string> }>();
  const reportGroups = new Map<string, typeof variantReport>();
  for (const row of variantReport) {
    const key = `${row.campaign_id}-${row.experiment_revision}`;
    reportGroups.set(key, [...(reportGroups.get(key) || []), row]);
  }
  for (const [key, rows] of reportGroups) {
    const enoughData = rows.length > 0 && rows.every(row => row.sent >= 30);
    const bestRate = enoughData ? Math.max(...rows.map(row => row.sent ? row.closed / row.sent : 0)) : -1;
    recommendationByExperiment.set(key, {
      enoughData,
      leaders: new Set(enoughData ? rows.filter(row => row.sent && row.closed / row.sent === bestRate).map(row => row.variant_id) : []),
    });
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Stats + filters */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-700 flex-shrink-0 flex-wrap">
        <span className="text-xs font-semibold text-gray-200">Client Pool {stats.total ? `(${stats.total})` : ''}</span>
        {stats.closedValue > 0 && (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-300 font-medium">
            Chốt: {fmtMoney(stats.closedValue)}
          </span>
        )}
        <div className="flex-1" />
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm tên, SĐT, UID..."
          className="bg-gray-800 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 w-44" />
        <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}
          className="bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500">
          <option value="">Mọi nhân viên</option>
          {employees.map((e: any) => <option key={e.employee_id} value={e.employee_id}>{e.display_name || e.username}</option>)}
        </select>
        <select value={silentDays} onChange={(e) => setSilentDays(Number(e.target.value))}
          className="bg-gray-800 border border-gray-600 rounded-lg px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500"
          title="Lọc khách im lặng">
          <option value={0}>Mọi tương tác</option>
          <option value={7}>Im lặng ≥7 ngày</option>
          <option value={30}>Im lặng ≥30 ngày</option>
          <option value={90}>Im lặng ≥90 ngày</option>
        </select>
        <button onClick={savePreset} title="Lưu bộ lọc hiện tại"
          className="px-2 py-1.5 rounded-lg border border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-500 text-xs">
          ＋ Preset
        </button>
      </div>
      {presets.length > 0 && (
        <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-gray-700 flex-shrink-0 flex-wrap">
          {presets.map((p) => (
            <span key={p.name}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-blue-500/30 text-blue-300">
              <button onClick={() => { setOwnerFilter(p.owner); setSilentDays(p.silent); }} title="Áp dụng">{p.name}</button>
              <button onClick={() => deletePreset(p.name)} title="Xóa" className="text-gray-500 hover:text-red-400">×</button>
            </span>
          ))}
        </div>
      )}

      <div className="border-b border-gray-700 flex-shrink-0">
        <button onClick={() => setShowVariantReport(value => !value)}
          className="w-full flex items-center gap-2 px-4 py-2 text-left text-xs font-semibold text-gray-200 hover:bg-gray-800/70">
          <span>{showVariantReport ? '▾' : '▸'}</span>
          Hiệu quả kịch bản theo campaign
          <span className="text-[10px] font-normal text-gray-500">{variantReport.length} nhóm biến thể</span>
        </button>
        {showVariantReport && (
          <div className="max-h-52 overflow-auto px-4 pb-2">
            <p className="text-[10px] text-gray-500 mb-1">Tỷ lệ chốt trên lượt gửi thành công là tiêu chí chính; doanh thu là thông tin bổ sung. CRM chỉ gợi ý khi mỗi biến thể có ít nhất 30 lượt gửi thành công.</p>
            {variantReport.length === 0 ? (
              <p className="text-[10px] text-gray-500 py-2">Chưa có dữ liệu thử nghiệm. Kịch bản cũ không có gán biến thể sẽ không được gán số liệu ngược lại.</p>
            ) : (
              <table className="w-full text-[10px] text-gray-300 border-collapse">
                <thead className="text-gray-500"><tr>
                  <th className="text-left py-1 pr-2">Campaign / kịch bản</th><th className="text-right px-1">Mẫu / gửi</th>
                  <th className="text-right px-1">Phản hồi</th><th className="text-right px-1">Tư vấn</th>
                  <th className="text-right px-1">Chốt / tỷ lệ</th><th className="text-right pl-1">Doanh thu</th>
                </tr></thead>
                <tbody>{variantReport.map(row => (
                  <tr key={`${row.campaign_id}-${row.experiment_revision}-${row.variant_id}`} className="border-t border-gray-800">
                    <td className="py-1.5 pr-2">
                      <span className="text-gray-200">{row.campaign_name}</span><span className="text-gray-500"> · {row.variant_label}</span>
                      <span className="ml-1 text-[9px] text-gray-600">thử nghiệm v{row.experiment_revision}</span>
                      {(() => {
                        const recommendation = recommendationByExperiment.get(`${row.campaign_id}-${row.experiment_revision}`);
                        if (!recommendation?.enoughData) return <span className="block text-[9px] text-amber-400">Chưa đủ dữ liệu để gợi ý</span>;
                        return recommendation.leaders.has(row.variant_id)
                          ? <span className="block text-[9px] text-green-300">Gợi ý theo tỷ lệ chốt · nhân viên quyết định</span>
                          : null;
                      })()}
                      {row.rules_snapshot && <details className="mt-0.5"><summary className="cursor-pointer text-violet-400">Quy tắc {row.rules_version ? `v${row.rules_version}` : 'chung'}</summary><p className="max-w-xl whitespace-pre-wrap text-[9px] text-gray-400 mt-1">{row.rules_snapshot}</p></details>}
                    </td>
                    <td className="text-right px-1">{row.sample_size} / {row.sent}</td>
                    <td className="text-right px-1">{row.replied}</td><td className="text-right px-1">{row.consulting}</td>
                    <td className="text-right px-1">{row.closed}{row.sent ? ` (${Math.round(row.closed / row.sent * 100)}%)` : ''}</td>
                    <td className="text-right pl-1">{fmtMoney(row.revenue) || '0'}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Kanban */}
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden p-3">
        {loading && entries.length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-8">Đang tải Client Pool...</p>
        ) : (
          <div className="flex gap-3 h-full min-w-max">
            {CLIENT_STAGES.map((s) => {
              const cards = byStage(s.value);
              return (
                <div key={s.value}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (dragId) { const d = dragId; setDragId(null); changeStage(d, s.value); } }}
                  className={`w-60 flex-shrink-0 flex flex-col rounded-xl border-t-2 ${STAGE_COLORS[s.value]} bg-gray-800/60 max-h-full`}>
                  <div className={`px-3 py-2 flex items-center justify-between rounded-t-xl ${STAGE_BG[s.value]}`}>
                    <span className="text-xs font-semibold text-gray-200">{s.label}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">{stats.byStage[s.value] || 0}</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
                    {cards.length === 0 && (
                      <p className="text-[10px] text-gray-600 text-center py-4 italic">Kéo thả vào đây</p>
                    )}
                    {cards.map((c) => {
                      const silent = silentLabel(c.last_message_time);
                      return (
                        <div key={c.contact_id}
                          draggable
                          onDragStart={() => setDragId(c.contact_id)}
                          className="bg-gray-800 border border-gray-700 rounded-lg p-2.5 cursor-grab active:cursor-grabbing hover:border-gray-500 transition-colors">
                          <p className="text-xs font-medium text-gray-100 truncate" title={c.resolved_name || c.display_name}>
                            {c.resolved_name || c.display_name || c.contact_id}
                          </p>
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            {c.phone && <span className="text-[10px] text-gray-400 font-mono">{c.phone}</span>}
                            {silent && <span className="text-[9px] px-1.5 py-px rounded bg-amber-500/15 text-amber-300">{silent}</span>}
                          </div>
                          <div className="flex items-center gap-1.5 mt-2">
                            <select value={c.owner_employee || ''} title="Nhân viên phụ trách"
                              onChange={(e) => changeOwner(c.contact_id, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-1 py-1 text-[10px] text-gray-300 outline-none focus:border-blue-500">
                              <option value="">Chưa gán</option>
                              {employees.map((e: any) => <option key={e.employee_id} value={e.employee_id}>{e.display_name || e.username}</option>)}
                            </select>
                            <input type="number" min={0} title="Giá trị (VNĐ)" placeholder="₫"
                              defaultValue={c.deal_value || undefined}
                              key={`${c.contact_id}-${c.deal_value}`}
                              onBlur={(e) => { const v = Number(e.target.value); if (v !== c.deal_value) changeDeal(c.contact_id, v); }}
                              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                              className="w-20 bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-300 outline-none focus:border-blue-500" />
                            <button title="Xóa khỏi pool" onClick={() => removeEntry(c.contact_id, c.resolved_name || c.display_name || c.contact_id)}
                              className="text-gray-600 hover:text-red-400 text-xs px-1">×</button>
                          </div>
                          {c.stage === 'closed' && (
                            <button onClick={() => { setClosingContact(c); setAttributionCampaignId(c.attributed_campaign_id ? String(c.attributed_campaign_id) : ''); setClosingError(''); }}
                              className="mt-1 text-[9px] text-green-300 hover:text-green-200">
                              {c.attributed_campaign_id ? `Nguồn: ${campaigns.find(x => x.id === c.attributed_campaign_id)?.name || `Campaign ${c.attributed_campaign_id}`} · sửa` : 'Chọn campaign ghi nhận sale'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {total > entries.length && (
        <p className="text-[10px] text-gray-500 px-4 py-1 border-t border-gray-700 flex-shrink-0">
          Hiển thị {entries.length}/{total} — thu hẹp bộ lọc để xem thêm
        </p>
      )}

      {closingContact && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) setClosingContact(null); }}>
          <div className="w-full max-w-sm rounded-xl border border-gray-700 bg-gray-800 p-4 shadow-2xl">
            <h3 className="text-sm font-semibold text-gray-100">Ghi nhận sale đã chốt</h3>
            <p className="text-xs text-gray-400 mt-1">Chọn campaign được ghi nhận cho {closingContact.resolved_name || closingContact.display_name || closingContact.contact_id}.</p>
            <select value={attributionCampaignId} onChange={e => setAttributionCampaignId(e.target.value)}
              className="w-full mt-3 bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-gray-200 outline-none focus:border-green-500">
              <option value="">Chọn campaign</option>
              {campaigns.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
            </select>
            {closingError && <p className="text-[10px] text-red-300 mt-2">{closingError}</p>}
            {campaigns.length === 0 && <p className="text-[10px] text-amber-300 mt-2">Chưa có campaign để ghi nhận.</p>}
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setClosingContact(null)} className="px-3 py-1.5 rounded-lg bg-gray-700 text-gray-300 text-xs">Hủy</button>
              <button onClick={saveClosedAttribution} disabled={!attributionCampaignId}
                className="px-3 py-1.5 rounded-lg bg-green-600 text-white text-xs disabled:opacity-40">Lưu sale đã chốt</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
