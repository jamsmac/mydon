import { Chat } from "../../components/chat";

export const dynamic = "force-dynamic";

export default function Assistant() {
  return (
    <>
      <div className="page-head">
        <h1>Помощник</h1>
        <p>Один и тот же MYDON, что и в Telegram. Спрашивай — отвечает по данным системы.</p>
      </div>
      <Chat />
    </>
  );
}
