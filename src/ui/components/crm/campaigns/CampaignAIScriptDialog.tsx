import React, { useState, useEffect, useRef } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { SparklesIcon } from '@/components/common/icons';
import { type Channel } from '../../../../configs/channelConfig';

interface CampaignAIScriptDialogProps {
  /** Tên nick gửi (prefill, sửa được) — dùng để preview, KHÔNG ghi cứng vào kịch bản */
  senderName: string;
  /** zaloId nick gửi (nếu có) — để AI xưng hô đúng nick qua service */
  zaloId?: string;
  channel: Channel;
  initialRulesSnapshot?: string;
  onApply: (texts: string[], rulesSnapshot: string, rulesVersion: number) => void;
  onClose: () => void;
}

const GOALS = [
  { value: 'ban_hang', label: 'Bán hàng / chốt đơn' },
  { value: 'gioi_thieu', label: 'Giới thiệu sản phẩm' },
  { value: 'moi_nhom', label: 'Mời vào nhóm' },
  { value: 'cham_soc', label: 'Chăm sóc / tái kết nối' },
];

const TONES = [
  { value: 'than_thien', label: 'Thân thiện' },
  { value: 'chuyen_nghiep', label: 'Chuyên nghiệp' },
  { value: 'hai_huoc', label: 'Hài hước' },
  { value: 'ngan_gon', label: 'Ngắn gọn' },
];

function extractVariations(text: string, maxCount: number): string[] {
  // 1) JSON {"variations": [...]} hoặc mảng trần (kèm markdown fence)
  const tryParse = (s: string): string[] | null => {
    try {
      const p = JSON.parse(s);
      if (Array.isArray(p)) return p.filter((x) => typeof x === 'string');
      if (p && Array.isArray(p.variations)) return p.variations.filter((x: unknown) => typeof x === 'string');
    } catch { /* continue */ }
    return null;
  };
  const direct = tryParse(text.trim());
  if (direct && direct.length) return direct.slice(0, maxCount);
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed && parsed.length) return parsed.slice(0, maxCount);
  }
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    const parsed = tryParse(text.substring(braceStart, braceEnd + 1));
    if (parsed && parsed.length) return parsed.slice(0, maxCount);
  }
  const bracketStart = text.indexOf('[');
  const bracketEnd = text.lastIndexOf(']');
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    const parsed = tryParse(text.substring(bracketStart, bracketEnd + 1));
    if (parsed && parsed.length) return parsed.slice(0, maxCount);
  }
  // 2) Fallback: tách theo dòng đánh số hoặc đoạn văn
  const lines = text.split('\n').map((l) => l.replace(/^\s*(biến thể\s*)?\d+[\).\:\-]\s*/i, '').trim()).filter(Boolean);
  const chunks = lines.length >= 2 ? lines : text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  return chunks.filter((s) => s.length > 10).slice(0, maxCount);
}

const COMMON_SCRIPT_RULES = `Quy tắc chung:
- Không bịa giá, ưu đãi, kết quả, chứng nhận hoặc cam kết không có trong thông tin đầu vào.
- Không hứa hẹn lợi nhuận/kết quả chắc chắn; không tạo cảm giác khẩn cấp giả.
- Dùng {sender_name} cho người gửi và {name} cho người nhận.
- Mỗi tin nhắn dài 80–1000 ký tự, tối đa 2 emoji, có lời mời phản hồi tự nhiên.
- Cụm từ cấm: cam kết 100%, đảm bảo lợi nhuận, chắc chắn sinh lời, không rủi ro.`;
const CAMPAIGN_RULES_MARKER = '\n\nQuy tắc bổ sung cho campaign:\n';

function initialCampaignRules(snapshot?: string): string {
  if (!snapshot) return '';
  const markerAt = snapshot.indexOf(CAMPAIGN_RULES_MARKER);
  return markerAt >= 0 ? snapshot.slice(markerAt + CAMPAIGN_RULES_MARKER.length) : '';
}

function initialCommonRules(snapshot?: string): { version: number; text: string } | null {
  if (!snapshot) return null;
  const markerAt = snapshot.indexOf(CAMPAIGN_RULES_MARKER);
  const common = markerAt >= 0 ? snapshot.slice(0, markerAt) : snapshot;
  const match = common.match(/^Quy tắc chung v(\d+):\n([\s\S]*)$/);
  return match ? { version: Number(match[1]) || 0, text: match[2] } : null;
}

export function validateCampaignVariation(text: string): string[] {
  const issues: string[] = [];
  if (text.length < 80 || text.length > 1000) issues.push('Độ dài phải từ 80 đến 1.000 ký tự');
  if (!text.includes('{sender_name}')) issues.push('Thiếu placeholder {sender_name}');
  if (!text.includes('{name}')) issues.push('Thiếu placeholder {name}');
  const banned = ['cam kết 100%', 'đảm bảo lợi nhuận', 'chắc chắn sinh lời', 'không rủi ro'];
  const hit = banned.find(phrase => text.toLocaleLowerCase('vi').includes(phrase));
  if (hit) issues.push(`Có cụm từ cần tránh: “${hit}”`);
  return issues;
}

function buildSystemPrompt(count: number, rules: string): string {
  return `Bạn là copywriter viết tin nhắn Zalo/Telegram cho phần mềm CRM.
Nhiệm vụ: dựa trên yêu cầu của người dùng, trả về ĐÚNG ${count} biến thể tin nhắn.

QUY TẮC NỘI DUNG CỦA CAMPAIGN (phải tuân thủ):
${rules}

Chỉ trả về JSON hợp lệ, không markdown: {"variations": ["...", "..."]}.
Các biến thể phải khác nhau rõ về góc tiếp cận; không tự thêm tên thật, giá hoặc tuyên bố không có trong đầu vào.`;
}

export default function CampaignAIScriptDialog({ senderName: initialSender, zaloId, channel, initialRulesSnapshot, onApply, onClose }: CampaignAIScriptDialogProps) {
  const { showNotification, setView } = useAppStore();
  const [product, setProduct] = useState('');
  const [goal, setGoal] = useState(GOALS[0].value);
  const [tone, setTone] = useState(TONES[0].value);
  const [campaignRules, setCampaignRules] = useState(initialCampaignRules(initialRulesSnapshot));
  const [commonRules, setCommonRules] = useState(initialCommonRules(initialRulesSnapshot)?.text || COMMON_SCRIPT_RULES);
  const [savedCommonRules, setSavedCommonRules] = useState(initialCommonRules(initialRulesSnapshot)?.text || COMMON_SCRIPT_RULES);
  const [commonRulesVersion, setCommonRulesVersion] = useState(initialCommonRules(initialRulesSnapshot)?.version || 0);
  const [savingCommonRules, setSavingCommonRules] = useState(false);
  const rulesSnapshot = `Quy tắc chung v${commonRulesVersion}:\n${commonRules.trim()}${CAMPAIGN_RULES_MARKER}${campaignRules.trim()}`;
  // 3-5 biến thể để xoay vòng (random) khi gửi — tránh spam do trùng nội dung
  const [count, setCount] = useState(3);
  const [senderName, setSenderName] = useState(initialSender);
  const [assistants, setAssistants] = useState<any[]>([]);
  const [selectedAssistantId, setSelectedAssistantId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [variations, setVariations] = useState<string[]>([]);
  const [picked, setPicked] = useState<boolean[]>([]);
  const productRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!initialRulesSnapshot) return;
    const savedCommon = initialCommonRules(initialRulesSnapshot);
    if (!savedCommon) return;
    setCampaignRules(initialCampaignRules(initialRulesSnapshot));
    setCommonRules(savedCommon.text);
    setSavedCommonRules(savedCommon.text);
    setCommonRulesVersion(savedCommon.version);
  }, [initialRulesSnapshot]);

  useEffect(() => {
    (async () => {
      try {
        const defRes = await DataAccessor.getDefaultAssistant();
        if (defRes?.success && defRes.assistant) setSelectedAssistantId(defRes.assistant.id);
        const listRes = await DataAccessor.getAssistants();
        if (listRes?.success) {
          setAssistants(listRes.assistants || []);
          if (!defRes?.assistant && listRes.assistants.length > 0) setSelectedAssistantId(listRes.assistants[0].id);
        }
        if (!initialRulesSnapshot && zaloId) {
          const ruleRes = await DataAccessor.getCRMCommonScriptRules({ zaloId });
          const savedRules = ruleRes?.rules || (ruleRes as any)?.data;
          if (ruleRes?.success && savedRules?.rules_text) {
            setCommonRules(savedRules.rules_text);
            setSavedCommonRules(savedRules.rules_text);
            setCommonRulesVersion(savedRules.version || 0);
          }
        }
      } catch { /* ignore */ }
    })();
    productRef.current?.focus();
  }, []);

  const goalLabel = GOALS.find((g) => g.value === goal)?.label ?? goal;
  const toneLabel = TONES.find((t) => t.value === tone)?.label ?? tone;

  const handleGenerate = async () => {
    if (!product.trim() || !selectedAssistantId) return;
    setLoading(true);
    setError('');
    try {
      const userMsg = [
        `Kênh gửi: ${channel === 'zalo' ? 'Zalo' : 'Telegram'}.`,
        `Sản phẩm/dịch vụ/ưu đãi: ${product.trim()}`,
        `Mục tiêu: ${goalLabel}.`,
        `Giọng điệu: ${toneLabel}.`,
        `Tên người gửi để PREVIEW: "${senderName.trim() || '{sender_name}'}" (chỉ dùng khi preview, trong kịch bản vẫn giữ nguyên placeholder {sender_name}).`,
        `Trả về đúng ${count} biến thể.`,
      ].join('\n');
      const res = await ipc.ai?.chat(
        selectedAssistantId,
        [{ role: 'system', content: buildSystemPrompt(count, rulesSnapshot) }, { role: 'user', content: userMsg }],
        false,
        8000,
        zaloId || undefined,
      );
      if (!res?.success || !res.result) {
        setError(res?.error || 'AI không trả về kết quả');
        return;
      }
      const parsed = extractVariations(res.result, count);
      if (!parsed.length) {
        setError('AI trả về dữ liệu không đúng format. Thử mô tả rõ hơn.');
        return;
      }
      setVariations(parsed);
      setPicked(parsed.map(() => true));
    } catch (err: any) {
      setError(err?.message || 'Lỗi gọi AI');
    } finally {
      setLoading(false);
    }
  };

  const selectedIssues = variations.flatMap((text, index) => picked[index]
    ? validateCampaignVariation(text).map(issue => `Biến thể ${index + 1}: ${issue}`)
    : []);

  const handleApply = () => {
    const chosen = variations.filter((_, i) => picked[i]);
    if (!chosen.length || selectedIssues.length) return;
    onApply(chosen, rulesSnapshot.trim(), commonRulesVersion);
    showNotification(`Đã thêm ${chosen.length} biến thể từ AI`, 'success');
    onClose();
  };

  const handleSaveCommonRules = async () => {
    if (!zaloId || !commonRules.trim() || savingCommonRules) return;
    setSavingCommonRules(true);
    try {
      const res = await DataAccessor.saveCRMCommonScriptRules({ zaloId, rulesText: commonRules.trim() });
      const savedRules = res?.rules || (res as any)?.data;
      if (!res?.success || !savedRules?.version) {
        setError(res?.error || 'Không lưu được bộ quy tắc chung');
        return;
      }
      setCommonRulesVersion(savedRules.version);
      setSavedCommonRules(savedRules.rules_text);
      setVariations([]);
      setPicked([]);
      showNotification(`Đã lưu bộ quy tắc chung phiên bản ${savedRules.version}`, 'success');
    } catch (err: any) {
      setError(err?.message || 'Không lưu được bộ quy tắc chung');
    } finally { setSavingCommonRules(false); }
  };

  const canGenerate = product.trim().length > 0 && selectedAssistantId && commonRules.trim().length > 0 &&
    commonRules.trim() === savedCommonRules.trim() && !loading;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-[600px] max-h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white">
              <SparklesIcon className="w-4 h-4" />
            </div>
            <div>
              <p className="text-gray-100 font-semibold text-sm">AI viết kịch bản chiến dịch</p>
              <p className="text-gray-400 text-[11px] mt-0.5">Tự xưng theo nick gửi qua {'{sender_name}'} — dùng chung cho nhiều nick</p>
            </div>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-100 hover:bg-gray-700 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {assistants.length > 0 && (
            <div>
              <label className="text-gray-400 text-xs font-medium mb-1.5 block">Trợ lý AI</label>
              <select value={selectedAssistantId} onChange={(e) => setSelectedAssistantId(e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 outline-none focus:border-violet-500">
                {assistants.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.platform || 'openai'} - {a.model || 'default'})</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="text-gray-400 text-xs font-medium mb-1.5 block">Sản phẩm / dịch vụ / ưu đãi *</label>
            <textarea ref={productRef} value={product} onChange={(e) => setProduct(e.target.value)} rows={3}
              placeholder="VD: Khóa học đầu tư chứng khoán, ưu đãi giảm 30% đến hết tuần..."
              className="w-full bg-gray-900 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-violet-500 resize-none transition-colors" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-gray-400 text-xs font-medium mb-1.5 block">Mục tiêu</label>
              <select value={goal} onChange={(e) => setGoal(e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 rounded-xl px-2.5 py-2 text-sm text-gray-200 outline-none focus:border-violet-500">
                {GOALS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-xs font-medium mb-1.5 block">Giọng điệu</label>
              <select value={tone} onChange={(e) => setTone(e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 rounded-xl px-2.5 py-2 text-sm text-gray-200 outline-none focus:border-violet-500">
                {TONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-xs font-medium mb-1.5 block">Số biến thể (xoay vòng)</label>
              <select value={count} onChange={(e) => setCount(parseInt(e.target.value) || 3)}
                className="w-full bg-gray-900 border border-gray-600 rounded-xl px-2.5 py-2 text-sm text-gray-200 outline-none focus:border-violet-500">
                {[3, 4, 5].map((n) => <option key={n} value={n}>{n} biến thể</option>)}
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-gray-400 text-xs font-medium">Quy tắc chung v{commonRulesVersion}</label>
              <button type="button" onClick={handleSaveCommonRules} disabled={!zaloId || !commonRules.trim() || savingCommonRules}
                className="px-2 py-1 rounded-md border border-violet-500/40 text-[10px] text-violet-300 hover:bg-violet-500/10 disabled:opacity-40">
                {savingCommonRules ? 'Đang lưu...' : 'Lưu phiên bản chung mới'}
              </button>
            </div>
            <textarea value={commonRules} onChange={(e) => setCommonRules(e.target.value)} rows={5}
              className="w-full bg-gray-900 border border-gray-600 rounded-xl px-3 py-2.5 text-xs text-gray-200 focus:outline-none focus:border-violet-500 resize-y" />
            {commonRules.trim() !== savedCommonRules.trim() && <p className="text-[10px] text-amber-300 mt-1">Lưu phiên bản quy tắc chung mới trước khi sinh kịch bản.</p>}
            <label className="text-gray-400 text-xs font-medium mb-1.5 mt-3 block">Quy tắc bổ sung cho campaign</label>
            <textarea value={campaignRules} onChange={(e) => setCampaignRules(e.target.value)} rows={3}
              className="w-full bg-gray-900 border border-gray-600 rounded-xl px-3 py-2.5 text-xs text-gray-200 focus:outline-none focus:border-violet-500 resize-y" />
            <p className="text-[10px] text-gray-500 mt-1">Bản quy tắc được lưu cùng dữ liệu đo lường kịch bản trong CRM.</p>
          </div>

          <div>
            <label className="text-gray-400 text-xs font-medium mb-1.5 block">Tên người gửi (để preview)</label>
            <input value={senderName} onChange={(e) => setSenderName(e.target.value)}
              placeholder="Tên nick Zalo gửi..."
              className="w-full bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors" />
            <p className="text-[10px] text-gray-500 mt-1">Kịch bản lưu placeholder {'{sender_name}'} — lúc gửi mỗi nick tự xưng tên mình.</p>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5 space-y-2">
              <p className="text-xs text-red-400">{error.replace('AI_MISSING_KEY: ', '')}</p>
              {/AI_MISSING_KEY|api key|API key|401|unauthorized/i.test(error) && (
                <button
                  onClick={() => { onClose(); setView('integration'); }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors font-medium">
                  Mở cài đặt AI để dán key
                </button>
              )}
            </div>
          )}

          {/* Variations preview */}
          {variations.length > 0 && (
            <div className="space-y-2">
              <p className="text-gray-400 text-xs font-medium">Kết quả — tick chọn biến thể muốn thêm</p>
              {variations.map((v, i) => (
                <label key={i}
                  className={`flex gap-2.5 p-3 rounded-xl border cursor-pointer transition-colors ${
                    picked[i] ? 'border-violet-500/60 bg-violet-500/5' : 'border-gray-600 hover:border-gray-500'
                  }`}>
                  <input type="checkbox" checked={!!picked[i]}
                    onChange={() => setPicked((prev) => prev.map((p, j) => (j === i ? !p : p)))}
                    className="mt-1 flex-shrink-0 accent-violet-500" />
                  <div className="min-w-0">
                    <p className="text-[10px] text-violet-400 font-semibold mb-1">Biến thể {i + 1} (preview: {senderName.trim() || '...'} gửi)</p>
                    <textarea value={v} onChange={(e) => setVariations(prev => prev.map((text, j) => j === i ? e.target.value : text))}
                      rows={Math.min(6, Math.max(3, Math.ceil(v.length / 100)))}
                      className="w-full bg-gray-900/70 border border-gray-700 rounded-lg p-2 text-xs text-gray-200 leading-relaxed whitespace-pre-wrap break-words focus:outline-none focus:border-violet-500 resize-y"
                      onClick={(e) => e.stopPropagation()} />
                    {validateCampaignVariation(v).map(issue => <p key={issue} className="text-[10px] text-amber-400 mt-1">{issue}</p>)}
                    <p className="text-[10px] text-gray-500 font-mono mt-1.5 break-words">{v}</p>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-3 border-t border-gray-700 flex-shrink-0">
          <div className="flex-1" />
          <button onClick={onClose}
            className="px-4 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 transition-colors font-medium">
            Đóng
          </button>
          {variations.length > 0 && (
            <button onClick={handleGenerate} disabled={!canGenerate}
              className="px-4 py-2 rounded-xl border border-violet-500/40 text-violet-300 text-sm hover:bg-violet-500/10 disabled:opacity-40 transition-colors font-medium">
              Tạo lại
            </button>
          )}
          {variations.length > 0 ? (
            <button onClick={handleApply} disabled={!picked.some(Boolean) || selectedIssues.length > 0}
              className="px-5 py-2 rounded-xl bg-violet-600 text-white text-sm hover:bg-violet-700 disabled:opacity-40 transition-colors font-semibold">
              Thêm {picked.filter(Boolean).length} biến thể
            </button>
          ) : (
            <button onClick={handleGenerate} disabled={!canGenerate}
              className="px-5 py-2 rounded-xl bg-violet-600 text-white text-sm hover:bg-violet-700 disabled:opacity-40 transition-colors font-semibold flex items-center gap-2">
              <SparklesIcon className="w-4 h-4" />
              {loading ? 'Đang viết...' : 'Viết kịch bản'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
