"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import JobProgress from "../components/JobProgress";
import styles from "./history.module.css";

const SOURCE_LABELS = {
  upload: "파일 업로드",
  youtube: "YouTube",
};

function jobTitle(job) {
  if (job.sourceType === "upload") return job.originalFilename || "업로드된 영상";
  return job.sourceUrl || "YouTube 영상";
}

export default function HistoryPage() {
  const { status: sessionStatus } = useSession();
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState("");
  const pollRef = useRef(null);

  async function fetchJobs() {
    try {
      const res = await fetch("/api/jobs");
      if (!res.ok) {
        setError("목록을 불러오지 못했습니다.");
        return;
      }
      const data = await res.json();
      setJobs(data);

      const hasInProgress = data.some(
        (j) => j.status !== "done" && j.status !== "failed" && j.status !== "reviewing"
      );
      if (!hasInProgress && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (err) {
      setError("서버 오류가 발생했습니다.");
    }
  }

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;

    fetchJobs();
    pollRef.current = setInterval(fetchJobs, 3000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [sessionStatus]);

  if (sessionStatus === "loading") return null;

  if (sessionStatus === "unauthenticated") {
    return (
      <main className="page pageCentered">
        <p>이 기능을 사용하려면 로그인이 필요합니다.</p>
        <Link href="/login">로그인하러 가기</Link>
      </main>
    );
  }

  return (
    <main className="page">
      <div className={styles.header}>
        <h1 className={styles.title}>더빙 기록</h1>
        <Link href="/dub">새 더빙 시작하기</Link>
      </div>

      {error && <p className="errorText">{error}</p>}

      {jobs === null ? (
        <p className={styles.empty}>불러오는 중...</p>
      ) : jobs.length === 0 ? (
        <p className={styles.empty}>아직 더빙한 영상이 없습니다.</p>
      ) : (
        <div className={styles.list}>
          {jobs.map((job) => (
            <div key={job.id} className={`card ${styles.jobCard}`}>
              <div className={styles.cardHeader}>
                <span className={styles.jobTitle}>{jobTitle(job)}</span>
                <span className={styles.meta}>
                  {SOURCE_LABELS[job.sourceType]} · {job.targetLanguage} ·{" "}
                  {new Date(job.createdAt).toLocaleString("ko-KR")}
                </span>
              </div>

              <JobProgress status={job.status} errorMessage={job.errorMessage} />

              {job.status === "reviewing" && (
                <p style={{ textAlign: "center" }}>
                  <Link href={`/dub?job=${job.id}`}>검토/수정하기</Link>
                </p>
              )}

              {job.status === "done" && (
                <div className={styles.links}>
                  {job.hasOutput && (
                    <a href={`/api/jobs/${job.id}/video`} download>
                      영상 다운로드
                    </a>
                  )}
                  {job.hasSubtitles && (
                    <a href={`/api/jobs/${job.id}/srt`} download>
                      자막 다운로드 (SRT)
                    </a>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
