import type { ReactNode } from "react";

export const metadata = {
  title: "IDent",
  description: "IDent — Phase 0A scaffold",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
