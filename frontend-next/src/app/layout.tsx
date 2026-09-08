import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ArticulAIT | 3D Walkthrough Studio",
  description:
    "AI-powered 3D Gaussian Splatting walkthrough platform for real estate and spatial computing.",
};

import NavigationLogger from "@/components/NavigationLogger";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        <NavigationLogger />
        <div className="bg-mesh" />
        {children}
      </body>
    </html>
  );
}
