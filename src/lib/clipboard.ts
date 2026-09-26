export async function copyText(text: string): Promise<void> {
  if (!text) throw new Error("沒有可複製的內容");

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Safari and embedded browsers can reject Clipboard API access. Fall
      // through to a user-gesture based copy without exposing the text in UI.
    }
  }

  const field = document.createElement("textarea");
  const active = document.activeElement as HTMLElement | null;
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.position = "fixed";
  field.style.inset = "0 auto auto -9999px";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.focus();
  field.select();
  field.setSelectionRange(0, field.value.length);
  const copied = document.execCommand("copy");
  field.remove();
  active?.focus();
  if (!copied) throw new Error("瀏覽器拒絕複製");
}
