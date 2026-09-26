"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { hasBankDetails, maskBankAccount } from "@/lib/payment-info";
import { money } from "@/lib/types";
import type { Member, Transfer } from "@/lib/types";
import { Person } from "./forms";

export function TransferCard({
  index,
  transfer,
  payer,
  recipient,
  busy,
  onMarkPaid,
  onFeedback,
}: {
  index: number;
  transfer: Transfer;
  payer: Member;
  recipient: Member;
  busy: boolean;
  onMarkPaid: () => void;
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

  return (
    <article
      className="transfer"
      data-testid="transfer-card"
      aria-label={`${payer.name}匯款給${recipient.name}`}
    >
      <span className="transfer-index">
        {String(index + 1).padStart(2, "0")}
      </span>
      <div className="transfer-people">
        <Person member={payer} />
        <ArrowRight size={19} aria-hidden="true" />
        <Person member={recipient} />
      </div>
      <strong className="transfer-amount">{money(transfer.amount)}</strong>

      {hasBankDetails(recipient) ? (
        <div className="bank-panel">
          <div className="bank-details">
            <span>收款銀行</span>
            <strong>
              {recipient.bank_code} {recipient.bank_name}
            </strong>
            <span>帳號</span>
            <strong className="masked-account">
              {maskBankAccount(recipient.bank_account)}
            </strong>
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
      ) : (
        <div className="bank-panel bank-missing">
          <span>
            {recipient.icon} {recipient.name}
          </span>
          <p>尚未提供匯款資料</p>
        </div>
      )}

      <button
        className="secondary mark-paid"
        disabled={busy}
        onClick={onMarkPaid}
      >
        ✓ 已付款
      </button>
    </article>
  );
}
