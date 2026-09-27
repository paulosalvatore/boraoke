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
    //
    // TICKET-103: only when the caller has NOT supplied a class. `size` is the
    // raster resolution of the generated PNG, which is not the same thing as the
    // display box — a caller with a stylesheet (the TV, whose `.qr` is sized in
    // `vw`) sets the box itself, and an inline width/height wins over that class,
    // so the placeholder rendered at a different size than the QR that replaced
    // it and the layout popped for a frame. Letting the class own the box when
    // there is one keeps raster resolution and display size independent, which is
    // what lets the TV raster at 240 for camera legibility over moving video
    // while still displaying at its own `vw` size.
    return (
      <div
        className={className}
        style={
          className
            ? { background: "#ffffff", borderRadius: 8 }
            : { width: size, height: size, background: "#ffffff", borderRadius: 8 }
        }
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
