"use client";

import type { Event, Expense, Member, SettlementReview } from "@/lib/types";
import { money } from "@/lib/types";
import { reviewEligibility } from "@/lib/settlement-review";
import { Person } from "./forms";

const taipeiTime = (value: string) =>
  new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

function remaining(deadline: string) {
  const milliseconds = Math.max(0, new Date(deadline).getTime() - Date.now());
  const hours = Math.ceil(milliseconds / 3_600_000);
  return hours > 24
    ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小時`
    : `${hours} 小時`;
}

export function SettlementReviewPanel({
  event,
  review,
  members,
  expenses,
  actor,
  settlementLocked,
  busy,
  onViewMine,
  onStart,
  onConfirm,
  onDispute,
  onWithdrawDispute,
  onCancel,
  onCopyReminder,
}: {
  event: Event;
  review?: SettlementReview;
  members: Member[];
  expenses: Expense[];
  actor: string;
  settlementLocked: boolean;
  busy: boolean;
  onViewMine: () => void;
  onStart: () => void;
  onConfirm: () => void;
  onDispute: () => void;
  onWithdrawDispute: () => void;
  onCancel: () => void;
  onCopyReminder: () => void;
}) {
  const getMember = (id: string) => members.find((member) => member.id === id);
  const eligibility = reviewEligibility(review);
  const actorParticipant = review?.participants.find(
    (participant) => participant.member_id === actor,
  );
  const actorDispute = review?.disputes.find(
    (dispute) => dispute.member_id === actor && !dispute.withdrawn_at,
  );
  const actorMember = getMember(actor);
  const actorPaid = expenses.reduce(
    (sum, expense) => sum + (expense.payer_id === actor ? expense.amount : 0),
    0,
  );
  const actorShare = expenses.reduce(
    (sum, expense) =>
      sum +
      (expense.splits.find((split) => split.member_id === actor)
        ?.share_amount ?? 0),
    0,
  );
  const guests = event.members
    .map(getMember)
    .filter((member): member is Member => member?.member_type === "guest");

  return (
    <section className="review-panel" aria-labelledby="review-title">
      <div className="review-heading">
        <div>
          <span className="eyebrow">結算前核對</span>
          <h3 id="review-title">個人消費明細確認</h3>
        </div>
        <span
          className={`review-status ${
            settlementLocked
              ? "complete"
              : !review
                ? "idle"
                : eligibility.activeDisputes
                  ? "disputed"
                  : eligibility.eligible
                    ? "ready"
                    : "reviewing"
          }`}
        >
          {settlementLocked
            ? "✓ 已正式結算"
            : !review
              ? "尚未發起"
              : eligibility.activeDisputes
                ? "⚠ 有異議"
                : eligibility.eligible
                  ? "✓ 可開始結算"
                  : "核對中"}
        </span>
      </div>

      {!review && !settlementLocked && (
        <>
          <p>
            成員可在 48
            小時內核對明細。全員確認可提前結算；期限到達後，若無待處理異議，即可由成員開始結算。逾期未回覆將保留為未確認紀錄。
          </p>
          <button className="primary" disabled={busy} onClick={onStart}>
            發起明細確認
          </button>
        </>
      )}

      {review && (
        <>
          <div className="review-meta">
            <span>第 {review.round_number} 輪</span>
            <span>
              已確認 {eligibility.confirmed}／{eligibility.total} 人
            </span>
            <span>截止：{taipeiTime(review.deadline_at)}</span>
            {review.status === "open" && !eligibility.expired && (
              <span>剩餘 {remaining(review.deadline_at)}</span>
            )}
          </div>

          <div className="review-members" aria-label="必要確認成員狀態">
            {review.participants.map((participant) => {
              const person = getMember(participant.member_id);
              if (!person) return null;
              const dispute = review.disputes.find(
                (item) =>
                  item.member_id === participant.member_id &&
                  !item.withdrawn_at,
              );
              return (
                <div key={participant.member_id}>
                  <Person small member={person} />
                  <span>
                    {dispute
                      ? "已提出問題"
                      : participant.confirmed_at
                        ? "已確認"
                        : eligibility.expired
                          ? "逾期未確認"
                          : "未確認"}
                  </span>
                </div>
              );
            })}
          </div>

          {guests.length > 0 && (
            <p className="review-guest-note">
              臨時成員：{guests.map((guest) => guest.name).join("、")}
              ，由活動成員協助核對，不列入必要確認人數。
            </p>
          )}

          {actorParticipant && actorMember && (
            <div className="review-identity">
              <strong>
                目前以 {actorMember.icon} {actorMember.name} 身分操作
              </strong>
              <span>
                代墊 {money(actorPaid)} · 分攤 {money(actorShare)} ·{" "}
                {actorPaid - actorShare >= 0 ? "淨應收" : "淨應付"}{" "}
                {money(Math.abs(actorPaid - actorShare))}
              </span>
            </div>
          )}

          {review.status === "open" && (
            <div className="review-actions">
              {actorParticipant && (
                <button className="secondary" onClick={onViewMine}>
                  查看我的明細
                </button>
              )}
              <button className="secondary" onClick={onCopyReminder}>
                複製提醒訊息
              </button>
              {actorParticipant && !actorDispute && (
                <button
                  className="primary"
                  disabled={busy || Boolean(actorParticipant.confirmed_at)}
                  onClick={onConfirm}
                >
                  {actorParticipant.confirmed_at
                    ? "✓ 已確認明細"
                    : "確認明細正確"}
                </button>
              )}
              {actorParticipant && !actorDispute && (
                <button
                  className="secondary warning-button"
                  disabled={busy}
                  onClick={onDispute}
                >
                  明細有問題
                </button>
              )}
              {actorDispute && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={onWithdrawDispute}
                >
                  撤回我的異議
                </button>
              )}
              <button
                className="text-button danger-text"
                disabled={busy}
                onClick={onCancel}
              >
                取消本輪，返回編輯
              </button>
            </div>
          )}
          {review.status === "open" &&
            eligibility.expired &&
            !eligibility.allConfirmed && (
              <p className="review-expired-note">
                期限已到，仍有 {eligibility.total - eligibility.confirmed}{" "}
                人未確認。這些紀錄不會被標示為本人確認；若沒有異議，可手動開始結算。
              </p>
            )}
        </>
      )}
    </section>
  );
}
