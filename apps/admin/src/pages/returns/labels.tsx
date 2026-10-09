// Words and colours for return requests (task 5.5; database.md §8.5b), shared by the queue, the return page and the order page.
import { RETURN_REASON_LABEL, type ReturnRequestStatus } from '@artq/shared';

export const RETURN_STATUS: Record<ReturnRequestStatus, [string, string]> = {
  REQUESTED: ['To decide', 'bg-warning-bg text-warning-ink'], APPROVED: ['Approved', 'bg-[#e0f2fe] text-[#075985]'], REJECTED: ['Rejected', 'bg-surface-100 text-ink-700'],
  IN_TRANSIT: ['On its way back', 'bg-[#e0f2fe] text-[#075985]'], RECEIVED: ['Received: inspect', 'bg-warning-bg text-warning-ink'], INSPECTED: ['Inspected: refund', 'bg-warning-bg text-warning-ink'],
  REFUNDED: ['Refunded', 'bg-[#dcfce7] text-success-700'], CLOSED: ['Closed', 'bg-surface-100 text-ink-700'], CANCELLED: ['Cancelled', 'bg-surface-100 text-ink-700'],
};
export const ReturnPill = ({ status }: { status: string }) => {
  const [label, tone] = RETURN_STATUS[status as ReturnRequestStatus] ?? [status, 'bg-surface-100 text-ink-700'];
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{label}</span>;
};
export const reasonLabel = (r: string) => RETURN_REASON_LABEL[r as keyof typeof RETURN_REASON_LABEL] ?? r;
