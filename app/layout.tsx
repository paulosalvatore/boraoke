import "./globals.css";
import { FeedbackWidget } from "@/components/FeedbackWidget";

export { metadata, viewport } from "./metadata";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>
        {children}
        <FeedbackWidget />
      </body>
    </html>
  );
}
