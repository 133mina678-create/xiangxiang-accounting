import type { SettlementReview } from "./types";

export function reviewEligibility(review: SettlementReview | undefined) {
  if (!review || review.status !== "open")
    return {
      eligible: false,
      expired: false,
      allConfirmed: false,
      activeDisputes: 0,
      confirmed: 0,
      total: 0,
    };
  const activeDisputes = review.disputes.filter(
    (dispute) => !dispute.withdrawn_at,
  ).length;
  const confirmed = review.participants.filter(
    (participant) => participant.confirmed_at,
  ).length;
  return {
    eligible: review.can_start,
    expired: review.deadline_reached,
    allConfirmed: confirmed === review.participants.length,
    activeDisputes,
    confirmed,
    total: review.participants.length,
  };
}
