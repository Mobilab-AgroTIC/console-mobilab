// Ce que les deux bots partagent : sessions rangées dans app.bot_sessions (spec §4.14), identification de la
// personne, claviers, réponses aux boutons, expiration des conversations.
import { Context, InlineKeyboard, type SessionFlavor, type StorageAdapter } from "grammy";
import { q, un, json } from "../db.js";
import type { Services } from "../services.js";

export interface Conversation {
  nom: string;               // ajouter, renommer, seuil, nom_ferme, creer_client, ajouter_pour, repondre…
  etape: string;
  donnees: Record<string, any>;
  depuis: number;            // dernière activité (ms)
  commande: string;          // commande d'origine, pour « Trop d'attente, on recommence : /ajouter »
}

export interface Session {
  conv?: Conversation;
  oubliee?: { commande: string; jusqua: number };
  ferme?: string;            // ferme du dernier écran
  retour?: string;           // callback du bouton « Non » (spec §4.15, `no`)
  texteLibre?: string;       // texte en attente de « J'envoie ce message à Mobilab ? »
  support?: { tenant: string; depuis: number };
  dernierPasAdmin?: number;  // dernier « réservé à l'équipe » (une ligne par jour, spec §5.1)
}

export interface Personne { id: number; telegram_user_id: number | null; display_name: string; is_admin: boolean;
  grafana_login: string | null; grafana_user_id: number | null; grafana_password_sent_at: Date | null; settings: any;
  access_requested_at: Date | null; profile: any }

export type Ctx = Context & SessionFlavor<Session> & { personne: Personne | null; s: Services };

export const CONVERSATION_MS = 30 * 60000;

/** Sessions dans Postgres : un redémarrage ne perd rien (spec §2.2, point 3). */
export function stockage(prefixe: string): StorageAdapter<Session> {
  const cle = (k: string) => `${prefixe}:${k}`;
  return {
    async read(k) {
      const r = await un<{ value: Session }>(`SELECT value FROM app.bot_sessions WHERE key = $1`, [cle(k)]);
      return r?.value;
    },
    async write(k, v) {
      await q(`INSERT INTO app.bot_sessions (key, value, updated_at) VALUES ($1, $2::jsonb, now())
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [cle(k), json(v)]);
    },
    async delete(k) {
      await q(`DELETE FROM app.bot_sessions WHERE key = $1`, [cle(k)]);
    },
  };
}

export async function chargerPersonne(telegramId: number): Promise<Personne | null> {
  return un<Personne>(`SELECT id, telegram_user_id, display_name, is_admin, grafana_login, grafana_user_id, grafana_password_sent_at,
                              settings, access_requested_at, profile FROM app.people WHERE telegram_user_id = $1`, [telegramId]);
}

/** Démarre une conversation ; une autre commande l'abandonne sans rien dire (spec §4.14). */
export function demarrer(ctx: Ctx, nom: string, etape: string, commande: string, donnees: Record<string, any> = {}) {
  ctx.session.conv = { nom, etape, donnees, depuis: Date.now(), commande };
  delete ctx.session.oubliee;
}

export function finir(ctx: Ctx) {
  delete ctx.session.conv;
}

/** Conversation en cours, ou null si elle a plus de 30 min (elle est alors notée « oubliée » 24 h). */
export function conversation(ctx: Ctx): Conversation | null {
  const c = ctx.session.conv;
  if (!c) return null;
  if (Date.now() - c.depuis > CONVERSATION_MS) {
    ctx.session.oubliee = { commande: c.commande, jusqua: Date.now() + 24 * 3600000 };
    delete ctx.session.conv;
    return null;
  }
  c.depuis = Date.now();
  return c;
}

export type Bouton = { text: string; callback_data?: string; url?: string };

/** Clavier en lignes de `parLigne` boutons. */
export function clavier(boutons: (Bouton | null | undefined | false)[], parLigne = 2): InlineKeyboard {
  const k = new InlineKeyboard();
  let n = 0;
  for (const b of boutons) {
    if (!b) continue;
    if (n && n % parLigne === 0) k.row();
    if (b.url) k.url(b.text, b.url); else k.text(b.text, b.callback_data!);
    n++;
  }
  return k;
}

export function lignes(...rangees: (Bouton | null | undefined | false)[][]): InlineKeyboard {
  const k = new InlineKeyboard();
  for (const r of rangees) {
    const ok = r.filter(Boolean) as Bouton[];
    if (!ok.length) continue;
    for (const b of ok) { if (b.url) k.url(b.text, b.url); else k.text(b.text, b.callback_data!); }
    k.row();
  }
  return k;
}

/** Clavier de réponse avec un seul bouton [Annuler] (spec §4.4). */
export function clavierAnnuler(texte: string, exemple?: string) {
  return { keyboard: [[{ text: texte }]], resize_keyboard: true, is_persistent: true, input_field_placeholder: exemple };
}
export const sansClavier = { remove_keyboard: true as const };

/** Retire le clavier [Annuler] sans laisser de trace. Telegram refuse de modifier un message envoyé avec un clavier
 *  de réponse, même pour le retirer : on l'appelle avant un message qu'une tâche mettra à jour (« ⏳ … »). */
export async function retirerClavier(ctx: Ctx) {
  const m = await dire(ctx, "…", { reply_markup: sansClavier }).catch(() => undefined);
  if (m) await ctx.api.deleteMessage(m.chat.id, m.message_id).catch(() => undefined);
}

/** Affiche un écran : modifie le message du bouton, sinon en envoie un nouveau (spec §4.1, point 9). */
export async function ecran(ctx: Ctx, texte: string, k?: InlineKeyboard) {
  const opts = { parse_mode: "HTML" as const, reply_markup: k, link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(texte, opts); return; } catch (e: any) {
      if (/not modified/i.test(String(e?.description || e?.message))) return;
    }
  }
  await ctx.reply(texte, opts);
}

export async function dire(ctx: Ctx, texte: string, extra: Record<string, unknown> = {}) {
  return ctx.reply(texte, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
}

/** Âge d'un écran de confirmation (spec §4.14 : 2 min actionneur, 5 min les autres). Le bot réécrit le même message
 *  d'écran en écran : on compte depuis sa dernière modification (l'affichage de la question), pas depuis son envoi. */
export function tropAncien(ctx: Ctx, minutes: number): boolean {
  const m = ctx.callbackQuery?.message;
  const d = m && "edit_date" in m && m.edit_date ? m.edit_date : m?.date;
  return Boolean(d && Date.now() / 1000 - d > minutes * 60);
}

export function decouper(data: string): string[] {
  return data.split(":");
}

export const DEVEUI = /^[0-9a-f]{16}$/;
export const SLUG = /^f[0-9]{4,}$/;
