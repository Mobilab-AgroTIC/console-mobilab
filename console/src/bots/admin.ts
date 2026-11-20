// Bot admin (spec V3 §5) : équipe Mobilab. Contrôle is_admin sur from.id à chaque mise à jour (§5.1),
// conversation privée seulement, boutons préfixés « a: » (§5.2).
import { Bot, session, InlineKeyboard, InputFile } from "grammy";
import { db, q, un, tx, json, audit, notifier } from "../db.js";
import { admin as T, client as TC, commun as C, f } from "../textes.fr.js";
import { echapper, depuis, duree, jour, jourHeure, heure, avecUnite, nombre, prenom, nomTelegram, quand } from "../format.js";
import { controler as controlerCode, groupes, lireListe, ressembleAUneListe, rangerCodes, court } from "../codes.js";
import { creerLien, lireParametre, consommer } from "../invitations.js";
import { chiffrer, dechiffrer, codeErreur } from "../crypto.js";
import { catalogue, modele as modeleDe, definition, pourcentagePile, pileFaible, modesDe, modelesProposes, voiesDe, sondesPour, marques, typesDeMarque, boutonModele } from "../catalogue.js";
import { creerJob, chiffrerSecret, relancer, annuler } from "../jobs/moteur.js";
import { redecoder, appDe, idTtn } from "../jobs/taches.js";
import { envoyer, avertirAdmins, lienBot, envoyerDocument, effacerPlusTard, envoyerAuxMembres, type Services } from "../services.js";
import { fichePdf, qrPng } from "../fiche.js";
import { calculerEtat, etatCourant, texteEtat, resumeDuMatin } from "../surveillance.js";
import { log } from "../log.js";
import { questionSonde } from "../notifications.js";
import { libelleType, apresMarque, questionCategorie, questionType } from "./client.js";
import { type Ctx, type Session, stockage, chargerPersonne, demarrer, finir, conversation, clavier, clavierAnnuler, sansClavier, retirerClavier,
  ecran, dire, tropAncien, DEVEUI, SLUG } from "./commun.js";
import { capteursDe, etatCapteur, regles, ferme as lireFerme, capteur as lireCapteur } from "./donnees.js";

const PAR_PAGE = 8;
const ROLE: Record<string, string> = { proprietaire: "propriétaire", membre: "collègue", conseiller: "conseiller" };

// ===================================================================== clients (§5.6)

async function chercherClients(texte: string) {
  const t = texte.trim().toLowerCase();
  const dev = t.replace(/[\s:-]/g, "");
  return q(`SELECT DISTINCT t.slug FROM app.tenants t
            LEFT JOIN app.devices d ON d.tenant_slug = t.slug
            LEFT JOIN app.memberships m ON m.tenant_slug = t.slug LEFT JOIN app.people p ON p.id = m.person_id
            WHERE t.status <> 'supprime' AND (lower(t.display_name) LIKE '%' || $1 || '%' OR t.slug = $1
              OR (length($2) >= 6 AND d.dev_eui LIKE '%' || $2) OR lower(p.display_name) LIKE '%' || $1 || '%' OR lower(p.grafana_login) = $1)
            LIMIT 20`, [t, dev]);
}

async function ecranClients(ctx: Ctx, page = 0, filtre?: string[]) {
  const l = await q(`SELECT t.slug, t.display_name, t.status, t.created_at, t.purge_after,
                     (SELECT count(*) FROM app.devices d WHERE d.tenant_slug = t.slug AND d.ttn_status <> 'supprime')::int AS capteurs,
                     (SELECT count(*) FROM app.alert_state s JOIN app.alert_rules r ON r.id = s.rule_id AND r.kind = 'silence'
                      JOIN app.devices d ON d.dev_eui = r.dev_eui WHERE d.tenant_slug = t.slug AND s.state = 'alarm' AND d.ttn_status <> 'supprime')::int AS muets
                     FROM app.tenants t WHERE t.status NOT IN ('supprime') ${filtre ? "AND t.slug = ANY($1::text[])" : ""}`, filtre ? [filtre] : []);
  if (!l.length) { await ecran(ctx, T.aucun_client); return; }
  const rang = (x: any) => (x.muets ? 0 : x.status === "en_attente_activation" ? 1 : x.status === "suspendu" ? 2 : x.status === "suppression" ? 3 : 4);
  l.sort((a, b) => rang(a) - rang(b) || a.display_name.localeCompare(b.display_name, "fr"));
  const pages = Math.ceil(l.length / PAR_PAGE);
  page = Math.max(0, Math.min(page, pages - 1));
  const morceau = l.slice(page * PAR_PAGE, (page + 1) * PAR_PAGE);
  const txt = [f(T.clients_titre, { n: l.length })];
  for (const x of morceau) {
    const nom = echapper(x.display_name);
    if (x.muets) txt.push(f(T.client_muets, { ferme: nom, n: x.muets }));
    else if (x.status === "en_attente_activation") txt.push(f(T.client_pas_activee, { ferme: nom, duree: depuis(x.created_at) }));
    else if (x.status === "suspendu") txt.push(f(T.client_pause, { ferme: nom }));
    else if (x.status === "suppression") txt.push(f(T.client_efface, { ferme: nom, date: x.purge_after ? jour(x.purge_after) : "?" }));
    else if (x.status === "en_creation") txt.push(`⏳ ${nom} · en création`);
    else txt.push(f(T.client_ok, { ferme: nom, n: x.capteurs }));
  }
  const k = clavier(morceau.map(x => ({ text: x.display_name, callback_data: `a:cli:${x.slug}` })));
  if (pages > 1) { k.row(); if (page > 0) k.text(C.precedent, `a:cl:${page - 1}`); if (page < pages - 1) k.text(C.suivant, `a:cl:${page + 1}`); }
  await ecran(ctx, txt.join("\n"), k);
}

async function ecranClient(ctx: Ctx, slug: string) {
  const t = await lireFerme(slug);
  if (!t) { await ecran(ctx, T.aucun_client); return; }
  const caps = await capteursDe(slug);
  const ok = caps.filter(c => etatCapteur(c).rang === 4).length;
  const muets = caps.filter(c => c.muet);
  const jamais = caps.filter(c => !c.last_seen).length;
  const piles = caps.filter(c => c.pile).length;
  const dernier = caps.filter(c => c.last_seen).sort((a, b) => new Date(b.last_seen!).getTime() - new Date(a.last_seen!).getTime())[0];
  const alertes = await un(`SELECT (SELECT count(*) FROM app.alert_state s JOIN app.alert_rules r ON r.id = s.rule_id JOIN app.devices d ON d.dev_eui = r.dev_eui
                             WHERE d.tenant_slug = $1 AND s.state = 'alarm' AND d.ttn_status <> 'supprime')::int AS en_cours,
                            (SELECT count(*) FROM app.notifications WHERE tenant_slug = $1 AND kind = 'alerte' AND transition = 'alarme'
                             AND created_at > now() - interval '7 days')::int AS envoyees`, [slug]);
  const pers = await q(`SELECT p.display_name, m.role FROM app.memberships m JOIN app.people p ON p.id = m.person_id WHERE m.tenant_slug = $1 AND m.status = 'actif'`, [slug]);
  const proprio = pers.find(p => p.role === "proprietaire");
  const par = t.created_by ? (await un(`SELECT display_name FROM app.people WHERE id = $1`, [t.created_by]))?.display_name : "—";
  const statut = t.status === "actif" ? f(T.statut_actif, { date: t.activated_at ? jour(t.activated_at) : "?" })
    : t.status === "en_attente_activation" ? T.statut_attente : t.status === "suspendu" ? T.statut_pause
    : t.status === "suppression" ? f(T.statut_suppression, { date: t.purge_after ? jour(t.purge_after) : "?" }) : T.statut_creation;
  const sante = t.config?.sante || {};
  const l = [f(T.fiche_client_titre, { ferme: echapper(t.display_name), slug }),
    f(T.fiche_client_statut, { statut, par: echapper(par) }) + (t.grafana_org_id && ctx.s.cfg.grafana.publicUrl ? ` · <a href="${ctx.s.cfg.grafana.publicUrl}/?orgId=${t.grafana_org_id}">Graphiques</a>` : ""),
    f(T.fiche_client_capteurs, { total: caps.length, ok, muets: muets.length, jamais })];
  if (piles) l.push(f(T.fiche_client_piles, { n: piles }));
  if (dernier) l.push(f(T.fiche_client_dernier, { duree: depuis(dernier.last_seen), capteur: echapper(dernier.name) }));
  l.push(f(T.fiche_client_alertes, { en_cours: alertes.en_cours, envoyees: alertes.envoyees }));
  l.push(f(T.fiche_client_personnes, { n: pers.length, proprietaire: echapper(proprio?.display_name || "—") }));
  l.push(f(T.fiche_client_sante, { ttn: sante.ttn || "?", webhook: sante.webhook || "?", grafana: sante.grafana || "?", base: sante.base || "?" }));
  if (t.migration) l.push(`Migration V1 : ${echapper(JSON.stringify(t.migration)).slice(0, 80)}`);
  const casse = Object.values(sante).includes("❌");
  const k = clavier([{ text: T.bouton_capteurs, callback_data: `a:cli:${slug}:c` }, { text: T.bouton_personnes, callback_data: `a:cli:${slug}:p` },
    { text: T.bouton_alertes, callback_data: `a:cli:${slug}:al` }, { text: T.bouton_ajouter_capteur, callback_data: `a:cli:${slug}:aj` },
    { text: T.bouton_support, callback_data: `a:sup:${slug}` },
    casse ? { text: T.bouton_reparer, callback_data: `a:cli:${slug}:fix` } : { text: C.plus, callback_data: `a:cli:${slug}:pl` }]);
  await ecran(ctx, l.join("\n"), k);
}

async function ecranCapteursClient(ctx: Ctx, slug: string) {
  const t = await lireFerme(slug);
  const caps = await capteursDe(slug);
  const l = [f(T.capteurs_client_titre, { ferme: echapper(t.display_name), n: caps.length })];
  for (const c of caps.sort((a, b) => etatCapteur(a).rang - etatCapteur(b).rang || a.name.localeCompare(b.name, "fr")).slice(0, 30)) {
    const m = modeleDe(c.model_key);
    const detail = !c.last_seen ? `jamais connecté (ajouté il y a ${depuis(c.created_at)})` : c.muet ? `muet depuis ${depuis(c.last_seen)}`
      : `${echapper(c.last_values?.resume || "")} · il y a ${depuis(c.last_seen)}`;
    l.push(f(T.capteur_admin_ligne, { etat: etatCapteur(c).emoji, capteur: echapper(c.name), modele: echapper(m?.modele || "modèle ?"), detail }));
  }
  const k = clavier(caps.slice(0, 16).map(c => ({ text: `${etatCapteur(c).emoji} ${c.name}`, callback_data: `a:dev:${c.dev_eui}` })), 1);
  k.row().text(T.bouton_derniers_messages, `a:cli:${slug}:m`).text(C.retour, `a:cli:${slug}`);
  await ecran(ctx, l.join("\n"), k);
}

async function ecranDerniersMessages(ctx: Ctx, slug: string | null, dev: string | null) {
  const l = await q(`SELECT u.time, u.f_port, u.f_cnt, u.rssi, u.snr, u.gateways, u.decoded, d.name FROM public.uplinks u
                     LEFT JOIN app.devices d ON d.dev_eui = u.dev_eui
                     WHERE ${dev ? "u.dev_eui = $1" : "u.tenant = $1 AND u.dev_eui IS NOT NULL"} ORDER BY u.time DESC LIMIT 10`, [dev || slug]);
  const titre = dev ? `${echapper(l[0]?.name || court(dev))} · derniers messages` : f(T.derniers_messages_titre, { ferme: echapper((await lireFerme(slug!)).display_name) });
  const txt = [titre];
  for (const x of l) {
    const gw = (x.gateways || [])[0]?.id || "";
    const radio = x.rssi !== null ? ` · ${x.rssi} dBm / ${nombre(x.snr, 1)} · ${echapper(gw)}` : "";
    txt.push(`${heure(x.time)} ${echapper(x.name || "?")} · port ${x.f_port}${x.f_port === 5 ? " (identité)" : ""}${radio}`);
  }
  if (!l.length) txt.push("—");
  await ecran(ctx, txt.join("\n"), clavier([{ text: C.retour, callback_data: dev ? `a:dev:${dev}` : `a:cli:${slug}:c` }]));
}

async function ecranPersonnes(ctx: Ctx, slug: string) {
  const t = await lireFerme(slug);
  const l = await q(`SELECT p.id, p.display_name, p.grafana_login, m.role, m.receives_alerts, m.grafana_role, m.status,
                     (SELECT count(*) FROM app.memberships m2 WHERE m2.person_id = p.id AND m2.role = 'conseiller')::int AS fermes
                     FROM app.memberships m JOIN app.people p ON p.id = m.person_id WHERE m.tenant_slug = $1 ORDER BY m.role, p.display_name`, [slug]);
  const txt = [f(T.personnes_titre, { ferme: echapper(t.display_name), n: l.length })];
  for (const p of l) {
    const g = p.grafana_role === "Admin" ? "Grafana admin" : p.grafana_role === "Editor" ? "Grafana modification" : p.grafana_role ? "Grafana lecture" : "sans Grafana";
    txt.push(`${echapper(p.display_name)} · ${ROLE[p.role]}${p.role === "conseiller" ? ` (${p.fermes} fermes)` : ""}${p.status !== "actif" ? " · en attente d'accord" : ""} · ${p.receives_alerts ? "🔔" : "🔕"} · ${g}`);
  }
  const inv = await un(`SELECT count(*)::int AS n FROM app.invitations WHERE tenant_slug = $1 AND kind = 'join' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [slug]);
  if (inv.n) txt.push(`Lien en attente : ${inv.n}`);
  const k = clavier(l.map(p => ({ text: p.display_name.slice(0, 30), callback_data: `a:per:${slug}:${p.id}` })));
  k.row().text("Ajouter une personne", `a:cli:${slug}:pa`).text(C.retour, `a:cli:${slug}`);
  await ecran(ctx, txt.join("\n"), k);
}

async function ecranPersonne(ctx: Ctx, slug: string, id: number, action?: string) {
  const p = await un(`SELECT p.*, m.role, m.receives_alerts, m.grafana_role, m.granted_at FROM app.people p JOIN app.memberships m ON m.person_id = p.id
                      WHERE p.id = $1 AND m.tenant_slug = $2`, [id, slug]);
  if (!p) { await ecranPersonnes(ctx, slug); return; }
  const t = await lireFerme(slug);
  if (action === "al") {
    await q(`UPDATE app.memberships SET receives_alerts = NOT receives_alerts WHERE person_id = $1 AND tenant_slug = $2`, [id, slug]);
    return ecranPersonne(ctx, slug, id);
  }
  if (action === "mdp") {
    const m = await dire(ctx, TC.graphiques_en_cours);
    await creerJob(db(), { kind: "mdp_grafana", params: { person_id: id, tenant: slug, afficher_admin: !p.telegram_user_id, par_admin: Boolean(p.telegram_user_id),
      admin_chat: ctx.chat!.id, admin_message: m.message_id }, requested_by: ctx.personne!.id, chat_id: ctx.chat!.id, message_id: m.message_id });
    return;
  }
  if (action === "r" || action === "r!") {
    if (action === "r") {
      await ecran(ctx, `Retirer ${echapper(p.display_name)} de ${echapper(t.display_name)} ?`, clavier([{ text: TC.bouton_retirer, callback_data: `a:per:${slug}:${id}:r!` }, { text: C.annuler, callback_data: `a:per:${slug}:${id}` }]));
      return;
    }
    const { retirerAcces } = await import("./client.js");
    const ok = await retirerAcces(ctx, slug, id, ctx.personne!.id, "admin");
    if (ok) await envoyerAuxMembres(ctx.s, slug, f(TC.mobilab_retire, { nom: echapper(p.display_name) }));
    await ecran(ctx, ok ? f(TC.retire_ok, { nom: echapper(p.display_name) }) : TC.dernier_proprietaire, clavier([{ text: C.retour, callback_data: `a:cli:${slug}:p` }]));
    return;
  }
  if (action?.startsWith("role")) {
    const [, role, g] = action.split("-");
    if (role && ["proprietaire", "membre", "conseiller"].includes(role)) {
      const grafana = role === "proprietaire" ? "Admin" : g === "e" ? "Editor" : "Viewer";
      const ok = await tx(async c => {
        if (p.role === "proprietaire" && role !== "proprietaire") {
          const n = (await c.query(`SELECT count(*)::int AS n FROM app.memberships WHERE tenant_slug = $1 AND role = 'proprietaire' AND status = 'actif'`, [slug])).rows[0].n;
          if (n <= 1 && t.status !== "en_attente_activation") return false;
        }
        await c.query(`UPDATE app.memberships SET role = $3, grafana_role = $4 WHERE person_id = $1 AND tenant_slug = $2`, [id, slug, role, grafana]);
        await creerJob(c, { kind: "grafana_personne", tenant: slug, params: { person_id: id }, requested_by: ctx.personne!.id });
        await audit(c, { acteur: ctx.personne!.id, via: "admin", tenant: slug, action: "rôle", details: { person_id: id, role, grafana } });
        return true;
      });
      if (!ok) { await ctx.answerCallbackQuery({ text: TC.dernier_proprietaire }).catch(() => undefined); }
      return ecranPersonne(ctx, slug, id);
    }
    await ecran(ctx, "Rôle ?", clavier([{ text: "Propriétaire", callback_data: `a:per:${slug}:${id}:role-proprietaire` },
      { text: "Collègue · lecture", callback_data: `a:per:${slug}:${id}:role-membre-v` }, { text: "Collègue · modification", callback_data: `a:per:${slug}:${id}:role-membre-e` },
      { text: "Conseiller · lecture", callback_data: `a:per:${slug}:${id}:role-conseiller-v` }, { text: "Conseiller · modification", callback_data: `a:per:${slug}:${id}:role-conseiller-e` },
      { text: C.retour, callback_data: `a:per:${slug}:${id}` }]));
    return;
  }
  const autres = await q(`SELECT t.display_name FROM app.memberships m JOIN app.tenants t ON t.slug = m.tenant_slug WHERE m.person_id = $1 AND m.tenant_slug <> $2`, [id, slug]);
  const txt = [`${echapper(p.display_name)} · ${ROLE[p.role]} chez ${echapper(t.display_name)}`,
    `Telegram ${p.telegram_user_id ? "✅" : "—"} · Grafana : ${echapper(p.grafana_login || "—")} (${p.grafana_role || "—"}) · depuis le ${jour(p.granted_at)}`];
  if (autres.length) txt.push(`Suit aussi : ${autres.map(a => echapper(a.display_name)).join(", ")}`);
  await ecran(ctx, txt.join("\n"), clavier([{ text: "Rôle", callback_data: `a:per:${slug}:${id}:role` },
    { text: `Alertes ${p.receives_alerts ? "oui" : "non"}`, callback_data: `a:per:${slug}:${id}:al` },
    { text: T.bouton_mdp_grafana, callback_data: `a:per:${slug}:${id}:mdp` }, { text: "Retirer de cette ferme", callback_data: `a:per:${slug}:${id}:r` },
    { text: C.retour, callback_data: `a:cli:${slug}:p` }]));
}

async function ecranAlertesClient(ctx: Ctx, slug: string, historique = false) {
  const t = await lireFerme(slug);
  if (historique) {
    const l = await q(`SELECT n.created_at, n.transition, n.statut, n.destinataires, d.name FROM app.notifications n LEFT JOIN app.devices d ON d.dev_eui = n.dev_eui
                       WHERE n.tenant_slug = $1 AND n.audience = 'client' ORDER BY n.id DESC LIMIT 20`, [slug]);
    const txt = [`${echapper(t.display_name)} · historique des alertes`];
    for (const n of l) {
      const dest = (n.destinataires || []).map((x: any) => (x.resultat === "ok" ? "✅ reçu" : `❌ ${x.resultat}`)).join(", ") || n.statut.replace("_", " ");
      txt.push(`${jourHeure(n.created_at)} ${echapper(n.name || "?")} · ${n.transition} · ${echapper(dest)}`);
    }
    await ecran(ctx, txt.join("\n"), clavier([{ text: C.retour, callback_data: `a:cli:${slug}:al` }]));
    return;
  }
  const enCours = await q(`SELECT d.name, r.kind, r.metric, r.min, r.max, s.since FROM app.alert_state s JOIN app.alert_rules r ON r.id = s.rule_id
                           JOIN app.devices d ON d.dev_eui = r.dev_eui WHERE d.tenant_slug = $1 AND s.state = 'alarm' AND d.ttn_status <> 'supprime'`, [slug]);
  const rs = await un(`SELECT count(*) FILTER (WHERE r.kind = 'silence')::int AS silence, count(*) FILTER (WHERE r.kind = 'battery')::int AS pile,
                       count(*) FILTER (WHERE r.kind = 'threshold')::int AS seuils, count(*) FILTER (WHERE r.kind = 'state')::int AS etat
                       FROM app.alert_rules r JOIN app.devices d ON d.dev_eui = r.dev_eui WHERE d.tenant_slug = $1 AND d.ttn_status <> 'supprime'`, [slug]);
  const env = await un(`SELECT count(*) FILTER (WHERE statut = 'envoye')::int AS ok, count(*) FILTER (WHERE statut IN ('echec', 'sans_destinataire'))::int AS ko
                        FROM app.notifications WHERE tenant_slug = $1 AND audience = 'client' AND created_at > now() - interval '7 days'`, [slug]);
  const txt = [f(T.alertes_client_titre, { ferme: echapper(t.display_name) }),
    `En cours : ${enCours.length ? enCours.map(e => `${echapper(e.name)} ${e.kind === "silence" ? "muet" : e.kind === "battery" ? "pile" : e.metric} depuis ${depuis(e.since)}`).join(" · ") : "aucune"}`,
    `Règles : ${rs.silence} pas de nouvelles · ${rs.pile} pile · ${rs.seuils} seuils · ${rs.etat} état`,
    `Envoyées sur 7 j : ${env.ok} · non livrées : ${env.ko}`];
  await ecran(ctx, txt.join("\n"), clavier([{ text: "Historique", callback_data: `a:cli:${slug}:h` }, { text: C.retour, callback_data: `a:cli:${slug}` }]));
}

async function ecranPlus(ctx: Ctx, slug: string) {
  const t = await lireFerme(slug);
  const mesures = await un(`SELECT 1 FROM public.measures WHERE tenant = $1 LIMIT 1`, [slug]);
  const suspendu = t.status === "suspendu" || t.status === "suppression";
  const k = clavier([
    !suspendu && { text: T.bouton_lien_activation, callback_data: `a:cli:${slug}:la` },
    !suspendu && { text: T.bouton_groupe_alertes, callback_data: `a:cli:${slug}:ga` },
    { text: T.bouton_mdp_grafana, callback_data: `a:cli:${slug}:pw` }, { text: T.bouton_renommer, callback_data: `a:cli:${slug}:rn` },
    { text: T.bouton_journal, callback_data: `a:cli:${slug}:j` },
    suspendu ? { text: T.bouton_reactiver, callback_data: `a:cli:${slug}:re` } : mesures ? { text: T.bouton_suspendre, callback_data: `a:cli:${slug}:su` } : null,
    (!mesures || t.status === "suspendu") && { text: T.bouton_supprimer, callback_data: `a:cli:${slug}:dl` },
    { text: C.retour, callback_data: `a:cli:${slug}` },
  ]);
  await ecran(ctx, f(T.plus_titre, { ferme: echapper(t.display_name) }), k);
}

async function actionClient(ctx: Ctx, slug: string, ecr: string, extra: string[]) {
  if (!SLUG.test(slug)) return;
  const t = await lireFerme(slug);
  if (!t) return;
  const s = ctx.s;
  const p = ctx.personne!;
  switch (ecr) {
    case "c": return ecranCapteursClient(ctx, slug);
    case "m": return ecranDerniersMessages(ctx, slug, null);
    case "p": return ecranPersonnes(ctx, slug);
    case "al": return ecranAlertesClient(ctx, slug);
    case "h": return ecranAlertesClient(ctx, slug, true);
    case "pl": return ecranPlus(ctx, slug);
    case "aj": return lancerAjoutPour(ctx, slug);
    case "pa": {
      await ecran(ctx, "Rôle ?", clavier([{ text: "Collègue", callback_data: `a:cli:${slug}:pam` }, { text: "Conseiller", callback_data: `a:cli:${slug}:pac` }]));
      return;
    }
    case "pam": {
      const l = await creerLien(db(), "join", { tenant: slug, par: p.id, payload: { role: "membre", grafana_role: "Viewer" } });
      const lien = lienBot(s, "client", l.parametre);
      await dire(ctx, `Lien pour un collègue de ${echapper(t.display_name)} (7 j) :\n${lien}`);
      await ctx.replyWithPhoto(new InputFile(await qrPng(lien), "qr.png"));
      return;
    }
    case "pac": {
      demarrer(ctx, "conseiller", "nom", "/clients", { slug });
      await dire(ctx, "Quel conseiller ? (nom et organisme, ex. Paul Martin, Chambre d'agriculture)", { reply_markup: clavierAnnuler(C.annuler) });
      return;
    }
    case "fix": {
      await creerJob(db(), { kind: "verifier_ferme", tenant: slug, requested_by: p.id });
      await ctx.answerCallbackQuery({ text: "⏳ Contrôle et réparation lancés." }).catch(() => undefined);
      return ecranPlus(ctx, slug);
    }
    case "la": {
      const proprio = await un(`SELECT p.* FROM app.memberships m JOIN app.people p ON p.id = m.person_id WHERE m.tenant_slug = $1 AND m.role = 'proprietaire' ORDER BY m.granted_at LIMIT 1`, [slug]);
      if (proprio?.telegram_user_id && extra[0] !== "ok") {
        await ecran(ctx, f(T.deja_proprietaire, { nom: echapper(proprio.display_name) }), clavier([{ text: T.bouton_creer_lien, callback_data: `a:cli:${slug}:la:ok` }, { text: C.annuler, callback_data: `a:cli:${slug}:pl` }]));
        return;
      }
      const l = await creerLien(db(), "activation", { tenant: slug, par: p.id, payload: proprio?.telegram_user_id ? {} : { person_id: proprio?.id } });
      const lien = lienBot(s, "client", l.parametre);
      await dire(ctx, f(T.nouveau_lien_activation, { lien }));
      await ctx.replyWithPhoto(new InputFile(await qrPng(lien), "qr.png"));
      await audit(db(), { acteur: p.id, via: "admin", tenant: slug, action: "lien d'activation" });
      return;
    }
    case "ga": {
      const l = await creerLien(db(), "groupe", { tenant: slug, par: p.id, payload: { admin: true } });
      const lien = lienBot(s, "client", l.parametre, true);
      await dire(ctx, f(T.lien_groupe, { lien }));
      await ctx.replyWithPhoto(new InputFile(await qrPng(lien), "qr.png"));
      return;
    }
    case "pw": {
      const l = await q(`SELECT p.id, p.display_name FROM app.memberships m JOIN app.people p ON p.id = m.person_id WHERE m.tenant_slug = $1 AND m.status = 'actif'`, [slug]);
      if (l.length === 1) return ecranPersonne(ctx, slug, l[0].id, "mdp");
      await ecran(ctx, T.laquelle, clavier(l.map(x => ({ text: x.display_name, callback_data: `a:per:${slug}:${x.id}:mdp` }))));
      return;
    }
    case "rn": {
      demarrer(ctx, "renommer_ferme", "nom", "/clients", { slug });
      await dire(ctx, f(T.renommer_ferme, { ferme: echapper(t.display_name) }), { reply_markup: clavierAnnuler(C.annuler) });
      return;
    }
    case "j": {
      const l = await q(`SELECT a.at, a.action, a.via, a.details, p.display_name, d.name FROM app.audit a LEFT JOIN app.people p ON p.id = a.actor_id
                         LEFT JOIN app.devices d ON d.dev_eui = a.dev_eui WHERE a.tenant_slug = $1 ORDER BY a.id DESC LIMIT 15`, [slug]);
      const txt = [f(T.journal_titre, { ferme: echapper(t.display_name) })];
      for (const x of l) txt.push(`${jourHeure(x.at)} ${echapper(x.display_name || "système")}${x.via === "support" ? " (support)" : ""} · ${echapper(x.action)}${x.name ? ` : ${echapper(x.name)}` : ""}`);
      if (!l.length) txt.push(T.journal_vide);
      await ecran(ctx, txt.join("\n"), clavier([{ text: C.retour, callback_data: `a:cli:${slug}:pl` }]));
      return;
    }
    case "su": {
      if (extra[0] !== "ok") {
        await ecran(ctx, f(T.suspendre_question, { ferme: echapper(t.display_name) }), clavier([{ text: T.bouton_suspendre, callback_data: `a:cli:${slug}:su:ok` }, { text: C.annuler, callback_data: `a:cli:${slug}:pl` }]));
        return;
      }
      const m = await dire(ctx, "⏳");
      await creerJob(db(), { kind: "suspendre_client", tenant: slug, requested_by: p.id, chat_id: ctx.chat!.id, message_id: m.message_id });
      await audit(db(), { acteur: p.id, via: "admin", tenant: slug, action: "suspension" });
      return;
    }
    case "re": {
      const m = await dire(ctx, "⏳");
      await creerJob(db(), { kind: "reactiver_client", tenant: slug, requested_by: p.id, chat_id: ctx.chat!.id, message_id: m.message_id });
      await audit(db(), { acteur: p.id, via: "admin", tenant: slug, action: "réactivation" });
      return;
    }
    case "dl": {
      const mesures = await un(`SELECT 1 FROM public.measures WHERE tenant = $1 LIMIT 1`, [slug]);
      if (!mesures) {
        if (extra[0] !== "ok") {
          await ecran(ctx, f(T.supprimer_essai_question, { ferme: echapper(t.display_name) }), clavier([{ text: T.bouton_supprimer, callback_data: `a:cli:${slug}:dl:ok` }, { text: C.annuler, callback_data: `a:cli:${slug}:pl` }]));
          return;
        }
        if (tropAncien(ctx, 5)) { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
        const m = await dire(ctx, "⏳");
        await creerJob(db(), { kind: "purger_client", tenant: slug, requested_by: p.id, chat_id: ctx.chat!.id, message_id: m.message_id });
        return;
      }
      if (t.status !== "suspendu") { await ecran(ctx, T.suspendre_avant, clavier([{ text: C.retour, callback_data: `a:cli:${slug}:pl` }])); return; }
      if (extra[0] === "x") {
        await exporterMesures(ctx, slug);
        return;
      }
      demarrer(ctx, "supprimer_ferme", "nom", "/clients", { slug });
      await dire(ctx, f(T.supprimer_ferme_question, { ferme: echapper(t.display_name), date: jour(new Date(Date.now() + 30 * 86400000)) }),
        { reply_markup: clavier([{ text: T.bouton_exporter, callback_data: `a:cli:${slug}:dl:x` }]) });
      return;
    }
    default:
      return ecranClient(ctx, slug);
  }
}

async function exporterMesures(ctx: Ctx, slug: string) {
  const l = await q(`SELECT m.time, d.name, m.dev_eui, m.metric, m.value FROM public.measures m LEFT JOIN app.devices d ON d.dev_eui = m.dev_eui
                     WHERE m.tenant = $1 ORDER BY m.time LIMIT 2000000`, [slug]);
  const csv = ["time;capteur;dev_eui;mesure;valeur", ...l.map(x => `${new Date(x.time).toISOString()};${String(x.name || "").replace(/;/g, ",")};${x.dev_eui};${x.metric};${x.value}`)].join("\n");
  const { gzipSync } = await import("node:zlib");
  await envoyerDocument(ctx.s, "admin", ctx.chat!.id, gzipSync(Buffer.from(csv, "utf8")), `mesures-${slug}.csv.gz`);
}

// ===================================================================== fiche capteur admin (§5.7)

async function ecranCapteurAdmin(ctx: Ctx, dev: string, ecr?: string, extra: string[] = []) {
  if (!DEVEUI.test(dev)) return;
  const d = await lireCapteur(dev);
  if (!d) { await ecran(ctx, TC.capteur_disparu); return; }
  const m = modeleDe(d.model_key);
  const s = ctx.s;
  const app = await appDe(db(), d.tenant_slug);
  switch (ecr) {
    case "m": return ecranDerniersMessages(ctx, null, dev);
    case "d": {
      const res: string[] = [];
      for (const [nom, srv] of [["Identity Server", "is"], ["Join Server", "js"], ["Network Server", "ns"], ["Application Server", "as"]] as const) {
        try { const r = await s.ttn.lireDevice(srv, app, idTtn(d)); res.push(`${nom} ${r ? "✅" : "❌"}`); } catch (e: any) { res.push(`${nom} ❌ (${e.code || "?"})`); }
      }
      const w = await s.ttn.lireWebhook(app).catch(() => null);
      const txt = [res.join(" · "), `Dernière connexion : ${d.config?.detected?.joined_at ? jourHeure(d.config.detected.joined_at) : "—"} · Webhook de la ferme ${w && !w.health_status?.unhealthy ? "✅" : "❌"}`];
      const k = clavier([res.some(r => r.includes("❌")) && { text: "Réenregistrer", callback_data: `a:dev:${dev}:k` }, { text: C.retour, callback_data: `a:dev:${dev}` }]);
      await ecran(ctx, txt.join("\n"), k);
      return;
    }
    case "k": {
      demarrer(ctx, "corriger", "appeui", "/clients", { ferme: d.tenant_slug, nom: d.name, dev_eui_origine: dev.toUpperCase(), admin: true });
      await dire(ctx, TC.corriger_codes_question, { reply_markup: clavierAnnuler(C.annuler) });
      return;
    }
    case "t": {
      const mode = d.mode_override ? `${d.mode_override} (forcé)` : `automatique (lu : ${d.config?.detected?.mode_lu ?? "—"})`;
      const rs = await regles(dev);
      const silence = rs.find(r => r.kind === "silence");
      const txt = [`${echapper(d.name)} · réglages techniques`, `Modèle : ${echapper(m?.libelle || "—")} (${echapper(d.config?.model_source || d.config?.detected?.modele_par || "—")})`,
        `Mode : ${echapper(mode)}`, `Sondes : ${echapper(Object.entries(d.probes || {}).map(([v, p]: any) => `${v} ${p.sonde}`).join(", ") || "—")}`,
        `Alertes intégrées : ${silence?.enabled === false ? "désactivées" : "actives"} · pas de nouvelles après ${silence?.params?.delai_min ? duree(silence.params.delai_min * 60000) : "auto"}`];
      await ecran(ctx, txt.join("\n"), clavier([{ text: "Modèle", callback_data: `a:dev:${dev}:mod` }, { text: "Mode", callback_data: `a:dev:${dev}:mo` },
        { text: "Sondes", callback_data: `a:dev:${dev}:so` }, { text: "Alertes intégrées", callback_data: `a:dev:${dev}:ai` },
        { text: T.bouton_redecoder, callback_data: `a:dev:${dev}:rd` }, { text: C.retour, callback_data: `a:dev:${dev}` }]));
      return;
    }
    case "mod": {
      const l = [...catalogue().modeles.values()].sort((a, b) => a.libelle.localeCompare(b.libelle, "fr"));
      if (extra[0] !== undefined) {
        const choix = l[Number(extra[0])];
        if (!choix) return;
        await tx(async c => {
          await c.query(`UPDATE app.devices SET model_key = $2, config = config || '{"model_source":"admin"}' WHERE dev_eui = $1`, [dev, choix.cle]);
          await creerJob(c, { kind: "mise_en_service", tenant: d.tenant_slug, dev_eui: dev, requested_by: ctx.personne!.id });
          await c.query(`UPDATE app.anomalies SET resolved_at = now(), resolved_by = $2 WHERE dev_eui = $1 AND raison = 'modele_inconnu' AND resolved_at IS NULL`, [dev, ctx.personne!.id]);
          await audit(c, { acteur: ctx.personne!.id, via: "admin", tenant: d.tenant_slug, dev_eui: dev, action: "modèle", details: { model_key: choix.cle } });
        });
        await ecran(ctx, f(T.modele_choisi, { modele: echapper(choix.libelle) }), clavier([{ text: T.bouton_redecoder, callback_data: `a:dev:${dev}:rd` }, { text: C.retour, callback_data: `a:dev:${dev}:t` }]));
        return;
      }
      await ecran(ctx, T.choisir_modele, clavier(l.map((x, i) => ({ text: `${x.cle === d.model_key ? "✅ " : ""}${boutonModele(x)}`, callback_data: `a:dev:${dev}:mod:${i}` })), 1));
      return;
    }
    case "mo": {
      const modes = modesDe(m);
      if (extra[0] !== undefined) {
        const choix = extra[0] === "a" ? null : modes[Number(extra[0])]?.code ?? null;
        await q(`UPDATE app.devices SET mode_override = $2 WHERE dev_eui = $1`, [dev, choix]);
        await creerJob(db(), { kind: "mise_en_service", tenant: d.tenant_slug, dev_eui: dev, requested_by: ctx.personne!.id });
        await ecran(ctx, choix ? f(TC.mode_force_ok, { mode: echapper(choix) }) : TC.mode_auto_ok, clavier([{ text: T.bouton_redecoder, callback_data: `a:dev:${dev}:rd` }, { text: C.retour, callback_data: `a:dev:${dev}:t` }]));
        return;
      }
      await ecran(ctx, "Mode ?", clavier([{ text: "Automatique", callback_data: `a:dev:${dev}:mo:a` }, ...modes.map((x, i) => ({ text: `${x.code} · ${x.libelle}`, callback_data: `a:dev:${dev}:mo:${i}` }))]));
      return;
    }
    case "so": {
      const id = await questionSonde(s, "admin", ctx.chat!.id, { ...d, probes: {} }, 0, false);
      if (!id) await ecran(ctx, "Ce mode n'a pas d'entrée.", clavier([{ text: C.retour, callback_data: `a:dev:${dev}:t` }]));
      return;
    }
    case "ai": {
      if (extra[0] === "off" || extra[0] === "on") {
        await q(`UPDATE app.alert_rules SET enabled = $2 WHERE dev_eui = $1 AND kind IN ('silence', 'battery', 'state')`, [dev, extra[0] === "on"]);
      } else if (extra[0]) {
        await q(`UPDATE app.alert_rules SET params = params || jsonb_build_object('delai_min', $2::int) WHERE dev_eui = $1 AND kind = 'silence'`, [dev, Number(extra[0]) * 60]);
      }
      if (extra[0]) return ecranCapteurAdmin(ctx, dev, "t");
      const rs = await regles(dev);
      const actives = rs.find(r => r.kind === "silence")?.enabled !== false;
      await ecran(ctx, "Pas de nouvelles après ?", clavier([{ text: "3 h", callback_data: `a:dev:${dev}:ai:3` }, { text: "12 h", callback_data: `a:dev:${dev}:ai:12` },
        { text: "24 h", callback_data: `a:dev:${dev}:ai:24` }, { text: actives ? "Désactiver" : "Réactiver", callback_data: `a:dev:${dev}:ai:${actives ? "off" : "on"}` },
        { text: C.retour, callback_data: `a:dev:${dev}:t` }]));
      return;
    }
    case "rd": {
      try {
        await redecoder(s, dev, new Date(Date.now() - 7 * 86400000));
        await ecran(ctx, T.redecodage_lance, clavier([{ text: C.retour, callback_data: `a:dev:${dev}` }]));
      } catch (e: any) { await ecran(ctx, `❌ ${echapper(e.message)}`); }
      return;
    }
    case "pl": {
      await ecran(ctx, `${echapper(d.name)} · autres actions`, clavier([{ text: TC.bouton_renommer, callback_data: `a:dev:${dev}:rn` },
        (m?.actions?.length || d.config?.actions?.length) && { text: T.bouton_commandes, callback_data: `a:dev:${dev}:co` },
        { text: TC.bouton_supprimer, callback_data: `a:dev:${dev}:dl` }, { text: C.retour, callback_data: `a:dev:${dev}` }]));
      return;
    }
    case "rn": {
      demarrer(ctx, "renommer", "nom", "/clients", { dev });
      await dire(ctx, f(TC.renommer_question, { capteur: echapper(d.name) }), { reply_markup: clavierAnnuler(C.annuler) });
      return;
    }
    case "co": {
      const l = await q(`SELECT c.*, p.display_name FROM app.commands c LEFT JOIN app.people p ON p.id = c.requested_by WHERE c.dev_eui = $1 ORDER BY c.id DESC LIMIT 10`, [dev]);
      const txt = [`Ordres · ${echapper(d.name)}`, ...l.map(c => `${jourHeure(c.requested_at)} · ${echapper(c.action)} · ${echapper(c.display_name || "?")} · ${c.status}`)];
      const enCours = l.find(c => ["demandee", "envoyee"].includes(c.status));
      await ecran(ctx, txt.join("\n"), clavier([enCours && { text: "Annuler l'ordre en file", callback_data: `a:cmd:x:${enCours.id}` }, { text: C.retour, callback_data: `a:dev:${dev}` }]));
      return;
    }
    case "dl": {
      if (extra[0] !== "ok") {
        await ecran(ctx, f(T.supprimer_capteur_question, { capteur: echapper(d.name) }), clavier([{ text: TC.bouton_supprimer, callback_data: `a:dev:${dev}:dl:ok` }, { text: C.annuler, callback_data: `a:dev:${dev}` }]));
        return;
      }
      await tx(async c => {
        await c.query(`UPDATE app.devices SET ttn_status = 'supprime' WHERE dev_eui = $1`, [dev]);
        await creerJob(c, { kind: "supprimer_capteur", tenant: d.tenant_slug, dev_eui: dev, requested_by: ctx.personne!.id, params: { via: "admin" } });
      });
      await envoyerAuxMembres(s, d.tenant_slug, f(TC.mobilab_supprime, { capteur: echapper(d.name) }));
      await ecran(ctx, f(T.capteur_supprime, { capteur: echapper(d.name) }));
      return;
    }
    default: {
      const det = d.config?.detected || {};
      const rs = await regles(dev);
      const etat = !d.last_seen ? "⏳" : rs.some(r => r.state === "alarm") ? "⚠️" : "✅";
      const reglesTxt = rs.filter(r => r.enabled).map(r => {
        const def = definition(m, r.metric);
        const nom = r.kind === "silence" ? "pas de nouvelles" : r.kind === "battery" ? "pile" : r.kind === "state" ? (def?.libelle || r.metric).toLowerCase()
          : r.min !== null ? `&lt; ${avecUnite(r.min, def)}` : `&gt; ${avecUnite(r.max, def)}`;
        return `${nom} ${r.state === "alarm" ? "⚠️" : "✅"}`;
      }).join(" · ");
      const txt = [f(T.fiche_capteur_titre, { etat, capteur: echapper(d.name), ferme: echapper(d.ferme) }),
        f(T.fiche_capteur_codes, { deveui: groupes(dev), appeui: groupes(d.join_eui || ""), hint: echapper(d.config?.appkey_hint || "?") }),
        f(T.fiche_capteur_modele, { modele: echapper(m?.libelle || "modèle ?"), firmware: echapper(det.firmware || "?"), mode: echapper(d.mode_override ? `${d.mode_override} (forcé)` : det.mode_lu ? `auto (${det.mode_lu})` : "auto") }),
        f(T.fiche_capteur_ttn, { statut: `${d.ttn_status}${det.joined_at ? ` le ${jourHeure(det.joined_at)}` : ""}` })];
      if (d.last_seen) txt.push(f(T.fiche_capteur_dernier, { age: `il y a ${depuis(d.last_seen)}`, rssi: d.last_rssi ?? "?", snr: nombre(d.last_snr, 1) }));
      if (d.last_values?.resume) txt.push(`${echapper(d.last_values.resume)}${d.battery_mv ? ` · ${pileFaible(m, d.battery_mv) ? "🪫" : "🔋"} ${pourcentagePile(m, d.battery_mv) ?? "?"} % (${nombre(d.battery_mv / 1000, 2)} V)` : ""}`);
      if (reglesTxt) txt.push(`🔔 ${reglesTxt}`);
      await ecran(ctx, txt.join("\n"), clavier([{ text: T.bouton_derniers_messages, callback_data: `a:dev:${dev}:m` }, { text: T.bouton_diagnostic, callback_data: `a:dev:${dev}:d` },
        { text: T.bouton_reglages_tech, callback_data: `a:dev:${dev}:t` }, { text: T.bouton_corriger_codes, callback_data: `a:dev:${dev}:k` },
        { text: C.plus, callback_data: `a:dev:${dev}:pl` }, { text: C.retour, callback_data: `a:cli:${d.tenant_slug}:c` }]));
    }
  }
}

// ===================================================================== /creer_client (§5.4)

async function etapeCreerClient(ctx: Ctx, texte: string) {
  const conv = ctx.session.conv!;
  const dn = conv.donnees;
  if (conv.etape === "nom") {
    const lignesTxt = texte.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lignesTxt.length > 1) {
      const fermes = lignesTxt.map(l => { const [nom, email] = l.split(/\s*;\s*/); return { nom: nom.slice(0, 60), email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.toLowerCase() : null }; })
        .filter(x => x.nom.length >= 2);
      dn.lot = fermes;
      conv.etape = "confirmer_lot";
      await dire(ctx, f(T.fermes_lues, { n: fermes.length }), { reply_markup: clavier([{ text: f(T.bouton_creer_n, { n: fermes.length }), callback_data: "a:cc:lot" }, { text: C.annuler, callback_data: "a:cc:x" }]) });
      return;
    }
    const nom = texte.trim();
    if (nom.length < 2 || nom.length > 60) { await dire(ctx, T.nom_ferme_invalide); return; }
    dn.nom = nom;
    const existe = await un(`SELECT slug FROM app.tenants WHERE lower(display_name) = lower($1) AND status <> 'supprime'`, [nom]);
    if (existe && !dn.forcer) {
      await dire(ctx, f(T.ferme_existe, { ferme: echapper(nom) }), { reply_markup: clavier([{ text: T.bouton_creer_quand_meme, callback_data: "a:cc:force" }, { text: T.bouton_voir_fiche, callback_data: `a:cli:${existe.slug}` }]) });
      return;
    }
    conv.etape = "email";
    await dire(ctx, T.q_email, { reply_markup: clavier([{ text: C.passer, callback_data: "a:cc:passer" }]) });
    return;
  }
  if (conv.etape === "email") {
    const e = texte.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { await dire(ctx, T.email_invalide); return; }
    dn.email = e;
    conv.etape = "capteurs";
    await dire(ctx, T.q_capteurs, { reply_markup: clavier([{ text: T.bouton_plus_tard, callback_data: "a:cc:fin" }]) });
    return;
  }
  if (conv.etape === "capteurs") {
    if (ressembleAUneListe(texte)) {
      const l = lireListe(texte);
      const bons = l.filter(x => !x.erreurs.length);
      dn.capteurs = [...(dn.capteurs || []), ...bons.map(x => ({ nom: x.nom, appeui: x.appeui, deveui: x.deveui, modele: x.modele || null,
        appkey: chiffrer(ctx.s.cfg.secretsKey!, x.appkey!).toString("base64") }))];
      const err = l.filter(x => x.erreurs.length).map(x => f(T.liste_ligne_erreur, { ligne: x.ligne, nom: echapper(x.nom), erreur: echapper(x.erreurs.join(", ")) }));
      await dire(ctx, [f(T.liste_lue, { n: l.length }), ...err].join("\n"));
      return confirmerCreation(ctx);
    }
    dn.capteur_courant = { nom: texte.trim().slice(0, 40) };
    conv.etape = "c_codes";
    await dire(ctx, TC.q_appeui);
    return;
  }
  if (conv.etape === "c_codes") {
    const cc = dn.capteur_courant;
    const r = rangerCodes(texte);
    if (r.appkey) cc.appkey = chiffrer(ctx.s.cfg.secretsKey!, r.appkey).toString("base64");
    if (r.appeui && !cc.appeui) cc.appeui = r.appeui;
    if (r.deveui && !cc.deveui) cc.deveui = r.deveui;
    else if (r.appeui && cc.appeui && cc.appeui !== r.appeui && !cc.deveui && !r.deveui && cc.appkey && Object.keys(r).length === 1) cc.deveui = r.appeui;
    if (!cc.appeui) { await dire(ctx, TC.err_16_appeui); return; }
    if (!cc.appkey) { await dire(ctx, TC.q_appkey); return; }
    if (!cc.deveui) { await dire(ctx, TC.q_deveui); return; }
    dn.capteurs = [...(dn.capteurs || []), cc];
    delete dn.capteur_courant;
    conv.etape = "capteurs";
    await dire(ctx, f(T.capteur_note, { capteur: echapper(cc.nom), n: dn.capteurs.length }), { reply_markup: clavier([{ text: C.oui, callback_data: "a:cc:autre" }, { text: T.bouton_c_est_tout, callback_data: "a:cc:fin" }]) });
  }
}

async function confirmerCreation(ctx: Ctx) {
  const conv = ctx.session.conv!;
  const dn = conv.donnees;
  conv.etape = "confirmer";
  const login = dn.email || "(le code de la ferme)";
  await dire(ctx, f(T.confirmer_creation, { ferme: echapper(dn.nom), n: (dn.capteurs || []).length, login: echapper(login) }),
    { reply_markup: clavier([{ text: T.bouton_creer, callback_data: "a:cc:ok" }, { text: C.annuler, callback_data: "a:cc:x" }]) });
}

/** Crée la personne prévue et le job creer_client, dans une transaction (spec §6.2, « À la création du job »). */
async function lancerCreation(ctx: Ctx, nom: string, email: string | null, capteurs: any[], o: { chat?: number; message?: number; lot?: string } = {}) {
  return tx(async c => {
    const slug = (await c.query(`SELECT 'f' || lpad(n::text, greatest(4, length(n::text)), '0') AS slug FROM nextval('app.tenant_slug_seq') AS n`)).rows[0].slug;
    let personId: number;
    const connu = email ? (await c.query(`SELECT id FROM app.people WHERE grafana_login = $1`, [email])).rows[0] : null;
    if (connu) personId = connu.id;
    else {
      const r = await c.query(`INSERT INTO app.people (display_name, source, grafana_login) VALUES ($1, 'admin', $2) RETURNING id`, [email || nom, email || slug]);
      personId = Number(r.rows[0].id);
    }
    const cles: Record<string, string> = {};
    for (const cap of capteurs) cles[String(cap.deveui).toUpperCase()] = dechiffrer(ctx.s.cfg.secretsKey!, Buffer.from(cap.appkey, "base64"));
    const id = await creerJob(c, { kind: "creer_client", tenant: slug, requested_by: ctx.personne!.id, chat_id: o.chat ?? null, message_id: o.message ?? null,
      params: { nom, email, person_id: personId, origine: "admin", lot: o.lot ?? null,
        capteurs: capteurs.map(x => ({ nom: x.nom, appeui: String(x.appeui).toLowerCase(), deveui: String(x.deveui).toLowerCase(), modele: x.modele || null })) },
      secret: capteurs.length ? chiffrerSecret(ctx.s, JSON.stringify(cles)) : null });
    return { slug, id };
  });
}

// ===================================================================== /ajouter_pour (§5.8)

async function lancerAjoutPour(ctx: Ctx, slug?: string, recherche?: string) {
  if (!slug && recherche) {
    const l = await chercherClients(recherche);
    if (l.length === 1) slug = l[0].slug;
  }
  if (!slug) {
    const recents = await q(`SELECT DISTINCT ON (a.tenant_slug) a.tenant_slug, t.display_name, a.at FROM app.audit a JOIN app.tenants t ON t.slug = a.tenant_slug
                             WHERE a.actor_id = $1 AND t.status NOT IN ('supprime', 'suppression') ORDER BY a.tenant_slug, a.at DESC`, [ctx.personne!.id]);
    recents.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    demarrer(ctx, "ajouter_pour", "ferme", "/ajouter_pour", {});
    await dire(ctx, T.pour_quel_client, { reply_markup: clavier(recents.slice(0, 3).map(x => ({ text: x.display_name, callback_data: `a:ap:${x.tenant_slug}` }))) });
    return;
  }
  const t = await lireFerme(slug);
  demarrer(ctx, "ajouter_pour", "nom", "/ajouter_pour", { ferme: slug });
  await dire(ctx, f(T.nom_capteur_pour, { ferme: echapper(t.display_name) }), { reply_markup: clavierAnnuler(C.annuler) });
}

async function etapeAjoutPour(ctx: Ctx, texte: string) {
  const conv = ctx.session.conv!;
  const dn = conv.donnees;
  if (conv.etape === "ferme") {
    const l = await chercherClients(texte);
    if (l.length === 1) return lancerAjoutPour(ctx, l[0].slug);
    const fermes = await q(`SELECT slug, display_name FROM app.tenants WHERE slug = ANY($1::text[])`, [l.map(x => x.slug)]);
    await dire(ctx, fermes.length ? T.pour_quel_client : T.aucun_client, { reply_markup: clavier(fermes.map(x => ({ text: x.display_name, callback_data: `a:ap:${x.slug}` }))) });
    return;
  }
  if (conv.etape === "nom") {
    if (ressembleAUneListe(texte)) {
      const l = lireListe(texte);
      for (const x of l) {
        if (x.erreurs.length) continue;
        const ailleurs = await un(`SELECT d.name, t.display_name, d.tenant_slug FROM app.devices d JOIN app.tenants t ON t.slug = d.tenant_slug
                                   WHERE d.dev_eui = $1 AND d.ttn_status NOT IN ('supprime', 'echec')`, [x.deveui!.toLowerCase()]);
        if (ailleurs) x.erreurs.push(ailleurs.tenant_slug === dn.ferme ? `déjà ici (${ailleurs.name})` : `DevEUI déjà chez ${ailleurs.display_name}`);
      }
      const bons = l.filter(x => !x.erreurs.length);
      dn.liste = bons.map(x => ({ nom: x.nom, appeui: x.appeui, deveui: x.deveui, modele: x.modele || null, appkey: chiffrer(ctx.s.cfg.secretsKey!, x.appkey!).toString("base64") }));
      conv.etape = "liste";
      const err = l.filter(x => x.erreurs.length).map(x => f(T.liste_ligne_erreur, { ligne: x.ligne, nom: echapper(x.nom), erreur: echapper(x.erreurs.join(", ")) }));
      await dire(ctx, [f(T.liste_lue, { n: l.length }), ...err].join("\n"), { reply_markup: clavier([{ text: f(T.bouton_creer_bons, { n: bons.length }), callback_data: "a:apl:ok" }, { text: T.bouton_recoller, callback_data: "a:apl:re" }]) });
      return;
    }
    const nom = texte.trim();
    if (nom.length < 1 || nom.length > 40) { await dire(ctx, TC.nom_invalide); return; }
    dn.nom = nom;
    conv.etape = "marque";
    await dire(ctx, TC.q_marque, { reply_markup: clavier(marques().map(m => ({ text: m.bouton, callback_data: `a:aj:m:${m.cle}` }))) });
    return;
  }
  if (conv.etape === "marque" || conv.etape === "type") { await dire(ctx, TC.choisir_bouton); return; }
  if (conv.etape === "codes") {
    const r = rangerCodes(texte);
    if (r.appkey) dn.appkey = chiffrer(ctx.s.cfg.secretsKey!, r.appkey).toString("base64");
    if (r.appeui && !dn.appeui) dn.appeui = r.appeui;
    if (r.deveui && !dn.deveui) dn.deveui = r.deveui;
    else if (r.appeui && dn.appeui && r.appeui !== dn.appeui && !dn.deveui) dn.deveui = r.appeui;
    if (!r.appkey && !r.appeui && !r.deveui) {
      const n = nettoyer16(texte);
      await dire(ctx, `Le code fait 16 caractères (0-9, A-F) ou 32 pour l'AppKey. Vous en avez tapé ${n}.`);
      return;
    }
    if (!dn.appeui) { await dire(ctx, TC.q_appeui); return; }
    if (!dn.appkey) { await dire(ctx, TC.q_appkey); return; }
    if (!dn.deveui) { await dire(ctx, TC.q_deveui); return; }
    conv.etape = "relecture";
    const appkey = dechiffrer(ctx.s.cfg.secretsKey!, Buffer.from(dn.appkey, "base64"));
    const m = await dire(ctx, [echapper(dn.nom), f(TC.relecture_type, { type: echapper(libelleType(dn)) }), `AppEUI  <code>${groupes(dn.appeui)}</code>`, `AppKey  <code>${groupes(appkey)}</code>`, `DevEUI  <code>${groupes(dn.deveui)}</code>`, TC.relecture_question].join("\n"),
      { reply_markup: clavier([{ text: TC.bouton_oui_ok, callback_data: "a:apr:ok" }, { text: TC.bouton_corriger, callback_data: "a:apr:fx" }]) });
    dn.relecture = m.message_id;
    if (ctx.message) dn.message_codes = ctx.message.message_id;
  }
}

function nettoyer16(t: string) { return t.replace(/[\s:-]/g, "").length; }

async function validerAjoutPour(ctx: Ctx) {
  const conv = conversation(ctx);
  if (!conv || conv.nom !== "ajouter_pour" || conv.etape !== "relecture") { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
  const dn = conv.donnees;
  finir(ctx);
  await ctx.answerCallbackQuery().catch(() => undefined);
  const appkey = dechiffrer(ctx.s.cfg.secretsKey!, Buffer.from(dn.appkey, "base64"));
  // La saisie de l'AppKey est effacée, la relecture réduite (spec §5.8).
  if (dn.message_codes) await ctx.api.deleteMessage(ctx.chat!.id, dn.message_codes).catch(() => undefined);
  await ctx.editMessageText([echapper(dn.nom), `AppEUI  <code>${groupes(dn.appeui)}</code>`, `AppKey  …${appkey.slice(-4)}`, `DevEUI  <code>${groupes(dn.deveui)}</code>`].join("\n"), { parse_mode: "HTML" }).catch(() => undefined);
  await enregistrerPour(ctx, dn.ferme, { nom: dn.nom, appeui: dn.appeui, deveui: dn.deveui, modele: dn.modele || null, marque: dn.marque_bouton || null }, appkey);
}

async function enregistrerPour(ctx: Ctx, slug: string, cap: { nom: string; appeui: string; deveui: string; modele: string | null; marque?: string | null }, appkey: string) {
  const dev = cap.deveui.toLowerCase();
  const t = await lireFerme(slug);
  const existant = await un(`SELECT d.name, d.tenant_slug, d.ttn_status, t.display_name FROM app.devices d JOIN app.tenants t ON t.slug = d.tenant_slug WHERE d.dev_eui = $1`, [dev]);
  if (existant && !["supprime", "echec"].includes(existant.ttn_status)) {
    if (existant.tenant_slug === slug) { await dire(ctx, f(T.deveui_deja_ici, { ferme: echapper(t.display_name), capteur: echapper(existant.name) }), { reply_markup: sansClavier }); return; }
    await dire(ctx, f(T.deveui_ailleurs, { ferme: echapper(existant.display_name), capteur: echapper(existant.name) }), { reply_markup: sansClavier });
    return;
  }
  await retirerClavier(ctx);
  const m = await dire(ctx, f(TC.enregistre_en_cours, { capteur: echapper(cap.nom) }));
  await creerJob(db(), { kind: "ajouter_capteur", tenant: slug, dev_eui: dev, requested_by: ctx.personne!.id, chat_id: ctx.chat!.id, message_id: m.message_id,
    params: { nom: cap.nom, appeui: cap.appeui.toLowerCase(), modele: cap.modele, marque: cap.marque || null, bot: "admin", via: "admin",
      reprise: Boolean(existant && existant.tenant_slug === slug && existant.ttn_status === "supprime") },
    secret: chiffrerSecret(ctx.s, appkey) });
  await audit(db(), { acteur: ctx.personne!.id, via: "admin", tenant: slug, dev_eui: dev, action: "ajout de capteur demandé", details: { nom: cap.nom } });
}

// ===================================================================== /inconnus (§5.13)

async function ecranInconnus(ctx: Ctx) {
  const l = await q(`SELECT a.*, d.name, t.display_name FROM app.anomalies a LEFT JOIN app.devices d ON d.dev_eui = a.dev_eui
                     LEFT JOIN app.tenants t ON t.slug = a.tenant_slug WHERE a.resolved_at IS NULL ORDER BY a.last_seen DESC LIMIT 16`);
  if (!l.length) { await ecran(ctx, T.inconnus_vide); return; }
  const txt = [f(T.inconnus_titre, { n: l.length })];
  l.forEach((a, i) => {
    let ligne: string;
    if (a.raison === "deveui_inconnu") ligne = f(T.inconnu_deveui, { deveui: groupes(a.dev_eui), app: echapper(a.application_id || "?"), n: a.count });
    else if (a.raison === "modele_inconnu") ligne = f(T.inconnu_modele, { capteur: echapper(a.name || "?"), ferme: echapper(a.display_name || "?"), n: a.count,
      detail: a.details?.port5_code ? ` (port 5 : ${echapper(a.details.port5_code)})` : "" });
    else if (a.raison === "decodage") ligne = f(T.inconnu_decodage, { capteur: echapper(a.name || "?"), ferme: echapper(a.display_name || "?"), n: a.count });
    else ligne = f(T.inconnu_autre, { raison: a.raison.replace(/_/g, " "), objet: echapper(a.name || court(a.dev_eui || "") || a.gateway_id || "?"), n: a.count });
    txt.push(`${i + 1}. ${ligne}`);
  });
  await ecran(ctx, txt.join("\n"), clavier(l.map((a, i) => ({ text: String(i + 1), callback_data: `a:ano:${a.id}:v` })), 4));
}

async function actionInconnu(ctx: Ctx, id: number, action: string, extra: string[]) {
  const a = await un(`SELECT a.*, d.name, t.display_name FROM app.anomalies a LEFT JOIN app.devices d ON d.dev_eui = a.dev_eui
                      LEFT JOIN app.tenants t ON t.slug = a.tenant_slug WHERE a.id = $1`, [id]);
  if (!a) { await ecran(ctx, T.inconnus_vide); return; }
  if (action === "i") {
    await q(`UPDATE app.anomalies SET resolved_at = now(), resolved_by = $2 WHERE id = $1`, [id, ctx.personne!.id]);
    await ecran(ctx, T.ignore_ok, clavier([{ text: C.retour, callback_data: "a:inc" }]));
    return;
  }
  if (action === "m" && a.dev_eui) return ecranCapteurAdmin(ctx, a.dev_eui, "mod", extra);
  if (action === "rd" && a.dev_eui) return ecranCapteurAdmin(ctx, a.dev_eui, "rd");
  if (action === "rt") {
    demarrer(ctx, "rattacher", "ferme", "/inconnus", { anomalie: id, dev: a.dev_eui, app: a.application_id });
    const slug = /^mobilab-(f[0-9]{4,})$/.exec(a.application_id || "")?.[1];
    if (slug) { ctx.session.conv!.donnees.ferme = slug; ctx.session.conv!.etape = "nom"; await dire(ctx, T.rattacher_nom, { reply_markup: clavierAnnuler(C.annuler) }); }
    else await dire(ctx, T.rattacher_ferme, { reply_markup: clavierAnnuler(C.annuler) });
    return;
  }
  if (action === "sup" && a.dev_eui && a.application_id) {
    await ctx.s.ttn.supprimerPartout(a.application_id, a.dev_eui).catch(() => undefined);
    await q(`UPDATE app.anomalies SET resolved_at = now(), resolved_by = $2 WHERE id = $1`, [id, ctx.personne!.id]);
    await ecran(ctx, T.ignore_ok, clavier([{ text: C.retour, callback_data: "a:inc" }]));
    return;
  }
  const trame = (a.trames || []).slice(-1)[0];
  const txt = [`${a.raison.replace(/_/g, " ")} · ${echapper(a.name || groupes(a.dev_eui || "") || a.gateway_id || "?")}${a.display_name ? ` · ${echapper(a.display_name)}` : ""}`,
    `${a.count} fois · première le ${jourHeure(a.first_seen)} · dernière il y a ${depuis(a.last_seen)}`];
  if (a.application_id) txt.push(`App TTN : ${echapper(a.application_id)}`);
  if (trame?.hex) txt.push(`Dernière trame : port ${trame.f_port} · <code>${echapper(trame.hex)}</code>`);
  if (a.details?.erreur) txt.push(`Erreur : ${echapper(a.details.erreur)}`);
  const b = [];
  if (a.raison === "deveui_inconnu") b.push({ text: T.bouton_rattacher, callback_data: `a:ano:${id}:rt` }, { text: "Supprimer de TTN", callback_data: `a:ano:${id}:sup` });
  if (["modele_inconnu", "decodage"].includes(a.raison) && a.dev_eui) b.push({ text: T.bouton_choisir_modele, callback_data: `a:ano:${id}:m` }, { text: "Re-décoder", callback_data: `a:ano:${id}:rd` });
  if (a.raison === "decodage" && a.dev_eui) b.push({ text: "Forcer le mode", callback_data: `a:dev:${a.dev_eui}:mo` });
  if (["mauvaise_application", "capteur_supprime"].includes(a.raison) && a.dev_eui && a.application_id) b.push({ text: "Supprimer de cette app", callback_data: `a:ano:${id}:sup` });
  b.push({ text: T.bouton_ignorer, callback_data: `a:ano:${id}:i` }, { text: C.retour, callback_data: "a:inc" });
  await ecran(ctx, txt.join("\n"), clavier(b));
}

// ===================================================================== /stats (§5.14)

async function ecranStats(ctx: Ctx, jours = 7) {
  const s = await un(`SELECT
      (SELECT count(*) FROM app.tenants WHERE status NOT IN ('supprime', 'en_creation'))::int AS clients,
      (SELECT count(*) FROM app.tenants WHERE status = 'actif')::int AS actifs,
      (SELECT count(*) FROM app.tenants WHERE status = 'en_attente_activation')::int AS attente,
      (SELECT count(*) FROM app.tenants WHERE status = 'suspendu')::int AS pause,
      (SELECT count(*) FROM app.people WHERE NOT is_admin)::int AS personnes,
      (SELECT count(DISTINCT person_id) FROM app.memberships WHERE role = 'conseiller')::int AS conseillers,
      (SELECT count(*) FROM app.devices WHERE ttn_status <> 'supprime')::int AS capteurs,
      (SELECT count(*) FROM app.alert_state s JOIN app.alert_rules r ON r.id = s.rule_id AND r.kind = 'silence' WHERE s.state = 'alarm')::int AS muets,
      (SELECT count(*) FROM public.uplinks WHERE dev_eui IS NOT NULL AND time > now() - make_interval(days => $1))::int AS messages,
      (SELECT count(*) FROM app.notifications WHERE kind = 'alerte' AND transition = 'alarme' AND created_at > now() - make_interval(days => $1))::int AS alertes,
      (SELECT count(*) FROM app.notifications WHERE kind = 'alerte' AND statut IN ('echec', 'sans_destinataire') AND created_at > now() - make_interval(days => $1))::int AS non_livrees`, [jours]);
  const modeles = await q(`SELECT coalesce(model_key, '?') AS m, count(*)::int AS n FROM app.devices WHERE ttn_status <> 'supprime' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`);
  const txt = [f(T.stats_titre, { n: jours }), f(T.stats_clients, { total: s.clients, actifs: s.actifs, attente: s.attente, pause: s.pause }),
    f(T.stats_personnes, { n: s.personnes, conseillers: s.conseillers }),
    f(T.stats_capteurs, { n: s.capteurs, muets: s.capteurs ? Math.round(100 * s.muets / s.capteurs) : 0 }),
    f(T.stats_messages, { n: nombre(s.messages / jours, 0) }),
    f(T.stats_alertes, { n: s.alertes, non_livrees: s.alertes ? Math.round(100 * s.non_livrees / s.alertes) : 0 }),
    f(T.stats_modeles, { liste: modeles.map(m => `${echapper(modeleDe(m.m)?.modele || m.m)} ${m.n}`).join(" · ") || "—" })];
  await ecran(ctx, txt.join("\n"), clavier([{ text: jours === 7 ? "30 jours" : "7 jours", callback_data: `a:st:${jours === 7 ? 30 : 7}` }, { text: "Fichier CSV", callback_data: "a:st:csv" }]));
}

async function statsCsv(ctx: Ctx) {
  const l = await q(`SELECT t.slug, t.display_name, t.created_at, t.activated_at,
                     (SELECT count(*) FROM app.devices d WHERE d.tenant_slug = t.slug AND d.ttn_status <> 'supprime')::int AS capteurs,
                     (SELECT count(*) FROM public.uplinks u WHERE u.tenant = t.slug AND u.time > now() - interval '30 days')::int AS messages,
                     (SELECT count(*) FROM app.notifications n WHERE n.tenant_slug = t.slug AND n.kind = 'alerte' AND n.created_at > now() - interval '30 days')::int AS alertes,
                     (SELECT count(*) FROM app.memberships m WHERE m.tenant_slug = t.slug)::int AS personnes,
                     (SELECT count(*) FROM app.memberships m WHERE m.tenant_slug = t.slug AND m.role = 'conseiller')::int AS conseillers
                     FROM app.tenants t WHERE t.status <> 'supprime' ORDER BY t.slug`);
  const csv = ["slug;nom;creation;activation;capteurs;messages_30j;alertes_30j;personnes;conseillers",
    ...l.map(x => [x.slug, String(x.display_name).replace(/;/g, ","), jour(x.created_at), x.activated_at ? jour(x.activated_at) : "", x.capteurs, x.messages, x.alertes, x.personnes, x.conseillers].join(";"))].join("\n");
  await envoyerDocument(ctx.s, "admin", ctx.chat!.id, Buffer.from(csv, "utf8"), "stats-mobilab.csv");
}

// ===================================================================== /reglages (§5.15, §5.17)

async function ecranNotifs(ctx: Ctx) {
  const p = await un(`SELECT settings FROM app.people WHERE id = $1`, [ctx.personne!.id]);
  const st = p?.settings || {};
  await ecran(ctx, f(T.notifs_titre, { infos: st.infos === "resume" ? T.infos_resume : T.infos_direct, heure: st.heure_resume ?? 8 }),
    clavier([{ text: st.infos === "resume" ? T.bouton_infos_direct : T.bouton_infos_resume, callback_data: "a:rg:infos" },
      { text: T.bouton_heure_resume, callback_data: "a:rg:heure" }, { text: T.bouton_pause_24h, callback_data: "a:rg:pause" }, { text: C.retour, callback_data: "a:rg" }]));
}

async function ecranAdmins(ctx: Ctx) {
  const l = await q(`SELECT p.id, p.display_name, p.telegram_user_id, p.profile FROM app.people p WHERE p.is_admin ORDER BY p.id`);
  const txt = [f(T.admins_titre, { n: l.length })];
  for (const a of l) {
    if (ctx.s.cfg.adminBootstrapIds.includes(Number(a.telegram_user_id))) txt.push(f(T.admin_permanent, { nom: echapper(a.display_name) }));
    else txt.push(f(T.admin_ajoute, { nom: echapper(a.display_name), par: echapper(a.profile?.admin_par || "?"), date: a.profile?.admin_le ? jour(a.profile.admin_le) : "?" }));
  }
  await ecran(ctx, txt.join("\n"), clavier([{ text: T.bouton_ajouter_admin, callback_data: "a:rg:aa" }, { text: T.bouton_retirer_admin, callback_data: "a:rg:ra" }, { text: C.retour, callback_data: "a:rg" }]));
}

// ===================================================================== le bot

export async function majCommandesAdmin(bot: Bot<Ctx>, s: Services) {
  const m = T.menu;
  const cmds = Object.entries(m).map(([command, description]) => ({ command, description }));
  await bot.api.setMyCommands([], { scope: { type: "default" } }).catch(() => undefined);
  for (const a of await q(`SELECT telegram_user_id FROM app.people WHERE is_admin AND telegram_user_id IS NOT NULL`)) {
    await bot.api.setMyCommands(cmds, { scope: { type: "chat", chat_id: Number(a.telegram_user_id) } }).catch(() => undefined);
  }
  void s;
}

/** Les ids de ADMIN_BOOTSTRAP_IDS deviennent admins à chaque démarrage (spec §5.1). */
export async function amorcerAdmins(s: Services) {
  for (const id of s.cfg.adminBootstrapIds) {
    await q(`INSERT INTO app.people (telegram_user_id, display_name, source, is_admin) VALUES ($1, 'Admin Mobilab', 'admin', true)
             ON CONFLICT (telegram_user_id) DO UPDATE SET is_admin = true`, [id]);
  }
}

export function creerBotAdmin(s: Services): Bot<Ctx> {
  const bot = new Bot<Ctx>(s.cfg.telegram.adminToken || "0:test", { botInfo: s.cfg.telegram.adminToken ? undefined : ({ id: 2, is_bot: true, first_name: "Mobilab admin", username: s.noms.admin || "MobilabAdminBot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any) });

  bot.use(async (ctx, next) => {
    ctx.s = s;
    if (!ctx.from || (ctx.chat && ctx.chat.type !== "private")) return;   // muet hors conversation privée (spec §5.1)
    ctx.personne = await chargerPersonne(ctx.from.id);
    await next();
  });
  bot.use(session({ initial: (): Session => ({}), storage: stockage("admin"), getSessionKey: ctx => (ctx.from ? String(ctx.from.id) : undefined) }));

  // Lien adm_ : seule entrée pour un non-admin (spec §5.17).
  bot.command("start", async (ctx, next) => {
    const lien = lireParametre(String(ctx.match || ""));
    if (!lien || lien.kind !== "admin") return next();
    const nom = nomTelegram(ctx.from);
    const ok = await tx(async c => {
      const inv = await consommer(c, lien.empreinte, "admin", null);
      if (!inv) return null;
      const par = inv.created_by ? (await c.query(`SELECT display_name FROM app.people WHERE id = $1`, [inv.created_by])).rows[0]?.display_name : "?";
      const r = await c.query(`INSERT INTO app.people (telegram_user_id, display_name, source, is_admin, profile) VALUES ($1, $2, 'admin', true, $3::jsonb)
                               ON CONFLICT (telegram_user_id) DO UPDATE SET is_admin = true, profile = app.people.profile || EXCLUDED.profile RETURNING id`,
        [ctx.from!.id, nom, json({ admin_par: par, admin_le: new Date().toISOString() })]);
      await c.query(`UPDATE app.invitations SET used_by = $2 WHERE token = $1`, [lien.empreinte, r.rows[0].id]);
      await notifier(c, { audience: "admin", kind: "nouvel_admin", details: { nom, par } });
      return true;
    });
    if (!ok) { await dire(ctx, TC.lien_mort); return; }
    ctx.personne = await chargerPersonne(ctx.from!.id);
    await dire(ctx, T.bienvenue_admin);
    await majCommandesAdmin(bot, s);
  });

  // Contrôle is_admin sur chaque mise à jour (spec §5.1) : une ligne par jour au plus à un inconnu.
  bot.use(async (ctx, next) => {
    if (ctx.personne?.is_admin) return next();
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
    const dernier = ctx.session.dernierPasAdmin || 0;
    await q(`INSERT INTO app.audit (via, action, details) VALUES ('systeme', 'inconnu sur le bot admin', $1::jsonb)`, [json({ telegram_id: ctx.from!.id })]).catch(() => undefined);
    if (Date.now() - dernier > 86400000) { ctx.session.dernierPasAdmin = Date.now(); await dire(ctx, T.reserve); }
  });

  bot.catch(async err => {
    const code = codeErreur();
    log.error(`bot admin ${code} : ${err.error instanceof Error ? err.error.stack || err.error.message : String(err.error)}`);
    try { if (err.ctx.callbackQuery) await err.ctx.answerCallbackQuery().catch(() => undefined); await err.ctx.reply(`${C.erreur_interne} (${code})`); } catch { /* rien */ }
  });

  // Toute commande admin arrête le mode support (spec §5.9).
  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/") && ctx.session.support) { delete ctx.session.support; await dire(ctx, T.support_fin); }
    await next();
  });

  bot.command("start", async ctx => {
    finir(ctx);
    const e = etatCourant() || await calculerEtat(s);
    const { texte, boutons } = texteEtat(e, s.cfg.version);
    if (texte.includes("Tout va bien")) await dire(ctx, f(T.bonjour_ok, { prenom: echapper(prenom(ctx.personne!.display_name)), capteurs: nombre(e.capteurs, 0), messages: nombre(e.messages24h, 0) }), { reply_markup: sansClavier });
    else await dire(ctx, texte, { reply_markup: clavier(boutons) });
  });
  bot.command("aide", async ctx => { finir(ctx); await dire(ctx, T.aide, { reply_markup: sansClavier }); });
  bot.command("annuler", async ctx => { finir(ctx); delete ctx.session.support; await dire(ctx, C.annule, { reply_markup: sansClavier }); });
  bot.command("etat", async ctx => { finir(ctx); const e = etatCourant() || await calculerEtat(s); const { texte, boutons } = texteEtat(e, s.cfg.version); await dire(ctx, texte, { reply_markup: clavier(boutons) }); });
  bot.command(["clients", "client"], async ctx => {
    finir(ctx);
    const t = String(ctx.match || "").trim();
    if (!t) return ecranClients(ctx);
    const l = await chercherClients(t);
    const dev = t.replace(/[\s:-]/g, "").toLowerCase();
    if (/^[0-9a-f]{16}$/.test(dev) && (await lireCapteur(dev))) return ecranCapteurAdmin(ctx, dev);
    if (l.length === 1) return ecranClient(ctx, l[0].slug);
    return ecranClients(ctx, 0, l.map(x => x.slug));
  });
  bot.command("creer_client", async ctx => {
    if (!s.cfg.secretsKey) { await dire(ctx, "SECRETS_KEY manquant : création impossible."); return; }
    demarrer(ctx, "creer_client", "nom", "/creer_client", {});
    await dire(ctx, T.q_nom_ferme, { reply_markup: clavierAnnuler(C.annuler) });
  });
  bot.command("ajouter_pour", async ctx => { finir(ctx); await lancerAjoutPour(ctx, undefined, String(ctx.match || "").trim() || undefined); });
  bot.command("inviter", async ctx => {
    finir(ctx);
    const n = await un(`SELECT count(*)::int AS n FROM app.invitations WHERE kind = 'new_client' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`);
    demarrer(ctx, "inviter", "nom", "/inviter", {});
    await dire(ctx, T.inviter_pour_qui, { reply_markup: clavier([{ text: C.passer, callback_data: "a:iv:passer" }, n.n ? { text: f(T.bouton_en_cours, { n: n.n }), callback_data: "a:iv:liste" } : null]) });
  });
  bot.command("inconnus", async ctx => { finir(ctx); await ecranInconnus(ctx); });
  bot.command("stats", async ctx => { finir(ctx); await ecranStats(ctx); });
  bot.command("conseillers", async ctx => {
    finir(ctx);
    const l = await q(`SELECT p.id, p.display_name, p.profile, count(*)::int AS n FROM app.memberships m JOIN app.people p ON p.id = m.person_id
                       WHERE m.role = 'conseiller' GROUP BY p.id ORDER BY p.display_name`);
    const txt = [f(T.conseillers_titre, { n: l.length }), ...l.map(c => f(T.conseiller_ligne, { nom: echapper(c.display_name + (c.profile?.organisme ? ` (${c.profile.organisme})` : "")), n: c.n }))];
    await dire(ctx, txt.join("\n"));
  });
  bot.command("reglages", async ctx => {
    finir(ctx);
    await dire(ctx, T.reglages_titre, { reply_markup: clavier([{ text: T.bouton_mes_notifications, callback_data: "a:rg:n" }, { text: T.bouton_admins, callback_data: "a:rg:ad" }]) });
  });
  bot.command("resume", async ctx => { await resumeDuMatin(s, ctx.personne!.id); });
  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) { finir(ctx); await dire(ctx, TC.commande_inconnue); return; }
    await next();
  });

  // Réponse à un ✉️ par la fonction « Répondre » de Telegram (spec §5.16)
  bot.on("message:text", async (ctx, next) => {
    const rep = ctx.message.reply_to_message;
    if (!rep || conversation(ctx)) return next();
    const n = await un(`SELECT * FROM app.notifications WHERE kind = 'message_client' AND destinataires @> $1::jsonb ORDER BY id DESC LIMIT 1`,
      [json([{ chat_id: ctx.chat.id, message_id: rep.message_id }])]);
    if (!n) return next();
    await repondreClient(ctx, n.id, ctx.message.text);
  });

  bot.on("message:text", async ctx => {
    const texte = ctx.message.text;
    if (/^(annuler|stop)$/i.test(texte.trim()) || texte === C.annuler) { finir(ctx); await dire(ctx, C.annule, { reply_markup: sansClavier }); return; }
    const conv = conversation(ctx);
    if (!conv) {
      // Texte tapé hors conversation : recherche d'un client ou d'un DevEUI (spec §5.6).
      const l = await chercherClients(texte);
      const dev = texte.replace(/[\s:-]/g, "").toLowerCase();
      if (/^[0-9a-f]{16}$/.test(dev) && (await lireCapteur(dev))) return ecranCapteurAdmin(ctx, dev);
      if (l.length === 1) return ecranClient(ctx, l[0].slug);
      if (l.length) return ecranClients(ctx, 0, l.map(x => x.slug));
      await dire(ctx, T.aide);
      return;
    }
    switch (conv.nom) {
      case "creer_client": return etapeCreerClient(ctx, texte);
      case "ajouter_pour": return etapeAjoutPour(ctx, texte);
      case "inviter": {
        finir(ctx);
        return inviter(ctx, texte.trim().slice(0, 60));
      }
      case "repondre": {
        finir(ctx);
        return repondreClient(ctx, conv.donnees.notif, texte);
      }
      case "renommer_ferme": {
        const nom = texte.trim();
        if (nom.length < 2 || nom.length > 60) { await dire(ctx, T.nom_ferme_invalide); return; }
        finir(ctx);
        const t = await lireFerme(conv.donnees.slug);
        await q(`UPDATE app.tenants SET display_name = $2 WHERE slug = $1`, [t.slug, nom]);
        if (t.grafana_org_id && s.grafana.configure) await s.grafana.renommerOrg(Number(t.grafana_org_id), nom).catch(() => s.grafana.renommerOrg(Number(t.grafana_org_id), `${nom} (${t.slug})`)).catch(() => undefined);
        await audit(db(), { acteur: ctx.personne!.id, via: "admin", tenant: t.slug, action: "ferme renommée", details: { avant: t.display_name, apres: nom } });
        await dire(ctx, f(T.renomme_ferme, { ferme: echapper(nom) }), { reply_markup: sansClavier });
        return;
      }
      case "supprimer_ferme": {
        finir(ctx);
        const t = await lireFerme(conv.donnees.slug);
        if (texte.trim().toLowerCase() !== String(t.display_name).toLowerCase()) { await dire(ctx, T.nom_different, { reply_markup: sansClavier }); return; }
        await retirerClavier(ctx);
        const m = await dire(ctx, "⏳");
        await creerJob(db(), { kind: "supprimer_client", tenant: t.slug, requested_by: ctx.personne!.id, chat_id: ctx.chat.id, message_id: m.message_id });
        await ctx.api.editMessageText(ctx.chat.id, m.message_id, f(T.suppression_programmee, { ferme: echapper(t.display_name), date: jour(new Date(Date.now() + 30 * 86400000)) }),
          { reply_markup: clavier([{ text: T.bouton_reactiver, callback_data: `a:cli:${t.slug}:re` }]) }).catch(() => undefined);
        return;
      }
      case "renommer": {
        const nom = texte.trim();
        const d = await lireCapteur(conv.donnees.dev);
        if (!d) { finir(ctx); return; }
        if (nom.length < 1 || nom.length > 40) { await dire(ctx, TC.nom_invalide); return; }
        finir(ctx);
        await tx(async c => {
          await c.query(`UPDATE app.devices SET name = $2 WHERE dev_eui = $1`, [d.dev_eui, nom]);
          await creerJob(c, { kind: "renommer_capteur", tenant: d.tenant_slug, dev_eui: d.dev_eui, requested_by: ctx.personne!.id });
          await audit(c, { acteur: ctx.personne!.id, via: "admin", tenant: d.tenant_slug, dev_eui: d.dev_eui, action: "renommé", details: { avant: d.name, apres: nom } });
        });
        await dire(ctx, f(TC.renomme, { capteur: echapper(nom) }), { reply_markup: sansClavier });
        return;
      }
      case "corriger": {
        // Mêmes contrôles que le bot client : AppEUI, AppKey, DevEUI puis relecture.
        const dn = conv.donnees;
        const r = rangerCodes(texte);
        if (r.appkey) dn.appkey = chiffrer(s.cfg.secretsKey!, r.appkey).toString("base64");
        if (r.appeui && !dn.appeui) dn.appeui = r.appeui;
        if (r.deveui) dn.deveui = r.deveui;
        else if (r.appeui && dn.appeui && r.appeui !== dn.appeui) dn.deveui = r.appeui;
        if (!dn.appeui) { await dire(ctx, TC.err_16_appeui); return; }
        if (!dn.appkey) { await dire(ctx, TC.q_appkey); return; }
        if (!dn.deveui) { await dire(ctx, TC.q_deveui); return; }
        if (dn.deveui.toUpperCase() !== dn.dev_eui_origine) { finir(ctx); await dire(ctx, "Un autre DevEUI = un autre capteur. Supprimez celui-ci et ajoutez le nouveau.", { reply_markup: sansClavier }); return; }
        finir(ctx);
        const appkey = dechiffrer(s.cfg.secretsKey!, Buffer.from(dn.appkey, "base64"));
        await retirerClavier(ctx);
        const m = await dire(ctx, f(TC.enregistre_en_cours, { capteur: echapper(dn.nom) }));
        await creerJob(db(), { kind: "corriger_codes", tenant: dn.ferme, dev_eui: dn.dev_eui_origine.toLowerCase(), requested_by: ctx.personne!.id, chat_id: ctx.chat.id,
          message_id: m.message_id, params: { appeui: dn.appeui.toLowerCase(), nom: dn.nom, bot: "admin", via: "admin" }, secret: chiffrerSecret(s, appkey) });
        return;
      }
      case "rattacher": {
        const dn = conv.donnees;
        if (conv.etape === "ferme") {
          const l = await chercherClients(texte);
          if (l.length !== 1) { await dire(ctx, T.aucun_client); return; }
          dn.ferme = l[0].slug;
          conv.etape = "nom";
          await dire(ctx, T.rattacher_nom);
          return;
        }
        finir(ctx);
        const nom = texte.trim().slice(0, 40);
        await tx(async c => {
          await c.query(`INSERT INTO app.devices (dev_eui, tenant_slug, name, ttn_status, created_by, config) VALUES ($1, $2, $3, 'connecte', $4, '{}')
                         ON CONFLICT (dev_eui) DO UPDATE SET tenant_slug = EXCLUDED.tenant_slug, name = EXCLUDED.name, ttn_status = 'connecte'
                         WHERE app.devices.ttn_status IN ('supprime', 'echec')`, [dn.dev, dn.ferme, nom, ctx.personne!.id]);
          await c.query(`UPDATE app.anomalies SET resolved_at = now(), resolved_by = $2 WHERE id = $1`, [dn.anomalie, ctx.personne!.id]);
          await audit(c, { acteur: ctx.personne!.id, via: "admin", tenant: dn.ferme, dev_eui: dn.dev, action: "capteur rattaché", details: { nom } });
        });
        await dire(ctx, f(T.rattache_ok, { capteur: echapper(nom), ferme: echapper((await lireFerme(dn.ferme)).display_name) }), { reply_markup: sansClavier });
        return;
      }
      case "conseiller": {
        finir(ctx);
        const [nom, organisme] = texte.split(/\s*,\s*/);
        const slug = conv.donnees.slug;
        const t = await lireFerme(slug);
        const connu = await un(`SELECT p.id FROM app.people p JOIN app.memberships m ON m.person_id = p.id AND m.role = 'conseiller'
                                WHERE lower(p.display_name) = lower($1) LIMIT 1`, [nom.trim()]);
        const res = await tx(async c => {
          let id = connu?.id;
          if (!id) id = (await c.query(`INSERT INTO app.people (display_name, source, profile) VALUES ($1, 'admin', $2::jsonb) RETURNING id`,
            [nom.trim().slice(0, 80), json(organisme ? { organisme: organisme.trim().slice(0, 80) } : {})])).rows[0].id;
          await c.query(`INSERT INTO app.memberships (person_id, tenant_slug, role, grafana_role, receives_alerts, status, source, granted_by)
                         VALUES ($1, $2, 'conseiller', 'Viewer', false, 'en_attente_accord', 'bot', $3) ON CONFLICT (person_id, tenant_slug) DO NOTHING`, [id, slug, ctx.personne!.id]);
          await audit(c, { acteur: ctx.personne!.id, via: "admin", tenant: slug, action: "conseiller proposé", details: { nom } });
          return id;
        });
        if (t.status === "actif") {
          for (const pr of await q(`SELECT p.telegram_user_id FROM app.memberships m JOIN app.people p ON p.id = m.person_id WHERE m.tenant_slug = $1 AND m.role = 'proprietaire' AND p.telegram_user_id IS NOT NULL`, [slug])) {
            await envoyer(s, "client", Number(pr.telegram_user_id), f(TC.propose_conseiller, { nom: echapper(nom + (organisme ? ` (${organisme})` : "")) }),
              { inline_keyboard: [[{ text: TC.bouton_accepter, callback_data: `sh:${slug}:ok:${res}` }, { text: TC.bouton_refuser, callback_data: `sh:${slug}:no:${res}` }]] });
          }
        }
        await dire(ctx, `✅ Demande envoyée au propriétaire de ${echapper(t.display_name)}.`, { reply_markup: sansClavier });
        return;
      }
      case "heure": {
        const h = Number(texte.trim());
        finir(ctx);
        if (!Number.isInteger(h) || h < 0 || h > 23) { await dire(ctx, T.heure_question); return; }
        await q(`UPDATE app.people SET settings = settings || jsonb_build_object('heure_resume', $2::int) WHERE id = $1`, [ctx.personne!.id, h]);
        await dire(ctx, "✅", { reply_markup: sansClavier });
        return;
      }
      default:
        finir(ctx);
    }
  });

  bot.on("message:document", async ctx => {
    const conv = conversation(ctx);
    const doc = ctx.message.document;
    if (!conv || !["creer_client", "ajouter_pour"].includes(conv.nom) || !/\.(csv|txt)$/i.test(doc.file_name || "") || (doc.file_size || 0) > 200000) return;
    const fichier = await ctx.api.getFile(doc.file_id);
    // L'adresse du fichier contient le jeton du bot : jamais journalisée (spec §4.4).
    const rep = await fetch(`https://api.telegram.org/file/bot${s.cfg.telegram.adminToken}/${fichier.file_path}`);
    const texte = await rep.text();
    if (conv.nom === "creer_client") { conv.etape = "capteurs"; return etapeCreerClient(ctx, texte); }
    conv.etape = "nom";
    return etapeAjoutPour(ctx, texte);
  });

  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("a:")) { await ctx.answerCallbackQuery(); return; }
    const [, verbe0, ...a] = data.split(":");
    const conf = verbe0.endsWith("!");
    const verbe = verbe0.replace(/!$/, "");
    let repondu = false;
    const repondre = async (text?: string) => { if (!repondu) { repondu = true; await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => undefined); } };
    switch (verbe) {
      case "etat": {
        if (a[0] === "r") { await repondre("⏳"); await calculerEtat(s); }
        if (a[0] === "ta") {
          const l = await q(`SELECT j.*, t.display_name FROM app.jobs j LEFT JOIN app.tenants t ON t.slug = j.tenant_slug WHERE j.status = 'echec' ORDER BY j.id DESC LIMIT 6`);
          if (!l.length) { await ecran(ctx, T.aucune_tache); break; }
          for (const j of l) {
            await dire(ctx, f(T.tache_ligne, { id: j.id, kind: j.kind, objet: echapper(`${j.params?.nom || j.dev_eui || ""} · ${j.display_name || j.tenant_slug || ""}`),
              etape: j.step || "début", erreur: echapper(j.error || "?"), duree: depuis(j.updated_at) }),
              { reply_markup: clavier([{ text: T.bouton_relancer, callback_data: `a:job:r:${j.id}` }, { text: T.bouton_annuler, callback_data: `a:job:x:${j.id}` },
                j.tenant_slug ? { text: T.bouton_voir_fiche, callback_data: `a:cli:${j.tenant_slug}` } : null]) });
          }
          break;
        }
        if (a[0] === "in") { await ecranInconnus(ctx); break; }
        if (a[0] === "mu") {
          const l = await q(`SELECT t.slug, t.display_name, d.name, s.since FROM app.alert_state s JOIN app.alert_rules r ON r.id = s.rule_id AND r.kind = 'silence'
                             JOIN app.devices d ON d.dev_eui = r.dev_eui JOIN app.tenants t ON t.slug = d.tenant_slug WHERE s.state = 'alarm' AND d.ttn_status <> 'supprime' ORDER BY 2, 3`);
          const jamais = await q(`SELECT d.dev_eui, d.name, t.display_name FROM app.devices d JOIN app.tenants t ON t.slug = d.tenant_slug
                                  WHERE d.ttn_status = 'enregistre' AND d.created_at < now() - interval '60 minutes'`);
          const fermes = [...new Set(l.map(x => x.slug))];
          const txt = [T.muets_titre, ...fermes.map(fs => `${echapper(l.find(x => x.slug === fs)!.display_name)} : ${l.filter(x => x.slug === fs).map(x => `${echapper(x.name)} (${depuis(x.since)})`).join(", ")}`)];
          if (jamais.length) txt.push("⏳ Jamais connectés : " + jamais.map(x => `${echapper(x.name)} (${echapper(x.display_name)})`).join(", "));
          await ecran(ctx, txt.join("\n"), clavier([...fermes.map(fs => ({ text: l.find(x => x.slug === fs)!.display_name, callback_data: `a:cli:${fs}` })),
            ...jamais.slice(0, 4).map(x => ({ text: `${T.bouton_diagnostic} ${x.name}`.slice(0, 40), callback_data: `a:dev:${x.dev_eui}:d` }))]));
          break;
        }
        if (a[0] === "co") {
          const l = await q(`SELECT c.*, d.name, t.display_name, p.display_name AS auteur FROM app.commands c JOIN app.devices d ON d.dev_eui = c.dev_eui
                             JOIN app.tenants t ON t.slug = d.tenant_slug LEFT JOIN app.people p ON p.id = c.requested_by
                             WHERE c.requested_at > now() - interval '7 days' ORDER BY c.id DESC LIMIT 12`);
          const txt = ["Ordres · 7 derniers jours", ...l.map(c => `${jourHeure(c.requested_at)} ${echapper(c.name)} (${echapper(c.display_name)}) · ${echapper(c.action)} · ${echapper(c.auteur || "?")}${c.via === "support" ? " (support)" : ""} · ${c.status}`)];
          const enFile = l.find(c => ["demandee", "envoyee"].includes(c.status));
          await ecran(ctx, txt.join("\n"), clavier([enFile && { text: "Annuler l'ordre en file", callback_data: `a:cmd:x:${enFile.id}` }, { text: C.retour, callback_data: "a:etat" }]));
          break;
        }
        const e = etatCourant() || await calculerEtat(s);
        const { texte, boutons } = texteEtat(e, s.cfg.version);
        await ecran(ctx, texte, clavier(boutons));
        break;
      }
      case "gw": {
        const l = await q(`SELECT g->>'id' AS id, count(*)::int AS n, count(DISTINCT u.tenant)::int AS fermes, max(u.time) AS vue
                           FROM public.uplinks u, jsonb_array_elements(coalesce(u.gateways, '[]'::jsonb)) g
                           WHERE u.time > now() - interval '7 days' AND u.dev_eui IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
        const noms = new Map((await q(`SELECT gateway_id, label FROM app.gateways`)).map(x => [x.gateway_id, x.label]));
        const txt = [T.passerelles_titre, ...l.map(g => {
          const nom = echapper(noms.get(g.id) || g.id);
          const dispa = Date.now() - new Date(g.vue).getTime() > 2 * 3600000;
          return dispa ? `⚠️ ${nom} · plus rien depuis ${depuis(g.vue)} (${g.fermes} fermes)` : f(T.passerelle_ligne, { nom, n: g.n, fermes: g.fermes, duree: depuis(g.vue) });
        })];
        if (!l.length) txt.push("—");
        await ecran(ctx, txt.join("\n"), clavier([{ text: C.retour, callback_data: "a:etat" }]));
        break;
      }
      case "cl": await ecranClients(ctx, Number(a[0]) || 0); break;
      case "cli": if (a[1]) await actionClient(ctx, a[0], a[1], a.slice(2)); else await ecranClient(ctx, a[0]); break;
      case "per": await ecranPersonne(ctx, a[0], Number(a[1]), a[2]); break;
      case "dev": await ecranCapteurAdmin(ctx, a[0], a[1], a.slice(2)); break;
      case "job": {
        const id = Number(a[1]);
        if (a[0] === "r") { await relancer(id); await repondre(f(T.tache_relancee, { id })); }
        else if (a[0] === "x") { await annuler(id, s); await repondre(f(T.tache_annulee, { id })); }
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
        break;
      }
      case "fic": {
        const pages = (s.memoire.get(-Number(a[0])) as any)?.fiche;
        if (!pages) { await repondre(C.trop_ancien); break; }
        const id = await envoyerDocument(s, "admin", ctx.chat!.id, await fichePdf(pages), "fiche-mobilab.pdf");
        if (id) await effacerPlusTard("admin", ctx.chat!.id, id);
        break;
      }
      case "cc": {
        const conv = conversation(ctx);
        if (!conv || conv.nom !== "creer_client") { await repondre(C.trop_ancien); break; }
        const dn = conv.donnees;
        if (a[0] === "x") { finir(ctx); await ecran(ctx, C.annule); break; }
        if (a[0] === "force") { dn.forcer = true; conv.etape = "email"; await repondre(); await dire(ctx, T.q_email, { reply_markup: clavier([{ text: C.passer, callback_data: "a:cc:passer" }]) }); return; }
        if (a[0] === "passer") { conv.etape = "capteurs"; await repondre(); await dire(ctx, T.q_capteurs, { reply_markup: clavier([{ text: T.bouton_plus_tard, callback_data: "a:cc:fin" }]) }); return; }
        if (a[0] === "autre") { conv.etape = "capteurs"; await repondre(); await dire(ctx, TC.q_nom); return; }
        if (a[0] === "fin") { await repondre(); await confirmerCreation(ctx); return; }
        if (a[0] === "ok") {
          finir(ctx);
          await repondre();
          await retirerClavier(ctx);
          const m = await dire(ctx, f(T.creation_titre, { ferme: echapper(dn.nom) }));
          await lancerCreation(ctx, dn.nom, dn.email || null, dn.capteurs || [], { chat: ctx.chat!.id, message: m.message_id });
          return;
        }
        if (a[0] === "lot") {
          finir(ctx);
          await repondre();
          const lot = `l${Date.now()}`;
          await retirerClavier(ctx);
          const m = await dire(ctx, f(T.creation_n, { fait: 0, total: dn.lot.length }));
          s.lots.set(lot, { total: dn.lot.length, pages: [], chat: ctx.chat!.id, message: m.message_id, lignes: {} });
          for (const fe of dn.lot) await lancerCreation(ctx, fe.nom, fe.email, [], { lot });
          return;
        }
        break;
      }
      case "iv": {
        if (a[0] === "passer") { finir(ctx); await repondre(); await inviter(ctx, null); return; }
        if (a[0] === "liste") {
          const l = await q(`SELECT i.token, i.payload, i.created_at, i.expires_at, p.display_name FROM app.invitations i LEFT JOIN app.people p ON p.id = i.created_by
                             WHERE i.kind = 'new_client' AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() ORDER BY i.created_at`);
          await ecran(ctx, l.map(i => f(T.invitation_ligne, { nom: echapper(i.payload?.note || "—"), par: echapper(i.display_name || "?"), date: jour(i.created_at), expire: jour(i.expires_at) })).join("\n") || "—",
            clavier(l.map(i => ({ text: `${T.bouton_supprimer} ${i.payload?.note || ""}`.slice(0, 40), callback_data: `a:inv:x:${String(i.token).slice(0, 8)}` }))));
          break;
        }
        break;
      }
      case "inv": {
        if (a[0] === "x") {
          await q(`UPDATE app.invitations SET revoked_at = now() WHERE token LIKE $1 || '%' AND used_at IS NULL`, [a[1]]);
          await ecran(ctx, T.lien_supprime);
        } else if (a[0] === "qr") {
          const lien = (s.memoire.get(-1) as any)?.[a[1]];
          if (lien) await ctx.replyWithPhoto(new InputFile(await qrPng(lien), "qr.png"));
        }
        break;
      }
      case "ap": await repondre(); await lancerAjoutPour(ctx, a[0]); return;
      case "aj": {
        const conv = conversation(ctx);
        if (!conv || conv.nom !== "ajouter_pour") { await repondre(C.trop_ancien); break; }
        const mq = a[0] === "m" ? marques().find(m => m.cle === a[1]) : null;
        if (mq && conv.etape === "marque") {
          conv.donnees.marque_bouton = mq.bouton;
          if (typesDeMarque(mq.cle).length) {
            conv.etape = await apresMarque(ctx, mq.cle, "a:");
            break;
          }
          conv.etape = "codes";
          await repondre(); await ecran(ctx, f(TC.relecture_type, { type: echapper(libelleType(conv.donnees)) })); await dire(ctx, TC.q_appeui);
          return;
        }
        if (a[0] === "k" && (conv.etape === "categorie" || conv.etape === "type")) {
          if (!a[2]) { conv.etape = "categorie"; await questionCategorie(ctx, a[1], "a:"); break; }
          conv.etape = "type";
          await questionType(ctx, a[1], "a:", a[2]);
          break;
        }
        if (a[0] === "t" && (conv.etape === "type" || conv.etape === "categorie")) {
          conv.donnees.modele = a[1] === "a" ? null : modeleDe(a[1])?.cle || null;
          conv.etape = "codes";
          await repondre(); await ecran(ctx, f(TC.relecture_type, { type: echapper(libelleType(conv.donnees)) })); await dire(ctx, TC.q_appeui);
          return;
        }
        break;
      }
      case "apr": {
        if (a[0] === "ok") { await validerAjoutPour(ctx); return; }
        const conv = conversation(ctx);
        if (conv?.nom === "ajouter_pour") { delete conv.donnees.appeui; delete conv.donnees.appkey; delete conv.donnees.deveui; conv.etape = "codes"; await repondre(); await dire(ctx, TC.q_appeui); return; }
        break;
      }
      case "apl": {
        const conv = conversation(ctx);
        if (!conv || conv.nom !== "ajouter_pour") { await repondre(C.trop_ancien); break; }
        if (a[0] === "re") { conv.etape = "nom"; await repondre(); await dire(ctx, T.liste_illisible); return; }
        finir(ctx);
        await repondre();
        for (const cap of conv.donnees.liste || []) {
          await enregistrerPour(ctx, conv.donnees.ferme, cap, dechiffrer(s.cfg.secretsKey!, Buffer.from(cap.appkey, "base64")));
        }
        return;
      }
      case "ano": {
        if (a[0] === undefined) break;
        await actionInconnu(ctx, Number(a[0]), a[1] || "v", a.slice(2));
        break;
      }
      case "inc": await ecranInconnus(ctx); break;
      case "md":
      case "mt": {
        // Réponse de l'admin à « Quel est ce capteur ? » (spec §5.8).
        const dev = a[0];
        if (a[1] === "a") { await ecran(ctx, TC.modele_autre); break; }
        if (a[1] === "l") { await ecranCapteurAdmin(ctx, dev, "mod"); break; }
        const l = verbe === "md" ? modelesProposes(dev) : [];
        const m = l[Number(a[1])];
        const d = await lireCapteur(dev);
        if (!m || !d) break;
        await tx(async c => {
          await c.query(`UPDATE app.devices SET model_key = $2, config = config || '{"model_source":"admin"}' WHERE dev_eui = $1`, [dev, m.cle]);
          await creerJob(c, { kind: "mise_en_service", tenant: d.tenant_slug, dev_eui: dev, params: { redecoder: true, annonce: true }, requested_by: ctx.personne!.id });
        });
        await ecran(ctx, f(TC.modele_note, { modele: echapper(m.libelle) }));
        break;
      }
      case "ps": {
        const [dev, n, choix0] = a;
        const premiere = /p$/.test(choix0 || "");
        const choix = String(choix0 || "").replace(/p$/, "");
        const d = await lireCapteur(dev);
        if (!d) break;
        const m = modeleDe(d.model_key);
        const voie = voiesDe(m, d.mode_override || d.config?.detected?.mode_lu || null)[Number(n) - 1];
        if (!voie) break;
        const sonde = choix === "r" ? "rien" : choix === "u" ? "tension_brute" : catalogue().ordreSondes[Number(choix)];
        const probes = { ...(d.probes || {}), [voie]: { sonde, par: ctx.personne!.id, le: new Date().toISOString(), ...(choix === "u" ? { inconnue: true } : {}) } };
        await q(`UPDATE app.devices SET probes = $2::jsonb WHERE dev_eui = $1`, [dev, json(probes)]);
        await ecran(ctx, f(TC.entree_choisie, { n, sonde: echapper(sonde === "rien" ? TC.rien : catalogue().sondes[sonde]?.libelle || sonde) }));
        d.probes = probes;
        const suite = await questionSonde(s, "admin", ctx.chat!.id, d, Number(n), premiere);
        if (!suite) await creerJob(db(), { kind: "mise_en_service", tenant: d.tenant_slug, dev_eui: dev, params: { redecoder: true, annonce: premiere }, requested_by: ctx.personne!.id });
        break;
      }
      case "cmd": {
        if (a[0] !== "x") break;
        const cmd = await un(`SELECT c.*, d.tenant_slug, d.config AS dconfig FROM app.commands c JOIN app.devices d ON d.dev_eui = c.dev_eui WHERE c.id = $1`, [Number(a[1])]);
        if (!cmd || !["demandee", "envoyee"].includes(cmd.status)) { await repondre("—"); break; }
        await s.ttn.viderFile(await appDe(db(), cmd.tenant_slug), idTtn({ dev_eui: cmd.dev_eui, config: cmd.dconfig })).catch(() => undefined);
        await q(`UPDATE app.commands SET status = 'annulee' WHERE id = $1`, [cmd.id]);
        await envoyerAuxMembres(s, cmd.tenant_slug, f(TC.mobilab_annule_ordre, { action: echapper(cmd.action) }));
        await ecran(ctx, TC.ordre_annule);
        break;
      }
      case "ntf": {
        const id = Number(a[0]);
        const n = await un(`SELECT * FROM app.notifications WHERE id = $1`, [id]);
        if (!n) break;
        if (a[1] === "r") {
          demarrer(ctx, "repondre", "texte", "/etat", { notif: id });
          await repondre();
          await dire(ctx, f(T.repondre_a, { nom: echapper(n.details?.nom || "?") }), { reply_markup: clavierAnnuler(C.annuler) });
          return;
        }
        if (a[1] === "ok" || a[1] === "no") {
          if (n.details?.decision) { await repondre(n.details.decision); break; }
          const decision = `${a[1] === "ok" ? "acceptée" : "refusée"} par ${prenom(ctx.personne!.display_name)}`;
          await q(`UPDATE app.notifications SET details = details || jsonb_build_object('decision', $2::text) WHERE id = $1`, [id, decision]);
          if (a[1] === "ok") {
            const p = await un(`SELECT * FROM app.people WHERE id = $1`, [n.details.person_id]);
            if (p?.telegram_user_id) {
              // Invitation n_ liée à cette personne, utilisée aussitôt : le bot client demande le nom de la ferme (spec §5.16).
              await tx(async c => {
                const l = await creerLien(c, "new_client", { par: ctx.personne!.id, payload: { person_id: p.id, demande: true } });
                await consommer(c, (await import("../invitations.js")).lireParametre(l.parametre)!.empreinte, "new_client", p.id);
                await c.query(`INSERT INTO app.bot_sessions (key, value, updated_at) VALUES ($1, $2::jsonb, now())
                               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
                  [`client:${p.telegram_user_id}`, json({ conv: { nom: "nom_ferme", etape: "nom", donnees: { invite_par: ctx.personne!.id }, depuis: Date.now(), commande: "/start" } })]);
              });
              await envoyer(s, "client", Number(p.telegram_user_id), f(TC.nom_ferme_question_accepte, { prenom: echapper(prenom(p.display_name)) }),
                { force_reply: true, input_field_placeholder: TC.nom_ferme_exemple } as any);
            }
          }
          for (const dst of (n.destinataires || []) as any[]) {
            if (!dst.message_id) continue;
            await ctx.api.editMessageText(dst.chat_id, dst.message_id, `${f(T.notif_demande_acces, { nom: echapper(n.details?.nom || "?"), pseudo: "" }).replace(/\.$/, "")} · ${echapper(decision)}`).catch(() => undefined);
          }
          await repondre();
          break;
        }
        break;
      }
      case "sup": {
        const slug = a[0];
        const t = await lireFerme(slug);
        if (!t) break;
        ctx.session.support = { tenant: slug, depuis: Date.now() };
        await audit(db(), { acteur: ctx.personne!.id, via: "support", tenant: slug, action: "mode support" });
        await ecran(ctx, f(T.support_titre, { ferme: echapper(t.display_name) }), clavier([{ text: T.bouton_capteurs, callback_data: `a:cli:${slug}:c` },
          { text: T.bouton_alertes, callback_data: `a:cli:${slug}:al` }, { text: "Ajouter", callback_data: `a:cli:${slug}:aj` }, { text: "Partage", callback_data: `a:cli:${slug}:p` },
          t.grafana_org_id && s.cfg.grafana.publicUrl ? { text: "Graphiques", url: `${s.cfg.grafana.publicUrl}/?orgId=${t.grafana_org_id}` } : null,
          { text: T.bouton_quitter, callback_data: "a:supx" }]));
        break;
      }
      case "supx": delete ctx.session.support; await ecran(ctx, T.support_fin); break;
      case "st": if (a[0] === "csv") await statsCsv(ctx); else await ecranStats(ctx, Number(a[0]) || 7); break;
      case "rg": {
        const p = ctx.personne!;
        if (!a[0]) { await ecran(ctx, T.reglages_titre, clavier([{ text: T.bouton_mes_notifications, callback_data: "a:rg:n" }, { text: T.bouton_admins, callback_data: "a:rg:ad" }])); break; }
        if (a[0] === "n") { await ecranNotifs(ctx); break; }
        if (a[0] === "infos") { await q(`UPDATE app.people SET settings = settings || jsonb_build_object('infos', CASE WHEN settings->>'infos' = 'resume' THEN 'direct' ELSE 'resume' END) WHERE id = $1`, [p.id]); await ecranNotifs(ctx); break; }
        if (a[0] === "pause") { await q(`UPDATE app.people SET settings = settings || jsonb_build_object('pause_jusqua', (now() + interval '24 hours')::text) WHERE id = $1`, [p.id]); await ecran(ctx, T.pause_ok); break; }
        if (a[0] === "heure") { demarrer(ctx, "heure", "h", "/reglages", {}); await repondre(); await dire(ctx, T.heure_question); return; }
        if (a[0] === "ad") { await ecranAdmins(ctx); break; }
        if (a[0] === "aa") {
          const l = await creerLien(db(), "admin", { par: p.id });
          await ecran(ctx, f(T.lien_admin, { lien: lienBot(s, "admin", l.parametre) }));
          break;
        }
        if (a[0] === "ra") {
          const l = await q(`SELECT id, display_name, telegram_user_id FROM app.people WHERE is_admin AND id <> $1`, [p.id]);
          const retirables = l.filter(x => !s.cfg.adminBootstrapIds.includes(Number(x.telegram_user_id)));
          await ecran(ctx, T.bouton_retirer_admin, clavier([...retirables.map(x => ({ text: x.display_name, callback_data: `a:rg:rx:${x.id}` })), { text: C.retour, callback_data: "a:rg:ad" }]));
          break;
        }
        if (a[0] === "rx") {
          const id = Number(a[1]);
          if (id === p.id) { await repondre(T.pas_soi_meme); break; }
          const x = await un(`SELECT display_name, telegram_user_id FROM app.people WHERE id = $1`, [id]);
          if (!x || s.cfg.adminBootstrapIds.includes(Number(x.telegram_user_id))) break;
          if (!conf && a[2] !== "ok") { await ecran(ctx, `Retirer ${echapper(x.display_name)} ?`, clavier([{ text: TC.bouton_retirer, callback_data: `a:rg:rx:${id}:ok` }, { text: C.annuler, callback_data: "a:rg:ad" }])); break; }
          await q(`UPDATE app.people SET is_admin = false WHERE id = $1`, [id]);
          await bot.api.deleteMyCommands({ scope: { type: "chat", chat_id: Number(x.telegram_user_id) } }).catch(() => undefined);
          await ecran(ctx, f(T.admin_retire, { nom: echapper(x.display_name) }));
          break;
        }
        break;
      }
      default: break;
    }
    await repondre();
  });

  return bot;
}

async function inviter(ctx: Ctx, note: string | null) {
  const l = await creerLien(db(), "new_client", { par: ctx.personne!.id, payload: note ? { note } : {} });
  const lien = lienBot(ctx.s, "client", l.parametre);
  const cle = l.empreinte.slice(0, 8);
  const memo = (ctx.s.memoire.get(-1) as Record<string, string>) || {};
  memo[cle] = lien;
  ctx.s.memoire.set(-1, memo);
  await dire(ctx, f(T.lien_invitation, { nom: echapper(note || "un nouveau client"), lien }),
    { reply_markup: clavier([{ text: T.bouton_qr, callback_data: `a:inv:qr:${cle}` }, { text: T.bouton_supprimer_lien, callback_data: `a:inv:x:${cle}` }]) });
}

async function repondreClient(ctx: Ctx, notifId: number, texte: string) {
  const n = await un(`SELECT * FROM app.notifications WHERE id = $1`, [notifId]);
  if (!n) return;
  const p = await un(`SELECT * FROM app.people WHERE id = $1`, [n.details?.person_id]);
  if (!p?.telegram_user_id) return;
  const id = await envoyer(ctx.s, "client", Number(p.telegram_user_id), f(TC.reponse_mobilab, { texte: echapper(texte) }));
  if (!id) { await dire(ctx, f(T.client_a_bloque, { nom: echapper(p.display_name) }), { reply_markup: sansClavier }); return; }
  await q(`UPDATE app.notifications SET details = details || jsonb_build_object('repondu_par', $2::text) WHERE id = $1`, [notifId, ctx.personne!.display_name]);
  await dire(ctx, T.reponse_envoyee, { reply_markup: sansClavier });
  // Pour les autres admins, le ✉️ est édité : « répondu par Léa » (spec §5.16).
  for (const dst of (n.destinataires || []) as any[]) {
    if (!dst.message_id || dst.chat_id === ctx.chat!.id) continue;
    await ctx.api.editMessageText(dst.chat_id, dst.message_id,
      f(T.notif_message_client, { nom: echapper(p.display_name), ferme: "", texte: echapper(n.details?.texte || "") }).replace(" () ", " ") + f(T.repondu_par, { nom: echapper(prenom(ctx.personne!.display_name)) })).catch(() => undefined);
  }
}
