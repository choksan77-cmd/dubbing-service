"use client";

import styles from "./JobProgress.module.css";

const STEPS = [
  { key: "downloading", label: "영상 가져오기" },
  { key: "transcribing", label: "음성 인식" },
  { key: "translating", label: "번역" },
  { key: "dubbing", label: "더빙 음성 생성" },
  { key: "muxing", label: "영상 합성" },
  { key: "done", label: "완료" },
];

export default function JobProgress({ status, errorMessage }) {
  if (status === "failed") {
    return (
      <div className={styles.wrap}>
        <div className={styles.row}>
          {STEPS.map((step) => (
            <div key={step.key} className={styles.step}>
              <div className={`${styles.dot} ${styles.dotFailed}`} />
              <span className={styles.labelFailed}>{step.label}</span>
            </div>
          ))}
        </div>
        <p className={styles.errorText}>실패: {errorMessage || "알 수 없는 오류가 발생했습니다."}</p>
      </div>
    );
  }

  // "reviewing" has no dot of its own — treat it as "everything up to
  // dubbing is complete, nothing active yet" while the user edits the
  // script/voices. Without this branch, findIndex returns -1 for
  // "reviewing" and every dot would incorrectly show as pending.
  const currentIndex =
    status === "pending"
      ? -1
      : status === "reviewing"
      ? STEPS.findIndex((s) => s.key === "dubbing")
      : STEPS.findIndex((s) => s.key === status);

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        {STEPS.map((step, i) => {
          const state = i < currentIndex || status === "done" ? "complete" : i === currentIndex ? "active" : "pending";
          const dotClass =
            state === "complete" ? styles.dotComplete : state === "active" ? styles.dotActive : "";
          const labelClass = state === "pending" ? styles.label : styles.labelActive;
          return (
            <div key={step.key} className={styles.step}>
              <div className={`${styles.dot} ${dotClass}`} />
              <span className={labelClass}>{step.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
