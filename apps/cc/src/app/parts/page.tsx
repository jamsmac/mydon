import { PartsView } from "../../components/parts-view";

export const dynamic = "force-dynamic";

/**
 * Узлы — экран НАПРАВЛЕНИЯ VendHub (решение владельца 09.09.2026), доступный и
 * по своему адресу: на него ссылаются «Обслуживание», очередь узлов и бот.
 * Тело — общий компонент, его же рисует вкладка «Парк» рабочего места.
 */
export default async function PartsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; location?: string; attention?: string; q?: string }>;
}) {
  return <PartsView sp={await searchParams} />;
}
