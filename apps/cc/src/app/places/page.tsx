import { PlacesView } from "../../components/places-view";

export const dynamic = "force-dynamic";

/**
 * Места — экран НАПРАВЛЕНИЯ VendHub (решение владельца 09.09.2026), а живёт он
 * и по своему адресу: закладки, ссылки бота и переходы «исправить →» с карточек
 * ведут сюда, и ломать их ради переезда вкладки незачем. Тело экрана — общий
 * компонент, который рисует и вкладка «Парк» рабочего места.
 */
export default function PlacesPage() {
  return <PlacesView />;
}
