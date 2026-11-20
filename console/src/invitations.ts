// Liens d'invitation (spec V3 §4.3, §6.3) : jeton de 32 octets, seule l'empreinte est stockée, usage unique.
import type pg from "pg";
import { jeton, empreinte } from "./crypto.js";
import { json, q } from "./db.js";

export type Kind = "activation" | "new_client" | "join" | "groupe" | "admin";
export const PREFIXES: Record<Kind, string> = { activation: "a_", new_client: "n_", join: "j_", groupe: "g_", admin: "adm_" };
export const DUREES_H: Record<Kind, number> = { activation: 720, new_client: 168, join: 168, groupe: 24, admin: 24 };

/** Crée un lien. Un nouveau lien a_ ou g_ révoque le précédent de la même ferme (spec §6.3). */
export async function creerLien(c: pg.PoolClient | pg.Pool, kind: Kind, o: { tenant?: string | null; payload?: Record<string, unknown>;
  par?: number | null }): Promise<{ parametre: string; empreinte: string }> {
  if ((kind === "activation" || kind === "groupe") && o.tenant) {
    await c.query(`UPDATE app.invitations SET revoked_at = now() WHERE kind = $1 AND tenant_slug = $2 AND used_at IS NULL AND revoked_at IS NULL`,
      [kind, o.tenant]);
  }
  const j = jeton();
  const e = empreinte(j);
  await c.query(
    `INSERT INTO app.invitations (token, kind, tenant_slug, payload, created_by, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, now() + make_interval(hours => $6))`,
    [e, kind, o.tenant ?? null, json(o.payload ?? {}), o.par ?? null, DUREES_H[kind]]);
  return { parametre: PREFIXES[kind] + j, empreinte: e };
}

export function lireParametre(p: string): { kind: Kind; empreinte: string } | null {
  const m = /^(a_|n_|j_|g_|adm_)([A-Za-z0-9_-]{43})$/.exec(String(p || "").trim());
  if (!m) return null;
  const kind = (Object.entries(PREFIXES).find(([, v]) => v === m[1]) as [Kind, string])[0];
  return { kind, empreinte: empreinte(m[2]) };
}

/** Consomme le lien en une requête atomique (spec §6.3, étape 1). null : lien mort. */
export async function consommer(c: pg.PoolClient, e: string, kind: Kind, personId: number | null):
  Promise<{ kind: Kind; tenant_slug: string | null; payload: any; created_by: number | null } | null> {
  const r = await c.query(
    `UPDATE app.invitations SET used_at = now(), used_by = $3
     WHERE token = $1 AND kind = $2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
     RETURNING kind, tenant_slug, payload, created_by`, [e, kind, personId]);
  return r.rows[0] || null;
}

/** Lien déjà utilisé ou périmé : sa ferme, pour répondre « déjà accès » à la même personne. */
export async function fermeDuLien(e: string): Promise<string | null> {
  const r = await q(`SELECT tenant_slug FROM app.invitations WHERE token = $1`, [e]);
  return r[0]?.tenant_slug ?? null;
}
