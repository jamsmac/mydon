import { describe, expect, it } from "vitest";
import { GEOCODER_USER_AGENT, formatReverse } from "./geocode";

describe("адрес по точке на карте (М-5)", () => {
  it("улица с домом, район, город — без страны и индекса", () => {
    expect(
      formatReverse({
        address: {
          road: "улица Шота Руставели",
          house_number: "156",
          suburb: "Яккасарайский район",
          city: "Ташкент",
          postcode: "100121",
          country: "Узбекистан",
        },
      }),
    ).toBe("улица Шота Руставели, 156, Яккасарайский район, Ташкент");
  });

  it("без дома — улица; без улицы — район и город", () => {
    expect(formatReverse({ address: { road: "Олмачи", city: "Ташкент" } })).toBe("Олмачи, Ташкент");
    expect(formatReverse({ address: { suburb: "Чиланзар", city: "Ташкент" } })).toBe("Чиланзар, Ташкент");
  });

  it("совпавшие район и город не дублируются", () => {
    expect(formatReverse({ address: { city_district: "Ташкент", city: "Ташкент" } })).toBe("Ташкент");
  });

  it("пустой или чужой ответ — null, а не пустая строка", () => {
    expect(formatReverse(null)).toBeNull();
    expect(formatReverse({ error: "Unable to geocode" })).toBeNull();
    expect(formatReverse({ address: {} })).toBeNull();
  });

  it("подпись запросов без почты владельца — её не отправляем стороннему сервису", () => {
    expect(GEOCODER_USER_AGENT).not.toMatch(/@/);
  });
});
