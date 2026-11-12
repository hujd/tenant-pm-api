export function parseLimit(raw: unknown, fallback = 50, max = 200): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function parseCursor(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function page<T>(rows: T[], limit: number, offset: number): { items: T[]; next: number | null } {
  return {
    items: rows,
    next: rows.length === limit ? offset + limit : null,
  };
}
