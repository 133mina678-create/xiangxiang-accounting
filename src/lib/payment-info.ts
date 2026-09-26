import type { Member, Transfer } from "./types";

export type MemberWithBankDetails = Member & {
  bank_code: string;
  bank_name: string;
  bank_account: string;
};

export function transferRecipient(
  transfer: Transfer,
  members: Member[],
): Member {
  const recipient = members.find((member) => member.id === transfer.to_id);
  if (!recipient) throw new Error("找不到收款人");
  return recipient;
}

export function hasBankDetails(
  member: Member,
): member is MemberWithBankDetails {
  return Boolean(member.bank_code && member.bank_name && member.bank_account);
}

export function maskBankAccount(account: string): string {
  return `•••• •••• ${account.slice(-4)}`;
}
