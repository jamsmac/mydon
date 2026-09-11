import { MaintenanceView } from "../../components/maintenance-view";

export const dynamic = "force-dynamic";

/**
 * Обслуживание — экран НАПРАВЛЕНИЯ VendHub (решение владельца 09.09.2026),
 * живущий и по своему адресу: сюда ведут ссылки карточек и бота. Тело — общий
 * компонент, его же рисует вкладка «Парк» рабочего места.
 */
export default function MaintenancePage() {
  return <MaintenanceView />;
}
