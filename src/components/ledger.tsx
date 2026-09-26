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
  Archive,
  RotateCcw,
  MapPin,
  CalendarDays,
  RefreshCw,
} from "lucide-react";
import { readBook, mutate } from "@/lib/api";
import { settle, statistics } from "@/lib/calculations";
import { transferRecipient } from "@/lib/payment-info";
import { categories, money } from "@/lib/types";
import type { Book, Event, Expense, Member } from "@/lib/types";
import { EventForm, ExpenseForm, Modal, Person, FormError } from "./forms";
import { TransferCard } from "./transfer-card";

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
    [synced, setSynced] = useState(false);
  const [day, setDay] = useState(""),
    [payer, setPayer] = useState(""),
    [category, setCategory] = useState(""),
    [grouped, setGrouped] = useState(true),
    [statsDay, setStatsDay] = useState("");
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
  }, [refresh]); // Identity is a preference only, never authorization.
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
    if (!book?.members.some((m) => m.id === actor)) {
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
  const openEvent = (id: string) => {
    setEventId(id);
    setTab("expenses");
    setDay("");
    setPayer("");
    setCategory("");
    setStatsDay("");
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
  const event = book.events.find((e) => e.id === eventId);
  const expenses = book.expenses.filter(
    (e) => e.event_id === eventId && !e.deleted_at,
  );
  const payments = book.payments.filter((p) => p.event_id === eventId);
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
  const balances = event ? statistics(event.members, expenses, payments) : [];
  const transfers = settle(balances);
  const days = [...new Set(expenses.map((e) => e.date))].sort();
  const exportCSV = () => {
    const cell = (s: string) =>
      `"${(/^[=+\-@\t\r]/.test(s) ? "'" : "") + s.replaceAll('"', '""')}"`;
    const rows = [
      [
        "日期",
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
  const cards = (past: boolean) =>
    book.events
      .filter((e) => e.archived === past)
      .map((e) => {
        const es = book.expenses.filter(
          (x) => x.event_id === e.id && !x.deleted_at,
        );
        return (
          <button
            className="event-card"
            key={e.id}
            onClick={() => openEvent(e.id)}
          >
            <div className="event-art">
              <span>
                <MapPin size={22} />
              </span>
              <span className="event-status">
                {past ? "回憶收藏" : "一起出發"}
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
                  <strong>{money(es.reduce((s, x) => s + x.amount, 0))}</strong>
                </span>
                <span className="round-arrow">
                  <ArrowRight size={20} />
                </span>
              </div>
            </div>
          </button>
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
              {book.members.some((m) => m.id === actor) ? (
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
                  <span>{book.events.filter((e) => !e.archived).length}</span>
                </h2>
                <span className="muted">下一段回憶，從這裡開始</span>
              </div>
              <div className="event-grid">{cards(false)}</div>
              {!book.events.some((e) => !e.archived) && (
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
              {!book.events.some((e) => e.archived) && (
                <p className="muted">結束的活動可以收進這裡，隨時回來看看。</p>
              )}
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
                    {event.archived ? "已收藏" : "持續記錄中"}
                  </span>
                </div>
              </section>
              <div className="event-tools">
                <button
                  className="text-link"
                  onClick={() => setDialog({ kind: "event", event })}
                >
                  <Pencil size={15} />
                  編輯活動
                </button>
                <button className="text-link" onClick={exportCSV}>
                  <Download size={15} />
                  匯出 CSV
                </button>
                <button
                  className="text-link"
                  disabled={busy}
                  onClick={() =>
                    void save("event.archive", {
                      event_id: event.id,
                      archived: !event.archived,
                    })
                  }
                >
                  <Archive size={15} />
                  {event.archived ? "重新開啟" : "移至過去活動"}
                </button>
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
                    <button
                      className="primary add-expense"
                      onClick={() => setDialog({ kind: "expense" })}
                    >
                      <Plus size={19} />
                      新增消費
                    </button>
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
                            <strong>{x.note || c[2]}</strong>
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
                </section>
              )}
              {tab === "settle" && (
                <section className="settlement">
                  <div className="section-title">
                    <div>
                      <p className="eyebrow">少轉幾筆，多一點輕鬆</p>
                      <h2>最後怎麼付？</h2>
                    </div>
                    <span className="settle-symbol">💸</span>
                  </div>
                  <p className="muted">
                    已扣除標記完成的轉帳。依目前帳目，使用最少筆數結清。
                  </p>
                  {transfers.length ? (
                    <>
                      <div className="settle-intro">
                        完成以下 <b>{transfers.length}</b>{" "}
                        筆轉帳，即可結清本次活動。
                      </div>
                      {transfers.map((t, i) => {
                        const recipient = transferRecipient(t, book.members);
                        return (
                          <TransferCard
                            key={`${t.from_id}-${t.to_id}`}
                            index={i}
                            transfer={t}
                            payer={member(t.from_id)}
                            recipient={recipient}
                            busy={busy}
                            onFeedback={setNotice}
                            onMarkPaid={() =>
                              setDialog({
                                kind: "confirm",
                                title: "確認已完成轉帳？",
                                message: `${member(t.from_id).name} 已轉 ${money(t.amount)} 給 ${recipient.name}。這個按鈕只記錄付款狀態，不會實際匯款。`,
                                action: "payment.add",
                                data: { event_id: event.id, ...t },
                              })
                            }
                          />
                        );
                      })}
                    </>
                  ) : (
                    <div className="all-clear">
                      <span>🎉</span>
                      <h2>
                        {expenses.length
                          ? "本次活動已全部結清！"
                          : "目前沒有需要結算的費用"}
                      </h2>
                      <p>帳目與紀錄都會保留，隨時可以回來看。</p>
                    </div>
                  )}
                  <div className="balance-check">
                    <span>
                      剩餘應收{" "}
                      <b>
                        {money(
                          balances
                            .filter((x) => x.remaining > 0)
                            .reduce((s, x) => s + x.remaining, 0),
                        )}
                      </b>
                    </span>
                    <span>
                      剩餘應付{" "}
                      <b>
                        {money(
                          -balances
                            .filter((x) => x.remaining < 0)
                            .reduce((s, x) => s + x.remaining, 0),
                        )}
                      </b>
                    </span>
                    <span>✓ 金額平衡</span>
                  </div>
                  {payments.length > 0 && (
                    <>
                      <h3 className="subheading">已完成的轉帳</h3>
                      {payments.map((p) => (
                        <div className="paid-row" key={p.id}>
                          <span>
                            ✓ {member(p.from_id).icon} {member(p.from_id).name}{" "}
                            → {member(p.to_id).icon} {member(p.to_id).name}
                          </span>
                          <b>{money(p.amount)}</b>
                          <button
                            className="text-link"
                            onClick={() =>
                              setDialog({
                                kind: "confirm",
                                title: "取消付款標記？",
                                message: "這筆款項會重新加入剩餘應付計算。",
                                action: "payment.remove",
                                data: { event_id: event.id, id: p.id },
                              })
                            }
                          >
                            取消標記
                          </button>
                        </div>
                      ))}
                    </>
                  )}
                  <p className="hint">
                    修改或刪除舊消費後，已付款紀錄仍保留；若有人多付，系統會列出退還差額的轉帳。
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
              {book.members.map((m) => (
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
        {dialog?.kind === "event" && (
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
                title={`${c[1]} ${x.note || c[2]}`}
                onClose={() => setDialog(null)}
              >
                <p className="detail-amount">{money(x.amount)}</p>
                <p className="muted">
                  {x.date} · {c[2]} ·{" "}
                  {
                    {
                      equal: "平均分攤",
                      custom: "自訂金額",
                      weighted: "份數分攤",
                    }[x.mode]
                  }
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
                        {x.mode === "weighted" ? ` · ${s.weight} 份` : ""}
                      </b>
                    </div>
                  ))}
                </div>
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
                        message: `${x.note || c[2]} ${money(x.amount)} 將移至回收區，活動統計與結算會重新計算。`,
                        action: "expense.delete",
                        data: { id: x.id, event_id: x.event_id },
                      })
                    }
                  >
                    <Trash2 size={16} />
                    刪除
                  </button>
                </div>
              </Modal>
            );
          })()}
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
                    {e.note || "消費"} · {money(e.amount)}
                    <small>
                      {book.events.find((x) => x.id === e.event_id)?.name} ·{" "}
                      {e.date}
                    </small>
                  </span>
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
                </div>
              ))}
          </Modal>
        )}
      </div>
    </FormError.Provider>
  );
}
