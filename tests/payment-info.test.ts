import { describe, expect, it } from "vitest";
import {
  hasBankDetails,
  maskBankAccount,
  transferDetailsText,
  transferRecipient,
} from "../src/lib/payment-info";
import { settle } from "../src/lib/calculations";
import type { Member, Transfer } from "../src/lib/types";

const members: Member[] = [
  ["厚諾", "822", "中國信託", "078540354361"],
  ["星醬", "009", "彰化銀行", "61248603680100"],
  ["無語", "808", "玉山銀行", "0381979312472"],
  ["庫莫", "006", "合作金庫", "251899012944"],
  ["千瑾", "700", "郵局", "01410091872553"],
  ["兔子草", null, null, null],
].map(([name, bank_code, bank_name, bank_account], position) => ({
  id: String(position),
  name: name!,
  icon: "●",
  color: "#000000",
  position,
  bank_code,
  bank_name,
  bank_account,
}));

const byName = (name: string) => members.find((m) => m.name === name)!;
const transfer = (from: string, to: string): Transfer => ({
  from_id: byName(from).id,
  to_id: byName(to).id,
  amount: 800,
});

describe("結算匯款資訊", () => {
  it("永遠使用轉帳收款人的銀行資料", () => {
    expect(transferRecipient(transfer("星醬", "厚諾"), members).name).toBe(
      "厚諾",
    );
    expect(transferRecipient(transfer("厚諾", "星醬"), members).name).toBe(
      "星醬",
    );
  });

  it.each([
    ["庫莫", "006", "251899012944"],
    ["厚諾", "822", "078540354361"],
    ["星醬", "009", "61248603680100"],
    ["千瑾", "700", "01410091872553"],
    ["無語", "808", "0381979312472"],
  ])("保留 %s 的銀行代碼與完整文字帳號", (name, code, account) => {
    const recipient = byName(name);
    expect(recipient.bank_code).toBe(code);
    expect(recipient.bank_account).toBe(account);
    expect(transferDetailsText(recipient, 800)).toContain(`帳號：${account}`);
  });

  it("畫面遮罩只顯示末四碼，複製內容保留完整帳號與前導零", () => {
    const recipient = byName("厚諾");
    expect(maskBankAccount(recipient.bank_account!)).toBe("•••• •••• 4361");
    expect(maskBankAccount(recipient.bank_account!)).not.toContain(
      recipient.bank_account!,
    );
    expect(transferDetailsText(recipient, 800)).toBe(
      "收款人：厚諾\n銀行：822 中國信託\n帳號：078540354361\n金額：NT$ 800",
    );
  });

  it("兔子草維持未設定狀態且不產生可複製內容", () => {
    const recipient = byName("兔子草");
    expect(hasBankDetails(recipient)).toBe(false);
    expect(recipient.bank_account).toBeNull();
    expect(transferDetailsText(recipient, 500)).toBeNull();
  });

  it("附加銀行資料不改變最少轉帳演算法", () => {
    const balances = [-800, 800, 0, 0, 0, 0].map((remaining, index) => ({
      id: members[index].id,
      remaining,
    }));
    expect(settle(balances)).toEqual([
      { from_id: byName("厚諾").id, to_id: byName("星醬").id, amount: 800 },
    ]);
  });
});
