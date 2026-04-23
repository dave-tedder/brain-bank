import type { Metadata, Viewport } from "next";
import "./globals.css";
import MatrixRain from "@/components/MatrixRain";
import NavSidebar from "@/components/NavSidebar";
import NavBottom from "@/components/NavBottom";
import ChatFAB from "@/components/ChatFAB";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export const metadata: Metadata = {
  title: "Open Brain",
  description: "Neural Terminal - Semantic Memory System",
  robots: "noindex, nofollow",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Open Brain",
  },
  manifest: "/manifest.json",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=VT323&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen">
        <MatrixRain />
        <div className="relative z-10 min-h-screen">
          <NavSidebar />
          <main className="md:ml-[220px] min-h-screen pb-20 md:pb-0">
            <div className="max-w-6xl mx-auto p-4 md:p-8 pt-[calc(env(safe-area-inset-top)+1rem)] md:pt-8">
              {children}
            </div>
          </main>
          <NavBottom />
          <ChatFAB />
        </div>
      </body>
    </html>
  );
}
