import { redirect } from "next/navigation";

/** Автоматы переехали внутрь рабочего места VendHub — старый адрес ведёт туда. */
export default function VendingPage() {
  redirect("/domain/vendhub?tab=vending");
}
