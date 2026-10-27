"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  BookOpen,
  ChartNoAxesColumn,
  Wallet,
  Download,
  Copy,
  Settings2,
  Trash2,
  Pencil,
  Lock,
  RotateCcw,
  MapPin,
  CalendarDays,
  RefreshCw,
  ArchiveRestore,
  ShieldCheck,
} from "lucide-react";
import {
  readBook,
  mutate,
  submitTransferProof,
  transitionTransfer,
  startSettlement,
  cancelSettlement,
  startSettlementReview,
  transitionSettlementReview,
  cancelSettlementReview,
  manageEvent,
} from "@/lib/api";
import {
  settle,
  statistics,
  personalExpenseRecords,
  transfersForMember,
  transferTotalsForMember,
} from "@/lib/calculations";
import { transferRecipient } from "@/lib/payment-info";
import { copyText } from "@/lib/clipboard";
import { categories, money } from "@/lib/types";
import type {
  Book,
  Event,
  Expense,
  Member,
  Payment,
  SettlementReview,
  Transfer,
} from "@/lib/types";
import { EventForm, ExpenseForm, Modal, Person, FormError } from "./forms";
import { SettlementCard, TransferCard } from "./transfer-card";
import {
  TransferProofDialog,
  TransferProofViewer,
} from "./transfer-proof-dialog";
import { reviewEligibility } from "@/lib/settlement-review";
import { SettlementReviewPanel } from "./settlement-review";

type Dialog =
  | { kind: "identity" }
  | { kind: "event"; event?: Event }
  | { kind: "expense"; expense?: Expense }
  | { kind: "detail"; id: string }
  | {
      kind: "confirm";
      title: string;
      message: string;
      action: string;
      data: Record<string, unknown>;
    }
  | { kind: "proof-upload"; transfer: Transfer; payment?: Payment }
  | { kind: "proof-view"; payment: Payment }
  | {
      kind: "transfer-confirm";
      payment: Payment;
      action: "confirm" | "dispute" | "withdraw";
    }
  | { kind: "settlement-confirm"; action: "start" | "cancel" }
  | {
      kind: "review-confirm";
      action: "start" | "confirm" | "cancel" | "withdraw";
    }
  | { kind: "review-dispute" }
  | { kind: "event-lifecycle"; event: Event; action: "delete" | "restore" }
  | { kind: "recently-deleted" }
  | { kind: "settings" }
  | null;
export default function Ledger({ secret }: { secret: string }) {
  const [book, setBook] = useState<Book | null>(null),
    [actor, setActor] = useState(""),
    [eventId, setEventId] = useState(""),
    [tab, setTab] = useState("expenses");
  const [dialog, setDialog] = useState<Dialog>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [synced, setSynced] = useState(false),
    [syncedAt, setSyncedAt] = useState(0),
    [managementEnabled, setManagementEnabled] = useState(false),
    [adminSecret, setAdminSecret] = useState(""),
    [deleteConfirmation, setDeleteConfirmation] = useState(""),
    [reviewReason, setReviewReason] = useState(""),
    [reviewExpense, setReviewExpense] = useState("");
  const [day, setDay] = useState(""),
    [payer, setPayer] = useState(""),
    [category, setCategory] = useState(""),
    [grouped, setGrouped] = useState(true),
    [statsDay, setStatsDay] = useState(""),
    [spendingPerson, setSpendingPerson] = useState(""),
    [settlementView, setSettlementView] = useState<"all" | "mine">("all"),
    [settlementPerson, setSettlementPerson] = useState("");
  const [undo, setUndo] = useState<{ id: string; event_id: string } | null>(
    null,
  );
  const revision = useRef(-1),
    working = useRef(false),
    request = useRef(0);
  const refresh = useCallback(async () => {
    const n = ++request.current;
    try {
      const next = await readBook(secret);
      if (n !== request.current) return;
      if (next.revision >= revision.current) {
        revision.current = next.revision;
        setBook(next);
        setSyncedAt(Date.now());
      }
      setSynced(true);
    } catch (e) {
      setSynced(false);
      if (revision.current < 0) setError((e as Error).message);
    }
  }, [secret]);
  // Hydrate browser-only identity after SSR; this preference is external state.
  useEffect(() => {
    const identity = localStorage.getItem("xiangxiang-identity");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate external browser preference.
    if (identity) setActor(identity);
    else setDialog({ kind: "identity" });
    void refresh();
    void fetch(`/api/book/${secret}/event-lifecycle`)
      .then((response) => response.json())
      .then((result) => setManagementEnabled(result.enabled === true))
      .catch(() => setManagementEnabled(false));
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !working.current)
        void refresh();
    }, 3000);
    const wake = () => void refresh();
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [refresh, secret]); // Identity is a preference only, never authorization.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 12000);
    return () => clearTimeout(t);
  }, [undo]);
  const save = async (
    action: string,
    data: Record<string, unknown>,
    expected?: number,
  ) => {
    if (working.current) return false;
    if (
      !book?.members.some((m) => m.id === actor && m.member_type !== "guest")
    ) {
      setDialog({ kind: "identity" });
      return false;
    }
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await mutate(secret, expected ?? revision.current, actor, action, data);
      await refresh();
      setNotice("已儲存到共同帳本");
      return true;
    } catch (e) {
      setError((e as Error).message);
      await refresh();
      return false;
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const runTransferMutation = async (operation: () => Promise<unknown>) => {
    if (working.current) throw new Error("上一個操作仍在處理中");
    if (
      !book?.members.some((m) => m.id === actor && m.member_type !== "guest")
    ) {
      setDialog({ kind: "identity" });
      throw new Error("請先選擇操作身份");
    }
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      await refresh();
      throw caught;
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const openEvent = (id: string) => {
    setEventId(id);
    setTab("expenses");
    setDay("");
    setPayer("");
    setCategory("");
    setStatsDay("");
    setSpendingPerson("");
    setSettlementView("all");
    setSettlementPerson("");
  };
  const openEventLifecycle = (target: Event, action: "delete" | "restore") => {
    setAdminSecret("");
    setDeleteConfirmation("");
    setDialog({ kind: "event-lifecycle", event: target, action });
  };
  const runEventLifecycle = async (
    target: Event,
    action: "delete" | "restore",
  ) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await manageEvent(secret, {
        eventId: target.id,
        action,
        adminSecret,
      });
      if (action === "delete") setEventId("");
      await refresh();
      setNotice(
        action === "delete"
          ? `已將「${target.name}」移至最近刪除`
          : `已還原「${target.name}」`,
      );
      setDialog(null);
      setAdminSecret("");
      setDeleteConfirmation("");
    } catch (caught) {
      setError((caught as Error).message);
      await refresh();
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setNotice("已複製秘密連結，請只分享給六位朋友");
    } catch {
      setError("無法複製，請直接複製瀏覽器網址。");
    }
  };
  if (!book)
    return (
      <main className="welcome">
        <div className="brand-mark">香</div>
        <h1>香香的記帳本</h1>
        <p role="status">{error || "正在打開共同帳本…"}</p>
        {error && (
          <button
            className="primary"
            onClick={() => {
              setError("");
              void refresh();
            }}
          >
            重新連線
          </button>
        )}
      </main>
    );
  const member = (id: string): Member => book.members.find((m) => m.id === id)!;
  const fixedMembers = book.members.filter(
    (candidate) => candidate.member_type !== "guest",
  );
  const event = book.events.find((e) => e.id === eventId && !e.deleted_at);
  const eventIsClosed = event?.status === "closed";
  const settlementLocked = event?.settlement_state === "locked";
  const eventReviews = (book.reviews ?? []).filter(
    (review) => review.event_id === eventId,
  );
  const openReview = eventReviews.find((review) => review.status === "open");
  const settledReview = [...eventReviews]
    .reverse()
    .find((review) => review.status === "settled");
  const displayedReview: SettlementReview | undefined = settlementLocked
    ? settledReview
    : openReview;
  const currentReviewEligibility = reviewEligibility(openReview);
  const eventEditable = Boolean(
    event &&
    !event.deleted_at &&
    !eventIsClosed &&
    !settlementLocked &&
    !openReview,
  );
  const expenses = book.expenses.filter(
    (e) => e.event_id === eventId && !e.deleted_at,
  );
  const payments = book.payments.filter((p) => p.event_id === eventId);
  const pendingPayments = payments.filter((p) =>
    ["pending_payment", "record_only"].includes(p.status),
  );
  const activePayments = payments.filter((p) =>
    ["awaiting_confirmation", "disputed"].includes(p.status),
  );
  const completedPayments = payments.filter((p) =>
    ["confirmed", "auto_confirmed"].includes(p.status),
  );
  const awaitingCount = payments.filter(
    (p) => p.status === "awaiting_confirmation",
  ).length;
  const disputedCount = payments.filter((p) => p.status === "disputed").length;
  const total = expenses.reduce((s, x) => s + x.amount, 0);
  const filtered = expenses.filter(
    (e) =>
      (!day || e.date === day) &&
      (!payer || e.payer_id === payer) &&
      (!category || e.category === category),
  );
  const stats = event
    ? statistics(
        event.members,
        expenses.filter((e) => !statsDay || e.date === statsDay),
      )
    : [];
  const selectedSpendingPerson =
    event?.members.find((id) => id === spendingPerson) ??
    event?.members.find((id) => id === actor) ??
    event?.members[0] ??
    "";
  const personalSpending = personalExpenseRecords(
    expenses.filter((expense) => !statsDay || expense.date === statsDay),
    selectedSpendingPerson,
  );
  const personalSpendingTotals = personalSpending.reduce(
    (totals, row) => ({
      gross: totals.gross + row.gross,
      discount: totals.discount + row.discount,
      spent: totals.spent + row.spent,
      paid: totals.paid + row.paid,
    }),
    { gross: 0, discount: 0, spent: 0, paid: 0 },
  );
  const balances = event ? statistics(event.members, expenses, payments) : [];
  const transfers = settlementLocked ? [] : settle(balances);
  const guestTransfers = transfers.filter(
    (transfer) =>
      member(transfer.from_id).member_type === "guest" ||
      member(transfer.to_id).member_type === "guest",
  );
  const fixedTransfers = transfers.filter(
    (transfer) =>
      member(transfer.from_id).member_type !== "guest" &&
      member(transfer.to_id).member_type !== "guest",
  );
  const fixedBalances = balances.filter(
    (balance) => member(balance.id).member_type !== "guest",
  );
  const hasUnfinishedPayments =
    (fixedBalances.some((balance) => balance.remaining > 0) &&
      fixedBalances.some((balance) => balance.remaining < 0)) ||
    payments.some((payment) =>
      ["pending_payment", "awaiting_confirmation", "disputed"].includes(
        payment.status,
      ),
    );
  const canCancelSettlement =
    settlementLocked &&
    payments.every((payment) =>
      ["pending_payment", "record_only"].includes(payment.status),
    );
  const selectedSettlementPerson =
    event?.members.find((id) => id === settlementPerson) ??
    event?.members.find((id) => id === actor) ??
    event?.members[0] ??
    "";
  const visibleForPerson = <T extends Transfer>(rows: T[]) =>
    settlementView === "all"
      ? rows
      : transfersForMember(rows, selectedSettlementPerson);
  const settlementRows: Transfer[] = settlementLocked ? payments : transfers;
  const personalTotals = transferTotalsForMember(
    settlementRows,
    selectedSettlementPerson,
  );
  const days = [...new Set(expenses.map((e) => e.date))].sort();
  const exportCSV = () => {
    const cell = (s: string) =>
      `"${(/^[=+\-@\t\r]/.test(s) ? "'" : "") + s.replaceAll('"', '""')}"`;
    const rows = [
      [
        "日期",
        "消費名稱",
        "分類",
        "備註",
        "付款人",
        "金額",
        "分攤方式",
        "分攤對象",
        "各自分攤金額",
      ],
      ...expenses.map((e) => [
        e.date,
        e.name,
        categories.find((c) => c[0] === e.category)![2],
        e.note,
        member(e.payer_id).name,
        String(e.amount),
        { equal: "平均", custom: "自訂", weighted: "份數" }[e.mode],
        e.splits.map((s) => member(s.member_id).name).join("、"),
        e.splits
          .map((s) => `${member(s.member_id).name}: ${s.share_amount}`)
          .join("；"),
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob(
        ["\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n")],
        { type: "text/csv;charset=utf-8" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${event?.name ?? "活動"}-帳目.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const deletedEvents = book.deleted_events ?? [];
  const cards = (past: boolean) =>
    book.events
      .filter((e) => !e.deleted_at && (e.status === "closed") === past)
      .map((e) => {
        const es = book.expenses.filter(
          (x) => x.event_id === e.id && !x.deleted_at,
        );
        return (
          <div className="event-card-shell" key={e.id}>
            <button className="event-card" onClick={() => openEvent(e.id)}>
              <div className="event-art">
                <span>
                  <MapPin size={22} />
                </span>
                <span className="event-status">
                  {past ? "已結束" : "一起出發"}
                </span>
                <div className="event-friends">
                  {e.members.map((id) => (
                    <span key={id} title={member(id).name}>
                      {member(id).icon}
                    </span>
                  ))}
                </div>
              </div>
              <div className="event-body">
                <p className="date">
                  {e.start_date.replaceAll("-", " / ")}
                  {e.end_date && e.end_date !== e.start_date
                    ? ` — ${e.end_date.slice(5).replace("-", " / ")}`
                    : ""}
                </p>
                <h3>{e.name}</h3>
                <p className="muted">
                  {e.members.length} 位朋友 <span>·</span> {es.length} 筆消費
                </p>
                <div className="event-bottom">
                  <span>
                    目前總花費
                    <strong>
                      {money(es.reduce((s, x) => s + x.amount, 0))}
                    </strong>
                  </span>
                  <span className="round-arrow">
                    <ArrowRight size={20} />
                  </span>
                </div>
              </div>
            </button>
            {past && (
              <button
                className="past-event-delete"
                onClick={() => openEventLifecycle(e, "delete")}
                aria-label={`刪除活動 ${e.name}`}
              >
                <Trash2 size={15} />
                刪除活動
              </button>
            )}
          </div>
        );
      });
  return (
    <FormError.Provider value={error}>
      <div className="app-shell">
        <header className="topbar">
          <button className="brand" onClick={() => setEventId("")}>
            <span className="brand-mark">香</span>
            <span>
              香香的記帳本<small>今天又是誰先墊錢？</small>
            </span>
          </button>
          <div className="header-actions">
            <span
              className={`sync ${synced ? "" : "offline"}`}
              title="每 3 秒向雲端同步"
            >
              {synced ? "雲端已同步" : "連線中斷・等待重連"}
            </span>
            <button
              className="identity"
              aria-label="切換我是誰"
              onClick={() => setDialog({ kind: "identity" })}
            >
              {fixedMembers.some((m) => m.id === actor) ? (
                <Person small member={member(actor)} />
              ) : (
                "我是誰？"
              )}
            </button>
            <button
              className="icon-button"
              aria-label="帳本設定"
              onClick={() => setDialog({ kind: "settings" })}
            >
              <Settings2 size={20} />
            </button>
          </div>
        </header>
        <main className="main-content">
          {!event ? (
            <>
              <section className="home-heading">
                <div>
                  <p className="eyebrow">OUR LITTLE ADVENTURES</p>
                  <h1>奶蛋香香的</h1>
                  <p className="muted">把花費記下來，把時間留給朋友。</p>
                </div>
                <button
                  className="primary"
                  onClick={() => setDialog({ kind: "event" })}
                >
                  <Plus size={18} />
                  新增活動
                </button>
              </section>
              <div className="section-title">
                <h2>
                  進行中的活動{" "}
                  <span>
                    {
                      book.events.filter(
                        (e) => !e.deleted_at && e.status === "active",
                      ).length
                    }
                  </span>
                </h2>
                <span className="muted">下一段回憶，從這裡開始</span>
              </div>
              <div className="event-grid">{cards(false)}</div>
              {!book.events.some(
                (e) => !e.deleted_at && e.status === "active",
              ) && (
                <div className="empty">
                  <BookOpen />
                  <h3>還沒有進行中的活動</h3>
                  <p>聚餐也好，旅行也好，先幫這次相聚取個名字。</p>
                  <button
                    className="secondary"
                    onClick={() => setDialog({ kind: "event" })}
                  >
                    ＋ 建立第一個活動
                  </button>
                </div>
              )}
              <div className="section-title past-heading">
                <h2>過去的活動</h2>
                <span className="muted">花費有記錄，回憶也在</span>
              </div>
              <div className="event-grid">{cards(true)}</div>
              {!book.events.some(
                (e) => !e.deleted_at && e.status === "closed",
              ) && (
                <p className="muted">結束的活動可以收進這裡，隨時回來看看。</p>
              )}
              <button
                className="recently-deleted-link"
                onClick={() => setDialog({ kind: "recently-deleted" })}
              >
                <Trash2 size={15} />
                最近刪除
                {deletedEvents.length > 0 && (
                  <span>{deletedEvents.length}</span>
                )}
              </button>
              <footer className="home-footer">
                <span>🔥 ⭐ 💬 🦑 🥒 🐰</span>
                <p>六個人，一本帳。每一筆都算得剛剛好。</p>
              </footer>
            </>
          ) : (
            <>
              <button className="back-link" onClick={() => setEventId("")}>
                <ArrowLeft size={17} />
                所有活動
              </button>
              <section className="event-heading">
                <div>
                  <div className="eyebrow">
                    <CalendarDays size={15} />
                    {event.start_date}
                    {event.end_date ? ` — ${event.end_date}` : ""} ·{" "}
                    {event.members.length} 人
                  </div>
                  <h1>{event.name}</h1>
                  {event.note && <p className="muted">{event.note}</p>}
                  <div className="participant-strip">
                    {event.members.map((id) => (
                      <Person key={id} small member={member(id)} />
                    ))}
                  </div>
                </div>
                <div className="total-box">
                  <span>這趟一起花了</span>
                  <strong data-testid="event-total">{money(total)}</strong>
                  <span>
                    {expenses.length} 筆消費 ·{" "}
                    {eventIsClosed ? "已結束" : "持續記錄中"}
                  </span>
                </div>
              </section>
              {eventIsClosed && (
                <div className="closed-banner" role="status">
                  <Lock size={18} />
                  <span>
                    <strong>此活動已結束</strong>
                    歷史帳目目前為唯讀
                  </span>
                </div>
              )}
              {!eventIsClosed && settlementLocked && (
                <div className="settlement-lock-banner" role="status">
                  <Lock size={18} />
                  <span>
                    <strong>正式結算已開始</strong>
                    消費與分攤已建立快照，目前帳目為唯讀
                  </span>
                </div>
              )}
              {!eventIsClosed && openReview && (
                <div className="review-lock-banner" role="status">
                  <Lock size={18} />
                  <span>
                    <strong>個人明細確認進行中</strong>
                    待核對內容已固定；如需修正，請先取消本輪確認
                  </span>
                </div>
              )}
              <div className="event-tools">
                {eventEditable && (
                  <button
                    className="text-link"
                    onClick={() => setDialog({ kind: "event", event })}
                  >
                    <Pencil size={15} />
                    編輯活動
                  </button>
                )}
                <button className="text-link" onClick={exportCSV}>
                  <Download size={15} />
                  匯出 CSV
                </button>
                {!eventIsClosed && (
                  <button
                    className="text-link"
                    disabled={busy}
                    onClick={() => {
                      if (!settlementLocked) {
                        setError(
                          openReview
                            ? "請先完成本輪核對並開始正式結算。"
                            : "請先到「最後怎麼付？」發起個人明細確認。",
                        );
                        return;
                      }
                      if (hasUnfinishedPayments) {
                        setError(
                          "目前仍有尚未完成的款項，請完成所有結算後再結束活動。",
                        );
                        return;
                      }
                      setDialog({
                        kind: "confirm",
                        title: "結束這個活動？",
                        message:
                          "確定要結束這個活動嗎？結束後帳目將改為唯讀，但仍可查看歷史紀錄。",
                        action: "event.close",
                        data: { event_id: event.id },
                      });
                    }}
                  >
                    <Lock size={15} />
                    結束活動
                  </button>
                )}
              </div>
              <nav className="tabs" aria-label="活動頁面">
                <button
                  className={tab === "expenses" ? "active" : ""}
                  onClick={() => setTab("expenses")}
                >
                  <BookOpen size={19} />
                  帳目
                </button>
                <button
                  className={tab === "stats" ? "active" : ""}
                  onClick={() => setTab("stats")}
                >
                  <ChartNoAxesColumn size={19} />
                  統計
                </button>
                <button
                  className={tab === "settle" ? "active" : ""}
                  onClick={() => setTab("settle")}
                >
                  <Wallet size={19} />
                  最後怎麼付？
                </button>
              </nav>
              {tab === "expenses" && (
                <section>
                  <div className="section-title">
                    <h2>一起花的每一筆</h2>
                    {eventEditable && (
                      <button
                        className="primary add-expense"
                        onClick={() => setDialog({ kind: "expense" })}
                      >
                        <Plus size={19} />
                        新增消費
                      </button>
                    )}
                  </div>
                  <div className="filters">
                    <label>
                      日期
                      <select
                        value={day}
                        onChange={(e) => setDay(e.target.value)}
                      >
                        <option value="">全部日期</option>
                        {days.map((d) => (
                          <option key={d}>{d}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      付款人
                      <select
                        value={payer}
                        onChange={(e) => setPayer(e.target.value)}
                      >
                        <option value="">所有付款人</option>
                        {event.members.map((id) => (
                          <option key={id} value={id}>
                            {member(id).icon} {member(id).name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      分類
                      <select
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                      >
                        <option value="">所有分類</option>
                        {categories.map(([id, icon, name]) => (
                          <option key={id} value={id}>
                            {icon} {name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="list-meta">
                    <span>
                      {filtered.length} 筆 ·{" "}
                      {money(filtered.reduce((s, x) => s + x.amount, 0))}
                    </span>
                    <div className="segmented">
                      <button
                        aria-pressed={!grouped}
                        onClick={() => setGrouped(false)}
                      >
                        全部
                      </button>
                      <button
                        aria-pressed={grouped}
                        onClick={() => setGrouped(true)}
                      >
                        依日期
                      </button>
                    </div>
                  </div>
                  {filtered.map((x, i) => {
                    const c = categories.find((c) => c[0] === x.category)!;
                    return (
                      <div key={x.id}>
                        {grouped &&
                          (i === 0 || filtered[i - 1].date !== x.date) && (
                            <h3 className="day-heading">
                              {x.date.replaceAll("-", " / ")}
                              <span>
                                {money(
                                  filtered
                                    .filter((y) => y.date === x.date)
                                    .reduce((s, y) => s + y.amount, 0),
                                )}
                              </span>
                            </h3>
                          )}
                        <button
                          className="expense-row"
                          onClick={() =>
                            setDialog({ kind: "detail", id: x.id })
                          }
                        >
                          <span className={`category-icon ${x.category}`}>
                            {c[1]}
                          </span>
                          <span className="expense-main">
                            <strong>{x.name}</strong>
                            <span>
                              <Person small member={member(x.payer_id)} />{" "}
                              <span className="muted">先付款</span>
                            </span>
                          </span>
                          <span className="expense-amount">
                            <strong>{money(x.amount)}</strong>
                            <small>
                              {x.splits.length} 人分攤
                              {x.mode === "equal" &&
                              x.amount % x.splits.length === 0
                                ? ` · 每人 $${x.amount / x.splits.length}`
                                : ""}
                            </small>
                            {!grouped && <small>{x.date}</small>}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                  {!filtered.length && (
                    <div className="empty">
                      <BookOpen />
                      <h3>
                        {expenses.length
                          ? "沒有符合條件的帳目"
                          : "第一筆花費，從這裡開始"}
                      </h3>
                      <p>
                        {expenses.length
                          ? "試試其他日期、付款人或分類。"
                          : "輸入金額、選擇分類，就能幫大家記一筆。"}
                      </p>
                    </div>
                  )}
                </section>
              )}
              {tab === "stats" && (
                <section>
                  <div className="section-title">
                    <h2>每個人，都算清楚。</h2>
                    <label className="compact-label">
                      統計範圍
                      <select
                        value={statsDay}
                        onChange={(e) => setStatsDay(e.target.value)}
                      >
                        <option value="">整趟活動</option>
                        {days.map((d) => (
                          <option key={d}>{d}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="summary-band">
                    <div>
                      <span>{statsDay ? "當日總花費" : "活動總支出"}</span>
                      <strong>
                        {money(stats.reduce((s, x) => s + x.paid, 0))}
                      </strong>
                    </div>
                    <div>
                      <span>消費紀錄</span>
                      <strong>
                        {
                          expenses.filter(
                            (e) => !statsDay || e.date === statsDay,
                          ).length
                        }
                        <small> 筆</small>
                      </strong>
                    </div>
                  </div>
                  <p className="hint">
                    實際付款是先墊的錢；應負擔是自己分到的費用。以下差額尚未扣除朋友間的轉帳。
                  </p>
                  <div className="stats-grid">
                    {stats.map((s) => (
                      <article
                        className="stat-card"
                        key={s.id}
                        style={
                          {
                            "--person-color": member(s.id).color,
                          } as React.CSSProperties
                        }
                      >
                        <Person member={member(s.id)} />
                        <dl>
                          <div>
                            <dt>實際付款</dt>
                            <dd>{money(s.paid)}</dd>
                          </div>
                          <div>
                            <dt>應負擔</dt>
                            <dd>{money(s.share)}</dd>
                          </div>
                          <div
                            className={`net ${s.net >= 0 ? "positive" : "negative"}`}
                          >
                            <dt>
                              {s.net > 0
                                ? "應收"
                                : s.net < 0
                                  ? "應付"
                                  : "不欠不墊"}
                            </dt>
                            <dd>{money(Math.abs(s.net))}</dd>
                          </div>
                        </dl>
                      </article>
                    ))}
                  </div>
                  <section className="personal-spending">
                    <div className="personal-spending-head">
                      <div>
                        <p className="eyebrow">自己的每一筆，都看得懂</p>
                        <h2>個人消費明細</h2>
                      </div>
                      <label className="compact-label">
                        查看成員
                        <select
                          aria-label="查看個人消費的成員"
                          value={selectedSpendingPerson}
                          onChange={(e) => setSpendingPerson(e.target.value)}
                        >
                          {event.members.map((id) => (
                            <option key={id} value={id}>
                              {member(id).icon} {member(id).name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {selectedSpendingPerson && (
                      <>
                        <div className="personal-spending-summary">
                          <Person member={member(selectedSpendingPerson)} />
                          <div>
                            <span>折扣前</span>
                            <strong>
                              {money(personalSpendingTotals.gross)}
                            </strong>
                          </div>
                          <div>
                            <span>實際花銷</span>
                            <strong>
                              {money(personalSpendingTotals.spent)}
                            </strong>
                          </div>
                          <div>
                            <span>獲得折扣</span>
                            <strong>
                              {money(personalSpendingTotals.discount)}
                            </strong>
                          </div>
                          <div>
                            <span>先付款</span>
                            <strong>
                              {money(personalSpendingTotals.paid)}
                            </strong>
                          </div>
                        </div>
                        <p className="hint">
                          實際花銷是自己分到的折後費用；先付款是替大家墊付的金額，兩者分開計算。
                        </p>
                        <div className="personal-expense-list">
                          {personalSpending.map(
                            ({ expense: item, gross, discount, spent }) => {
                              const itemCategory = categories.find(
                                (candidate) => candidate[0] === item.category,
                              )!;
                              return (
                                <button
                                  type="button"
                                  className="personal-expense-row"
                                  key={item.id}
                                  onClick={() =>
                                    setDialog({ kind: "detail", id: item.id })
                                  }
                                >
                                  <span className="personal-expense-icon">
                                    {itemCategory[1]}
                                  </span>
                                  <span className="personal-expense-main">
                                    <strong>{item.name}</strong>
                                    <small>
                                      {item.date} · {itemCategory[2]} ·{" "}
                                      {member(item.payer_id).name}先付款
                                    </small>
                                  </span>
                                  <span className="personal-expense-money">
                                    <strong>{money(spent)}</strong>
                                    {discount > 0 && (
                                      <small>
                                        原價 {money(gross)} · 折{" "}
                                        {money(discount)}
                                      </small>
                                    )}
                                  </span>
                                </button>
                              );
                            },
                          )}
                          {!personalSpending.length && (
                            <div className="empty compact-empty">
                              <BookOpen />
                              <p>這個範圍內沒有個人消費紀錄。</p>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </section>
                </section>
              )}
              {tab === "settle" && (
                <section className="settlement">
                  <SettlementReviewPanel
                    event={event}
                    review={displayedReview}
                    members={book.members}
                    expenses={expenses}
                    actor={actor}
                    settlementLocked={settlementLocked}
                    busy={busy}
                    onViewMine={() => {
                      setSpendingPerson(actor);
                      setStatsDay("");
                      setTab("stats");
                    }}
                    onStart={() =>
                      setDialog({ kind: "review-confirm", action: "start" })
                    }
                    onConfirm={() =>
                      setDialog({ kind: "review-confirm", action: "confirm" })
                    }
                    onDispute={() => {
                      setReviewReason("");
                      setReviewExpense("");
                      setDialog({ kind: "review-dispute" });
                    }}
                    onWithdrawDispute={() =>
                      setDialog({ kind: "review-confirm", action: "withdraw" })
                    }
                    onCancel={() =>
                      setDialog({ kind: "review-confirm", action: "cancel" })
                    }
                    onCopyReminder={() => {
                      if (!openReview) return;
                      const deadline = new Intl.DateTimeFormat("zh-TW", {
                        timeZone: "Asia/Taipei",
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(openReview.deadline_at));
                      const reminder = `【${event.name}】第 ${openReview.round_number} 輪個人消費明細確認\n截止：${deadline}\n請開啟共同帳本核對自己的代墊與分攤：${window.location.href}`;
                      void copyText(reminder)
                        .then(() => setNotice("已複製明細確認提醒"))
                        .catch(() =>
                          setError("無法複製提醒，請確認瀏覽器權限。"),
                        );
                    }}
                  />
                  <div className="section-title">
                    <div>
                      <p className="eyebrow">少轉幾筆，多一點輕鬆</p>
                      <h2>最後怎麼付？</h2>
                    </div>
                    <span className="settle-symbol">💸</span>
                  </div>
                  <p className="muted">
                    {settlementLocked
                      ? "正式結算金額已固定；完成匯款後，需由收款人確認。"
                      : "目前是即時預覽，消費變動時結算金額也會更新。"}
                  </p>
                  <div className="settlement-view-controls">
                    <div className="segmented" aria-label="結算顯示範圍">
                      <button
                        aria-pressed={settlementView === "all"}
                        onClick={() => setSettlementView("all")}
                      >
                        全部結算
                      </button>
                      <button
                        aria-pressed={settlementView === "mine"}
                        onClick={() => setSettlementView("mine")}
                      >
                        只看我的
                      </button>
                    </div>
                    {settlementView === "mine" && (
                      <label className="compact-label">
                        查看成員
                        <select
                          value={selectedSettlementPerson}
                          onChange={(e) => setSettlementPerson(e.target.value)}
                        >
                          {event.members.map((id) => (
                            <option key={id} value={id}>
                              {member(id).icon} {member(id).name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  {settlementView === "mine" && selectedSettlementPerson && (
                    <div className="personal-settlement-summary">
                      <Person member={member(selectedSettlementPerson)} />
                      <div>
                        <span>本次應付</span>
                        <strong>{money(personalTotals.outgoing)}</strong>
                      </div>
                      <div>
                        <span>本次應收</span>
                        <strong>{money(personalTotals.incoming)}</strong>
                      </div>
                    </div>
                  )}
                  {!eventIsClosed && (
                    <div
                      className={`settlement-snapshot-panel ${settlementLocked ? "locked" : "preview"}`}
                    >
                      <div>
                        <strong>
                          {settlementLocked ? "🔒 正式結算已鎖定" : "結算預覽"}
                        </strong>
                        <p>
                          {settlementLocked
                            ? `建立時間：${event.settlement_started_at ? new Date(event.settlement_started_at).toLocaleString("zh-TW") : "—"}`
                            : "確認後會固定消費、分攤與轉帳關係。"}
                        </p>
                      </div>
                      {!settlementLocked ? (
                        openReview && currentReviewEligibility.eligible ? (
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() =>
                              setDialog({
                                kind: "settlement-confirm",
                                action: "start",
                              })
                            }
                          >
                            <Lock size={17} /> 開始結算
                          </button>
                        ) : (
                          <span className="snapshot-note">
                            {openReview
                              ? currentReviewEligibility.activeDisputes
                                ? "請先處理明細異議"
                                : "等待全員確認或 48 小時期限到達"
                              : "請先發起個人明細確認"}
                          </span>
                        )
                      ) : canCancelSettlement ? (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            setDialog({
                              kind: "settlement-confirm",
                              action: "cancel",
                            })
                          }
                        >
                          <RotateCcw size={17} /> 取消結算，返回編輯
                        </button>
                      ) : (
                        <span className="snapshot-note">
                          已有付款提交，不能取消結算
                        </span>
                      )}
                    </div>
                  )}
                  {(settlementRows.length > 0 || activePayments.length > 0) && (
                    <div
                      className="settlement-reminders"
                      aria-label="轉帳狀態提醒"
                    >
                      <span>
                        待付款{" "}
                        {settlementLocked
                          ? pendingPayments.filter(
                              (p) => p.status === "pending_payment",
                            ).length
                          : fixedTransfers.length}{" "}
                        筆
                      </span>
                      {(settlementLocked
                        ? pendingPayments.some(
                            (p) => p.status === "record_only",
                          )
                        : guestTransfers.length > 0) && (
                        <span>
                          臨時成員記帳{" "}
                          {settlementLocked
                            ? pendingPayments.filter(
                                (p) => p.status === "record_only",
                              ).length
                            : guestTransfers.length}{" "}
                          筆
                        </span>
                      )}
                      <span>等待確認 {awaitingCount} 筆</span>
                      <span className={disputedCount ? "has-dispute" : ""}>
                        有異議 {disputedCount} 筆
                      </span>
                    </div>
                  )}
                  {visibleForPerson(activePayments).length > 0 && (
                    <>
                      <h3 className="subheading">付款確認中</h3>
                      {visibleForPerson(activePayments).map((payment) => (
                        <SettlementCard
                          key={payment.id}
                          payment={payment}
                          payer={member(payment.from_id)}
                          recipient={member(payment.to_id)}
                          actor={actor}
                          busy={busy}
                          onViewProof={() =>
                            setDialog({ kind: "proof-view", payment })
                          }
                          onConfirm={() =>
                            setDialog({
                              kind: "transfer-confirm",
                              payment,
                              action: "confirm",
                            })
                          }
                          onDispute={() =>
                            setDialog({
                              kind: "transfer-confirm",
                              payment,
                              action: "dispute",
                            })
                          }
                          onReupload={() =>
                            setDialog({
                              kind: "proof-upload",
                              transfer: payment,
                              payment,
                            })
                          }
                          onWithdraw={() =>
                            setDialog({
                              kind: "transfer-confirm",
                              payment,
                              action: "withdraw",
                            })
                          }
                        />
                      ))}
                    </>
                  )}
                  {settlementLocked &&
                    visibleForPerson(pendingPayments).length > 0 && (
                      <>
                        <h3 className="subheading">待付款與記帳資料</h3>
                        <div className="settle-intro">
                          固定成員間的款項可使用轉帳確認流程；臨時成員款項只列明金額，請自行確認。
                        </div>
                        {visibleForPerson(pendingPayments).map((payment, i) => {
                          const recipient = transferRecipient(
                            payment,
                            book.members,
                          );
                          return (
                            <TransferCard
                              key={payment.id}
                              index={i}
                              transfer={payment}
                              payer={member(payment.from_id)}
                              recipient={recipient}
                              actor={actor}
                              busy={busy}
                              state={
                                payment.status === "record_only"
                                  ? "record_only"
                                  : "pending"
                              }
                              onFeedback={setNotice}
                              onStartPayment={() =>
                                setDialog({
                                  kind: "proof-upload",
                                  transfer: payment,
                                  payment,
                                })
                              }
                            />
                          );
                        })}
                      </>
                    )}
                  {!settlementLocked &&
                    visibleForPerson(transfers).length > 0 && (
                      <>
                        <h3 className="subheading">預覽收付款關係</h3>
                        {visibleForPerson(transfers).map((transfer, i) => (
                          <TransferCard
                            key={`${transfer.from_id}-${transfer.to_id}`}
                            index={i}
                            transfer={transfer}
                            payer={member(transfer.from_id)}
                            recipient={member(transfer.to_id)}
                            actor={actor}
                            busy={busy}
                            state="preview"
                            onFeedback={setNotice}
                            onStartPayment={() => undefined}
                          />
                        ))}
                      </>
                    )}
                  {settlementLocked &&
                  !visibleForPerson(pendingPayments).length &&
                  !visibleForPerson(activePayments).length &&
                  !visibleForPerson(completedPayments).length ? (
                    <div className="all-clear">
                      <span>🎉</span>
                      <h2>目前沒有需要結算的費用</h2>
                      <p>正式快照與歷史帳目都已保留。</p>
                    </div>
                  ) : settlementLocked &&
                    !pendingPayments.length &&
                    activePayments.length ? (
                    <div className="all-clear waiting">
                      <span>🕐</span>
                      <h2>所有款項都已送出</h2>
                      <p>等待收款人確認後，本次活動就會正式結清。</p>
                    </div>
                  ) : settlementLocked &&
                    !pendingPayments.length &&
                    !activePayments.length &&
                    completedPayments.length ? (
                    <div className="all-clear">
                      <span>🎉</span>
                      <h2>本次活動已全部結清！</h2>
                      <p>帳目與紀錄都會保留，隨時可以回來看。</p>
                    </div>
                  ) : null}
                  <div className="balance-check">
                    <span>
                      結算應收{" "}
                      <b>
                        {money(
                          settlementRows.reduce(
                            (sum, row) => sum + row.amount,
                            0,
                          ),
                        )}
                      </b>
                    </span>
                    <span>
                      結算應付{" "}
                      <b>
                        {money(
                          settlementRows.reduce(
                            (sum, row) => sum + row.amount,
                            0,
                          ),
                        )}
                      </b>
                    </span>
                    <span>✓ 金額平衡</span>
                  </div>
                  {visibleForPerson(completedPayments).length > 0 && (
                    <>
                      <h3 className="subheading">已完成的轉帳</h3>
                      {visibleForPerson(completedPayments).map((payment) => (
                        <SettlementCard
                          key={payment.id}
                          payment={payment}
                          payer={member(payment.from_id)}
                          recipient={member(payment.to_id)}
                          actor={actor}
                          busy={busy}
                          onViewProof={() => undefined}
                          onConfirm={() => undefined}
                          onDispute={() => undefined}
                          onReupload={() => undefined}
                          onWithdraw={() => undefined}
                        />
                      ))}
                    </>
                  )}
                  <p className="hint">
                    正式結算使用不可覆寫的快照。漏記費用應以新的補充結算批次處理，不可修改已有付款紀錄。
                  </p>
                </section>
              )}
            </>
          )}
        </main>
        {error && !dialog && (
          <div className="error-toast" role="alert">
            <span>{error}</span>
            <button aria-label="關閉錯誤" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {(notice || undo) && (
          <div className="toast" role="status">
            <span>{undo ? "消費已刪除，可在設定的回收區復原" : notice}</span>
            {undo && (
              <button
                disabled={busy}
                onClick={async () => {
                  if (await save("expense.restore", undo)) setUndo(null);
                }}
              >
                復原 Undo
              </button>
            )}
          </div>
        )}
        {dialog?.kind === "identity" && (
          <Modal title="嗨，你是哪位朋友？" onClose={() => setDialog(null)}>
            <p className="muted">
              方便預設付款人，也讓大家知道是誰記的帳。隨時可以切換。
            </p>
            <div className="identity-grid">
              {fixedMembers.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    localStorage.setItem("xiangxiang-identity", m.id);
                    setActor(m.id);
                    setDialog(null);
                  }}
                >
                  <Person member={m} />
                  <span>{actor === m.id ? "✓" : "→"}</span>
                </button>
              ))}
            </div>
            <p className="hint">這不是登入。持有秘密連結的朋友都有編輯權限。</p>
          </Modal>
        )}
        {dialog?.kind === "event" && !dialog.event?.deleted_at && (
          <EventForm
            members={book.members}
            event={dialog.event}
            getRevision={() => revision.current}
            onSave={save}
            busy={busy}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === "expense" && event && (
          <ExpenseForm
            members={book.members}
            actor={actor}
            event={event}
            expense={dialog.expense}
            getRevision={() => revision.current}
            onSave={save}
            busy={busy}
            settlementWarning={payments.length > 0}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === "detail" &&
          (() => {
            const x = book.expenses.find((e) => e.id === dialog.id);
            if (!x || x.deleted_at)
              return (
                <Modal title="紀錄已變更" onClose={() => setDialog(null)}>
                  <p>這筆消費已被刪除，可以到回收區查看。</p>
                </Modal>
              );
            const c = categories.find((c) => c[0] === x.category)!;
            return (
              <Modal
                title={`${c[1]} ${x.name}`}
                onClose={() => setDialog(null)}
              >
                <p className="detail-amount">{money(x.amount)}</p>
                <p className="muted">
                  {x.date} · {c[2]} ·{" "}
                  {x.splits.some((split) => split.gross_amount != null)
                    ? x.splits.some(
                        (split) => split.discount_method === "shared",
                      )
                      ? "共同折扣"
                      : "個別折扣"
                    : {
                        equal: "平均分攤",
                        custom: "自訂金額",
                        weighted: "份數分攤",
                      }[x.mode]}
                </p>
                <p className="detail-payer">
                  付款：
                  <Person member={member(x.payer_id)} />
                </p>
                <div className="split-preview">
                  <strong>每人應負擔</strong>
                  {x.splits.map((s) => (
                    <div key={s.member_id}>
                      <Person small member={member(s.member_id)} />
                      <b>
                        {money(s.share_amount)}
                        {(s.discount_amount ?? 0) > 0 && (
                          <small className="split-discount-detail">
                            原價 {money(s.gross_amount ?? s.share_amount)} ·
                            折扣 {money(s.discount_amount ?? 0)}
                          </small>
                        )}
                        {x.mode === "weighted" ? ` · ${s.weight} 份` : ""}
                      </b>
                    </div>
                  ))}
                </div>
                {x.note && (
                  <div className="expense-note">
                    <strong>備註</strong>
                    <p>{x.note}</p>
                  </div>
                )}
                {eventEditable && (
                  <div className="two-col">
                    <button
                      className="secondary"
                      onClick={() => setDialog({ kind: "expense", expense: x })}
                    >
                      <Pencil size={16} />
                      修改
                    </button>
                    <button
                      className="danger-button"
                      onClick={() =>
                        setDialog({
                          kind: "confirm",
                          title: "刪除這筆消費？",
                          message: `${x.name} ${money(x.amount)} 將移至回收區，活動統計與結算會重新計算。${payments.length ? "此活動已有付款進行中或已完成的交易，既有轉帳不會被刪除或改寫；差額會另列調整轉帳。" : ""}`,
                          action: "expense.delete",
                          data: { id: x.id, event_id: x.event_id },
                        })
                      }
                    >
                      <Trash2 size={16} />
                      刪除
                    </button>
                  </div>
                )}
              </Modal>
            );
          })()}
        {dialog?.kind === "proof-upload" && event && (
          <TransferProofDialog
            payer={member(dialog.transfer.from_id)}
            recipient={member(dialog.transfer.to_id)}
            amount={dialog.transfer.amount}
            reupload={dialog.payment?.status === "disputed"}
            onClose={() => setDialog(null)}
            onSubmit={async (proof) => {
              await runTransferMutation(() =>
                submitTransferProof(secret, {
                  proof,
                  revision: revision.current,
                  actor,
                  event_id: event.id,
                  from_id: dialog.transfer.from_id,
                  to_id: dialog.transfer.to_id,
                  amount: dialog.transfer.amount,
                  settlement_id: dialog.payment?.id,
                }),
              );
              setNotice(
                dialog.payment?.status === "disputed"
                  ? "已更新轉帳證明，重新開始 72 小時確認時間"
                  : "轉帳證明已送出，等待收款人確認",
              );
              setDialog(null);
            }}
          />
        )}
        {dialog?.kind === "proof-view" && (
          <TransferProofViewer
            secret={secret}
            paymentId={dialog.payment.id}
            actor={actor}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === "transfer-confirm" && (
          <Modal
            title={
              dialog.action === "confirm"
                ? "確認已收到款項？"
                : dialog.action === "dispute"
                  ? "回報尚未收到？"
                  : "撤回付款申請？"
            }
            onClose={() => setDialog(null)}
          >
            <p>
              {dialog.action === "confirm"
                ? `確定已收到 ${money(dialog.payment.amount)} 嗎？確認後，轉帳證明會立即刪除。`
                : dialog.action === "dispute"
                  ? `確定尚未收到 ${money(dialog.payment.amount)} 嗎？這會暫停 72 小時自動確認。`
                  : `確定撤回 ${money(dialog.payment.amount)} 的付款申請嗎？轉帳證明會刪除，狀態將回到待付款。`}
            </p>
            <div className="two-col">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button
                className={
                  dialog.action === "confirm" ? "primary" : "danger-button"
                }
                disabled={busy}
                onClick={async () => {
                  try {
                    await runTransferMutation(() =>
                      transitionTransfer(
                        secret,
                        dialog.payment.id,
                        revision.current,
                        actor,
                        dialog.action,
                      ),
                    );
                    setNotice(
                      dialog.action === "confirm"
                        ? "已確認收到，轉帳證明已排入立即刪除"
                        : dialog.action === "dispute"
                          ? "已回報尚未收到，自動確認已暫停"
                          : "付款申請已撤回，可重新提交正確證明",
                    );
                    setDialog(null);
                  } catch {
                    // The shared error toast already explains the failure.
                  }
                }}
              >
                {busy ? "處理中…" : "確認"}
              </button>
            </div>
          </Modal>
        )}
        {dialog?.kind === "review-confirm" && event && (
          <Modal
            title={
              {
                start: "發起個人明細確認？",
                confirm: "確認這份個人明細？",
                cancel: "取消本輪明細確認？",
                withdraw: "撤回明細異議？",
              }[dialog.action]
            }
            onClose={() => setDialog(null)}
          >
            {dialog.action === "start" ? (
              <p>
                建立後會固定本輪帳目 48
                小時。期間不能新增、修改、刪除或還原消費，也不能變更活動成員；如需修正，必須取消本輪後重新發起。
              </p>
            ) : dialog.action === "confirm" ? (
              <div className="review-confirm-copy">
                <strong>
                  目前以 {member(actor).icon} {member(actor).name} 身分確認
                </strong>
                <p>
                  我已核對本輪個人消費明細，確認目前列出的代墊與分攤內容正確。
                </p>
                <small>
                  身分選擇是朋友間協作紀錄，並非無法冒名的登入驗證。
                </small>
              </div>
            ) : dialog.action === "cancel" ? (
              <p>
                本輪會保留為取消紀錄，帳目恢復可編輯。修正後需重新發起完整的 48
                小時確認，舊確認不會沿用。
              </p>
            ) : (
              <p>撤回後仍是未確認狀態；若內容正確，請再按「確認明細正確」。</p>
            )}
            <div className="two-col">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                返回
              </button>
              <button
                className={
                  dialog.action === "cancel" ? "danger-button" : "primary"
                }
                disabled={busy}
                onClick={async () => {
                  if (!event) return;
                  try {
                    if (dialog.action === "start") {
                      await runTransferMutation(() =>
                        startSettlementReview(
                          secret,
                          revision.current,
                          actor,
                          event.id,
                        ),
                      );
                      setNotice("已發起 48 小時個人明細確認");
                    } else if (dialog.action === "cancel" && openReview) {
                      await runTransferMutation(() =>
                        cancelSettlementReview(
                          secret,
                          revision.current,
                          actor,
                          event.id,
                          openReview.id,
                        ),
                      );
                      setNotice("已取消本輪確認，可以返回編輯帳目");
                    } else if (openReview) {
                      await runTransferMutation(() =>
                        transitionSettlementReview(
                          secret,
                          actor,
                          event.id,
                          openReview.id,
                          dialog.action === "confirm"
                            ? "confirm"
                            : "withdraw_dispute",
                        ),
                      );
                      setNotice(
                        dialog.action === "confirm"
                          ? "已確認本輪個人消費明細"
                          : "已撤回異議，狀態改為未確認",
                      );
                    }
                    setDialog(null);
                  } catch {
                    // Shared error feedback already explains the failure.
                  }
                }}
              >
                {busy
                  ? "處理中…"
                  : dialog.action === "start"
                    ? "確認發起"
                    : dialog.action === "confirm"
                      ? "確認明細正確"
                      : dialog.action === "cancel"
                        ? "確認取消本輪"
                        : "確認撤回異議"}
              </button>
            </div>
          </Modal>
        )}
        {dialog?.kind === "review-dispute" && event && openReview && (
          <Modal title="回報明細問題" onClose={() => setDialog(null)}>
            <p>
              目前以 {member(actor).icon} {member(actor).name}{" "}
              身分回報。提出後會取消你的已確認狀態，並阻擋正式結算，直到你自行撤回。
            </p>
            <label>
              關聯消費（選填）
              <select
                value={reviewExpense}
                onChange={(e) => setReviewExpense(e.target.value)}
              >
                <option value="">整體明細</option>
                {expenses.map((expense) => (
                  <option key={expense.id} value={expense.id}>
                    {expense.date} · {expense.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              問題原因
              <textarea
                aria-label="明細問題原因"
                required
                maxLength={300}
                value={reviewReason}
                onChange={(e) => setReviewReason(e.target.value)}
                placeholder="例如：這筆晚餐沒有參加，請協助確認"
              />
            </label>
            <div className="two-col">
              <button className="secondary" onClick={() => setDialog(null)}>
                返回
              </button>
              <button
                className="danger-button"
                disabled={busy || !reviewReason.trim()}
                onClick={async () => {
                  try {
                    await runTransferMutation(() =>
                      transitionSettlementReview(
                        secret,
                        actor,
                        event.id,
                        openReview.id,
                        "dispute",
                        reviewReason,
                        reviewExpense || undefined,
                      ),
                    );
                    setNotice("已提出明細問題，正式結算暫停");
                    setDialog(null);
                  } catch {
                    // Shared error feedback already explains the failure.
                  }
                }}
              >
                {busy ? "送出中…" : "送出問題"}
              </button>
            </div>
          </Modal>
        )}
        {dialog?.kind === "settlement-confirm" && event && (
          <Modal
            title={
              dialog.action === "start" ? "開始正式結算？" : "取消正式結算？"
            }
            onClose={() => setDialog(null)}
          >
            <p>
              {dialog.action === "start"
                ? "系統會保存目前所有消費、分攤與收付款關係，並鎖定帳目。開始後不能修改或刪除已納入結算的消費。"
                : "取消後會刪除尚未付款的正式交易並返回編輯。已有付款提交時不能取消。"}
            </p>
            {dialog.action === "start" &&
              openReview &&
              currentReviewEligibility.expired &&
              !currentReviewEligibility.allConfirmed && (
                <div className="review-expiry-confirmation" role="note">
                  <strong>期限已到，但這不代表所有人都已確認。</strong>
                  <p>
                    尚未確認：
                    {openReview.participants
                      .filter((participant) => !participant.confirmed_at)
                      .map((participant) => member(participant.member_id).name)
                      .join("、")}
                  </p>
                  <p>目前沒有未撤回的異議，因此可以手動開始正式結算。</p>
                </div>
              )}
            <div className="two-col">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                返回
              </button>
              <button
                className={
                  dialog.action === "start" ? "primary" : "danger-button"
                }
                disabled={busy}
                onClick={async () => {
                  try {
                    await runTransferMutation(() =>
                      dialog.action === "start"
                        ? startSettlement(
                            secret,
                            revision.current,
                            actor,
                            event.id,
                            transfers.map((transfer) => ({
                              ...transfer,
                              id: crypto.randomUUID(),
                            })),
                          )
                        : cancelSettlement(
                            secret,
                            revision.current,
                            actor,
                            event.id,
                          ),
                    );
                    setNotice(
                      dialog.action === "start"
                        ? "正式結算已建立，帳目已鎖定"
                        : "已取消結算，可以繼續編輯帳目",
                    );
                    setDialog(null);
                  } catch {
                    // The shared error toast already explains the failure.
                  }
                }}
              >
                {busy
                  ? "處理中…"
                  : dialog.action === "start"
                    ? "確認開始結算"
                    : "確認取消結算"}
              </button>
            </div>
          </Modal>
        )}
        {dialog?.kind === "confirm" && (
          <Modal title={dialog.title} onClose={() => setDialog(null)}>
            <p>{dialog.message}</p>
            <div className="two-col">
              <button className="secondary" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  if (await save(dialog.action, dialog.data)) {
                    if (dialog.action === "expense.delete")
                      setUndo(dialog.data as { id: string; event_id: string });
                    setDialog(null);
                  }
                }}
              >
                {busy ? "儲存中…" : "確認"}
              </button>
            </div>
          </Modal>
        )}
        {dialog?.kind === "event-lifecycle" &&
          (() => {
            const target = dialog.event;
            const targetExpenses = book.expenses.filter(
              (expense) =>
                expense.event_id === target.id && !expense.deleted_at,
            );
            const targetPayments = book.payments.filter(
              (payment) => payment.event_id === target.id,
            );
            const highRisk =
              targetExpenses.length > 0 || target.settlement_state === "locked";
            const settlementStatus = targetPayments.some((payment) =>
              ["pending_payment", "awaiting_confirmation", "disputed"].includes(
                payment.status,
              ),
            )
              ? "仍有未完成款項"
              : target.settlement_state === "locked"
                ? "正式結算已完成"
                : "尚未正式結算";
            return (
              <Modal
                title={
                  dialog.action === "delete"
                    ? "確定要刪除這個活動嗎？"
                    : "還原這個活動？"
                }
                onClose={() => setDialog(null)}
              >
                <div className="lifecycle-summary">
                  <span className="lifecycle-icon">
                    {dialog.action === "delete" ? (
                      <Trash2 size={20} />
                    ) : (
                      <ArchiveRestore size={20} />
                    )}
                  </span>
                  <div>
                    <strong>{target.name}</strong>
                    <p>
                      {targetExpenses.length} 筆消費 · {settlementStatus}
                    </p>
                  </div>
                </div>
                <p className="lifecycle-message">
                  {dialog.action === "delete"
                    ? "活動將移至最近刪除，30 天內可以還原。刪除期間不會出現在一般活動列表。"
                    : `活動會回到原本的「${target.status === "closed" ? "已結束" : "進行中"}」狀態，既有帳目與結算紀錄都不會重新計算。`}
                </p>
                {dialog.action === "delete" && highRisk && (
                  <label className="admin-field">
                    輸入活動名稱以確認
                    <input
                      value={deleteConfirmation}
                      onChange={(input) =>
                        setDeleteConfirmation(input.target.value)
                      }
                      autoComplete="off"
                      placeholder={target.name}
                    />
                  </label>
                )}
                <label className="admin-field">
                  活動管理密碼
                  <input
                    disabled={!managementEnabled}
                    type="password"
                    value={adminSecret}
                    onChange={(input) => setAdminSecret(input.target.value)}
                    autoComplete="off"
                    inputMode="text"
                  />
                </label>
                {!managementEnabled && (
                  <p className="notice" role="status">
                    活動管理憑證尚未設定，刪除與還原暫未啟用。
                  </p>
                )}
                <p className="admin-security-note">
                  <ShieldCheck size={15} />
                  管理密碼只會送到伺服器驗證，不會保存在瀏覽器。
                </p>
                <div className="two-col">
                  <button className="secondary" onClick={() => setDialog(null)}>
                    取消
                  </button>
                  <button
                    className={
                      dialog.action === "delete" ? "danger-button" : "primary"
                    }
                    disabled={
                      busy ||
                      !managementEnabled ||
                      !adminSecret ||
                      (dialog.action === "delete" &&
                        highRisk &&
                        deleteConfirmation !== target.name)
                    }
                    onClick={() =>
                      void runEventLifecycle(target, dialog.action)
                    }
                  >
                    {busy
                      ? "處理中…"
                      : dialog.action === "delete"
                        ? "移至最近刪除"
                        : "還原活動"}
                  </button>
                </div>
              </Modal>
            );
          })()}
        {dialog?.kind === "recently-deleted" && (
          <Modal title="最近刪除" onClose={() => setDialog(null)}>
            <p className="muted">
              活動至少保留 30 天。永久清理尚未啟用，到期後仍會保留資料。
            </p>
            <div className="deleted-event-list">
              {deletedEvents.length ? (
                deletedEvents.map((target) => {
                  const remaining = target.purge_after
                    ? Math.max(
                        0,
                        Math.ceil(
                          (new Date(target.purge_after).getTime() - syncedAt) /
                            86_400_000,
                        ),
                      )
                    : 30;
                  return (
                    <article key={target.id} className="deleted-event-row">
                      <div>
                        <strong>{target.name}</strong>
                        <span>
                          {target.start_date.replaceAll("-", " / ")} · 原狀態：
                          {target.status === "closed" ? "已結束" : "進行中"}
                        </span>
                        <small>
                          {target.deleted_at
                            ? `${new Date(target.deleted_at).toLocaleDateString("zh-TW")} 刪除`
                            : ""}
                          {` · 剩餘 ${remaining} 天`}
                        </small>
                      </div>
                      <button
                        className="secondary"
                        onClick={() => openEventLifecycle(target, "restore")}
                      >
                        <ArchiveRestore size={16} />
                        還原活動
                      </button>
                    </article>
                  );
                })
              ) : (
                <div className="empty compact-empty">
                  <ArchiveRestore size={24} />
                  <h3>最近沒有刪除的活動</h3>
                  <p>移除的活動會在這裡保留至少 30 天。</p>
                </div>
              )}
            </div>
          </Modal>
        )}
        {dialog?.kind === "settings" && (
          <Modal title="共同帳本設定" onClose={() => setDialog(null)}>
            <button className="secondary full" onClick={copy}>
              <Copy size={17} />
              複製秘密帳本連結
            </button>
            <p className="hint">
              任何持有秘密連結的人都具備編輯權限，因此不要公開分享此網址。
            </p>
            <button
              className="secondary full"
              onClick={() => setDialog({ kind: "identity" })}
            >
              切換我是誰
            </button>
            <button className="text-link" onClick={() => void refresh()}>
              <RefreshCw size={16} />
              立即同步
            </button>
            {event && (
              <div className="event-danger-zone">
                <div>
                  <strong>刪除活動</strong>
                  <span>移至最近刪除，30 天內仍可安全還原。</span>
                </div>
                <button
                  className="danger-link"
                  onClick={() => {
                    if (
                      payments.some((p) =>
                        [
                          "pending_payment",
                          "awaiting_confirmation",
                          "disputed",
                        ].includes(p.status),
                      )
                    ) {
                      setError(
                        "此活動仍有尚未完成的款項，請先完成結算後再刪除。",
                      );
                      return;
                    }
                    openEventLifecycle(event, "delete");
                  }}
                >
                  <Trash2 size={15} />
                  刪除活動
                </button>
              </div>
            )}
            <h3 className="subheading">最近的修改紀錄</h3>
            <div className="activity-list">
              {book.logs.length ? (
                book.logs.map((l) => (
                  <p key={l.id}>
                    <b>
                      {member(l.actor_id).icon} {member(l.actor_id).name}
                    </b>{" "}
                    {l.detail}
                    <small>
                      {new Date(l.created_at).toLocaleString("zh-TW")}
                    </small>
                  </p>
                ))
              ) : (
                <p className="muted">目前還沒有修改紀錄。</p>
              )}
            </div>
            <h3 className="subheading">回收區</h3>
            <p className="hint">刪除的消費保留在這裡，可隨時復原。</p>
            {book.expenses
              .filter((e) => e.deleted_at)
              .map((e) => (
                <div className="trash-row" key={e.id}>
                  <span>
                    {e.name} · {money(e.amount)}
                    <small>
                      {book.events.find((x) => x.id === e.event_id)?.name} ·{" "}
                      {e.date}
                    </small>
                  </span>
                  {book.events.find((event) => event.id === e.event_id)
                    ?.deleted_at ? (
                    <small className="muted">活動在最近刪除</small>
                  ) : book.events.find((event) => event.id === e.event_id)
                      ?.status === "closed" ? (
                    <small className="muted">活動已結束</small>
                  ) : (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void save("expense.restore", {
                          id: e.id,
                          event_id: e.event_id,
                        })
                      }
                    >
                      <RotateCcw size={15} />
                      復原
                    </button>
                  )}
                </div>
              ))}
          </Modal>
        )}
      </div>
    </FormError.Provider>
  );
}
