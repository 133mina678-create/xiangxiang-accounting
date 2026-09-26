"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Clock3,
  Copy,
  Eye,
  RefreshCw,
  Upload,
} from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { hasBankDetails, maskBankAccount } from "@/lib/payment-info";
import {
  formatTransferTime,
  remainingConfirmationTime,
  settlementStatusLabel,
} from "@/lib/transfer-state";
import { money } from "@/lib/types";
import type { Member, Payment, Transfer } from "@/lib/types";
import { Person } from "./forms";

function PeopleAndAmount({ payer, recipient, amount }: {
  payer: Member;
  recipient: Member;
  amount: number;
}) {
  return (
    <>
      <div className="transfer-people">
        <Person member={payer} />
        <ArrowRight size={19} aria-hidden="true" />
        <Person member={recipient} />
      </div>
      <strong className="transfer-amount">{money(amount)}</strong>
    </>
  );
}

function BankPanel({ recipient, onFeedback }: {
  recipient: Member;
  onFeedback: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );
  const copyAccount = async (account: string) => {
    try {
      await copyText(account);
      setCopied(true);
      onFeedback(`已複製${recipient.name}的匯款帳號`);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      onFeedback("無法自動複製，請確認瀏覽器允許使用剪貼簿後重試");
    }
  };
  if (!hasBankDetails(recipient))
    return (
      <div className="bank-panel bank-missing">
        <span>{recipient.icon} {recipient.name}</span>
        <p>尚未提供匯款資料</p>
      </div>
    );
  return (
    <div className="bank-panel">
      <div className="bank-details">
        <span>收款銀行</span>
        <strong>{recipient.bank_code} {recipient.bank_name}</strong>
        <span>帳號</span>
        <strong className="masked-account">{maskBankAccount(recipient.bank_account)}</strong>
      </div>
      <div className="bank-actions">
        <button
          className="secondary copy-button"
          type="button"
          onClick={() => void copyAccount(recipient.bank_account)}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? "已複製" : "複製帳號"}
        </button>
      </div>
    </div>
  );
}

export function TransferCard({
  index,
  transfer,
  payer,
  recipient,
  actor,
  busy,
  onStartPayment,
  onFeedback,
}: {
  index: number;
  transfer: Transfer;
  payer: Member;
  recipient: Member;
  actor: string;
  busy: boolean;
  onStartPayment: () => void;
  onFeedback: (message: string) => void;
}) {
  return (
    <article className="transfer" data-testid="transfer-card" aria-label={`${payer.name}匯款給${recipient.name}`}>
      <span className="transfer-index">{String(index + 1).padStart(2, "0")}</span>
      <PeopleAndAmount payer={payer} recipient={recipient} amount={transfer.amount} />
      <BankPanel recipient={recipient} onFeedback={onFeedback} />
      <div className="transfer-state pending">
        <span className="status-pill">{settlementStatusLabel.pending_payment}</span>
        {actor === payer.id ? (
          <button className="primary transfer-action" disabled={busy} onClick={onStartPayment}>
            <Upload size={17} /> 我已轉帳
          </button>
        ) : (
          <p>等待{payer.name}完成轉帳</p>
        )}
      </div>
    </article>
  );
}

export function SettlementCard({
  payment,
  payer,
  recipient,
  actor,
  busy,
  onViewProof,
  onConfirm,
  onDispute,
  onReupload,
}: {
  payment: Payment;
  payer: Member;
  recipient: Member;
  actor: string;
  busy: boolean;
  onViewProof: () => void;
  onConfirm: () => void;
  onDispute: () => void;
  onReupload: () => void;
}) {
  const active = payment.status === "awaiting_confirmation" || payment.status === "disputed";
  const completed = payment.status === "confirmed" || payment.status === "auto_confirmed";
  return (
    <article
      className={`transfer lifecycle ${payment.status}`}
      data-testid="settlement-card"
      aria-label={`${payer.name}匯款給${recipient.name}`}
    >
      <span className="transfer-index">
        {payment.status === "disputed" ? <AlertTriangle size={18} /> : <Check size={18} />}
      </span>
      <PeopleAndAmount payer={payer} recipient={recipient} amount={payment.amount} />
      <div className="transfer-state-detail">
        <span className={`status-pill ${payment.status}`}>{settlementStatusLabel[payment.status]}</span>
        {payment.status === "awaiting_confirmation" && (
          <>
            <p>{payer.name}已標記完成轉帳，等待{recipient.name}確認。</p>
            <dl className="transfer-times">
              <div><dt>付款時間</dt><dd>{formatTransferTime(payment.paid_at)}</dd></div>
              <div>
                <dt>距離自動確認</dt>
                <dd><Clock3 size={14} /> {payment.paid_at ? remainingConfirmationTime(payment.paid_at) : "—"}</dd>
              </div>
            </dl>
          </>
        )}
        {payment.status === "disputed" && (
          <p className="dispute-message">收款人表示尚未收到款項，自動確認已暫停。</p>
        )}
        {completed && (
          <>
            <p>
              {payment.status === "auto_confirmed"
                ? "收款人在 72 小時內未提出異議，系統已自動確認。"
                : `${recipient.name}已確認收到 ${money(payment.amount)}。`}
            </p>
            <dl className="transfer-times">
              <div><dt>付款時間</dt><dd>{formatTransferTime(payment.paid_at)}</dd></div>
              <div><dt>完成時間</dt><dd>{formatTransferTime(payment.confirmed_at)}</dd></div>
              <div>
                <dt>確認方式</dt>
                <dd>
                  {payment.confirmation_method === "auto"
                    ? "72 小時自動確認"
                    : payment.confirmation_method === "legacy"
                      ? "舊版付款紀錄"
                      : "收款人手動確認"}
                </dd>
              </div>
            </dl>
            <p className="privacy-note">轉帳證明已依隱私設計刪除。</p>
          </>
        )}
      </div>
      {active && (actor === payer.id || actor === recipient.id) && (
        <div className="proof-actions">
          <button className="secondary" disabled={busy} onClick={onViewProof}>
            <Eye size={17} /> 查看轉帳證明
          </button>
        </div>
      )}
      {payment.status === "awaiting_confirmation" && actor === recipient.id && (
        <div className="recipient-actions">
          <button className="primary" disabled={busy} onClick={onConfirm}>
            <Check size={17} /> 確認收到
          </button>
          <button className="secondary warning" disabled={busy} onClick={onDispute}>尚未收到</button>
        </div>
      )}
      {payment.status === "disputed" && (
        <div className="recipient-actions">
          {actor === payer.id && (
            <button className="primary" disabled={busy} onClick={onReupload}>
              <RefreshCw size={17} /> 重新上傳證明
            </button>
          )}
          {actor === recipient.id && (
            <button className="primary" disabled={busy} onClick={onConfirm}>
              <Check size={17} /> 確認已收到
            </button>
          )}
        </div>
      )}
    </article>
  );
}
