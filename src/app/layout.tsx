import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "香香的記帳本",
  description: "六個朋友，一起出遊、輕鬆分帳。",
  robots: { index: false, follow: false },
  icons: { icon: "/icon.svg" },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
