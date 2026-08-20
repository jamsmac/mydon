import { redirect } from "next/navigation";

/** Кофе-бункеры переехали внутрь рабочего места VendHub — старый адрес ведёт туда. */
export default function CoffeePage() {
  redirect("/domain/vendhub?tab=service");
}
