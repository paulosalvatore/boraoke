"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * QrCode (TICKET-9) — renders a real QR of `value` as an <img> data URL.
 *
 * Client component: `qrcode` generates the PNG data URL in the browser (the
 * TV/idle/room-created surfaces that use it are already client-rendered, and
 * the join URL is only known client-side from window.location on /tv). Renders
 * nothing until the code is generated, so it never flashes a broken image.
 */
export default function QrCode({
  value,
  size = 240,
  className,
  title = "QR code",
}: {
  value: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    if (!value) {
      setDataUrl("");
      return;
    }
    QRCode.toDataURL(value, {
      width: size,
      margin: 1,
      color: { dark: "#0a0a0f", light: "#ffffff" },
      errorCorrectionLevel: "M",
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!dataUrl) {
    // Reserve the layout box so surrounding content doesn't jump on load.
    return (
      <div
        className={className}
        style={{ width: size, height: size, background: "#ffffff", borderRadius: 8 }}
        aria-label={title}
        role="img"
        data-testid="qr-placeholder"
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={dataUrl}
      alt={title}
      width={size}
      height={size}
      className={className}
      style={{ borderRadius: 8, display: "block" }}
      data-testid="qr-img"
    />
  );
}
