import { redirect } from "next/navigation";

/** Корень ведёт на главный экран — точку входа во всё (ТЗ FR-11). */
export default function Home() {
  redirect("/mydon");
}
