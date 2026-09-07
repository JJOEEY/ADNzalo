/**
 * labelUtils.ts
 *
 * Shared utilities for label sync operations.
 * Used by both runAccountInit (zaloInitUtils) and LabelSettings UI.
 */

import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { TagIcon } from '@/components/common/icons';

/**
 * Extract the display name from a Zalo label object.
 * Zalo labels use `text` as the primary name field, falling back to `name` and `title`.
 */
export function getZaloLabelName(zLabel: any): string {
    return (zLabel.text || zLabel.name || zLabel.title || `Nhãn ${zLabel.id ?? '?'}`).trim();
}

// ── Sync Zalo Labels -> Local DB ──────────────────────────────────────────────

export interface SyncZaloLabelsOptions {
    /** Raw Zalo label array from API (labelData) */
    zaloLabels: any[];
    /** Target account zalo_id */
    activeZaloId: string;
    /** merge = skip labels that already exist by name; replace = upsert all */
    mode: 'merge' | 'replace';
    /** Existing local labels (for merge dedup). If not provided, fetched from DB. */
    existingLocalLabels?: Array<{ name: string }>;
}

/**
 * Syncs Zalo labels into the local_labels DB table.
 *
 * Correctly maps Zalo API fields:
 *   text/name/title  ->  name
 *   color            ->  color
 *   emoji/icon       ->  emoji
 *   (computed)       ->  textColor  (based on background luminance)
 *
 * Returns the number of labels actually upserted.
 */
export async function syncZaloLabelsToLocalDB(opts: SyncZaloLabelsOptions): Promise<number> {
    const res = await syncZaloLabelsLinked(opts);
    return res.added + res.updated;
}

/**
 * Sync Zalo → local có liên kết 2 chiều (P4.1):
 * - Nhãn đã link: lan truyền đổi tên/màu/emoji từ Zalo (mirror).
 * - Tên trùng nhãn local chưa link: nhận link (adopt), giữ nguyên gán luồng.
 * - Nhãn Zalo đã xóa: gỡ link (mirror thành nhãn local thường, giữ gán luồng).
 * - mode 'replace': xóa hết rồi tạo lại có link (hành vi cũ).
 */
export async function syncZaloLabelsLinked(opts: SyncZaloLabelsOptions): Promise<{ added: number; updated: number; unlinked: number }> {
    const out = { added: 0, updated: 0, unlinked: 0 };
    const { zaloLabels, activeZaloId, mode } = opts;
    if (!zaloLabels || zaloLabels.length === 0) return out;

    let existing: any[] = [];
    try {
        const res = await DataAccessor.getLocalLabels({ zaloId: activeZaloId });
        existing = res?.labels || [];
    } catch { /* ignore */ }

    if (mode === 'replace') {
        for (const label of existing) {
            if (label?.id == null) continue;
            try { await DataAccessor.deleteLocalLabel({ id: label.id }); } catch { /* ignore */ }
        }
        existing = [];
    }

    const byLink = new Map<number, any>();
    const byName = new Map<string, any>();
    for (const l of existing) {
        if (l.zalo_label_id != null) byLink.set(Number(l.zalo_label_id), l);
        const key = String(l.name || '').toLowerCase();
        if (key && !byName.has(key)) byName.set(key, l);
    }

    const seenZaloIds = new Set<number>();
    let order = 0;
    for (const zLabel of zaloLabels) {
        const name = getZaloLabelName(zLabel);
        if (!name) continue;
        const zid = Number(zLabel.id);
        if (Number.isFinite(zid)) seenZaloIds.add(zid);
        const color = zLabel.color || '#3b82f6';
        const emoji = zLabel.emoji || zLabel.icon || '🏷️';
        const base = {
            name, color, textColor: '#ffffff', emoji,
            pageIds: activeZaloId, isActive: 1, sortOrder: order++,
            zaloLabelId: Number.isFinite(zid) ? zid : null,
        };
        try {
            const linked = Number.isFinite(zid) ? byLink.get(zid) : undefined;
            if (linked) {
                if (linked.name !== name || linked.color !== color || linked.emoji !== emoji) {
                    await DataAccessor.upsertLocalLabel({ label: { ...base, id: linked.id } });
                    out.updated++;
                }
                continue;
            }
            const sameName = byName.get(name.toLowerCase());
            if (mode === 'merge' && sameName) {
                await DataAccessor.upsertLocalLabel({ label: { ...base, id: sameName.id } });
                byName.delete(name.toLowerCase());
                out.updated++;
                continue;
            }
            await DataAccessor.upsertLocalLabel({ label: base });
            out.added++;
        } catch { /* skip individual failures */ }
    }

    for (const [zid, local] of byLink) {
        if (seenZaloIds.has(zid)) continue;
        try {
            await DataAccessor.upsertLocalLabel({
                label: {
                    name: local.name, color: local.color, textColor: local.text_color || '#ffffff',
                    emoji: local.emoji, pageIds: local.page_ids || activeZaloId,
                    isActive: local.is_active ?? 1, sortOrder: local.sort_order ?? 0,
                    id: local.id, zaloLabelId: null,
                },
            });
            out.unlinked++;
        } catch { /* ignore */ }
    }
    return out;
}
