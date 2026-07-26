import type { ReactNode } from "react";

export const metadata = {
  title: "MYDON",
  description: "Единый контур управления направлениями",
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="ru">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>{children}</body>
    </html>
  );
}
