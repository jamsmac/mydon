import { DOMAIN_LABELS, DOMAINS, type Domain } from "@mydon/shared";

export interface TaskWithDomain {
  domain: string | null;
}

export interface TaskDirectionGroup<T extends TaskWithDomain> {
  key: Domain | "unassigned";
  label: string;
  tasks: T[];
}

const DOMAIN_SET = new Set<string>(DOMAINS);

/**
 * One stable direction order for every task queue. Legacy rows without a
 * direction (and defensive unknown values) stay visible in the last bucket.
 */
export function groupTasksByDirection<T extends TaskWithDomain>(
  tasks: T[],
): TaskDirectionGroup<T>[] {
  const buckets = new Map<Domain, T[]>(DOMAINS.map((domain) => [domain, []]));
  const unassigned: T[] = [];

  for (const task of tasks) {
    if (task.domain !== null && DOMAIN_SET.has(task.domain)) {
      buckets.get(task.domain as Domain)?.push(task);
    } else {
      unassigned.push(task);
    }
  }

  const groups: TaskDirectionGroup<T>[] = DOMAINS.flatMap((domain) => {
    const grouped = buckets.get(domain) ?? [];
    return grouped.length > 0
      ? [{ key: domain, label: DOMAIN_LABELS[domain], tasks: grouped }]
      : [];
  });

  if (unassigned.length > 0) {
    groups.push({ key: "unassigned", label: "Без направления", tasks: unassigned });
  }
  return groups;
}
