import Link from "next/link";
import { partAttentionLabel } from "@mydon/shared";
import { core, CoreUnavailable, type PartsQueue as Queue } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { PartsQueue } from "../../../components/parts-queue";

export const dynamic = "force-dynamic";

/** Очередь внимания к узлам — по одному на экран (R-PU-4). */
export default async function PartsQueuePage() {
  let queue: Queue;
  try {
    queue = await core.partsQueue();
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  const counts = Object.entries(queue.counts).filter(([, n]) => n > 0);
  return (
    <>
      <div className="page-head">
        <Link href="/parts" className="back">
          ← Все узлы
        </Link>
        <h1>Наклеить номер</h1>
        <p>
          {queue.items.length === 0
            ? "Все узлы учтены."
            : `Узлов, требующих внимания: ${queue.items.length}` +
              (counts.length ? " · " + counts.map(([k, n]) => `${partAttentionLabel(k)} ${n}`).join(" · ") : "")}
        </p>
      </div>
      <PartsQueue queue={queue} />
    </>
  );
}
