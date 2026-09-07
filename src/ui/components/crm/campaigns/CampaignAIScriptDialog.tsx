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
  onApply: (texts: string[]) => void;
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

function buildSystemPrompt(count: number): string {
  return `Bạn là copywriter viết tin nhắn Zalo/Telegram cho phần mềm CRM.
Nhiệm vụ: dựa trên yêu cầu của người dùng, trả về ĐÚNG ${count} biến thể tin nhắn.

QUY TẮC BẮT BUỘC:
1. Chỉ trả về JSON hợp lệ, KHÔNG giải thích, KHÔNG markdown fence: {"variations": ["...", "..."]}
2. Mỗi biến thể là tin nhắn đầy đủ ý (400–1000 ký tự), tiếng Việt tự nhiên, có cấu trúc:
   chào người nhận → tự giới thiệu (dùng placeholder) → giá trị/lợi ích cụ thể → kêu gọi hành động rõ ràng (tham gia nhóm / trả lời / xem link).
3. Tự xưng của NGƯỜI GỬI luôn dùng placeholder {sender_name} — KHÔNG BAO GIỜ ghi tên cụ thể
   (VD đúng: "Em là {sender_name} bên shop..."; VD sai: "Em là Huy bên shop...").
4. Chào NGƯỜI NHẬN dùng placeholder {name} (VD: "Chào {name}, ...").
5. Các biến thể phải khác nhau rõ rệt về góc tiếp cận (không paraphrase nhẹ).
6. Không dùng ký tự trang trí quá đà, tối đa 2 emoji mỗi tin.`;
}

export default function CampaignAIScriptDialog({ senderName: initialSender, zaloId, channel, onApply, onClose }: CampaignAIScriptDialogProps) {
  const { showNotification, setView } = useAppStore();
  const [product, setProduct] = useState('');
  const [goal, setGoal] = useState(GOALS[0].value);
  const [tone, setTone] = useState(TONES[0].value);
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
    (async () => {
      try {
        const defRes = await DataAccessor.getDefaultAssistant();
        if (defRes?.success && defRes.assistant) setSelectedAssistantId(defRes.assistant.id);
        const listRes = await DataAccessor.getAssistants();
        if (listRes?.success) {
          setAssistants(listRes.assistants || []);
          if (!defRes?.assistant && listRes.assistants.length > 0) setSelectedAssistantId(listRes.assistants[0].id);
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
        [{ role: 'system', content: buildSystemPrompt(count) }, { role: 'user', content: userMsg }],
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

  const previewOf = (text: string) =>
    (text || '').replace(/\{sender_name\}/g, senderName.trim() || '{sender_name}').replace(/\{name\}/g, 'Nguyễn Văn A');

  const handleApply = () => {
    const chosen = variations.filter((_, i) => picked[i]);
    if (!chosen.length) return;
    onApply(chosen);
    showNotification(`Đã thêm ${chosen.length} biến thể từ AI`, 'success');
    onClose();
  };

  const canGenerate = product.trim().length > 0 && selectedAssistantId && !loading;

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
                    <p className="text-xs text-gray-200 leading-relaxed whitespace-pre-wrap break-words">{previewOf(v)}</p>
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
            <button onClick={handleApply} disabled={!picked.some(Boolean)}
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
