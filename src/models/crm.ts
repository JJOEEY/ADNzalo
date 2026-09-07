// ─── CRM Types ────────────────────────────────────────────────────────────────

export type CRMCampaignStatus = 'draft' | 'active' | 'paused' | 'done';
export type CRMContactStatus = 'pending' | 'sending' | 'sent' | 'failed';
export type CRMCampaignType = 'message' | 'friend_request' | 'mixed' | 'invite_to_group';

export interface CRMNote {
    id?: number;
    owner_zalo_id: string;
    contact_id: string;
    contact_type?: string;
    content: string;
    topic_id?: string | null;
    created_at?: number;
    updated_at?: number;
}

export interface CRMCampaign {
    id?: number;
    owner_zalo_id: string;
    /** Immutable channel snapshot for new records; legacy records resolve from account. */
    channel?: 'zalo' | 'facebook' | 'telegram_user' | 'telegram_bot';
    name: string;
    template_message: string;
    friend_request_message: string;
    campaign_type: CRMCampaignType;
    mixed_config?: string;
    status: CRMCampaignStatus;
    delay_seconds: number;
    /** Delay range: minimum seconds between sends (replaces fixed delay_seconds + jitter) */
    delay_min_seconds?: number;
    /** Delay range: maximum seconds between sends */
    delay_max_seconds?: number;
    /** Per-contact: minimum seconds between messages to the same contact (0 = use delay_min_seconds) */
    per_contact_delay_min_seconds?: number;
    /** Per-contact: maximum seconds between messages to the same contact (0 = use per_contact_delay_min_seconds) */
    per_contact_delay_max_seconds?: number;
    daily_send_limit?: number;
    daily_start_time?: string;
    created_at?: number;
    updated_at?: number;
    total_contacts?: number;
    sent_count?: number;
    pending_count?: number;
    failed_count?: number;
    sent_today_count?: number;
}

export interface CRMCampaignContact {
    id?: number;
    campaign_id: number;
    owner_zalo_id: string;
    contact_id: string;
    display_name?: string;
    avatar?: string;
    phone?: string;
    status: CRMContactStatus;
    sent_at?: number;
    retry_count?: number;
    error?: string;
    template_message?: string;
    delay_seconds?: number;
    campaign_type?: CRMCampaignType;
    friend_request_message?: string;
}

export interface CRMSendLog {
    id?: number;
    owner_zalo_id: string;
    channel?: 'zalo' | 'facebook' | 'telegram_user' | 'telegram_bot';
    contact_id: string;
    display_name?: string;
    phone?: string;
    contact_type?: string;
    campaign_id?: number;
    message: string;
    sent_at: number;
    status: 'sent' | 'failed';
    error?: string;
    data_request?: string;
    data_response?: string;
    send_type?: string;
}

export interface CRMTag {
    id?: number;
    owner_zalo_id: string;
    name: string;
    color: string;
    emoji: string;
    created_at: number;
}

export interface CRMContactTag {
    id?: number;
    owner_zalo_id: string;
    contact_id: string;
    tag_id: number;
}

// ── Client Pool (data → khách hàng, theo dõi bán hàng/CSKH) ──────────────
// Chứng khoán: stage = trạng thái chăm sóc/mở TK; deal_value = NAV/khớp lệnh.

/** Giai đoạn client pool: mới → đang tư vấn → chốt → chăm lại / mất */
export type ClientStage = 'new' | 'consulting' | 'closed' | 'nurturing' | 'lost';

export const CLIENT_STAGES: { value: ClientStage; label: string }[] = [
    { value: 'new',        label: 'Mới' },
    { value: 'consulting', label: 'Đang tư vấn' },
    { value: 'closed',     label: 'Chốt sale' },
    { value: 'nurturing',  label: 'Chăm lại' },
    { value: 'lost',       label: 'Mất' },
];

export interface ClientPoolEntry {
    id?: number;
    owner_zalo_id: string;
    contact_id: string;
    contact_type?: string;
    display_name?: string;
    stage: ClientStage;
    /** employee_id nhân viên phụ trách ('' = chưa gán) */
    owner_employee?: string;
    deal_value?: number;
    created_at?: number;
    updated_at?: number;
    // Join sẵn để hiển thị (không lưu DB)
    phone?: string;
    last_message_time?: number;
}

export interface ClientStageHistory {
    id?: number;
    owner_zalo_id: string;
    contact_id: string;
    from_stage: string;
    to_stage: string;
    changed_by?: string;
    note?: string;
    created_at?: number;
}
