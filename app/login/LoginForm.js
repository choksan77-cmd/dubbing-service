"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import styles from "../components/auth.module.css";

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const signupSuccess = searchParams.get("signup") === "success";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("이메일 또는 비밀번호가 올바르지 않습니다.");
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <main className="page pageCentered">
      <div className={`card ${styles.wrap}`}>
        <h1 className={styles.title}>로그인</h1>
        {signupSuccess && <p className={styles.success}>회원가입이 완료되었습니다. 로그인해주세요.</p>}
        <form onSubmit={handleSubmit} className={styles.form}>
          <input
            type="email"
            placeholder="이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p className="errorText">{error}</p>}
          <button type="submit" disabled={loading} className="button buttonPrimary">
            {loading ? "로그인 중..." : "로그인"}
          </button>
        </form>
        <p className={styles.footer}>
          계정이 없으신가요? <Link href="/signup">회원가입</Link>
        </p>
      </div>
    </main>
  );
}
