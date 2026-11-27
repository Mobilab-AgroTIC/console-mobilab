// Ce que les jobs, les bots et la surveillance partagent : configuration, clients TTN/Grafana,
// API Telegram des deux bots, et l'envoi de messages (avec suivi des personnes injoignables).
import { Api, InlineKeyboard, InputFile } from "grammy";
import type { Config } from "./config.js";
import { Ttn } from "./ttn.js";
import { Grafana } from "./grafana.js";
import { q, un, json } from "./db.js";
import { log } from "./log.js";
import { heureParis } from "./format.js";

export type Clavier = InlineKeyboard | { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] } | undefined;
export type QuelBot = "client" | "admin";

/** [⬅️ Retour] vers la fiche du capteur, dans le bot qui a envoyé le message : jamais de message sans issue. */
export function retourFiche(bot: QuelBot, dev: string): Clavier {
  return { inline_keyboard: [[{ text: "⬅️ Retour", callback_data: bot === "admin" ? `a:dev:${dev}` : `dv:${dev}` }]] };
}

export interface Services {
  cfg: Config;
  ttn: Ttn;
  grafana: Grafana;
  api: { client: Api | null; admin: Api | null };
  noms: { client: string; admin: string };
  /** Résultats gardés en mémoire seulement (liens, mots de passe), jamais en base (spec §6.1). */
  memoire: Map<number, Record<string, unknown>>;
  lots: Map<string, { total: number; pages: unknown[]; chat: number; message: number; lignes: Record<number, string> }>;
}

export function creerServices(cfg: Config): Services {
  return {
    cfg,
    ttn: new Ttn(cfg.ttn),
    grafana: new Grafana(cfg.grafana),
    api: {
      client: cfg.telegram.clientToken ? new Api(cfg.telegram.clientToken) : null,
      admin: cfg.telegram.adminToken ? new Api(cfg.telegram.adminToken) : null,
    },
    noms: { client: cfg.telegram.clientBotName, admin: cfg.telegram.adminBotName },
    memoire: new Map(),
    lots: new Map(),
  };
}

export function lienBot(s: Services, bot: QuelBot, param: string, groupe = false): string {
  const nom = bot === "client" ? s.noms.client : s.noms.admin;
  return `https://t.me/${nom}?${groupe ? "startgroup" : "start"}=${param}`;
}

function erreurTelegram(e: any): { code: number; description: string; migrate?: number } {
  return { code: Number(e?.error_code || 0), description: String(e?.description || e?.message || ""),
           migrate: e?.parameters?.migrate_to_chat_id };
}

/** Envoie un message ; null si la personne a bloqué le bot (marquée injoignable). */
export async function envoyer(s: Services, bot: QuelBot, chatId: number, texte: string, clavier?: Clavier,
  extra: Record<string, unknown> = {}): Promise<number | null> {
  const api = s.api[bot];
  if (!api) return null;
  try {
    const m = await api.sendMessage(chatId, texte, { parse_mode: "HTML", reply_markup: clavier as any,
      link_preview_options: { is_disabled: true }, ...extra });
    return m.message_id;
  } catch (e) {
    const t = erreurTelegram(e);
    if (t.code === 403 || /chat not found|blocked|deactivated/i.test(t.description)) {
      if (bot === "client" && chatId > 0) {
        await q(`UPDATE app.people SET unreachable_since = now() WHERE telegram_user_id = $1 AND unreachable_since IS NULL`, [chatId]).catch(() => undefined);
      }
      return null;
    }
    log.warn(`envoi Telegram (${bot}) refusé : ${t.code} ${t.description.slice(0, 80)}`);
    return null;
  }
}

export async function modifier(s: Services, bot: QuelBot, chatId: number | null | undefined, messageId: number | null | undefined,
  texte: string, clavier?: Clavier): Promise<boolean> {
  const api = s.api[bot];
  if (!api || !chatId || !messageId) return false;
  try {
    await api.editMessageText(chatId, messageId, texte, { parse_mode: "HTML", reply_markup: clavier as any,
      link_preview_options: { is_disabled: true } });
    return true;
  } catch (e) {
    const t = erreurTelegram(e);
    if (/not modified/i.test(t.description)) return true;
    log.warn(`modification Telegram (${bot}) refusée : ${t.code} ${t.description.slice(0, 80)}`);
    // Message impossible à modifier (clavier de réponse, message effacé…) : la réponse part dans un nouveau message.
    if (/can't be edited|message to edit not found/i.test(t.description)) return (await envoyer(s, bot, chatId, texte, clavier)) !== null;
    return false;
  }
}

export async function envoyerDocument(s: Services, bot: QuelBot, chatId: number, contenu: Buffer, nom: string, legende?: string) {
  const api = s.api[bot];
  if (!api) return null;
  try {
    const m = await api.sendDocument(chatId, new InputFile(contenu, nom), { caption: legende });
    return m.message_id;
  } catch (e) {
    log.warn(`envoi de document refusé : ${erreurTelegram(e).description.slice(0, 80)}`);
    return null;
  }
}

/** Efface un message plus tard (mot de passe affiché : 24 h, spec §5.4). Gardé en base pour survivre au redémarrage. */
export async function effacerPlusTard(bot: QuelBot, chatId: number, messageId: number, heures = 24) {
  await q(`INSERT INTO app.bot_sessions (key, value, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [`effacer:${bot}:${chatId}:${messageId}`, json({ bot, chatId, messageId, apres: new Date(Date.now() + heures * 3600000).toISOString() })]);
}

export async function effacerEchus(s: Services) {
  const l = await q(`SELECT key, value FROM app.bot_sessions WHERE key LIKE 'effacer:%' AND (value->>'apres')::timestamptz < now()`);
  for (const x of l) {
    const v = x.value;
    await s.api[v.bot as QuelBot]?.deleteMessage(v.chatId, v.messageId).catch(() => undefined);
    await q(`DELETE FROM app.bot_sessions WHERE key = $1`, [x.key]);
  }
}

export interface Admin { id: number; telegram_user_id: number; display_name: string; settings: any }

export async function admins(): Promise<Admin[]> {
  return q<Admin>(`SELECT id, telegram_user_id, display_name, settings FROM app.people WHERE is_admin AND telegram_user_id IS NOT NULL`);
}

/**
 * Notification aux admins (spec §5.15). Urgent : toujours en direct. Info : en direct, sauf pour l'admin qui
 * les veut dans son résumé ou qui est en pause 24 h. `seulement` : à un admin précis (« à l'admin qui… »).
 */
export async function avertirAdmins(s: Services, texte: string, o: { urgent?: boolean; clavier?: Clavier; seulement?: number | null;
  notificationId?: number } = {}): Promise<{ chat_id: number; message_id: number | null }[]> {
  const res: { chat_id: number; message_id: number | null }[] = [];
  for (const a of await admins()) {
    if (o.seulement && a.id !== o.seulement) continue;
    const reglages = a.settings || {};
    if (!o.urgent) {
      if (reglages.infos === "resume") continue;
      if (reglages.pause_jusqua && new Date(reglages.pause_jusqua) > new Date()) continue;
    }
    const id = await envoyer(s, "admin", Number(a.telegram_user_id), texte, o.clavier);
    res.push({ chat_id: Number(a.telegram_user_id), message_id: id });
  }
  if (o.notificationId) {
    await q(`UPDATE app.notifications SET statut = $2, destinataires = $3::jsonb WHERE id = $1`,
      [o.notificationId, res.some(r => r.message_id) ? "envoye" : "sans_destinataire", json(res)]);
  }
  return res;
}

/** Les personnes de la ferme à prévenir (propriétaires, et collègues si demandé), joignables en privé. */
export async function membres(tenant: string, roles: string[] = ["proprietaire"]): Promise<{ id: number; telegram_user_id: number; display_name: string }[]> {
  return q(`SELECT p.id, p.telegram_user_id, p.display_name FROM app.memberships m JOIN app.people p ON p.id = m.person_id
            WHERE m.tenant_slug = $1 AND m.status = 'actif' AND m.role = ANY($2::text[]) AND p.telegram_user_id IS NOT NULL
              AND p.unreachable_since IS NULL`, [tenant, roles]);
}

export async function envoyerAuxMembres(s: Services, tenant: string, texte: string, roles = ["proprietaire"], clavier?: Clavier) {
  for (const m of await membres(tenant, roles)) await envoyer(s, "client", Number(m.telegram_user_id), texte, clavier);
}

export function heuresCalmes(): boolean {
  const h = heureParis();
  return h < 8 || h >= 20;
}

export async function nomFerme(slug: string): Promise<string> {
  return (await un<{ display_name: string }>(`SELECT display_name FROM app.tenants WHERE slug = $1`, [slug]))?.display_name || slug;
}
