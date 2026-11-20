// Lectures et écritures courtes des bots (une transaction rapide, sans job : spec §2.2, point 4).
import { q, un } from "../db.js";
import { modele as modeleDe, pileFaible } from "../catalogue.js";

export type Role = "proprietaire" | "membre" | "conseiller";

export interface FermeDe { slug: string; display_name: string; status: string; role: Role; receives_alerts: boolean;
  grafana_org_id: number | null; alert_chat_id: number | null; grafana_role: string | null }

/** Fermes visibles d'une personne : adhésion active, ferme ni fermée ni en effacement (spec §4.10, §4.14). */
export async function fermesDe(personId: number): Promise<FermeDe[]> {
  return q<FermeDe>(
    `SELECT t.slug, t.display_name, t.status, m.role, m.receives_alerts, t.grafana_org_id, t.alert_chat_id, m.grafana_role
     FROM app.memberships m JOIN app.tenants t ON t.slug = m.tenant_slug
     WHERE m.person_id = $1 AND m.status = 'actif' AND t.status NOT IN ('suppression', 'supprime', 'en_creation')
     ORDER BY t.display_name`, [personId]);
}

export async function adhesion(personId: number, slug: string) {
  return un<{ role: Role; status: string; receives_alerts: boolean; grafana_role: string | null; tenant_status: string; display_name: string }>(
    `SELECT m.role, m.status, m.receives_alerts, m.grafana_role, t.status AS tenant_status, t.display_name
     FROM app.memberships m JOIN app.tenants t ON t.slug = m.tenant_slug WHERE m.person_id = $1 AND m.tenant_slug = $2`, [personId, slug]);
}

export async function ferme(slug: string) {
  return un(`SELECT * FROM app.tenants WHERE slug = $1`, [slug]);
}

export async function capteur(devEui: string) {
  return un(`SELECT d.*, t.display_name AS ferme, t.status AS statut_ferme FROM app.devices d JOIN app.tenants t ON t.slug = d.tenant_slug
             WHERE d.dev_eui = $1`, [devEui]);
}

export interface LigneCapteur { dev_eui: string; name: string; model_key: string | null; ttn_status: string; last_seen: Date | null;
  last_values: any; battery_mv: number | null; alerte: boolean; muet: boolean; pile: boolean; created_at: Date; config: any }

export async function capteursDe(slug: string): Promise<LigneCapteur[]> {
  const l = await q<LigneCapteur>(
    `SELECT d.dev_eui, d.name, d.model_key, d.ttn_status, d.last_seen, d.last_values, d.battery_mv, d.created_at, d.config,
            coalesce(bool_or(s.state = 'alarm' AND r.kind IN ('threshold', 'state')), false) AS alerte,
            coalesce(bool_or(s.state = 'alarm' AND r.kind = 'silence'), false) AS muet,
            coalesce(bool_or(s.state = 'alarm' AND r.kind = 'battery'), false) AS pile
     FROM app.devices d
     LEFT JOIN app.alert_rules r ON r.dev_eui = d.dev_eui AND r.enabled
     LEFT JOIN app.alert_state s ON s.rule_id = r.id
     WHERE d.tenant_slug = $1 AND d.ttn_status <> 'supprime'
     GROUP BY d.dev_eui ORDER BY d.name`, [slug]);
  // La pile se juge sur la dernière tension et la courbe du catalogue (l'état d'alarme peut dater d'avant).
  for (const c of l) c.pile = pileFaible(modeleDe(c.model_key), c.battery_mv);
  return l;
}

/** État d'un capteur pour la liste (spec §4.5) : ⚠️ en alerte, 📡 muet, 🪫 pile à changer, ⏳ en attente, ✅. */
export function etatCapteur(c: LigneCapteur): { emoji: string; rang: number } {
  if (c.alerte) return { emoji: "⚠️", rang: 0 };
  if (c.muet) return { emoji: "📡", rang: 1 };
  if (c.pile) return { emoji: "🪫", rang: 2 };
  if (!c.last_seen || !c.model_key) return { emoji: "⏳", rang: 3 };
  return { emoji: "✅", rang: 4 };
}

export async function regles(devEui: string) {
  return q(`SELECT r.*, s.state, s.since, s.muted_until, s.muted_by, s.last_value
            FROM app.alert_rules r LEFT JOIN app.alert_state s ON s.rule_id = r.id WHERE r.dev_eui = $1 ORDER BY r.id`, [devEui]);
}

export async function personne(id: number) {
  return un(`SELECT * FROM app.people WHERE id = $1`, [id]);
}

export async function proprietaires(slug: string) {
  return q(`SELECT p.* FROM app.memberships m JOIN app.people p ON p.id = m.person_id
            WHERE m.tenant_slug = $1 AND m.role = 'proprietaire' AND m.status = 'actif' ORDER BY m.granted_at`, [slug]);
}
