"use client";

import {
  Check,
  Clock3,
  Copy,
  FilePenLine,
  Plus,
  RotateCcw,
} from "lucide-react";
import type { Expense, Member, SupplementalBill } from "@/lib/types";
import { money } from "@/lib/types";
import { Person } from "./forms";

function taipei(value: string | null) {
  if (!value) return "尚未開始";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

const statusText: Record<SupplementalBill["status"], string> = {
  draft: "草稿",
  reviewing: "等待相關成員確認",
  settled: "已完成補充結算",
  canceled: "已取消",
};

export function SupplementalBills({
  bills,
  members,
  expenses,
  actor,
  busy,
  onCreate,
  onEdit,
  onConfirm,
  onProblem,
  onReject,
  onWithdraw,
  onSettle,
  onCancel,
  onCopyReminder,
}: {
  bills: SupplementalBill[];
  members: Member[];
  expenses: Expense[];
  actor: string;
  busy: boolean;
  onCreate: () => void;
  onEdit: (bill: SupplementalBill) => void;
  onConfirm: (bill: SupplementalBill) => void;
  onProblem: (bill: SupplementalBill) => void;
  onReject: (bill: SupplementalBill) => void;
  onWithdraw: (bill: SupplementalBill) => void;
  onSettle: (bill: SupplementalBill) => void;
  onCancel: (bill: SupplementalBill) => void;
  onCopyReminder: (bill: SupplementalBill) => void;
}) {
  const member = (id: string) => members.find((row) => row.id === id)!;
  const openTasks = bills.filter((bill) => {
    const participant = bill.version.participants.find(
      (row) => row.member_id === actor,
    );
    return bill.status === "reviewing" && participant?.status !== "confirmed";
  }).length;
  return (
    <section className="supplement-section" aria-labelledby="supplement-title">
      <div className="section-title supplement-heading">
        <div>
          <p className="eyebrow">局部補記，不打亂原付款</p>
          <h2 id="supplement-title">補充／修正帳單</h2>
          <p className="muted">
            補記增加真實費用；修正只計算前後差額。登記付款仍在「最後怎麼付？」完成。
          </p>
        </div>
        <button className="secondary" disabled={busy} onClick={onCreate}>
          <Plus size={17} /> 新增補充費用
        </button>
      </div>
      {openTasks > 0 && (
        <div className="my-task-banner" role="status">
          <Clock3 size={18} /> 我的待辦：{openTasks} 張帳單需要確認或處理
        </div>
      )}
      {!bills.length ? (
        <div className="empty compact-empty">
          <FilePenLine />
          <p>目前沒有補充或修正帳單。</p>
        </div>
      ) : (
        <div className="supplement-list">
          {bills.map((bill) => {
            const version = bill.version;
            const participant = version.participants.find(
              (row) => row.member_id === actor,
            );
            const activeDispute = version.disputes.find(
              (row) => row.member_id === actor && !row.resolved_at,
            );
            const affected = version.delta_snapshot.map((row) => row.member_id);
            const source = expenses.find(
              (row) => row.id === bill.source_expense_id,
            );
            return (
              <article
                key={bill.id}
                className={`supplement-card ${bill.status}`}
                data-testid="supplemental-bill"
              >
                <header>
                  <div>
                    <span className={`status-pill supplement-${bill.status}`}>
                      {statusText[bill.status]}
                    </span>
                    <h3>
                      #{bill.bill_number} · {version.proposal.name}
                    </h3>
                    <p>
                      {bill.kind === "correction"
                        ? `修正原消費：${source?.name ?? "歷史消費"}`
                        : "獨立補記消費"}{" "}
                      · 第 {version.version} 版
                    </p>
                  </div>
                  <strong>{money(version.proposal.amount)}</strong>
                </header>
                <p className="supplement-reason">{version.reason}</p>
                <div className="affected-people">
                  <strong>僅影響以下成員</strong>
                  <div>
                    {affected.map((id) => (
                      <Person
                        key={id}
                        member={member(id)}
                        small
                        showGuestLabel
                      />
                    ))}
                  </div>
                  <small>其他成員無須重新確認，原期限與付款安排不變。</small>
                </div>
                <div className="delta-grid">
                  {version.delta_snapshot.map((delta) => {
                    const net = delta.paid_delta - delta.share_delta;
                    return (
                      <div key={delta.member_id}>
                        <Person member={member(delta.member_id)} small />
                        <span>代墊 {money(delta.paid_delta)}</span>
                        <span>負擔 {money(delta.share_delta)}</span>
                        <b>
                          {net >= 0 ? "應收變化" : "應付變化"}{" "}
                          {money(Math.abs(net))}
                        </b>
                      </div>
                    );
                  })}
                </div>
                {bill.status === "reviewing" && (
                  <>
                    <div className="supplement-deadline">
                      <Clock3 size={16} /> 截止：{taipei(version.deadline_at)}
                      {version.deadline_reached && "（期限已到）"}
                    </div>
                    <div className="participant-statuses">
                      {version.participants.map((row) => (
                        <span key={row.member_id} className={row.status}>
                          {member(row.member_id).icon}{" "}
                          {member(row.member_id).name} ·{" "}
                          {row.status === "confirmed"
                            ? "已確認"
                            : row.status === "disputed"
                              ? "有問題"
                              : row.status === "rejected"
                                ? "已拒絕"
                                : version.deadline_reached
                                  ? "逾期未確認"
                                  : "未確認"}
                        </span>
                      ))}
                    </div>
                    {version.delta_snapshot.some(
                      (delta) =>
                        member(delta.member_id).member_type === "guest",
                    ) && (
                      <p className="hint">
                        臨時成員由活動成員協助核對，不列入必要確認人數。
                      </p>
                    )}
                    <div className="supplement-actions">
                      {participant &&
                        participant.status !== "confirmed" &&
                        !activeDispute && (
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() => onConfirm(bill)}
                          >
                            <Check size={16} /> 確認本版正確
                          </button>
                        )}
                      {participant && !activeDispute && (
                        <>
                          <button
                            className="secondary warning"
                            disabled={busy}
                            onClick={() => onProblem(bill)}
                          >
                            明細有問題
                          </button>
                          <button
                            className="secondary danger"
                            disabled={busy}
                            onClick={() => onReject(bill)}
                          >
                            明確拒絕
                          </button>
                        </>
                      )}
                      {activeDispute && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => onWithdraw(bill)}
                        >
                          <RotateCcw size={16} /> 撤回我的問題
                        </button>
                      )}
                      <button
                        className="secondary"
                        onClick={() => onCopyReminder(bill)}
                      >
                        <Copy size={16} /> 複製提醒訊息
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => onEdit(bill)}
                      >
                        建立新版
                      </button>
                      {version.can_settle && (
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() => onSettle(bill)}
                        >
                          手動完成補充結算
                        </button>
                      )}
                      <button
                        className="text-link danger"
                        disabled={busy}
                        onClick={() => onCancel(bill)}
                      >
                        取消這張帳單
                      </button>
                    </div>
                  </>
                )}
                {bill.status === "draft" && (
                  <div className="supplement-actions">
                    <button className="primary" onClick={() => onEdit(bill)}>
                      繼續編輯並送出
                    </button>
                    <button
                      className="text-link danger"
                      onClick={() => onCancel(bill)}
                    >
                      取消草稿
                    </button>
                  </div>
                )}
                {bill.status === "settled" && (
                  <p className="privacy-note">
                    <Check size={15} />{" "}
                    已建立獨立可追溯帳務，不會覆寫主帳付款紀錄。
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
