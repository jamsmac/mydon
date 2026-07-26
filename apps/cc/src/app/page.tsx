import { DOMAINS, DOMAIN_LABELS } from "@mydon/shared";

export default function Home() {
  return (
    <main style={{ padding: 40, maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: 40, letterSpacing: "-0.02em" }}>MYDON</h1>
      <p style={{ color: "#3D4A5C" }}>
        Единый контур управления. Оболочка Command Center (скелет, Фаза&nbsp;2).
      </p>
      <h2 style={{ fontSize: 18, marginTop: 32 }}>Домены</h2>
      <ul>
        {DOMAINS.map((d) => (
          <li key={d}>
            <code>/{d}</code> — {DOMAIN_LABELS[d]}
          </li>
        ))}
      </ul>
    </main>
  );
}
