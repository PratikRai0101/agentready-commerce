import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentReady Commerce — RunVista Sports",
  description: "Agentic commerce with authorization continuity: ambiguous intent to verified payment.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}