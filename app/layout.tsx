import type { Metadata } from "next";
import "./globals.css";
import { FeedbackWidget } from "@/components/FeedbackWidget";

export const metadata: Metadata = {
  title: "Cantai — Karaoke Queue",
  description: "Free karaoke queue platform for bars and venues.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <FeedbackWidget />
      </body>
    </html>
  );
}
