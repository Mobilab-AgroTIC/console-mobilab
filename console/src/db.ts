// Accès à Postgres avec le compte svc_console (spec V3 §2.3). Requêtes toujours paramétrées.
import pg from "pg";

export type Client = pg.PoolClient | pg.Pool;
export type Ligne = Record<string, any>;

let pool: pg.Pool | null = null;

export function ouvrir(url: string, max = 10): pg.Pool {
  // Sans URL, pg lit PGHOST, PGUSER, PGPASSWORD, PGDATABASE (mots de passe avec @ : / = sans souci d'encodage).
  pool = new pg.Pool({ ...(url ? { connectionString: url } : {}), max, application_name: "mobilab-console" });
  pool.on("error", e => console.error(JSON.stringify({ niveau: "erreur", message: `postgres : ${e.message}` })));
  return pool;
}

export function utiliser(p: pg.Pool) { pool = p; }

export function db(): pg.Pool {
  if (!pool) throw new Error("base non ouverte");
  return pool;
}

export async function q<T = any>(sql: string, params: unknown[] = [], c: Client = db()): Promise<T[]> {
  const r = await c.query(sql, params as any[]);
  return r.rows as T[];
}

/** Première ligne, ou null (typée sans null : l'appelant teste lui-même). */
export async function un<T = any>(sql: string, params: unknown[] = [], c: Client = db()): Promise<T> {
  const r = await c.query(sql, params as any[]);
  return (r.rows[0] ?? null) as T;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export const json = (v: unknown) => JSON.stringify(v ?? null);

/** Journal des actions (spec §5.2) : toute action qui change quelque chose. */
export async function audit(c: Client, a: { acteur?: number | null; via?: "bot" | "admin" | "support" | "systeme";
  tenant?: string | null; dev_eui?: string | null; action: string; details?: unknown }) {
  await c.query(
    `INSERT INTO app.audit (actor_id, via, tenant_slug, dev_eui, action, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [a.acteur ?? null, a.via ?? "bot", a.tenant ?? null, a.dev_eui ?? null, a.action, json(a.details ?? {})]);
}

/** Notification écrite par le service lui-même (admins, ou client), envoyée par le distributeur. */
export async function notifier(c: Client, n: { audience: "client" | "admin"; kind: string; tenant?: string | null;
  dev_eui?: string | null; details?: unknown; transition?: string }): Promise<number> {
  const r = await c.query(
    `INSERT INTO app.notifications (audience, expediteur, kind, tenant_slug, dev_eui, transition, details)
     VALUES ($1, 'service', $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [n.audience, n.kind, n.tenant ?? null, n.dev_eui ?? null, n.transition ?? (n.audience === "admin" ? "admin" : "info"), json(n.details ?? {})]);
  const id = Number(r.rows[0].id);
  await c.query("SELECT pg_notify('console', $1)", [String(id)]);
  return id;
}
