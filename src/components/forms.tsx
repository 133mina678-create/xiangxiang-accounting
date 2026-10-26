"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Event, Expense, Member, Mode } from "@/lib/types";
import { categories, money, today } from "@/lib/types";
import {
  integer,
  splitAmount,
  splitDiscount,
  splitSharedDiscount,
} from "@/lib/calculations";
export function Person({
  member,
  small = false,
  showGuestLabel = false,
}: {
  member: Member;
  small?: boolean;
  showGuestLabel?: boolean;
}) {
  return (
    <span
      className={`person ${small ? "small" : ""}`}
      style={{ "--person-color": member.color } as React.CSSProperties}
    >
      <span className="avatar">{member.icon}</span>
      <span>{member.name}</span>
      {showGuestLabel && member.member_type === "guest" && (
        <small className="guest-label">臨時成員</small>
      )}
    </span>
  );
}
export const FormError = createContext("");
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const error = useContext(FormError);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    const last = document.activeElement;
    d.showModal();
    return () => {
      d.close();
      if (last instanceof HTMLElement) last.focus();
    };
  }, []);
  return (
    <dialog ref={ref} onCancel={onClose} aria-labelledby="modal-title">
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="關閉"
        >
          ×
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
type Save = (
  action: string,
  data: Record<string, unknown>,
  expected?: number,
) => Promise<boolean>;
export function EventForm({
  members,
  event,
  onSave,
  onClose,
  busy,
  getRevision,
}: {
  members: Member[];
  event?: Event;
  onSave: Save;
  onClose: () => void;
  busy: boolean;
  getRevision: () => number;
}) {
  const [expected, setExpected] = useState(getRevision);
  const [eventUuid] = useState(() => event?.id ?? crypto.randomUUID());
  const availableMembers = members.filter(
    (member) =>
      member.member_type !== "guest" || member.guest_event_id === event?.id,
  );
  const [selected, setSelected] = useState(
    event?.members ??
      availableMembers
        .filter((member) => member.member_type !== "guest")
        .map((member) => member.id),
  );
  const [guests, setGuests] = useState<
    { id: string; name: string; note: string }[]
  >([]);
  const [guestOpen, setGuestOpen] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [guestNote, setGuestNote] = useState("");
  const [error, setError] = useState("");
  const guestMembers: Member[] = guests.map((guest, index) => ({
    ...guest,
    icon: "👤",
    color: "#718096",
    position: 1000 + index,
    bank_code: null,
    bank_name: null,
    bank_account: null,
    member_type: "guest",
    guest_event_id: eventUuid,
    guest_note: guest.note,
  }));
  const displayedMembers = [...availableMembers, ...guestMembers];
  return (
    <Modal title={event ? "編輯活動" : "新的小旅行"} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          if (!selected.length) {
            setError("至少選擇一位朋友");
            return;
          }
          if (
            await onSave(
              "event.save",
              {
                id: eventUuid,
                name: f.get("name"),
                start_date: f.get("start_date"),
                end_date: f.get("end_date"),
                note: f.get("note"),
                members: selected,
                guests: guests.filter((guest) => selected.includes(guest.id)),
              },
              expected,
            )
          )
            onClose();
          else setExpected(getRevision());
        }}
      >
        <label>
          活動名稱
          <input
            name="name"
            autoFocus
            required
            maxLength={80}
            defaultValue={event?.name}
            placeholder="例如：台北三天兩夜"
          />
        </label>
        <div className="two-col">
          <label>
            開始日期
            <input
              name="start_date"
              type="date"
              required
              defaultValue={event?.start_date ?? today()}
            />
          </label>
          <label>
            結束日期（選填）
            <input
              name="end_date"
              type="date"
              defaultValue={event?.end_date ?? ""}
            />
          </label>
        </div>
        <fieldset>
          <legend>這次有誰一起？</legend>
          <div className="member-grid">
            {displayedMembers.map((m) => (
              <button
                type="button"
                key={m.id}
                aria-pressed={selected.includes(m.id)}
                className="member-choice"
                onClick={() =>
                  setSelected((s) =>
                    s.includes(m.id)
                      ? s.filter((id) => id !== m.id)
                      : [...s, m.id],
                  )
                }
              >
                <Person member={m} showGuestLabel />
                <span>{selected.includes(m.id) ? "✓" : "＋"}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="text-link guest-add-toggle"
            onClick={() => setGuestOpen((open) => !open)}
          >
            ＋ 新增臨時成員
          </button>
          {guestOpen && (
            <div className="guest-editor">
              <label>
                名稱
                <input
                  aria-label="臨時成員名稱"
                  maxLength={40}
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="例如：小明"
                />
              </label>
              <label>
                簡單備註（選填）
                <input
                  aria-label="臨時成員備註"
                  maxLength={200}
                  value={guestNote}
                  onChange={(e) => setGuestNote(e.target.value)}
                  placeholder="例如：星醬的朋友"
                />
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  const name = guestName.trim();
                  if (!name) {
                    setError("請輸入臨時成員名稱");
                    return;
                  }
                  if (
                    displayedMembers.some(
                      (member) => member.name.trim() === name,
                    )
                  ) {
                    setError("這個活動已有同名成員");
                    return;
                  }
                  const id = crypto.randomUUID();
                  setGuests((current) => [
                    ...current,
                    { id, name, note: guestNote.trim() },
                  ]);
                  setSelected((current) => [...current, id]);
                  setGuestName("");
                  setGuestNote("");
                  setGuestOpen(false);
                  setError("");
                }}
              >
                加入這次活動
              </button>
            </div>
          )}
        </fieldset>
        {event && (
          <p className="hint">
            已有消費或轉帳的成員會保留，避免過去帳目失去歸屬。
          </p>
        )}
        <label>
          活動備註（選填）
          <textarea
            name="note"
            maxLength={1000}
            defaultValue={event?.note}
            placeholder="集合時間、想去的地方…"
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary full" disabled={busy}>
          {" "}
          {busy ? "儲存中…" : event ? "儲存活動" : "建立活動"}{" "}
        </button>
      </form>
    </Modal>
  );
}
export function ExpenseForm({
  members,
  event,
  expense,
  actor,
  onSave,
  onClose,
  busy,
  getRevision,
  settlementWarning = false,
}: {
  members: Member[];
  event: Event;
  expense?: Expense;
  actor: string;
  onSave: Save;
  onClose: () => void;
  busy: boolean;
  getRevision: () => number;
  settlementWarning?: boolean;
}) {
  const [expected, setExpected] = useState(getRevision);
  const [expenseUuid] = useState(() => expense?.id ?? crypto.randomUUID());
  const active = members.filter((m) => event.members.includes(m.id));
  const hasDiscount = Boolean(
    expense?.splits.some((split) => split.gross_amount != null),
  );
  const savedDiscountMethod = expense?.splits.find(
    (split) => split.discount_method,
  )?.discount_method;
  const [amount, setAmount] = useState(
    expense
      ? String(
          hasDiscount
            ? expense.splits.reduce(
                (sum, split) =>
                  sum + (split.gross_amount ?? split.share_amount),
                0,
              )
            : expense.amount,
        )
      : "",
  );
  const [payer, setPayer] = useState(
    expense?.payer_id ?? (event.members.includes(actor) ? actor : active[0].id),
  );
  const [category, setCategory] = useState(expense?.category ?? "food");
  const [method, setMethod] = useState<Mode | "discount" | "shared-discount">(
    hasDiscount
      ? savedDiscountMethod === "shared"
        ? "shared-discount"
        : "discount"
      : (expense?.mode ?? "equal"),
  );
  const [selected, setSelected] = useState(
    expense?.splits.map((s) => s.member_id) ?? event.members,
  );
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(
      active.map((m) => [
        m.id,
        String(
          expense?.splits.find((s) => s.member_id === m.id)?.[
            expense.mode === "custom" ? "share_amount" : "weight"
          ] ?? 1,
        ),
      ]),
    ),
  );
  const [grossValues, setGrossValues] = useState<Record<string, string>>(
    Object.fromEntries(
      active.map((m) => {
        const split = expense?.splits.find((s) => s.member_id === m.id);
        return [m.id, String(split?.gross_amount ?? split?.share_amount ?? 0)];
      }),
    ),
  );
  const [discountValues, setDiscountValues] = useState<Record<string, string>>(
    Object.fromEntries(
      active.map((m) => {
        const split = expense?.splits.find((s) => s.member_id === m.id);
        return [m.id, String(split?.discount_amount ?? 0)];
      }),
    ),
  );
  const [sharedDiscount, setSharedDiscount] = useState(
    hasDiscount
      ? String(
          expense!.splits.reduce(
            (sum, split) => sum + (split.discount_amount ?? 0),
            0,
          ),
        )
      : "",
  );
  const [error, setError] = useState("");
  const ordered = active
    .filter((m) => selected.includes(m.id))
    .map((m) => m.id);
  let preview: ReturnType<typeof splitAmount> = [];
  let validation = "";
  const isDiscountMethod =
    method === "discount" || method === "shared-discount";
  try {
    preview =
      method === "discount"
        ? splitDiscount(
            integer(amount, 1),
            ordered,
            Object.fromEntries(
              ordered.map((id) => [id, integer(grossValues[id] ?? "")]),
            ),
            Object.fromEntries(
              ordered.map((id) => [id, integer(discountValues[id] ?? "")]),
            ),
          )
        : method === "shared-discount"
          ? splitSharedDiscount(
              integer(amount, 1),
              integer(sharedDiscount, 1),
              ordered,
              Object.fromEntries(
                ordered.map((id) => [id, integer(grossValues[id] ?? "")]),
              ),
            )
          : splitAmount(
              integer(amount, 1),
              ordered,
              method,
              Object.fromEntries(
                ordered.map((id) => [
                  id,
                  integer(values[id] ?? "", method === "weighted" ? 1 : 0),
                ]),
              ),
              active.map((member) => member.id),
              event.remainder_rotation_index ?? 0,
            );
  } catch (e) {
    validation = (e as Error).message;
  }
  const checkoutAmount = isDiscountMethod
    ? preview.reduce((sum, split) => sum + split.share_amount, 0)
    : Number(amount || 0);
  const previewDiscount = preview.reduce(
    (sum, split) => sum + (split.discount_amount ?? 0),
    0,
  );
  const defaultDate = [today(), event.start_date].sort().at(-1)!;
  return (
    <Modal title={expense ? "修改這筆消費" : "記下一筆消費"} onClose={onClose}>
      {expense && settlementWarning && (
        <p className="settlement-warning" role="note">
          此活動已有付款進行中或已完成的交易。修改消費不會覆蓋既有轉帳；如有差額，結算頁會另外列出調整轉帳。
        </p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (validation) {
            setError(validation);
            return;
          }
          const f = new FormData(e.currentTarget);
          if (
            await onSave(
              isDiscountMethod ? "expense.discount.save" : "expense.save",
              {
                id: expenseUuid,
                event_id: event.id,
                name: f.get("name"),
                date: f.get("date"),
                amount: integer(checkoutAmount, 1),
                payer_id: payer,
                category,
                note: f.get("note"),
                mode: isDiscountMethod ? "custom" : method,
                discount_method:
                  method === "shared-discount" ? "shared" : "manual",
                splits: preview,
              },
              expected,
            )
          )
            onClose();
          else setExpected(getRevision());
        }}
      >
        <label>
          消費名稱
          <input
            name="name"
            aria-label="消費名稱"
            required
            maxLength={80}
            defaultValue={expense?.name}
            placeholder="例如：海底撈"
          />
        </label>
        <label className="amount-label">
          {isDiscountMethod ? "消費原價總額" : "消費金額"}{" "}
          <span>新台幣・整數元</span>
          <div className="amount-field">
            <span>NT$</span>
            <input
              aria-label={isDiscountMethod ? "消費原價總額" : "消費金額"}
              autoFocus
              inputMode="numeric"
              pattern="[0-9]+"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
          </div>
        </label>
        <label>
          記在哪一天？
          <input
            name="date"
            type="date"
            required
            min={event.start_date}
            max={event.end_date ?? undefined}
            defaultValue={
              expense?.date ??
              (event.end_date && defaultDate > event.end_date
                ? event.end_date
                : defaultDate)
            }
          />
        </label>
        <fieldset>
          <legend>誰先付款？</legend>
          <div className="member-grid">
            {active.map((m) => (
              <button
                key={m.id}
                type="button"
                className="member-choice"
                aria-pressed={payer === m.id}
                onClick={() => setPayer(m.id)}
              >
                <Person member={m} />
                {payer === m.id && "✓"}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>消費分類</legend>
          <div className="category-grid">
            {categories.map(([id, icon, name]) => (
              <button
                type="button"
                key={id}
                aria-pressed={category === id}
                onClick={() => setCategory(id)}
              >
                <span>{icon}</span>
                {name}
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          備註（選填）
          <textarea
            name="note"
            maxLength={300}
            defaultValue={expense?.note}
            placeholder="例如：Uber 去高鐵站"
          />
        </label>
        <fieldset>
          <legend>這筆錢誰需要負擔？</legend>
          <p className="hint">付款人可以不參與分攤。</p>
          <div className="member-grid">
            {active.map((m) => (
              <button
                type="button"
                key={m.id}
                className="member-choice"
                aria-pressed={selected.includes(m.id)}
                onClick={() =>
                  setSelected((s) =>
                    s.includes(m.id)
                      ? s.filter((id) => id !== m.id)
                      : [...s, m.id],
                  )
                }
              >
                <Person member={m} />
                <span>{selected.includes(m.id) ? "✓" : "＋"}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          分攤方式
          <select
            value={method}
            onChange={(e) => {
              const m = e.target.value as Mode | "discount" | "shared-discount";
              const enteringDiscount =
                (m === "discount" || m === "shared-discount") &&
                method !== "discount" &&
                method !== "shared-discount";
              setMethod(m);
              if (enteringDiscount) {
                setGrossValues(
                  Object.fromEntries(
                    active.map((person) => [
                      person.id,
                      String(
                        preview.find((split) => split.member_id === person.id)
                          ?.share_amount ?? 0,
                      ),
                    ]),
                  ),
                );
                setDiscountValues(
                  Object.fromEntries(active.map((person) => [person.id, "0"])),
                );
                setSharedDiscount("");
              }
              setValues(
                Object.fromEntries(
                  active.map((x) => [
                    x.id,
                    m === "custom"
                      ? String(
                          preview.find((s) => s.member_id === x.id)
                            ?.share_amount ?? 0,
                        )
                      : "1",
                  ]),
                ),
              );
            }}
          >
            <option value="equal">平均分攤</option>
            <option value="custom">自訂金額</option>
            <option value="weighted">比例／份數分攤</option>
            <option value="discount">個別折扣</option>
            <option value="shared-discount">共同折扣（自動分配）</option>
          </select>
        </label>
        {method === "custom" && (
          <p className="hint">
            修改總金額後，請重新確認每人的金額；合計相符才能儲存。
          </p>
        )}
        {method !== "equal" && !isDiscountMethod && (
          <div className="custom-splits">
            {active
              .filter((m) => selected.includes(m.id))
              .map((m) => (
                <label key={m.id}>
                  <Person member={m} />
                  <span className="inline-input">
                    <input
                      aria-label={`${m.name}${method === "custom" ? "分攤金額" : "份數"}`}
                      inputMode="numeric"
                      required
                      pattern="[0-9]+"
                      value={values[m.id] ?? ""}
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [m.id]: e.target.value }))
                      }
                    />
                    {method === "custom" ? "元" : "份"}
                  </span>
                </label>
              ))}
          </div>
        )}
        {isDiscountMethod && (
          <div className="discount-splits">
            <div className="discount-help">
              <strong>
                {method === "shared-discount"
                  ? "共同折扣自動分配"
                  : "分配每個人的折扣"}
              </strong>
              <p className="hint">
                {method === "shared-discount"
                  ? "填寫共同折扣與每人的原價消費，系統會依原價比例分配整數折扣。"
                  : "填寫每人的原價消費與個人折扣，系統會自動算出折後結帳金額。"}
              </p>
            </div>
            {method === "shared-discount" && (
              <label className="shared-discount-field">
                共同折扣總額
                <span className="inline-input">
                  <input
                    aria-label="共同折扣總額"
                    inputMode="numeric"
                    pattern="[0-9]+"
                    required
                    value={sharedDiscount}
                    onChange={(e) => setSharedDiscount(e.target.value)}
                    placeholder="例如：80"
                  />
                  元
                </span>
              </label>
            )}
            {active
              .filter((m) => selected.includes(m.id))
              .map((m) => (
                <div className="discount-row" key={m.id}>
                  <Person member={m} />
                  <label>
                    原價
                    <input
                      aria-label={`${m.name}原價消費`}
                      inputMode="numeric"
                      pattern="[0-9]+"
                      required
                      value={grossValues[m.id] ?? ""}
                      onChange={(e) =>
                        setGrossValues((values) => ({
                          ...values,
                          [m.id]: e.target.value,
                        }))
                      }
                    />
                  </label>
                  {method === "discount" ? (
                    <label>
                      折扣
                      <input
                        aria-label={`${m.name}個人折扣`}
                        inputMode="numeric"
                        pattern="[0-9]+"
                        required
                        value={discountValues[m.id] ?? ""}
                        onChange={(e) =>
                          setDiscountValues((values) => ({
                            ...values,
                            [m.id]: e.target.value,
                          }))
                        }
                      />
                    </label>
                  ) : (
                    <span className="auto-discount">
                      自動折扣
                      <b>
                        {money(
                          preview.find((s) => s.member_id === m.id)
                            ?.discount_amount ?? 0,
                        )}
                      </b>
                    </span>
                  )}
                  <span className="discount-result">
                    實際{" "}
                    {money(
                      preview.find((s) => s.member_id === m.id)?.share_amount ??
                        Math.max(
                          Number(grossValues[m.id] || 0) -
                            Number(discountValues[m.id] || 0),
                          0,
                        ),
                    )}
                  </span>
                </div>
              ))}
          </div>
        )}
        {isDiscountMethod && (
          <div className="discount-summary" aria-live="polite">
            <span>原價 {money(Number(amount || 0))}</span>
            <span>－ 折扣 {money(previewDiscount)}</span>
            <strong>＝ 結帳 {money(checkoutAmount)}</strong>
          </div>
        )}
        <div className="split-preview">
          <strong>分攤預覽</strong>
          {preview.length ? (
            preview.map((s) => (
              <div key={s.member_id}>
                <Person
                  small
                  member={members.find((m) => m.id === s.member_id)!}
                />
                <b>
                  {money(s.share_amount)}
                  {isDiscountMethod && (s.discount_amount ?? 0) > 0 && (
                    <small>（折 {money(s.discount_amount ?? 0)}）</small>
                  )}
                </b>
              </div>
            ))
          ) : (
            <p className="hint">
              {amount ? validation : "輸入金額後，即可查看每人分攤。"}
            </p>
          )}
          {method === "equal" &&
            preview.length > 0 &&
            Number(amount) % preview.length !== 0 && (
              <p className="hint">本筆無法整除的尾差已依成員公平輪替分配。</p>
            )}
          {method === "weighted" && (
            <p className="hint">
              尾差優先分配給餘數較大的成員；同餘數依固定成員順序。
            </p>
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary full" disabled={busy || Boolean(validation)}>
          {busy ? "儲存中…" : expense ? "儲存修改" : "儲存消費"}
        </button>
      </form>
    </Modal>
  );
}
