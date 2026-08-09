import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth-context";

export const metadata = {
  title: "IDent",
  description: "IDent — Phase 0B: Identity Core",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
