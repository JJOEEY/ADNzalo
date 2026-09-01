import { useCallback } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { syncZaloGroups, SyncGroupsProgress } from '@/lib/zaloGroupUtils';

/**
 * Check if account has premium from localStorage (no backend call).
 * ADNzalo: luôn trả về true để mở khóa quét thành viên ẩn miễn phí (không cần mua Premium như Deplao).
 */
export function isPremiumFromStorage(accountId: string): boolean {
  // ADNzalo: bỏ chặn Premium - quét ẩn luôn được phép
  return true;
  // Logic gốc Deplao giữ lại comment để tham khảo:
  // try {
  //   const raw = localStorage.getItem(`premium_${accountId}`);
  //   if (raw) {
  //     const data = JSON.parse(raw);
  //     return new Date(data.expiresAt) > new Date();
  //   }
  // } catch {}
  // return false;
}

interface UsePremiumMemberSyncOptions {
  accountId: string;
  groupId: string;
  onMembersSynced?: () => void;
}

interface UsePremiumMemberSyncResult {
  /** Check if current account has premium */
  isPremium: boolean;
  /** Sync members: uses scan API if premium, normal sync if not */
  syncMembers: (opts?: {
    onProgress?: (p: SyncGroupsProgress) => void;
    stopRef?: React.MutableRefObject<boolean>;
  }) => Promise<void>;
}

/**
 * Hook for syncing group members with premium fallback.
 * - Premium: uses scanGroupViaBackend for better sync
 * - Non-premium: uses normal syncZaloGroups
 */
export function usePremiumMemberSync({
  accountId,
  groupId,
  onMembersSynced,
}: UsePremiumMemberSyncOptions): UsePremiumMemberSyncResult {
  const isPremium = isPremiumFromStorage(accountId);

  const syncMembers = useCallback(async (opts?: {
    onProgress?: (p: SyncGroupsProgress) => void;
    stopRef?: React.MutableRefObject<boolean>;
  }) => {
    if (!accountId || !groupId) return;

    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;

    if (isPremium) {
      // Premium: use scan API for better sync
      const { scanGroupViaBackend } = await import('@/lib/backendService');
      const result = await scanGroupViaBackend({
        pageId: accountId,
        cookie: acc.cookies,
        imei: acc.imei,
        groupId,
      });

      if (result?.success && result.members?.length > 0) {
        await DataAccessor.saveGroupMembers({
          zaloId: accountId,
          groupId,
          members: result.members.map((m: any) => ({
            memberId: m.userId || m.id,
            displayName: m.displayName || m.zaloName || m.userId || m.id,
            avatar: m.avatar || '',
            role: 0,
          })),
        });
        onMembersSynced?.();
      }
    } else {
      // Non-premium: use normal syncZaloGroups
      const auth = buildZaloAuth(acc, accountId);
      await syncZaloGroups({
        activeAccountId: accountId,
        auth,
        groupId,
        onProgress: opts?.onProgress,
        onPhase1Done: async () => {},
        onGroupEnriched: async () => {
          onMembersSynced?.();
        },
        stopRef: opts?.stopRef,
      });
    }
  }, [accountId, groupId, isPremium, onMembersSynced]);

  return { isPremium, syncMembers };
}

/**
 * Phase C helper: bulk scan all groups via backend with per-account partitioning.
 * Exported for reuse - GroupMembersTab keeps inline handleScanAllGroups to avoid
 * breaking existing flow, but this helper provides the same logic for other callers.
 */
export async function syncAllGroups(params: {
  accountId: string;
  groupIds: string[];
  groupNames?: Record<string, string>;
  onProgress?: (current: { index: number; total: number; groupId: string; groupName: string }) => void;
  stopRef?: React.MutableRefObject<boolean>;
}): Promise<{ saved: number; failed: number; errors: Array<{ groupId: string; name: string; error: string }> }> {
  const { accountId, groupIds, groupNames, onProgress, stopRef } = params;
  const acc = useAccountStore.getState().getActiveAccount();
  if (!acc || !accountId || groupIds.length === 0) return { saved: 0, failed: 0, errors: [] };
  const { scanGroupViaBackend } = await import('@/lib/backendService');
  let saved = 0;
  let failed = 0;
  const errors: Array<{ groupId: string; name: string; error: string }> = [];
  for (let i = 0; i < groupIds.length; i++) {
    if (stopRef?.current) break;
    const groupId = groupIds[i];
    const groupName = groupNames?.[groupId] || groupId;
    onProgress?.({ index: i + 1, total: groupIds.length, groupId, groupName });
    try {
      const result = await scanGroupViaBackend({ pageId: accountId, cookie: acc.cookies, imei: acc.imei, groupId });
      if (result?.success && result.members && result.members.length > 0) {
        await DataAccessor.saveGroupMembers({
          zaloId: accountId,
          groupId,
          members: result.members.map((m: any) => ({
            memberId: m.userId || m.id,
            displayName: m.displayName || m.zaloName || m.userId || m.id,
            avatar: m.avatar || '',
            role: 0,
          })),
        });
        saved++;
      } else {
        const errMsg = result?.error || 'Không có thành viên hoặc quét thất bại';
        try {
          const auth = buildZaloAuth(acc, accountId);
          await syncZaloGroups({ activeAccountId: accountId, auth, groupId, stopRef });
          const check = await DataAccessor.getGroupMembers({ zaloId: accountId, groupId });
          if ((check?.members?.length ?? 0) > 0) saved++;
          else { failed++; errors.push({ groupId, name: groupName, error: errMsg }); }
        } catch (fallbackErr: any) {
          failed++; errors.push({ groupId, name: groupName, error: fallbackErr?.message || errMsg });
        }
      }
    } catch (err: any) {
      try {
        const auth = buildZaloAuth(acc, accountId);
        await syncZaloGroups({ activeAccountId: accountId, auth, groupId, stopRef });
        const check = await DataAccessor.getGroupMembers({ zaloId: accountId, groupId });
        if ((check?.members?.length ?? 0) > 0) saved++;
        else { failed++; errors.push({ groupId, name: groupName, error: err?.message || 'Lỗi kết nối backend' }); }
      } catch (fallbackErr: any) {
        failed++; errors.push({ groupId, name: groupName, error: err?.message || fallbackErr?.message || 'Lỗi không xác định' });
      }
    }
    if (!stopRef?.current && i + 1 < groupIds.length) await new Promise(r => setTimeout(r, 600));
  }
  return { saved, failed, errors };
}
