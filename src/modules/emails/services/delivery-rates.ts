/**
 * The success and bounce rates from terminal counts (#250). Pure.
 *
 * - `successRate = sent / (sent + failed + bounced)`, `null` when nothing
 *   reached a terminal state;
 * - `bounceRate = bounced / (sent + bounced)`, 0 when there is neither.
 */
export function deliveryRates(counts: {
  sent: number;
  failed: number;
  bounced: number;
}): {
  successRate: number | null;
  bounceRate: number;
} {
  const { sent, failed, bounced } = counts;
  const terminal = sent + failed + bounced;
  const reached = sent + bounced;
  return {
    successRate: terminal > 0 ? sent / terminal : null,
    bounceRate: reached > 0 ? bounced / reached : 0,
  };
}
