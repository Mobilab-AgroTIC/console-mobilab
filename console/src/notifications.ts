// Distributeur des notifications « service » (spec V3 §2.1, §8.10) : Node-RED (et le service lui-même) écrit
// une ligne app.notifications puis pg_notify('console', id). Le service l'envoie ; il relit aussi chaque minute
// les lignes restées à envoyer (un NOTIFY reçu pendant un redémarrage est perdu).
import type pg from "pg";
import { db, q, un, json } from "./db.js";
import { log } from "./log.js";
import { client as TC, admin as TA, f } from "./textes.fr.js";
import { echapper, heure } from "./format.js";
import { court } from "./codes.js";
import { modelesProposes, montagesMobilab, modele as modeleDe, voiesDe, sondesPour, boutonModele } from "./catalogue.js";
import { envoyer, modifier, avertirAdmins, nomFerme, type Services, type QuelBot } from "./services.js";
import { creerJob } from "./jobs/moteur.js";
import { annoncerPremiereMesure } from "./jobs/taches.js";

type Notif = { id: number; audience: string; kind: string; tenant_slug: string | null; dev_eui: string | null; details: any; created_at: Date };

const URGENTS = new Set(["panne_reseau", "tache_echec_urgent", "bot_demarrage"]);

export class Distributeur {
  private ecoute: pg.PoolClient | null = null;
  private minuterie: NodeJS.Timeout | null = null;
  private enCours = false;
  constructor(private s: Services) {}

  async demarrer() {
    this.ecoute = await db().connect();
    this.ecoute.on("notification", () => void this.traiter());
    await this.ecoute.query("LISTEN console");
    this.minuterie = setInterval(() => void this.traiter(), 60000);
    void this.traiter();
  }

  async arreter() {
    if (this.minuterie) clearInterval(this.minuterie);
    if (this.ecoute) { await this.ecoute.query("UNLISTEN console").catch(() => undefined); this.ecoute.release(); }
  }

  async traiter() {
    if (this.enCours) return;
    this.enCours = true;
    try {
      await q(`UPDATE app.notifications SET statut = 'a_envoyer' WHERE expediteur = 'service' AND statut = 'en_cours' AND created_at < now() - interval '10 minutes'`);
      for (;;) {
        const l = await q<Notif>(
          `UPDATE app.notifications SET statut = 'en_cours'
           WHERE id IN (SELECT id FROM app.notifications WHERE expediteur = 'service' AND statut = 'a_envoyer' AND envoyer_apres <= now()
                        ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING *`);
        if (!l.length) break;
        for (const n of l) {
          try {
            const statut = await this.une(n);
            await q(`UPDATE app.notifications SET statut = $2 WHERE id = $1 AND statut = 'en_cours'`, [n.id, statut]);
          } catch (e: any) {
            log.error(`notification ${n.id} (${n.kind}) : ${e?.message || e}`);
            await q(`UPDATE app.notifications SET statut = 'echec', erreur = $2 WHERE id = $1`, [n.id, String(e?.message || e).slice(0, 200)]);
          }
        }
      }
    } finally {
      this.enCours = false;
    }
  }

  private async capteur(dev: string | null) {
    if (!dev) return null;
    return un(`SELECT d.*, t.display_name AS ferme, t.status AS statut_ferme FROM app.devices d JOIN app.tenants t ON t.slug = d.tenant_slug WHERE d.dev_eui = $1`, [dev]);
  }

  /** Destinataire des questions sur un capteur : la personne qui l'a ajouté (un admin pour /ajouter_pour, spec §4.4). */
  private async auteur(d: any): Promise<{ bot: QuelBot; chat: number; id: number } | null> {
    if (!d?.created_by) return null;
    const p = await un(`SELECT id, telegram_user_id, is_admin FROM app.people WHERE id = $1`, [d.created_by]);
    if (!p?.telegram_user_id) return null;
    const membre = await un(`SELECT 1 FROM app.memberships WHERE person_id = $1 AND tenant_slug = $2 AND status = 'actif'`, [p.id, d.tenant_slug]);
    return { bot: p.is_admin && !membre ? "admin" : "client", chat: Number(p.telegram_user_id), id: p.id };
  }

  /** Renvoie le statut final de la ligne. */
  private async une(n: Notif): Promise<string> {
    const s = this.s;
    const d = await this.capteur(n.dev_eui);
    const det = n.details || {};
    const nom = echapper(d?.name || n.dev_eui || "");
    const ferme = echapper(d?.ferme || (n.tenant_slug ? await nomFerme(n.tenant_slug) : ""));
    switch (n.kind) {
      case "premiere_mesure": {
        if (det.attente_sondes) return "ecarte";           // annoncée après la question des sondes
        await annoncerPremiereMesure(s, n.dev_eui!);
        return "envoye";
      }
      case "modele_identifie": {
        if (!d) return "ecarte";
        const r = await q(`UPDATE app.devices SET model_key = $2, config = config || jsonb_build_object('model_source', $3::text)
                           WHERE dev_eui = $1 AND model_key IS NULL RETURNING dev_eui`, [d.dev_eui, det.model_key, det.par || "detecte"]);
        if (r.length) await creerJob(db(), { kind: "mise_en_service", tenant: d.tenant_slug, dev_eui: d.dev_eui, params: { redecoder: true } });
        return "envoye";
      }
      case "modele_a_choisir": {
        const a = await this.auteur(d);
        if (!a || d.model_key) return "sans_destinataire";
        const modeles = modelesProposes(d.dev_eui);
        const pre = a.bot === "admin" ? "a:" : "";
        const boutons = modeles.map((m, i) => ({ text: boutonModele(m), callback_data: `${pre}md:${d.dev_eui}:${i}` }));
        if (montagesMobilab().length) boutons.push({ text: TC.bouton_fait_maison, callback_data: `${pre}mt:${d.dev_eui}:l` });
        boutons.push({ text: TC.bouton_autre, callback_data: `${pre}md:${d.dev_eui}:a` });
        const lignes: { text: string; callback_data: string }[][] = [];
        for (const b of boutons) lignes.push([b]);
        const texte = a.bot === "admin" ? f(TA.modele_question_admin, { capteur: nom, ferme }) : f(TC.modele_question, { capteur: nom });
        const id = await envoyer(s, a.bot, a.chat, texte, { inline_keyboard: lignes });
        return id ? "envoye" : "echec";
      }
      case "sondes_a_preciser": {
        const a = await this.auteur(d);
        if (!a) return "sans_destinataire";
        const id = await questionSonde(s, a.bot, a.chat, d, 0, Boolean(det.premiere_mesure ?? true));
        return id ? "envoye" : "sans_destinataire";
      }
      case "commande": {
        const cmd = await un(`SELECT c.*, p.display_name AS auteur FROM app.commands c LEFT JOIN app.people p ON p.id = c.requested_by WHERE c.id = $1`, [det.command_id]);
        if (!cmd || !d) return "ecarte";
        const bot: QuelBot = cmd.via === "bot" ? "client" : "admin";
        const action = actionDe(d, cmd.action);
        if (cmd.status === "envoyee") await modifier(s, bot, cmd.chat_id, cmd.message_id, f(TC.ordre_parti, { capteur: nom }));
        else if (cmd.status === "confirmee") {
          const h = heure(cmd.confirmed_at || new Date());
          await modifier(s, bot, cmd.chat_id, cmd.message_id, f(TC.ordre_confirme, { capteur: nom, action: echapper(action), heure: h }));
          const t = await un(`SELECT alert_chat_id FROM app.tenants WHERE slug = $1`, [d.tenant_slug]);
          if (t?.alert_chat_id) await envoyer(s, "client", Number(t.alert_chat_id), f(TC.groupe_ordre_ok, { qui: echapper(cmd.auteur || "Mobilab"), action: echapper(action), capteur: nom, heure: h }));
        } else if (cmd.status === "echec") {
          await modifier(s, bot, cmd.chat_id, cmd.message_id, f(TC.ordre_echec, { capteur: nom }));
          await avertirAdmins(s, f(TA.notif_commande_echec, { action: echapper(action), capteur: nom, ferme, raison: "échec" }), { urgent: true });
        }
        return "envoye";
      }
      case "anomalie": {
        const a = await un(`SELECT * FROM app.anomalies WHERE id = $1`, [det.anomalie_id]);
        if (!a) return "ecarte";
        let texte: string;
        if (a.raison === "deveui_inconnu") texte = f(TA.notif_inconnu, { deveui: court(a.dev_eui || ""), app: echapper(a.application_id || "?"), n: a.count });
        else if (a.raison === "modele_inconnu") texte = f(TA.notif_modele_inconnu, { capteur: nom, ferme,
          detail: det.port5_code ? ` (port 5 : ${det.port5_code})` : det.contredit ? ` (port 5 : ${echapper(det.lu || det.port5_code || "?")}, choisi : ${echapper(det.model_key)})` : "" });
        else if (a.raison === "decodage") texte = f(TA.notif_decodage, { capteur: nom, ferme });
        else texte = f(TA.notif_autre_anomalie, { raison: a.raison.replace(/_/g, " "), objet: d ? `${nom} (${ferme})` : court(a.dev_eui || "") });
        await avertirAdmins(s, texte, { notificationId: n.id, clavier: { inline_keyboard: [[{ text: TA.bouton_a_identifier, callback_data: `a:ano:${a.id}:v` }]] } });
        return "envoye";
      }
      case "deja_enregistre": {
        const autre = await un(`SELECT d.name, t.display_name FROM app.devices d JOIN app.tenants t ON t.slug = d.tenant_slug WHERE d.dev_eui = $1`, [n.dev_eui]);
        const demandeur = n.tenant_slug ? await nomFerme(n.tenant_slug) : "?";
        const an = await un<{ id: number }>(
          `INSERT INTO app.anomalies (raison, tenant_slug, dev_eui, details) VALUES ('deja_enregistre', $1, $2, $3::jsonb)
           ON CONFLICT (raison, coalesce(tenant_slug, ''), coalesce(dev_eui, ''), coalesce(gateway_id, '')) WHERE resolved_at IS NULL
           DO UPDATE SET count = app.anomalies.count + 1, last_seen = now() RETURNING id`, [n.tenant_slug, n.dev_eui, json(det)]);
        await avertirAdmins(s, f(TA.notif_deja_enregistre, { deveui: court(n.dev_eui || ""), ferme: echapper(demandeur),
          autre: echapper(autre?.display_name || "TTN"), capteur: echapper(autre?.name || "?") }), { notificationId: n.id,
          clavier: { inline_keyboard: [[{ text: TA.bouton_ignorer, callback_data: `a:ano:${an?.id}:i` }, { text: TA.bouton_a_identifier, callback_data: `a:ano:${an?.id}:v` }]] } });
        return "envoye";
      }
      case "tache_echec": {
        const job = await un(`SELECT * FROM app.jobs WHERE id = $1`, [det.job_id]);
        if (!job) return "ecarte";
        // L'admin qui a lancé la tâche voit son propre message édité (spec §5.15) : les autres reçoivent la notification.
        const objet = job.params?.nom || n.dev_eui || n.tenant_slug || "";
        const texte = f(TA.notif_tache_echec, { kind: job.kind, objet: `${echapper(objet)}${ferme ? ` (${ferme})` : ""}`, etape: det.etape, erreur: echapper(det.erreur) });
        await avertirAdmins(s, texte, { urgent: true, notificationId: n.id,
          clavier: { inline_keyboard: [[{ text: TA.bouton_relancer, callback_data: `a:job:r:${job.id}` }, { text: TA.bouton_voir_fiche, callback_data: n.tenant_slug ? `a:cli:${n.tenant_slug}` : "a:etat" }]] } });
        return "envoye";
      }
      case "nouveau_client":
        await avertirAdmins(s, f(TA.notif_nouveau_client, { ferme, nom: echapper(det.nom || "?"), par: echapper(det.par || "—") }),
          { notificationId: n.id, clavier: { inline_keyboard: [[{ text: TA.bouton_voir_fiche, callback_data: `a:cli:${n.tenant_slug}` }]] } });
        return "envoye";
      case "ferme_activee":
        await avertirAdmins(s, f(TA.notif_ferme_activee, { ferme, nom: echapper(det.nom || "?") }),
          { notificationId: n.id, clavier: { inline_keyboard: [[{ text: TA.bouton_voir_fiche, callback_data: `a:cli:${n.tenant_slug}` }]] } });
        return "envoye";
      case "coupure_auto":
        await avertirAdmins(s, f(TA.notif_coupure_auto, { capteur: nom, ferme, n: det.alertes_24h || 6 }), { notificationId: n.id,
          clavier: { inline_keyboard: [[{ text: TC.bouton_alertes, callback_data: `a:dev:${n.dev_eui}` }]] } });
        return "envoye";
      case "panne_reseau":
        await avertirAdmins(s, f(TA.notif_panne_reseau, { n: det.capteurs, fermes: det.fermes, passerelles: echapper((det.passerelles || []).join(", ") || "?") }),
          { urgent: true, notificationId: n.id, clavier: { inline_keyboard: [[{ text: TA.bouton_passerelles, callback_data: "a:gw" }]] } });
        return "envoye";
      case "mode_change":
        await avertirAdmins(s, f(TA.notif_mode_change, { capteur: nom, ferme, avant: echapper(det.avant), apres: echapper(det.apres) }), { notificationId: n.id });
        return "envoye";
      case "mode_non_decrit":
        await avertirAdmins(s, f(TA.notif_mode_non_decrit, { capteur: nom, ferme, mode: echapper(det.mode) }), { notificationId: n.id });
        return "envoye";
      case "bande":
        await avertirAdmins(s, f(TA.notif_bande, { capteur: nom, ferme, bande: echapper(det.bande) }), { notificationId: n.id });
        return "envoye";
      case "catalogue_refuse":
        await avertirAdmins(s, f(TA.notif_catalogue_refuse, { erreur: echapper(det.erreur) }), { notificationId: n.id });
        return "envoye";
      case "groupe_perdu": {
        const t = await un(`SELECT display_name FROM app.tenants WHERE slug = $1`, [n.tenant_slug]);
        for (const m of await q(`SELECT p.telegram_user_id FROM app.memberships m JOIN app.people p ON p.id = m.person_id
                                 WHERE m.tenant_slug = $1 AND m.role = 'proprietaire' AND p.telegram_user_id IS NOT NULL`, [n.tenant_slug])) {
          await envoyer(s, "client", Number(m.telegram_user_id), f(TC.groupe_perdu, { groupe: echapper(t?.display_name || "") }));
        }
        await avertirAdmins(s, f(TA.notif_groupe_perdu, { ferme }), { notificationId: n.id });
        return "envoye";
      }
      case "bot_bloque":
      case "message_client":
      case "demande_acces":
        return "envoye";                                  // repris par le résumé du matin ou déjà envoyé par le bot
      case "nouvel_admin":
        await avertirAdmins(s, f(TA.notif_nouvel_admin, { nom: echapper(det.nom), par: echapper(det.par) }), { notificationId: n.id });
        return "envoye";
      case "sonde_autre":
        await avertirAdmins(s, f(TA.notif_sonde_autre, { capteur: nom, ferme, choix: echapper(det.choix), n: det.entree }), { notificationId: n.id,
          clavier: { inline_keyboard: [[{ text: TC.bouton_alertes.replace("🔔 Alertes", "Voir le capteur"), callback_data: `a:dev:${n.dev_eui}` }]] } });
        return "envoye";
      case "conseiller_reponse":
        await avertirAdmins(s, f(det.accepte ? TA.notif_conseiller_ok : TA.notif_conseiller_non, { proprietaire: echapper(det.proprietaire), nom: echapper(det.nom) }),
          { notificationId: n.id, seulement: det.admin_id || null });
        return "envoye";
      case "erreur_interne":
        await avertirAdmins(s, f(TA.notif_erreur_interne, { code: det.code, ou: echapper(det.ou) }), { notificationId: n.id });
        return "envoye";
      default:
        if (n.audience === "admin") {
          await avertirAdmins(s, `ℹ️ ${echapper(n.kind)} ${ferme ? `(${ferme})` : ""}`, { urgent: URGENTS.has(n.kind), notificationId: n.id });
          return "envoye";
        }
        return "ecarte";
    }
  }
}

export function actionDe(d: any, cle: string): string {
  const m = modeleDe(d?.model_key);
  const a = [...(m?.actions || []), ...((d?.config?.actions || []) as any[])].find((x: any) => x.cle === cle);
  return a?.bouton || cle;
}

/** Question « Qu'est-ce qui est branché sur l'entrée n ? » (spec §4.4). Envoie la première voie sans sonde à partir de `depuis`. */
export async function questionSonde(s: Services, bot: QuelBot, chat: number, d: any, depuis: number, premiere: boolean): Promise<number | null> {
  const m = modeleDe(d.model_key || d.config?.detected?.modele_lu);
  const mode = d.mode_override || d.config?.detected?.mode_lu || null;
  const voies = voiesDe(m, mode);
  for (let i = depuis; i < voies.length; i++) {
    if (d.probes?.[voies[i]]) continue;
    const pre = bot === "admin" ? "a:" : "";
    const boutons = sondesPour(m, voies[i]).filter(x => !x.sonde.brut_seulement)
      .map(x => ({ text: x.sonde.libelle, callback_data: `${pre}ps:${d.dev_eui}:${i + 1}:${x.rang}${premiere ? "p" : ""}` }));
    boutons.push({ text: TC.bouton_rien, callback_data: `${pre}ps:${d.dev_eui}:${i + 1}:r${premiere ? "p" : ""}` });
    boutons.push({ text: TC.bouton_sais_pas, callback_data: `${pre}ps:${d.dev_eui}:${i + 1}:u${premiere ? "p" : ""}` });
    const lignes: { text: string; callback_data: string }[][] = [];
    for (let k = 0; k < boutons.length; k += 2) lignes.push(boutons.slice(k, k + 2));
    return envoyer(s, bot, chat, f(TC.sonde_question, { n: i + 1, capteur: echapper(d.name) }), { inline_keyboard: lignes });
  }
  return null;
}
