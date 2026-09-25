import Link from "next/link";
import { configured } from "@/lib/api";
export default function Home() {
  return (
    <main className="welcome">
      <div className="brand-mark">奶</div>
      <p className="eyebrow">一起出門，也一起算清楚</p>
      <h1>我們的記帳本</h1>
      <p>今天又是誰先墊錢？</p>
      <div className="paper">
        <span className="friends">🔥 ⭐ 💬 🦑 🥒 🐰</span>
        <h2>六個朋友，一本共同帳本。</h2>
        <p>使用群組裡的秘密帳本連結，就能一起記下每筆花費。</p>
        <p className="muted">
          持有連結的人都能編輯，請只分享給這次一起出遊的朋友。
        </p>
        {!configured && (
          <p className="notice">
            雲端尚未設定。請依專案 README 設定 Supabase，執行 migration
            與建立帳本腳本，即可取得專屬連結。
          </p>
        )}
        <Link
          href="https://supabase.com/dashboard"
          className="text-link"
          referrerPolicy="no-referrer"
        >
          管理雲端設定 ↗
        </Link>
      </div>
    </main>
  );
}
