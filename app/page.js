export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        fontFamily: "sans-serif",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <h1>번역더빙 서비스</h1>
      <p>해외 영상을 올리면 번역·더빙·자막을 자동으로 입혀드립니다.</p>
      <p style={{ color: "#888", fontSize: "0.9rem" }}>
        배포 파이프라인 테스트용 기본 페이지입니다.
      </p>
    </main>
  );
}
