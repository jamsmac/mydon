import { redirect } from "next/navigation";

/**
 * Кофе-бункеры переехали внутрь рабочего места VendHub — старый адрес ведёт
 * туда. Адрес уточнён до ЛИСТА: раньше он приводил в верх «Полевой работы»,
 * и человек всё равно искал кофейную панель скроллом.
 */
export default function CoffeePage() {
  redirect("/domain/vendhub?tab=service:coffee");
}
