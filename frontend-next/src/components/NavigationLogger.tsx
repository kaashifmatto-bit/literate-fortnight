"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { getApiBase } from "@/lib/api";

export default function NavigationLogger() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;

    const reqId = `req_${Math.random().toString(36).substring(2, 9)}`;
    const startTime = performance.now();

    const logEntry = {
      req_id: reqId,
      method: "GET",
      url: pathname,
      status_code: 200,
      duration_ms: Math.round(performance.now() - startTime),
    };

    // Print to browser console
    console.log(
      `%c[Logger] %c[${reqId}] GET ${pathname} -> 200`,
      "color: #8b5cf6; font-weight: bold;",
      "color: #10b981;"
    );

    // Asynchronously send log to backend central logger without blocking UI
    const apiBase = getApiBase();
    fetch(`${apiBase}/api/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(logEntry),
    }).catch(() => {});
  }, [pathname]);

  return null;
}
