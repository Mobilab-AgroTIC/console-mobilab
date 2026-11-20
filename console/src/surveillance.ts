// Surveillance (spec V3 §2.5, §5.12, §5.15, §8.11) : contrôles au démarrage, état de la plateforme toutes les 5 min,
// Node-RED et arrivée des trames, résumé du matin, tâches de nuit.
import { q, un, db } from "./db.js";
import { log } from "./log.js";
import { admin as TA, f } from "./textes.fr.js";
import { echapper, depuis, duree, jour, jourHeure, heureParis, taille, nombre } from "./format.js";
import { avertirAdmins, admins, envoyer, effacerEchus, type Services } from "./services.js";
import { creerJob, purgerSecrets } from "./jobs/moteur.js";
import { sqlEmpreinte } from "./tableau.js";

export interface Etat {
  calcule: Date;
  services: { nodered: boolean; ttn: boolean | null; grafana: boolean | null; base: boolean };
  nodered: any;
  messages24h: number;
  derniereTrame: Date | null;
  capteurs: number;
  muets: number;
  fermesMuettes: number;
  jamais: number;
  taches: number;
  inconnus: number;
  ordres: { total: number; echecs: number };
  nonLivres: number;
  attente: number;
  file: number;
  controles: string[];
}

let dernier: Etat | null = null;
let nodeRedPanneDepuis: number | null = null;
let alerteTrames = false;
const controlesDemarrage: string[] = [];

export function etatCourant() { return dernier; }
export function erreursDemarrage() { return controlesDemarrage; }

/** Contrôles au démarrage puis chaque nuit (spec §2.5) ; un échec prévient les admins (§5.15). */
export async function controler(s: Services): Promise<string[]> {
  const err: string[] = [];
  try {
    const r = await un(`SELECT rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    if (!r?.rolcreaterole || !r?.rolbypassrls) err.push("le compte Postgres du service n'a pas CREATEROLE et BYPASSRLS");
    // Rôles de fermes seulement (slug f0042) : le compte du service est aussi lié à « clients », avec ADMIN.
    const dangereux = await q(`SELECT r.rolname FROM pg_roles r JOIN pg_auth_members am ON am.member = r.oid
                               JOIN pg_roles g ON g.oid = am.roleid AND g.rolname = 'clients'
                               WHERE r.rolname ~ '^f[0-9]{4,}$' AND (r.rolbypassrls OR r.rolsuper)`);
    if (dangereux.length) err.push(`rôle de ferme avec BYPASSRLS : ${dangereux.map(x => x.rolname).join(", ")}`);
  } catch (e: any) { err.push(`base : ${e.message}`); }
  if (s.ttn.configure) {
    try {
      const plans = await s.ttn.plansFrequence();
      if (!plans.includes(s.cfg.ttn.frequencyPlan)) err.push(`plan de fréquence ${s.cfg.ttn.frequencyPlan} inconnu de TTN`);
      // L'organisation doit exister et la clé doit pouvoir y lister et créer des applications (spec §6.1).
      let apps: string[] = [];
      try { apps = await s.ttn.listerApplications(); log.info(`TTN : organisation ${s.cfg.ttn.orgId} accessible, ${apps.length} application(s)`); }
      catch (e: any) { err.push(`TTN : organisation « ${s.cfg.ttn.orgId} » inaccessible avec la clé (${e.code || e.message})`); }
      if (apps[0]) {
        const droits = await s.ttn.droits(apps[0]);
        for (const d of ["RIGHT_APPLICATION_DEVICES_WRITE_KEYS", "RIGHT_APPLICATION_DEVICES_READ", "RIGHT_APPLICATION_TRAFFIC_DOWN_WRITE"]) {
          if (!droits.includes(d) && !droits.includes("RIGHT_APPLICATION_ALL")) err.push(`la clé TTN n'a pas le droit ${d.replace("RIGHT_APPLICATION_", "")}`);
        }
      }
    } catch (e: any) { err.push(`TTN : ${e.code || e.message}`); }
  } else err.push("TTN non configuré (TTN_HOST, TTN_API_KEY)");
  if (s.grafana.configure) {
    try {
      const moi = await s.grafana.moi();
      if (!moi.isGrafanaAdmin) err.push("le compte Grafana du service n'est pas administrateur serveur");
    } catch (e: any) { err.push(`Grafana : ${e.code || e.message}`); }
  } else err.push("Grafana non configuré (GRAFANA_ADMIN_USER, GRAFANA_ADMIN_PASSWORD)");
  controlesDemarrage.splice(0, controlesDemarrage.length, ...err);
  return err;
}

async function santeNodeRed(s: Services): Promise<any | null> {
  try {
    const r = await fetch(`${s.cfg.nodeRedUrl}/health`, { headers: { "x-mobilab-secret": s.cfg.ttn.webhookSecret }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Calcule l'état (toutes les 5 min, ou [Actualiser]). Prévient les admins des pannes (urgent). */
export async function calculerEtat(s: Services): Promise<Etat> {
  const nr = await santeNodeRed(s);
  let base = true;
  const e: Etat = { calcule: new Date(), services: { nodered: Boolean(nr), ttn: null, grafana: null, base: true }, nodered: nr,
    messages24h: 0, derniereTrame: null, capteurs: 0, muets: 0, fermesMuettes: 0, jamais: 0, taches: 0, inconnus: 0,
    ordres: { total: 0, echecs: 0 }, nonLivres: 0, attente: 0, file: 0, controles: [...controlesDemarrage] };
  try {
    const r = await un(`SELECT
        (SELECT count(*) FROM public.uplinks WHERE dev_eui IS NOT NULL AND time > now() - interval '24 hours')::int AS messages,
        (SELECT max(time) FROM public.uplinks WHERE dev_eui IS NOT NULL) AS derniere,
        (SELECT count(*) FROM app.devices WHERE ttn_status <> 'supprime')::int AS capteurs,
        (SELECT count(*) FROM app.devices WHERE ttn_status = 'enregistre' AND created_at < now() - interval '60 minutes')::int AS jamais,
        (SELECT count(*) FROM app.jobs WHERE status = 'echec')::int AS taches,
        (SELECT count(*) FROM app.anomalies WHERE resolved_at IS NULL)::int AS inconnus,
        (SELECT count(*) FROM app.commands WHERE requested_at > now() - interval '24 hours')::int AS ordres,
        (SELECT count(*) FROM app.commands WHERE requested_at > now() - interval '24 hours' AND status = 'echec')::int AS echecs,
        (SELECT count(*) FROM app.notifications WHERE audience = 'client' AND created_at > now() - interval '24 hours' AND statut IN ('sans_destinataire', 'echec'))::int AS non_livres,
        (SELECT count(*) FROM app.tenants WHERE status = 'en_attente_activation')::int AS attente,
        (SELECT count(*) FROM app.notifications WHERE statut = 'a_envoyer' AND envoyer_apres < now() - interval '10 minutes')::int AS file`);
    const m = await un(`SELECT count(*)::int AS n, count(DISTINCT d.tenant_slug)::int AS fermes FROM app.alert_state s
                        JOIN app.alert_rules r ON r.id = s.rule_id AND r.kind = 'silence' JOIN app.devices d ON d.dev_eui = r.dev_eui
                        WHERE s.state = 'alarm' AND d.ttn_status <> 'supprime'`);
    Object.assign(e, { messages24h: r.messages, derniereTrame: r.derniere, capteurs: r.capteurs, jamais: r.jamais, taches: r.taches,
      inconnus: r.inconnus, ordres: { total: r.ordres, echecs: r.echecs }, nonLivres: r.non_livres, attente: r.attente, file: r.file,
      muets: m.n, fermesMuettes: m.fermes });
  } catch (err: any) { base = false; log.error(`état : base injoignable (${err.message})`); }
  e.services.base = base;
  if (s.grafana.configure) e.services.grafana = await s.grafana.sante().then(() => true).catch(() => false);
  if (s.ttn.configure) e.services.ttn = await s.ttn.plansFrequence().then(() => true).catch(() => false);
  // Node-RED surveillé par le service (spec §2.5) : panne après 10 min, retour annoncé.
  if (!nr) {
    if (!nodeRedPanneDepuis) nodeRedPanneDepuis = Date.now();
    else if (Date.now() - nodeRedPanneDepuis > 10 * 60000 && !(dernier && !dernier.services.nodered && dernier.calcule.getTime() - nodeRedPanneDepuis > 10 * 60000)) {
      await avertirAdmins(s, f(TA.notif_nodered_panne, { duree: duree(Date.now() - nodeRedPanneDepuis) }), { urgent: true });
    }
  } else if (nodeRedPanneDepuis) {
    if (Date.now() - nodeRedPanneDepuis > 10 * 60000) await avertirAdmins(s, f(TA.notif_nodered_retour, { duree: duree(Date.now() - nodeRedPanneDepuis) }), { urgent: true });
    nodeRedPanneDepuis = null;
  }
  // Plus aucune trame depuis 30 min, toutes fermes confondues (§8.11) — seulement s'il y a des capteurs V3.
  if (e.capteurs > 0 && e.derniereTrame && Date.now() - new Date(e.derniereTrame).getTime() > 30 * 60000) {
    if (!alerteTrames) { alerteTrames = true; await avertirAdmins(s, TA.notif_plus_de_trame, { urgent: true, clavier: { inline_keyboard: [[{ text: "État", callback_data: "a:etat" }]] } }); }
  } else alerteTrames = false;
  dernier = e;
  return e;
}

/** Texte de /etat (spec §5.12). */
export function texteEtat(e: Etat, version: string): { texte: string; boutons: { text: string; callback_data: string }[] } {
  const ok = (b: boolean | null) => (b === null ? "—" : b ? "✅" : "❌");
  const l = [f(TA.etat_titre, { date: jourHeure(e.calcule) })];
  const boutons: { text: string; callback_data: string }[] = [];
  const probleme = !e.services.nodered || e.services.ttn === false || e.services.grafana === false || !e.services.base || e.muets || e.jamais
    || e.taches || e.inconnus || e.ordres.echecs || e.nonLivres || e.file || e.controles.length;
  if (!probleme) {
    l.push(f(TA.etat_ok, { capteurs: nombre(e.capteurs, 0), messages: nombre(e.messages24h, 0), version: echapper(version) }));
  } else {
    l.push(f(TA.etat_services, { nodered: ok(e.services.nodered), ttn: ok(e.services.ttn), grafana: ok(e.services.grafana), base: ok(e.services.base) }));
    l.push(f(TA.etat_messages, { duree: e.derniereTrame ? depuis(e.derniereTrame) : "?", n: nombre(e.messages24h, 0) }));
    if (e.muets || e.jamais) { l.push(f(TA.etat_muets, { n: e.muets, fermes: e.fermesMuettes, jamais: e.jamais })); boutons.push({ text: TA.bouton_muets, callback_data: "a:etat:mu" }); }
    if (e.taches) { l.push(f(TA.etat_taches, { n: e.taches })); boutons.push({ text: TA.bouton_taches, callback_data: "a:etat:ta" }); }
    if (e.inconnus) { l.push(f(TA.etat_inconnus, { n: e.inconnus })); boutons.push({ text: TA.bouton_a_identifier, callback_data: "a:etat:in" }); }
    if (e.ordres.echecs) { l.push(f(TA.etat_ordres, { echecs: e.ordres.echecs, total: e.ordres.total })); boutons.push({ text: TA.bouton_commandes, callback_data: "a:etat:co" }); }
    if (e.nonLivres || e.attente) l.push(f(TA.etat_non_livres, { n: e.nonLivres, attente: e.attente }));
    if (e.file) l.push(f(TA.etat_file, { n: e.file }));
    if (e.nodered?.rejets) l.push(f(TA.etat_rejets, { n: e.nodered.rejets }));
    if (e.nodered?.spool_octets) l.push(f(TA.etat_spool, { taille: taille(e.nodered.spool_octets) }));
    for (const c of e.controles) l.push(f(TA.etat_controles, { erreur: echapper(c) }));
  }
  boutons.push({ text: TA.bouton_passerelles, callback_data: "a:gw" }, { text: TA.bouton_actualiser, callback_data: "a:etat:r" });
  return { texte: l.join("\n"), boutons: boutons.slice(0, 6) };
}

/** Résumé du matin (spec §5.15) : envoyé même les jours sans rien, il prouve que le service tourne. */
export async function resumeDuMatin(s: Services, adminId?: number) {
  const aujourdhui = jour(new Date());
  const muets = await q(`SELECT t.display_name, d.name, s.since FROM app.alert_state s JOIN app.alert_rules r ON r.id = s.rule_id AND r.kind = 'silence'
                         JOIN app.devices d ON d.dev_eui = r.dev_eui JOIN app.tenants t ON t.slug = d.tenant_slug
                         WHERE s.state = 'alarm' AND d.ttn_status <> 'supprime' ORDER BY t.display_name, d.name`);
  const piles = await q(`SELECT d.name FROM app.alert_state s JOIN app.alert_rules r ON r.id = s.rule_id AND r.kind = 'battery'
                         JOIN app.devices d ON d.dev_eui = r.dev_eui WHERE s.state = 'alarm' AND d.ttn_status <> 'supprime'`);
  const attente = await q(`SELECT t.display_name, t.created_at,
                           (SELECT count(*) FROM app.notifications n WHERE n.tenant_slug = t.slug AND n.kind = 'alerte' AND n.transition = 'alarme'
                            AND n.created_at > now() - interval '1 day')::int AS alertes
                           FROM app.tenants t WHERE t.status = 'en_attente_activation'`);
  const bloques = await q(`SELECT p.display_name, (SELECT string_agg(t.display_name, ', ') FROM app.memberships m JOIN app.tenants t ON t.slug = m.tenant_slug
                           WHERE m.person_id = p.id) AS fermes FROM app.people p WHERE p.unreachable_since IS NOT NULL`);
  const sansReponse = await un(`SELECT count(*)::int AS n FROM app.notifications WHERE kind = 'message_client' AND created_at < now() - interval '24 hours'
                                AND created_at > now() - interval '7 days' AND NOT (details ? 'repondu_par')`);
  const hier = await un(`SELECT (SELECT count(*) FROM public.uplinks WHERE dev_eui IS NOT NULL AND time > now() - interval '1 day')::int AS messages,
                         (SELECT count(*) FROM app.notifications WHERE kind = 'alerte' AND transition = 'alarme' AND created_at > now() - interval '1 day')::int AS alertes,
                         (SELECT count(*) FROM app.jobs WHERE status = 'echec' AND updated_at > now() - interval '1 day')::int AS taches`);
  const nuit = await q(`SELECT t.display_name, j.result FROM app.jobs j JOIN app.tenants t ON t.slug = j.tenant_slug
                        WHERE j.kind = 'verifier_ferme' AND j.updated_at > now() - interval '1 day' AND jsonb_array_length(coalesce(j.result->'reparations', '[]'::jsonb)) > 0`);
  const effacees = await q(`SELECT t.display_name FROM app.audit a JOIN app.tenants t ON t.slug = a.tenant_slug
                            WHERE a.action = 'ferme effacée' AND a.at > now() - interval '1 day'`);
  const l: string[] = [];
  if (muets.length) {
    const fermes = new Set(muets.map(m => m.display_name));
    l.push(f(TA.resume_muets, { n: muets.length, fermes: fermes.size }));
    for (const fe of fermes) l.push(`  ${echapper(fe)} : ${muets.filter(m => m.display_name === fe).map(m => `${echapper(m.name)} (${depuis(m.since)})`).join(", ")}`);
  }
  if (piles.length) l.push(f(TA.resume_piles, { n: piles.length, liste: piles.slice(0, 5).map(p => echapper(p.name)).join(", ") + (piles.length > 5 ? ", …" : "") }));
  if (attente.length) l.push(f(TA.resume_attente, { liste: attente.map(a => `${echapper(a.display_name)} (${depuis(a.created_at)}, ${a.alertes} alerte(s) hier)`).join(", ") }));
  if (bloques.length) l.push(f(TA.resume_bloques, { liste: bloques.map(b => `${echapper(b.display_name)} (${echapper(b.fermes || "—")})`).join(", ") }));
  if (sansReponse?.n) l.push(f(TA.resume_sans_reponse, { n: sansReponse.n }));
  for (const n of nuit) l.push(`Nuit : ${(n.result.reparations || []).join(", ")} réparé chez ${echapper(n.display_name)} ✅`);
  for (const e of effacees) l.push(`🗑 ${echapper(e.display_name)} effacée`);
  const hierTxt = f(TA.resume_hier, { messages: nombre(hier.messages, 0), alertes: hier.alertes, taches: hier.taches });
  const texte = l.length ? [f(TA.resume_titre, { date: aujourdhui }), ...l, hierTxt].join("\n") : f(TA.resume_rien, { date: aujourdhui });
  for (const a of await admins()) {
    if (adminId && a.id !== adminId) continue;
    await envoyer(s, "admin", Number(a.telegram_user_id), texte, l.length ? { inline_keyboard: [[{ text: TA.bouton_muets, callback_data: "a:etat:mu" }, { text: "État", callback_data: "a:etat" }]] } : undefined);
  }
}

/** Fermes dont le tableau ne trace pas toutes les mesures reçues (empreinte changée), sans vérification déjà en file. */
export async function fermesAMettreAJour(): Promise<string[]> {
  const l = await q(`SELECT t.slug FROM app.tenants t WHERE t.status = 'actif' AND t.grafana_org_id IS NOT NULL
      AND coalesce(t.config->'grafana'->>'mesures', '') <> ${sqlEmpreinte("t.slug")}
      AND NOT EXISTS (SELECT 1 FROM app.jobs j WHERE j.kind = 'verifier_ferme' AND j.tenant_slug = t.slug AND j.status IN ('en_attente', 'en_cours'))`);
  return l.map(x => x.slug);
}

/** Boucle de surveillance : toutes les 5 min, résumé à l'heure de chaque admin, tâches de nuit à 3 h. */
export function demarrerSurveillance(s: Services) {
  let derniereNuit = "", resumes = new Map<number, string>();
  const tour = async () => {
    try {
      await calculerEtat(s);
      await effacerEchus(s);
      // Mesure nouvelle (sonde branchée, nouvelle voie) : « Mes capteurs » est refait, sa courbe apparaît.
      for (const slug of await fermesAMettreAJour()) await creerJob(db(), { kind: "verifier_ferme", tenant: slug, params: { tableau_seulement: true } });
      const cle = new Date().toISOString().slice(0, 10);
      const h = heureParis();
      for (const a of await admins()) {
        const heure = Number(a.settings?.heure_resume ?? 8);
        if (h === heure && resumes.get(a.id) !== cle) { resumes.set(a.id, cle); await resumeDuMatin(s, a.id); }
      }
      if (h === 3 && derniereNuit !== cle) {
        derniereNuit = cle;
        await controler(s);
        await purgerSecrets();
        await q(`DELETE FROM app.bot_sessions WHERE updated_at < now() - interval '7 days' AND key NOT LIKE 'effacer:%'`);
        await q(`DELETE FROM app.anomalies WHERE resolved_at < now() - interval '90 days'`);
        await q(`DELETE FROM app.audit WHERE at < now() - interval '3 years'`);
        for (const t of await q(`SELECT slug FROM app.tenants WHERE status IN ('actif', 'en_attente_activation', 'suspendu', 'suppression') AND grafana_org_id IS NOT NULL`)) {
          await creerJob(db(), { kind: "verifier_ferme", tenant: t.slug });
        }
      }
    } catch (e: any) {
      log.error(`surveillance : ${e?.message || e}`);
    }
  };
  void tour();
  return setInterval(() => void tour(), 5 * 60000);
}
