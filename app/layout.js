import { Inter } from "next/font/google";
import Providers from "./providers";
import Header from "./components/Header";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata = {
  title: "번역더빙 서비스",
  description: "해외 영상 자동 번역 · 더빙 · 자막 서비스",
};

export const viewport = {
  colorScheme: "dark",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko" className={inter.variable}>
      <body>
        <Providers>
          <Header />
          {children}
        </Providers>
      </body>
    </html>
  );
}
