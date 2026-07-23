export const metadata = {
  title: "번역더빙 서비스",
  description: "해외 영상 자동 번역 · 더빙 · 자막 서비스",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
