"use client";

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import styles from "./Header.module.css";

export default function Header() {
  const { data: session, status } = useSession();

  return (
    <header className={styles.header}>
      <Link href="/" className={styles.logo}>
        번역더빙
      </Link>

      <nav className={styles.nav}>
        {status === "authenticated" ? (
          <>
            <Link href="/dub">더빙 스튜디오</Link>
            <Link href="/history">더빙 기록</Link>
            <span className={styles.userEmail}>{session.user.name || session.user.email}</span>
            <button onClick={() => signOut()} className="button">
              로그아웃
            </button>
          </>
        ) : status === "loading" ? null : (
          <>
            <Link href="/login">로그인</Link>
            <Link href="/signup" className="button buttonPrimary">
              회원가입
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
