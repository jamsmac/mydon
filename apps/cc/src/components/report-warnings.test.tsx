import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AnalyticsWarning } from "@mydon/shared";
import { ReportWarnings } from "./report-warnings";

const ПРЕДУПРЕЖДЕНИЯ: AnalyticsWarning[] = [
  { code: "unknown_cost", message: "12 шт без себестоимости — маржа завышена" },
  { code: "excluded_sales", message: "SKLAD 4S: 1 шт вне парка — в маржу не вошёл" },
  { code: "excluded_sales", message: "SKLAD 4S: 1 шт вне парка — в маржу не вошёл" },
];

describe("Блок «Посчитано не всё»", () => {
  it("печатает причины, которых в самих числах не видно", () => {
    render(<ReportWarnings warnings={ПРЕДУПРЕЖДЕНИЯ} />);
    expect(screen.getByText("Посчитано не всё")).toBeVisible();
    expect(screen.getByText(/12 шт без себестоимости/)).toBeVisible();
  });

  it("одну и ту же причину дважды не повторяет", () => {
    render(<ReportWarnings warnings={ПРЕДУПРЕЖДЕНИЯ} />);
    expect(screen.getAllByText(/SKLAD 4S/)).toHaveLength(1);
  });

  it("код, который лист уже сказал своей строкой, в хвост не попадает", () => {
    render(<ReportWarnings warnings={ПРЕДУПРЕЖДЕНИЯ} covered={["unknown_cost"]} />);
    expect(screen.queryByText(/без себестоимости/)).toBeNull();
    expect(screen.getByText(/SKLAD 4S/)).toBeVisible();
  });

  it("предупреждений нет — блока нет вовсе, а не пустой заголовок", () => {
    const { container } = render(<ReportWarnings warnings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("поля нет вовсе (старый Core, фикстура) — блока нет и падения нет", () => {
    const { container } = render(<ReportWarnings />);
    expect(container).toBeEmptyDOMElement();
  });

  it("все причины покрыты листом — заголовка «Посчитано не всё» нет", () => {
    render(<ReportWarnings warnings={ПРЕДУПРЕЖДЕНИЯ} covered={["unknown_cost", "excluded_sales"]} />);
    expect(screen.queryByText("Посчитано не всё")).toBeNull();
  });
});
