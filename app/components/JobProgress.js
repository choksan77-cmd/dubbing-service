"use client";

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
      <div style={styles.wrap}>
        <div style={styles.row}>
          {STEPS.map((step) => (
            <div key={step.key} style={styles.stepFailed}>
              <div style={{ ...styles.dot, ...styles.dotFailed }} />
              <span style={styles.labelFailed}>{step.label}</span>
            </div>
          ))}
        </div>
        <p style={styles.errorText}>실패: {errorMessage || "알 수 없는 오류가 발생했습니다."}</p>
      </div>
    );
  }

  const currentIndex = status === "pending" ? -1 : STEPS.findIndex((s) => s.key === status);

  return (
    <div style={styles.wrap}>
      <div style={styles.row}>
        {STEPS.map((step, i) => {
          const state = i < currentIndex || status === "done" ? "complete" : i === currentIndex ? "active" : "pending";
          return (
            <div key={step.key} style={styles.step}>
              <div
                style={{
                  ...styles.dot,
                  ...(state === "complete" ? styles.dotComplete : state === "active" ? styles.dotActive : styles.dotPending),
                }}
              />
              <span style={state === "pending" ? styles.labelPending : styles.label}>{step.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  wrap: {
    width: "100%",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "0.25rem",
    width: "100%",
  },
  step: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.35rem",
    flex: 1,
    textAlign: "center",
  },
  stepFailed: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.35rem",
    flex: 1,
    textAlign: "center",
  },
  dot: {
    width: "14px",
    height: "14px",
    borderRadius: "50%",
    border: "2px solid #ccc",
  },
  dotComplete: {
    background: "#2f6f4f",
    border: "2px solid #2f6f4f",
  },
  dotActive: {
    background: "#fff",
    border: "2px solid #2f6f4f",
    boxShadow: "0 0 0 3px rgba(47,111,79,0.2)",
  },
  dotPending: {
    background: "#fff",
    border: "2px solid #ccc",
  },
  dotFailed: {
    background: "#c0392b",
    border: "2px solid #c0392b",
  },
  label: {
    fontSize: "0.75rem",
    color: "#333",
  },
  labelPending: {
    fontSize: "0.75rem",
    color: "#aaa",
  },
  labelFailed: {
    fontSize: "0.75rem",
    color: "#c0392b",
  },
  errorText: {
    marginTop: "0.75rem",
    color: "#c0392b",
    textAlign: "center",
  },
};
