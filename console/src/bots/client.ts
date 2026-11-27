// Bot client (spec V3 §4) : agriculteurs, collègues, conseillers, groupes.
// Chaque commande et chaque bouton revérifie le droit sur la ferme (§4.2) ; un bouton ne vaut jamais autorisation.
import { Bot, session, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";
import { db, q, un, tx, json, audit, notifier } from "../db.js";
import { client as T, commun as C, alertes as TA, f } from "../textes.fr.js";
import { echapper, depuis, duree, quand, heure, jour, avecUnite, reception, prenom, nomTelegram, nombre, texteIntervalle, lireIntervalle } from "../format.js";
import { controler, groupes, nettoyer } from "../codes.js";
import { creerLien, lireParametre, consommer, fermeDuLien } from "../invitations.js";
import { chiffrer, dechiffrer, codeErreur } from "../crypto.js";
import { modele as modeleDe, definition, pourcentagePile, pileFaible, mesuresAlertables, modesDe, voiesDe, sondesPour, modelesProposes, montagesMobilab, moduleIngest,
  marques, typesDeMarque, libelleMarque, libelleModele,
  catalogue, boutonModele, nomCommercial, categoriesDeMarque, actionDe, INTERVALLE, intervalleReglable, ordreIntervalle, type Modele } from "../catalogue.js";
import { creerJob, chiffrerSecret } from "../jobs/moteur.js";
import { appDe, idTtn } from "../jobs/taches.js";
import { envoyer, avertirAdmins, lienBot, type Services } from "../services.js";
import { questionSonde } from "../notifications.js";
import { log } from "../log.js";
import { type Ctx, type Session, stockage, chargerPersonne, demarrer, finir, conversation, clavier, lignes, clavierAnnuler,
  sansClavier, retirerClavier, ecran, dire, tropAncien, DEVEUI, SLUG } from "./commun.js";
import { fermesDe, adhesion, ferme as lireFerme, capteur as lireCapteur, capteursDe, etatCapteur, regles, proprietaires,
  type FermeDe, type Role } from "./donnees.js";

const PAR_PAGE = 8;
const ROLE_TXT: Record<string, string> = { proprietaire: T.role_proprietaire, membre: T.role_membre, conseiller: T.role_conseiller };

// ===================================================================== droits

type Niveau = "voir" | "regler" | "proprietaire";

/** Vérifie le droit de la personne sur la ferme ; répond lui-même en cas de refus (spec §4.2, §4.14). */
async function droit(ctx: Ctx, slug: string, niveau: Niveau): Promise<{ role: Role; display_name: string } | null> {
  const p = ctx.personne;
  if (ctx.session.support?.tenant === slug && p?.is_admin) return { role: "proprietaire", display_name: (await lireFerme(slug))?.display_name };
  const a = p ? await adhesion(p.id, slug) : null;
  const refuser = async (t: string) => { if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t }).catch(() => undefined); else await dire(ctx, t); };
  if (!a || a.status !== "actif" || ["suppression", "supprime"].includes(a.tenant_status)) { await refuser(T.plus_acces_bouton); return null; }
  if (a.tenant_status === "suspendu") { await refuser(f(T.ferme_pause, { ferme: a.display_name })); return null; }
  if (niveau === "regler" && a.role === "conseiller") { await refuser(T.reserve_ferme); return null; }
  if (niveau === "proprietaire" && a.role !== "proprietaire") { await refuser(T.reserve_ferme); return null; }
  return a;
}

async function droitCapteur(ctx: Ctx, dev: string, niveau: Niveau) {
  if (!DEVEUI.test(dev)) return null;
  const d = await lireCapteur(dev);
  if (!d || d.ttn_status === "supprime") {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: T.capteur_disparu }).catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    } else await dire(ctx, T.capteur_disparu);
    return null;
  }
  const a = await droit(ctx, d.tenant_slug, niveau);
  return a ? { d, a } : null;
}

/** Choix de la ferme quand il y en a plusieurs (spec §4.10). Renvoie la ferme ou null (l'écran de choix est affiché). */
async function choisirFerme(ctx: Ctx, ecranCode: string, filtre?: (x: FermeDe) => boolean): Promise<FermeDe | null> {
  const p = ctx.personne!;
  if (ctx.session.support) {
    const t = await lireFerme(ctx.session.support.tenant);
    return { slug: t.slug, display_name: t.display_name, status: t.status, role: "proprietaire", receives_alerts: false,
             grafana_org_id: t.grafana_org_id, alert_chat_id: t.alert_chat_id, grafana_role: "Admin" };
  }
  let l = await fermesDe(p.id);
  if (filtre) l = l.filter(filtre);
  if (!l.length) {
    await dire(ctx, T.plus_aucune_ferme, { reply_markup: clavier([{ text: T.bouton_demander_acces, callback_data: "rq" }]) });
    return null;
  }
  if (l.length === 1) return l[0];
  const lignesTxt: string[] = [T.vos_fermes];
  for (const x of l) {
    if (x.status === "suspendu") { lignesTxt.push(f(T.ferme_ligne_pause, { ferme: echapper(x.display_name) })); continue; }
    const st = await un(`SELECT count(*) FILTER (WHERE d.ttn_status <> 'supprime')::int AS n,
                          (SELECT count(*) FROM app.alert_state s JOIN app.alert_rules r ON r.id = s.rule_id JOIN app.devices d2 ON d2.dev_eui = r.dev_eui
                           WHERE d2.tenant_slug = $1 AND s.state = 'alarm' AND d2.ttn_status <> 'supprime')::int AS alertes
                         FROM app.devices d WHERE d.tenant_slug = $1`, [x.slug]);
    lignesTxt.push(st.alertes ? f(T.ferme_ligne_alerte, { ferme: echapper(x.display_name), n: st.alertes })
      : f(T.ferme_ligne_ok, { ferme: echapper(x.display_name), n: st.n }));
  }
  await ecran(ctx, lignesTxt.join("\n"), clavier(l.map(x => ({ text: x.display_name, callback_data: `fm:${x.slug}:${ecranCode}` }))));
  return null;
}

// ===================================================================== /capteurs et fiche (§4.5)

async function ecranListe(ctx: Ctx, slug: string, page = 0) {
  if (!(await droit(ctx, slug, "voir"))) return;
  ctx.session.ferme = slug;
  const t = await lireFerme(slug);
  const l = await capteursDe(slug);
  if (!l.length) {
    await ecran(ctx, `🏡 <b>${echapper(t.display_name)}</b>\n\n${T.aucun_capteur}`, clavier([{ text: T.bouton_ajouter_capteur, callback_data: `fm:${slug}:j` }]));
    return;
  }
  const tries = l.map(c => ({ c, e: etatCapteur(c) })).sort((a, b) => a.e.rang - b.e.rang || a.c.name.localeCompare(b.c.name, "fr"));
  const pages = Math.ceil(tries.length / PAR_PAGE);
  page = Math.max(0, Math.min(page, pages - 1));
  const morceau = tries.slice(page * PAR_PAGE, (page + 1) * PAR_PAGE);
  const texte = [l.length === 1 ? f(T.liste_titre_un, { ferme: echapper(t.display_name) }) : f(T.liste_titre, { ferme: echapper(t.display_name), n: l.length })];
  // Une seule liste : chaque capteur est un bouton avec son état et ses valeurs (choix du 19/11, la grille perdait).
  const k = clavier(morceau.map(({ c, e }) => ({ text: boutonCapteur(c, e.emoji), callback_data: `dv:${c.dev_eui}` })), 1);
  if (pages > 1) {
    k.row();
    if (page > 0) k.text(C.precedent, `ls:${slug}:${page - 1}`);
    if (page < pages - 1) k.text(C.suivant, `ls:${slug}:${page + 1}`);
  }
  await ecran(ctx, texte.join("\n"), k);
}

/** « ✅ Cave · 23,4 °C · 57 % » ; l'âge seulement quand la mesure date de plus d'une heure. Texte brut (bouton). */
export function boutonCapteur(c: { name: string; ttn_status: string; last_seen: Date | null; model_key: string | null; last_values: any; muet?: boolean },
  emoji: string): string {
  const l = [`${emoji} ${c.name}`];
  if (!c.model_key && c.last_seen === null && c.ttn_status === "connecte") l.push(T.modele_a_identifier);
  else if (!c.last_seen) l.push(c.ttn_status === "connecte" ? T.attend_mesure : T.pas_connecte);
  else if (c.muet) l.push(f(T.rien_depuis, { duree: depuis(c.last_seen) }));
  else {
    if (c.last_values?.resume) l.push(c.last_values.resume);
    if (Date.now() - new Date(c.last_seen).getTime() > 3600000) l.push(f(T.il_y_a, { duree: depuis(c.last_seen) }));
  }
  return l.join(" · ");
}

/** « 🔋 pile 85 % », « 🪫 pile 15 %, à changer » ; sans courbe de pile : « pile bonne » ou « à changer ». */
function textePile(m: any, mv: number | null): string | null {
  if (!mv) return null;
  const pct = pourcentagePile(m, mv);
  const faible = pileFaible(m, mv);
  if (pct === null) return faible ? T.pile_a_changer : T.pile_bonne;
  return f(faible ? T.pile_pct_a_changer : T.pile_pct, { pct });
}

async function texteFiche(d: any, conseiller: boolean) {
  const m = modeleDe(d.model_key);
  const l: string[] = [m ? f(T.fiche_titre, { capteur: echapper(d.name), modele: echapper(nomCommercial(m)) })
    : f(T.fiche_titre_sans_modele, { capteur: echapper(d.name) }), ""];
  const valeurs = Object.entries(d.last_values || {}).filter(([k]) => k !== "resume" && k !== "battery_mv" && !k.startsWith("brut_"));
  // Valeur bien plus ancienne que le dernier message (sonde débranchée…) : on montre son âge.
  const seuil = Math.max(3600, 2 * Number(m?.intervalle_defaut_s || 1200)) * 1000;
  for (const [k, v] of valeurs as [string, any][]) {
    const def = definition(m, k);
    if (!def) continue;
    const vieille = d.last_seen && v?.t && new Date(d.last_seen).getTime() - new Date(v.t).getTime() > seuil;
    l.push(`${emojiMesure(k, def)} ${echapper(def.libelle || k)} : <b>${avecUnite(v.v, def)}</b>${vieille ? f(T.valeur_ancienne, { duree: depuis(new Date(v.t)) }) : ""}`);
  }
  // Actionneur : dernière commande
  const actions = [...(m?.actions || []), ...((d.config?.actions || []) as any[])];
  if (actions.length) {
    const cmd = await un(`SELECT c.*, p.display_name FROM app.commands c LEFT JOIN app.people p ON p.id = c.requested_by
                          WHERE c.dev_eui = $1 ORDER BY c.id DESC LIMIT 1`, [d.dev_eui]);
    if (cmd) l.push(f(T.derniere_commande, { action: echapper(actionDe(d, cmd.action).toLowerCase()), quand: quand(cmd.requested_at),
      qui: echapper(prenom(cmd.display_name) || "Mobilab"), resultat: cmd.status === "confirmee" ? "✅" : cmd.status === "echec" ? "❌" : "⏳" }));
  }
  l.push("");
  if (!d.last_seen) l.push(`⏳ ${d.ttn_status === "connecte" ? T.fiche_attend : T.fiche_pas_connecte}`);
  else {
    const pile = textePile(m, d.battery_mv);
    const rec = reception(d.last_rssi, d.last_snr);
    const morceaux = [`🕒 ${f(T.il_y_a, { duree: depuis(d.last_seen) })}`];
    if (pile) morceaux.push(pile);
    if (rec) morceaux.push(`📶 réception ${rec}`);
    l.push(morceaux.join(" · "));
  }
  if (m?.modes) {
    const mode = d.mode_override || d.config?.detected?.mode_lu;
    if (mode) l.push(f(d.mode_override ? T.mode_force : T.mode_lu, { mode: echapper(m.modes[mode]?.libelle || mode) }));
  }
  const rs = await regles(d.dev_eui);
  const seuils = rs.filter(r => r.kind === "threshold" && r.enabled);
  const enAlarme = rs.find(r => r.state === "alarm" && r.kind !== "silence" && r.kind !== "battery");
  const coupee = rs.find(r => r.muted_until && new Date(r.muted_until) > new Date());
  if (enAlarme) {
    const def = definition(m, enAlarme.metric);
    const borne = enAlarme.kind === "threshold" ? ` (${enAlarme.min !== null ? "min" : "max"} ${avecUnite(enAlarme.min ?? enAlarme.max, def)})` : "";
    l.push(f(T.en_alerte_depuis, { duree: depuis(enAlarme.since) }) + borne);
  } else if (coupee) l.push(f(T.coupee_jusqua, { quand: quand(coupee.muted_until) }));
  else if (seuils.length) l.push(f(T.alerte_si, { regles: seuils.map(r => texteRegle(m, r)).join(" et ") }));
  return { texte: l.join("\n"), actions };
}

// Un emoji par mesure : celui du catalogue (champ « emoji »), sinon d'après le nom de la mesure.
const EMOJIS: [RegExp, string][] = [
  [/soil.*moisture|moisture/, "🌱"], [/humid/, "💧"], [/temp/, "🌡️"], [/flow/, "🚰"], [/volume/, "🪣"], [/distance|level/, "📏"],
  [/door|contact/, "🚪"], [/leak/, "💦"], [/pressure/, "⏲️"], [/illum/, "☀️"], [/_ec$/, "⚡"], [/count|pulse/, "🔢"], [/^brut_/, "🔌"],
  [/last_.*_min|duration/, "⏱️"],
];
export function emojiMesure(nom: string, def?: { emoji?: string } | null): string {
  return def?.emoji || EMOJIS.find(([r]) => r.test(nom))?.[1] || "•";
}

function texteRegle(m: any, r: any): string {
  const def = definition(m, r.metric);
  if (def?.alerte === "debit") return r.min !== null ? f(T.debit_arret_ok, { h: Math.round(r.for_minutes / 60) }).replace(/^✅ Alerte si /, "").replace(/\.$/, "")
    : f(T.debit_fuite_ok, { h: Math.round(r.for_minutes / 60) }).replace(/^✅ Alerte si /, "").replace(/\.$/, "");
  return r.min !== null ? `&lt; ${avecUnite(r.min, def)}` : `&gt; ${avecUnite(r.max, def)}`;   // HTML : < et > échappés
}

async function ecranFiche(ctx: Ctx, dev: string, nouveau = false) {
  const x = await droitCapteur(ctx, dev, "voir");
  if (!x) return;
  const { d, a } = x;
  ctx.session.ferme = d.tenant_slug;
  const conseiller = a.role === "conseiller";
  const { texte, actions } = await texteFiche(d, conseiller);
  const k = new InlineKeyboard();
  if (!conseiller && actions.length) {
    const enCours = await un(`SELECT id FROM app.commands WHERE dev_eui = $1 AND status IN ('demandee', 'envoyee')`, [dev]);
    actions.forEach((ac: any, i: number) => {
      if (enCours) k.text(T.bouton_ordre_en_cours, `ac:${dev}:${i}`); else k.text(ac.bouton, `ac:${dev}:${i}`);
    });
    k.row();
  }
  k.text(T.bouton_alertes, `al:${dev}`);
  if (!conseiller) k.text(T.bouton_reglages, `st:${dev}`);
  k.row().text(C.retour, `ls:${d.tenant_slug}:0`);
  if (nouveau) await dire(ctx, texte, { reply_markup: k }); else await ecran(ctx, texte, k);
}

async function ecranReglages(ctx: Ctx, dev: string) {
  const x = await droitCapteur(ctx, dev, "regler");
  if (!x) return;
  const { d, a } = x;
  const m = modeleDe(d.model_key);
  const branchements = Boolean(m?.modes && Object.keys(m.modes).length > 1) || voiesDe(m, null).length > 0;
  const silence = (await regles(dev)).find(r => r.kind === "silence");
  const pause = !silence?.enabled && silence?.params?.en_pause_depuis;
  const ligneSilence = silence?.enabled
    ? f(T.reglage_silence_oui, { delai: texteIntervalle(Math.round(delaiSilence(d, silence) / 60) * 60) })
    : pause ? f(T.reglage_silence_pause, { quand: quand(silence.params.en_pause_depuis) }) : T.reglage_silence_non;
  const k = clavier([
    { text: T.bouton_renommer, callback_data: `rn:${dev}` },
    branchements ? { text: T.bouton_branchements, callback_data: `pb:${dev}` } : null,
    intervalleReglable(m) ? { text: T.bouton_intervalle, callback_data: `iv:${dev}` } : null,
    { text: silence?.enabled ? T.bouton_silence_couper : pause ? T.bouton_silence_reactiver : T.bouton_silence_activer, callback_data: `ai:${dev}:s:r` },
    !d.last_seen ? { text: T.bouton_corriger_codes, callback_data: `ck:${dev}` } : null,
    a.role === "proprietaire" ? { text: T.bouton_supprimer, callback_data: `dl:${dev}` } : null,
    { text: C.retour, callback_data: `dv:${dev}` },
  ]);
  await ecran(ctx, [f(T.reglages_titre, { capteur: echapper(d.name) }), "", ligneSilence].join("\n"), k);
}

/** Délai (s) avant « pas de nouvelles » : même calcul que Node-RED (ingest/alertes.js). */
function delaiSilence(d: any, regle: any): number {
  return moduleIngest().alertes.delaiSilence({ intervalle_s: d.intervalle_s, mesure_s: d.config?.detected?.intervalle_s,
    delai_min: regle?.params?.delai_min });
}

async function ecranBranchements(ctx: Ctx, dev: string) {
  const x = await droitCapteur(ctx, dev, "regler");
  if (!x) return;
  const { d } = x;
  const m = modeleDe(d.model_key);
  const mode = d.mode_override || d.config?.detected?.mode_lu || null;
  const voies = voiesDe(m, mode);
  const l = [f(T.branchements_titre, { capteur: echapper(d.name), mode: echapper(m?.modes?.[mode]?.libelle || mode || "?") })];
  voies.forEach((v, i) => {
    const p = d.probes?.[v];
    const nom = !p ? T.rien : p.sonde === "rien" ? T.rien : p.sonde === "inconnue" ? T.bouton_sais_pas : catalogue().sondes[p.sonde]?.libelle || p.sonde;
    l.push(f(T.entree_ligne, { n: i + 1, sonde: echapper(nom) }));
  });
  const k = clavier([...voies.map((_, i) => ({ text: f(T.bouton_entree, { n: i + 1 }), callback_data: `pc:${dev}:${i + 1}` }))], 3);
  k.row();
  if (m?.modes && Object.keys(m.modes).length > 1) k.text(T.bouton_mode, `mo:${dev}`);
  k.text(C.retour, `st:${dev}`);
  await ecran(ctx, l.join("\n"), k);
}

/** Choix d'une sonde : depuis Branchements, ou réponse à la question posée à la première trame (`p`). */
async function choisirSonde(ctx: Ctx, dev: string, n: number, choix: string, premiere: boolean) {
  const x = await droitCapteur(ctx, dev, "regler");
  if (!x) return;
  const { d } = x;
  const m = modeleDe(d.model_key);
  const mode = d.mode_override || d.config?.detected?.mode_lu || null;
  const voie = voiesDe(m, mode)[n - 1];
  if (!voie) return;
  let sonde: string;
  if (choix === "r") sonde = "rien";
  else if (choix === "u") sonde = "inconnue";
  else sonde = catalogue().ordreSondes[Number(choix)] || "inconnue";
  const probes = { ...(d.probes || {}), [voie]: { sonde: sonde === "inconnue" ? "tension_brute" : sonde, par: ctx.personne?.id ?? null, le: new Date().toISOString() } };
  if (sonde === "inconnue") probes[voie].inconnue = true;
  await tx(async c => {
    await c.query(`UPDATE app.devices SET probes = $2::jsonb WHERE dev_eui = $1`, [dev, json(probes)]);
    await audit(c, { acteur: ctx.personne?.id, via: ctx.session.support ? "support" : "bot", tenant: d.tenant_slug, dev_eui: dev, action: "sonde", details: { voie, sonde } });
    if (sonde === "inconnue") await notifier(c, { audience: "admin", kind: "sonde_autre", tenant: d.tenant_slug, dev_eui: dev, details: { choix: T.bouton_sais_pas, entree: n } });
  });
  const libelle = sonde === "rien" ? T.rien : sonde === "inconnue" ? T.bouton_sais_pas : catalogue().sondes[sonde]?.libelle || sonde;
  await ctx.answerCallbackQuery().catch(() => undefined);
  await ecran(ctx, f(T.entree_choisie, { n, sonde: echapper(libelle) }));
  d.probes = probes;
  // Question suivante, puis mise_en_service (redécodage) et message de première mesure (spec §4.4).
  if (premiere && ctx.chat) {
    const suite = await questionSonde(ctx.s, "client", ctx.chat.id, d, n, true);
    if (suite) return;
  }
  await creerJob(db(), { kind: "mise_en_service", tenant: d.tenant_slug, dev_eui: dev,
    params: { redecoder: !d.config?.mise_en_service_at || premiere, annonce: premiere }, requested_by: ctx.personne?.id });
}

// ===================================================================== /ajouter (§4.4)

export function libelleType(dn: any): string {
  const m = dn.modele ? modeleDe(dn.modele) : null;
  if (m) return `${libelleModele(m)} (${libelleMarque(m.marque)})`;
  return `${T.type_inconnu}${dn.marque_bouton && dn.marque_bouton !== "Autre" ? ` (${dn.marque_bouton})` : ""}`;
}

/** Marque puis type (choix du 19/11) : l'id TTS du capteur en découle (« lht52-ff32 »). */
async function questionMarque(ctx: Ctx, pre = "") {
  await dire(ctx, T.q_marque, { reply_markup: clavier(marques().map(m => ({ text: m.bouton, callback_data: `${pre}aj:m:${m.cle}` }))) });
}

const LIBELLE_CATEGORIE: Record<string, string> = { temperature: T.categorie_temperature, niveau: T.categorie_niveau,
  porte: T.categorie_porte, autre: T.categorie_autre };

/** Marque à beaucoup de types : d'abord le genre de capteur (choix du 19/11), puis le type. */
export async function questionCategorie(ctx: Ctx, cle: string, pre = "") {
  await ecran(ctx, f(T.q_categorie, { marque: echapper(marques().find(m => m.cle === cle)?.bouton || "") }),
    clavier([...categoriesDeMarque(cle).map(c => ({ text: LIBELLE_CATEGORIE[c] || c, callback_data: `${pre}aj:k:${cle}:${c}` })),
      { text: T.bouton_pas_dans_liste, callback_data: `${pre}aj:t:a` }], 1));
}

export async function questionType(ctx: Ctx, cle: string, pre = "", categorie?: string) {
  const l = typesDeMarque(cle, categorie);
  const retour = categorie ? [{ text: C.retour, callback_data: `${pre}aj:k:${cle}:` }] : [];
  await ecran(ctx, f(T.q_type, { marque: echapper(marques().find(m => m.cle === cle)?.bouton || "") }),
    clavier([...l.map(m => ({ text: boutonModele(m), callback_data: `${pre}aj:t:${m.cle}` })), { text: T.bouton_autre, callback_data: `${pre}aj:t:a` },
      ...retour], 1));
}

/** Après la marque : catégories si la marque en a besoin, sinon directement les types. Renvoie l'étape suivante. */
export async function apresMarque(ctx: Ctx, cle: string, pre = ""): Promise<"categorie" | "type"> {
  if (categoriesDeMarque(cle).length) { await questionCategorie(ctx, cle, pre); return "categorie"; }
  await questionType(ctx, cle, pre);
  return "type";
}

function texteRelecture(dn: any): string {
  return [`📝 <b>${echapper(dn.nom)}</b>`, f(T.relecture_type, { type: echapper(libelleType(dn)) }), "",
    `AppEUI  <code>${groupes(dn.appeui)}</code>`, `AppKey  <code>${groupes(dn.appkey_affiche || "")}</code>`,
    `DevEUI  <code>${groupes(dn.deveui)}</code>`, "", T.relecture_question].join("\n");
}

async function lancerAjout(ctx: Ctx, f0?: FermeDe | null) {
  const p = ctx.personne!;
  const l = ctx.session.support ? [await choisirFerme(ctx, "j")] : (await fermesDe(p.id));
  const possibles = (l.filter(Boolean) as FermeDe[]).filter(x => x.role !== "conseiller" && x.status !== "suspendu");
  if (!f0) {
    if (!possibles.length) { await dire(ctx, (l.length ? T.reserve_ferme_ajout : T.plus_aucune_ferme)); return; }
    if (possibles.length > 1) {
      await dire(ctx, T.pour_quelle_ferme, { reply_markup: clavier(possibles.map(x => ({ text: x.display_name, callback_data: `fm:${x.slug}:j` }))) });
      return;
    }
    f0 = possibles[0];
  }
  if (!(await droit(ctx, f0.slug, "regler"))) return;
  demarrer(ctx, "ajouter", "marque", "/ajouter", { ferme: f0.slug });
  await questionMarque(ctx);
}

async function nomLibre(slug: string, nom: string, sauf?: string): Promise<boolean> {
  const r = await un(`SELECT 1 FROM app.devices WHERE tenant_slug = $1 AND lower(name) = lower($2) AND ttn_status <> 'supprime' AND dev_eui <> coalesce($3, '')`,
    [slug, nom, sauf ?? null]);
  return !r;
}

async function etapeAjout(ctx: Ctx, texte: string) {
  const conv = ctx.session.conv!;
  const dn = conv.donnees;
  const correction = conv.nom === "corriger";
  const suivante = async () => {
    if (!correction && !dn.nom) { conv.etape = "nom"; await dire(ctx, T.q_nom); return; }
    if (!dn.appeui) { conv.etape = "appeui"; await dire(ctx, T.q_appeui); return; }
    if (!dn.appkey) { conv.etape = "appkey"; await dire(ctx, T.q_appkey); return; }
    if (!dn.deveui) { conv.etape = "deveui"; await dire(ctx, T.q_deveui); return; }
    conv.etape = "relecture";
    const k = clavier([{ text: T.bouton_oui_ok, callback_data: "ad:ok" }, { text: T.bouton_corriger, callback_data: "ad:fx" }]);
    await dire(ctx, texteRelecture({ ...dn, appkey_affiche: dn.appkey ? dechiffrer(ctx.s.cfg.secretsKey!, Buffer.from(dn.appkey, "base64")) : "" }), { reply_markup: k });
  };
  switch (conv.etape) {
    case "marque":
    case "type":
      await dire(ctx, T.choisir_bouton);
      return;
    case "nom": {
      const nom = texte.trim();
      if (nom.length < 1 || nom.length > 40) { await dire(ctx, T.nom_invalide); return; }
      if (!(await nomLibre(dn.ferme, nom))) { await dire(ctx, T.nom_pris); return; }
      dn.nom = nom;
      return suivante();
    }
    case "appeui":
    case "appkey":
    case "deveui": {
      const r = controler(conv.etape, texte);
      if (!r.ok) {
        if (r.erreur === "appkey_a_la_place") {
          dn.appkey = chiffrer(ctx.s.cfg.secretsKey!, r.valeur).toString("base64");
          if (conv.etape === "appeui") { await dire(ctx, T.note_appkey); return; }
          return suivante();
        }
        await dire(ctx, conv.etape === "appkey" ? T.err_32_appkey : conv.etape === "appeui" ? T.err_16_appeui : T.err_16_deveui);
        return;
      }
      if (conv.etape === "appkey") dn.appkey = chiffrer(ctx.s.cfg.secretsKey!, r.valeur).toString("base64");
      else if (conv.etape === "appeui") dn.appeui = r.valeur;
      else {
        const dev = r.valeur.toLowerCase();
        if (correction && dev !== dn.dev_eui_origine) { await dire(ctx, "Un autre DevEUI = un autre capteur. Supprimez celui-ci et ajoutez le nouveau."); return; }
        const ici = await un(`SELECT name FROM app.devices WHERE dev_eui = $1 AND tenant_slug = $2 AND ttn_status NOT IN ('supprime', 'echec')`, [dev, dn.ferme]);
        if (ici && !correction) { finir(ctx); await dire(ctx, f(T.deveui_deja_ici, { capteur: echapper(ici.name) }), { reply_markup: sansClavier }); return; }
        dn.deveui = r.valeur;
      }
      return suivante();
    }
    default:
      return suivante();
  }
}

async function validerAjout(ctx: Ctx) {
  const conv = conversation(ctx);
  if (!conv || (conv.nom !== "ajouter" && conv.nom !== "corriger") || conv.etape !== "relecture") { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
  const dn = conv.donnees;
  if (!(await droit(ctx, dn.ferme, "regler"))) return;
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  const appkey = dechiffrer(ctx.s.cfg.secretsKey!, Buffer.from(dn.appkey, "base64"));
  const dev = String(dn.deveui).toLowerCase();
  finir(ctx);
  const via = ctx.session.support ? "support" : "bot";
  if (conv.nom === "corriger") {
    await retirerClavier(ctx);
    const m = await dire(ctx, f(T.enregistre_en_cours, { capteur: echapper(dn.nom) }));
    await creerJob(db(), { kind: "corriger_codes", tenant: dn.ferme, dev_eui: dev, requested_by: ctx.personne!.id, chat_id: ctx.chat!.id,
      message_id: m.message_id, params: { appeui: String(dn.appeui).toLowerCase(), nom: dn.nom, bot: "client", via }, secret: chiffrerSecret(ctx.s, appkey) });
    return;
  }
  // Doublons (spec §6.5) : autre ferme, capteur actif → rien n'est créé.
  const ailleurs = await un(`SELECT tenant_slug, name, ttn_status FROM app.devices WHERE dev_eui = $1`, [dev]);
  if (ailleurs && ailleurs.tenant_slug !== dn.ferme && !["supprime", "echec"].includes(ailleurs.ttn_status)) {
    await dire(ctx, T.deja_chez_nous, { reply_markup: sansClavier });
    await notifier(db(), { audience: "admin", kind: "deja_enregistre", tenant: dn.ferme, dev_eui: dev, details: { requested_by: ctx.personne!.id } });
    return;
  }
  await retirerClavier(ctx);
  const m = await dire(ctx, f(T.enregistre_en_cours, { capteur: echapper(dn.nom) }));
  await creerJob(db(), { kind: "ajouter_capteur", tenant: dn.ferme, dev_eui: dev, requested_by: ctx.personne!.id, chat_id: ctx.chat!.id,
    message_id: m.message_id, params: { nom: dn.nom, appeui: String(dn.appeui).toLowerCase(), modele: dn.modele || null, marque: dn.marque_bouton || null, bot: "client", via,
      reprise: Boolean(ailleurs && ailleurs.tenant_slug === dn.ferme && ailleurs.ttn_status === "supprime") },
    secret: chiffrerSecret(ctx.s, appkey) });
}

// ===================================================================== alertes (§4.7, §8.2)

async function ecranAlertes(ctx: Ctx, slug: string) {
  const a = await droit(ctx, slug, "voir");
  if (!a) return;
  ctx.session.ferme = slug;
  const t = await lireFerme(slug);
  const l = [f(T.alertes_titre, { ferme: echapper(t.display_name) }), ""];
  const enCours = await q(`SELECT d.dev_eui, d.name, d.model_key, d.battery_mv, r.kind, r.metric, r.min, r.max, s.since, s.last_value, s.muted_until, s.state
                           FROM app.alert_state s JOIN app.alert_rules r ON r.id = s.rule_id JOIN app.devices d ON d.dev_eui = r.dev_eui
                           WHERE d.tenant_slug = $1 AND d.ttn_status <> 'supprime' AND r.enabled
                             AND (s.state = 'alarm' OR s.muted_until > now()) ORDER BY s.since`, [slug]);
  const vus = new Set<string>();
  const boutons: { text: string; callback_data: string }[] = [];
  for (const x of enCours) {
    const m = modeleDe(x.model_key);
    if (x.muted_until && new Date(x.muted_until) > new Date()) {
      if (!vus.has(x.dev_eui + "m")) l.push(f(T.alerte_coupee, { capteur: echapper(x.name), quand: quand(x.muted_until) }));
      vus.add(x.dev_eui + "m");
      continue;
    }
    let valeur = "";
    if (x.kind === "silence") valeur = "pas de nouvelles";
    else if (x.kind === "battery") {
      const pct = pourcentagePile(m, x.battery_mv);
      valeur = `pile à changer${pct === null ? "" : ` (${pct} %)`}`;
    }
    else {
      const def = definition(m, x.metric);
      valeur = x.kind === "state" ? avecUnite(1, def) : `${avecUnite(x.last_value, def)} (${x.min !== null ? "min" : "max"} ${avecUnite(x.min ?? x.max, def)})`;
    }
    l.push(f(T.alerte_en_cours, { capteur: echapper(x.name), valeur: echapper(valeur), duree: depuis(x.since) }));
    if (!vus.has(x.dev_eui)) { boutons.push({ text: x.name, callback_data: `al:${x.dev_eui}` }); vus.add(x.dev_eui); }
  }
  if (!enCours.length) l.push(T.aucune_alerte);
  // Destinataires
  const dest = await q(`SELECT p.id, p.display_name FROM app.memberships m JOIN app.people p ON p.id = m.person_id
                        WHERE m.tenant_slug = $1 AND m.status = 'actif' AND m.receives_alerts AND p.telegram_user_id IS NOT NULL`, [slug]);
  const noms = dest.map(x => (x.id === ctx.personne?.id ? T.vous : echapper(prenom(x.display_name))));
  if (t.alert_chat_id && !t.alert_chat_unreachable_since) noms.push(f(T.groupe_nom, { groupe: echapper(t.config?.groupe_titre || "lié") }));
  l.push("", noms.length ? f(T.envoyees_a, { liste: noms.join(", ") }) : T.envoyees_a_personne);
  const seuils = await un(`SELECT 1 FROM app.alert_rules r JOIN app.devices d ON d.dev_eui = r.dev_eui WHERE d.tenant_slug = $1 AND r.kind = 'threshold'`, [slug]);
  if (!seuils) l.push(T.seuils_rappel);
  const k = clavier(boutons);
  k.row();
  if (!ctx.session.support) {
    const recoit = (await adhesion(ctx.personne!.id, slug))?.receives_alerts;
    k.text(recoit ? T.bouton_ne_plus_recevoir : T.bouton_recevoir, `rv:${slug}:${recoit ? 0 : 1}`);
  }
  if (a.role !== "conseiller") {
    if (t.alert_chat_id) k.text(f(T.bouton_groupe_x, { groupe: (t.config?.groupe_titre || "lié").slice(0, 20) }), `gp:${slug}`);
    else {
      const lien = await creerLien(db(), "groupe", { tenant: slug, par: ctx.personne?.id, payload: { admin: Boolean(ctx.session.support) } });
      k.url(T.bouton_aussi_groupe, lienBot(ctx.s, "client", lien.parametre, true));
    }
  }
  await ecran(ctx, l.join("\n"), k);
}

async function ecranAlertesCapteur(ctx: Ctx, dev: string) {
  const x = await droitCapteur(ctx, dev, "voir");
  if (!x) return;
  const { d, a } = x;
  const m = modeleDe(d.model_key);
  const etats = Object.values(m?.mesures || {}).filter(z => z.alerte === "etat");
  const toutes = await regles(dev);
  const l = [f(T.alertes_capteur_titre, { capteur: echapper(d.name) }), "", T.toujours_actives];
  // Alertes intégrées : « pas de nouvelles » active par défaut (27/11), les états non ; un tap les bascule.
  const silence = toutes.find(r => r.kind === "silence");
  const integrees: { cle: string; libelle: string; on: boolean; pause?: string }[] = [
    { cle: "s", libelle: T.alerte_silence, on: Boolean(silence?.enabled), pause: !silence?.enabled ? silence?.params?.en_pause_depuis : undefined },
    ...etats.map(e => ({ cle: `m:${e.nom}`, libelle: e.libelle || e.nom, on: Boolean(toutes.find(r => r.kind === "state" && r.metric === e.nom)?.enabled) })),
  ];
  for (const x of integrees) {
    const g = x.on ? T.integree_oui : x.pause ? T.integree_pause : T.integree_non;
    l.push(`${x.cle === "s" ? "📡" : "🚪"} ${f(g, { alerte: echapper(x.libelle), quand: x.pause ? quand(x.pause) : "" })}`);
  }
  l.push("");
  const rs = toutes.filter(r => r.kind === "threshold");
  const mesures = mesuresAlertables(m, d.last_values || {});
  for (const def of mesures) {
    const r = rs.filter(z => z.metric === def.nom);
    l.push(`${emojiMesure(def.nom, def)} ` + (r.length ? f(T.regle_ligne, { mesure: echapper(def.libelle || def.nom), regles: r.map(z => texteRegle(m, z)).join(" et ") })
      : f(T.regle_aucune, { mesure: echapper(def.libelle || def.nom) })));
  }
  const k = a.role === "conseiller" ? new InlineKeyboard() : clavier([
    ...integrees.map(x => ({ text: f(x.on ? T.bouton_desactiver : T.bouton_activer, { alerte: x.libelle }), callback_data: `ai:${dev}:${x.cle}` })),
    ...mesures.map(def => ({ text: def.libelle || def.nom, callback_data: `am:${dev}:${def.nom}` }))]);
  k.row().text(C.retour, `dv:${dev}`);
  await ecran(ctx, l.join("\n"), k);
}

async function ecranSeuil(ctx: Ctx, dev: string, metric: string) {
  const x = await droitCapteur(ctx, dev, "regler");
  if (!x) return;
  const { d } = x;
  const m = modeleDe(d.model_key);
  const def = definition(m, metric);
  if (!def) return;
  const actuelle = d.last_values?.[metric]?.v;
  const rs = (await regles(dev)).filter(r => r.kind === "threshold" && r.metric === metric);
  if (def.alerte === "debit") {
    const k = clavier([{ text: f(T.bouton_eau_arretee, { h: 12 }), callback_data: `th:${dev}:${metric}:lo:0` },
      { text: f(T.bouton_eau_coule, { h: 24 }), callback_data: `th:${dev}:${metric}:hi:0` },
      { text: T.bouton_aucune, callback_data: `th:${dev}:${metric}:x` }]);
    if (rs.length) k.row().text(T.bouton_changer_duree, `du:${dev}:${metric}:${rs[0].min !== null ? "lo" : "hi"}`);
    k.row().text(C.retour, `al:${dev}`);
    await ecran(ctx, f(T.debit_question, { capteur: echapper(d.name), valeur: actuelle !== undefined ? avecUnite(actuelle, def) : "?" }), k);
    return;
  }
  const lo = rs.find(r => r.min !== null), hi = rs.find(r => r.max !== null);
  const k = new InlineKeyboard();
  (def.seuils_proposes?.min || []).forEach((v, i) => k.text(`${lo && Number(lo.min) === v ? "✅ " : ""}< ${avecUnite(v, def)}`, `th:${dev}:${metric}:lo:${i}`));
  k.row();
  (def.seuils_proposes?.max || []).forEach((v, i) => k.text(`${hi && Number(hi.max) === v ? "✅ " : ""}> ${avecUnite(v, def)}`, `th:${dev}:${metric}:hi:${i}`));
  k.row().text(T.bouton_autre_valeur, `tv:${dev}:${metric}`).text(T.bouton_aucune, `th:${dev}:${metric}:x`);
  k.row().text(C.retour, `al:${dev}`);
  await ecran(ctx, f(T.seuil_question, { mesure: echapper(def.libelle || metric), capteur: echapper(d.name),
    valeur: actuelle !== undefined ? avecUnite(actuelle, def) : "?" }), k);
}

/** Pose, remplace ou enlève une borne (spec §8.2). Modifier une règle remet son état à ok, sans message. */
async function poserSeuil(ctx: Ctx, dev: string, metric: string, sens: "lo" | "hi" | "x", valeur: number | null, forMinutes = 0, basculer = false) {
  const x = await droitCapteur(ctx, dev, "regler");
  if (!x) return null;
  const { d } = x;
  return tx(async c => {
    if (sens === "x") {
      await c.query(`DELETE FROM app.alert_rules WHERE dev_eui = $1 AND kind = 'threshold' AND metric = $2`, [dev, metric]);
    } else {
      const colonne = sens === "lo" ? "min" : "max";
      const existe = (await c.query(`SELECT id, min, max FROM app.alert_rules WHERE dev_eui = $1 AND kind = 'threshold' AND metric = $2 AND ${colonne} IS NOT NULL`, [dev, metric])).rows[0];
      if (existe && basculer && Number(existe[colonne]) === valeur) {
        await c.query(`DELETE FROM app.alert_rules WHERE id = $1`, [existe.id]);
      } else if (existe) {
        await c.query(`UPDATE app.alert_rules SET ${colonne} = $2, for_minutes = $3 WHERE id = $1`, [existe.id, valeur, forMinutes]);
        await c.query(`UPDATE app.alert_state SET state = 'ok', since = now(), pending_since = NULL WHERE rule_id = $1`, [existe.id]);
      } else {
        const r = await c.query(`INSERT INTO app.alert_rules (dev_eui, kind, metric, ${colonne}, for_minutes, created_by)
                                 VALUES ($1, 'threshold', $2, $3, $4, $5) RETURNING id`, [dev, metric, valeur, forMinutes, ctx.personne?.id ?? null]);
        await c.query(`INSERT INTO app.alert_state (rule_id) VALUES ($1)`, [r.rows[0].id]);
      }
    }
    await audit(c, { acteur: ctx.personne?.id, via: ctx.session.support ? "support" : "bot", tenant: d.tenant_slug, dev_eui: dev, action: "seuil",
      details: { metric, sens, valeur, forMinutes } });
    return d;
  });
}

/** « < 3 », « > 28,5 », « moins 2 », « au-dessus de 30 », « 5 » (spec §4.7). */
export function lireLimite(texte: string, actuelle?: number): { sens: "lo" | "hi"; valeur: number } | null {
  const t = texte.toLowerCase().replace(",", ".").trim();
  const n = /-?\d+(\.\d+)?/.exec(t);
  if (!n) return null;
  const v = Number(n[0]);
  if (/<|moins|sous|min/.test(t)) return { sens: "lo", valeur: v };
  if (/>|plus|au-dessus|dessus|max/.test(t)) return { sens: "hi", valeur: v };
  if (actuelle === undefined) return null;
  return { sens: v < actuelle ? "lo" : "hi", valeur: v };
}

// ===================================================================== couper 24 h (§8.4)

async function couper(ctx: Ctx, id: number, reactiver: boolean) {
  const n = await un(`SELECT * FROM app.notifications WHERE id = $1 AND kind = 'alerte'`, [id]);
  if (!n) { await ctx.answerCallbackQuery(); return; }
  const p = ctx.personne;
  const a = p ? await adhesion(p.id, n.tenant_slug) : null;
  if (!a || a.status !== "actif" || a.role === "conseiller") { await ctx.answerCallbackQuery({ text: T.reserve_ferme }); return; }
  if (a.tenant_status === "suspendu") { await ctx.answerCallbackQuery({ text: f(T.ferme_pause, { ferme: a.display_name }) }); return; }
  const devs = [n.dev_eui, ...((n.details?.groupe || []) as string[])].filter(Boolean);
  await tx(async c => {
    if (reactiver) await c.query(`UPDATE app.alert_state SET muted_until = NULL, muted_by = NULL WHERE rule_id IN (SELECT id FROM app.alert_rules WHERE dev_eui = ANY($1::text[]))`, [devs]);
    else await c.query(`UPDATE app.alert_state SET muted_until = now() + interval '24 hours', muted_by = $2
                        WHERE rule_id IN (SELECT id FROM app.alert_rules WHERE dev_eui = ANY($1::text[]))`, [devs, p!.id]);
    await audit(c, { acteur: p!.id, tenant: n.tenant_slug, dev_eui: n.dev_eui, action: reactiver ? "alertes réactivées" : "alertes coupées 24 h" });
  });
  await ctx.answerCallbackQuery({ text: reactiver ? T.reactivee_reponse : T.coupee_reponse });
  // Toutes les copies du message sont modifiées (spec §4.8).
  const ligne = reactiver ? "" : "\n" + f(TA.coupee_par, { personne: echapper(prenom(p!.display_name)), quand: quand(new Date(Date.now() + 86400000)) });
  const k = reactiver
    ? { inline_keyboard: [[{ text: TA.bouton_couper, callback_data: `ct:${id}` }, { text: TA.bouton_voir, callback_data: n.details?.groupe?.length > 1 ? `ag:${id}` : `dv:${n.dev_eui}` }]] }
    : { inline_keyboard: [[{ text: TA.bouton_reactiver, callback_data: `rc:${id}` }]] };
  await modifierCopies(ctx, n, ligne, k);
}

/** Toutes les copies d'un message d'alerte : celle touchée change de dernière ligne (🔕…), les autres de boutons. */
async function modifierCopies(ctx: Ctx, n: any, ligne: string, k: { inline_keyboard: any[][] }) {
  for (const dst of (n.destinataires || []) as any[]) {
    if (!dst.message_id) continue;
    const msg = ctx.callbackQuery?.message;
    const base = msg && msg.chat.id === dst.chat_id && msg.message_id === dst.message_id ? (msg as any).text?.split("\n🔕")[0] : null;
    if (base) await ctx.api.editMessageText(dst.chat_id, dst.message_id, echapper(base) + ligne, { parse_mode: "HTML", reply_markup: k }).catch(() => undefined);
    else await ctx.api.editMessageReplyMarkup(dst.chat_id, dst.message_id, { reply_markup: k }).catch(() => undefined);
  }
}

/** « Réactiver cette alerte » : les « pas de nouvelles » du message repartent (envoyées une fois, puis en pause). */
async function reactiverSilence(ctx: Ctx, id: number) {
  const n = await un(`SELECT * FROM app.notifications WHERE id = $1 AND kind = 'alerte'`, [id]);
  if (!n) { await ctx.answerCallbackQuery(); return; }
  const p = ctx.personne;
  const a = p ? await adhesion(p.id, n.tenant_slug) : null;
  if (!a || a.status !== "actif" || a.role === "conseiller") { await ctx.answerCallbackQuery({ text: T.reserve_ferme }); return; }
  if (a.tenant_status === "suspendu") { await ctx.answerCallbackQuery({ text: f(T.ferme_pause, { ferme: a.display_name }) }); return; }
  const ids = ((n.details?.items || []) as any[]).filter(i => i.kind === "silence").map(i => Number(i.rule_id));
  await tx(async c => {
    await c.query(`UPDATE app.alert_rules SET enabled = true, params = params - 'en_pause_depuis' WHERE id = ANY($1::bigint[]) AND kind = 'silence'`, [ids]);
    await audit(c, { acteur: p!.id, tenant: n.tenant_slug, dev_eui: n.dev_eui, action: "alerte activée", details: { kind: "silence", depuis: "message" } });
  });
  await ctx.answerCallbackQuery({ text: T.silence_reactivee_reponse });
  const voir = n.details?.groupe?.length > 1 ? { text: TA.bouton_voir_tous, callback_data: `ag:${id}` } : { text: TA.bouton_voir, callback_data: `dv:${n.dev_eui}` };
  await modifierCopies(ctx, n, "\n" + f(TA.reactivee_par, { personne: echapper(prenom(p!.display_name)) }), { inline_keyboard: [[voir]] });
}

// ===================================================================== partager (§4.9)

async function ecranPartage(ctx: Ctx, slug: string) {
  const p = ctx.personne!;
  const a = await droit(ctx, slug, "voir");
  if (!a) return;
  ctx.session.ferme = slug;
  const t = await lireFerme(slug);
  if (a.role !== "proprietaire" && !ctx.session.support) {
    await ecran(ctx, f(T.acces_comme, { ferme: echapper(t.display_name), role: ROLE_TXT[a.role] }), clavier([{ text: T.bouton_quitter, callback_data: `lv:${slug}` }]));
    return;
  }
  if (ctx.callbackQuery || !ctx.session.support) {
    // Accès donnés ou retirés dans Grafana : relevés à l'ouverture (spec §4.9, §6.4).
    if (t.grafana_org_id && ctx.s.grafana.configure) {
      const { synchroniserAcces } = await import("../jobs/taches.js");
      await synchroniserAcces(db(), ctx.s, slug, Number(t.grafana_org_id)).catch(e => log.warn(`synchro Grafana ${slug} : ${e?.message || e}`));
    }
  }
  const membres = await q(`SELECT m.person_id, m.role, m.source, m.status, p.display_name FROM app.memberships m JOIN app.people p ON p.id = m.person_id
                           WHERE m.tenant_slug = $1 AND m.status = 'actif' ORDER BY m.role, p.display_name`, [slug]);
  const l = [f(T.partage_titre, { ferme: echapper(t.display_name) })];
  const boutons: { text: string; callback_data: string }[] = [];
  for (const m of membres) {
    if (m.person_id === p.id && m.role === "proprietaire") { l.push(T.partage_vous); continue; }
    const role = m.source === "grafana" ? T.role_graphiques : ROLE_TXT[m.role];
    l.push(f(T.partage_ligne, { nom: echapper(m.display_name), role }));
    boutons.push({ text: m.display_name.slice(0, 30), callback_data: `sh:${slug}:p:${m.person_id}` });
  }
  l.push(T.partage_mobilab);
  const inv = await q(`SELECT token, payload, expires_at FROM app.invitations WHERE tenant_slug = $1 AND kind = 'join' AND used_at IS NULL
                       AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at`, [slug]);
  for (const i of inv) {
    l.push(f(T.partage_invitations, { n: 1, role: ROLE_TXT[i.payload?.role] || "", date: jour(i.expires_at) }));
    boutons.push({ text: T.bouton_invitation, callback_data: `sh:${slug}:i:${String(i.token).slice(0, 8)}` });
  }
  const k = new InlineKeyboard().text(T.bouton_ajouter_quelquun, `sh:${slug}:add`).row();
  boutons.forEach((b, i) => { k.text(b.text, b.callback_data); if (i % 2 === 1) k.row(); });
  await ecran(ctx, l.join("\n"), k);
}

async function actionPartage(ctx: Ctx, conf: boolean, slug: string, quoi: string, arg?: string) {
  if (!SLUG.test(slug)) return;
  if (quoi === "ok" || quoi === "no") return reponseConseiller(ctx, slug, quoi === "ok", Number(arg));
  const a = await droit(ctx, slug, "proprietaire");
  if (!a) return;
  const t = await lireFerme(slug);
  const p = ctx.personne!;
  if (quoi === "add") {
    await ecran(ctx, T.pour_qui, clavier([{ text: T.bouton_collegue, callback_data: `sh:${slug}:m` }, { text: T.bouton_conseiller, callback_data: `sh:${slug}:c` }]));
  } else if (quoi === "m" || quoi === "c") {
    const role = quoi === "m" ? "membre" : "conseiller";
    const l = await creerLien(db(), "join", { tenant: slug, par: p.id, payload: { role, grafana_role: "Viewer" } });
    const url = lienBot(ctx.s, "client", l.parametre);
    await ecran(ctx, f(T.lien_partage, { lien: url }), new InlineKeyboard().url(T.bouton_transmettre, `https://t.me/share/url?url=${encodeURIComponent(url)}`));
  } else if (quoi === "p") {
    const m = await un(`SELECT m.*, p.display_name FROM app.memberships m JOIN app.people p ON p.id = m.person_id WHERE m.person_id = $1 AND m.tenant_slug = $2`, [Number(arg), slug]);
    if (!m) { await ecranPartage(ctx, slug); return; }
    const role = m.source === "grafana" ? T.role_graphiques : ROLE_TXT[m.role];
    const droits = T.droits_voit + (m.receives_alerts ? T.droits_alertes : T.droits_sans_alertes);
    const k = new InlineKeyboard();
    if (m.source !== "grafana" && m.role !== "proprietaire") k.text(m.grafana_role === "Editor" ? T.bouton_lecture_seule : T.bouton_peut_modifier, `sh:${slug}:e:${arg}`);
    k.text(T.bouton_retirer_acces, `sh:${slug}:r:${arg}`).row().text(C.retour, `fm:${slug}:p`);
    await ecran(ctx, f(T.fiche_personne, { nom: echapper(m.display_name), role, droits }), k);
  } else if (quoi === "e") {
    const m = await un(`SELECT m.grafana_role, p.display_name FROM app.memberships m JOIN app.people p ON p.id = m.person_id WHERE m.person_id = $1 AND m.tenant_slug = $2`, [Number(arg), slug]);
    if (!m) return;
    const nouveau = m.grafana_role === "Editor" ? "Viewer" : "Editor";
    await tx(async c => {
      await c.query(`UPDATE app.memberships SET grafana_role = $3 WHERE person_id = $1 AND tenant_slug = $2 AND role <> 'proprietaire'`, [Number(arg), slug, nouveau]);
      await creerJob(c, { kind: "grafana_personne", tenant: slug, params: { person_id: Number(arg) }, requested_by: p.id });
      await audit(c, { acteur: p.id, tenant: slug, action: "rôle Grafana", details: { person_id: Number(arg), role: nouveau } });
    });
    await ecran(ctx, f(nouveau === "Editor" ? T.peut_modifier_ok : T.lecture_seule_ok, { prenom: echapper(prenom(m.display_name)) }),
      clavier([{ text: C.retour, callback_data: `sh:${slug}:p:${arg}` }]));
  } else if (quoi === "r") {
    const m = await un(`SELECT m.role, p.display_name, p.telegram_user_id, p.grafana_user_id FROM app.memberships m JOIN app.people p ON p.id = m.person_id
                        WHERE m.person_id = $1 AND m.tenant_slug = $2`, [Number(arg), slug]);
    if (!m) { await ctx.answerCallbackQuery().catch(() => undefined); await ecran(ctx, f(T.retire_ok, { nom: "" })); return; }
    if (!conf) {
      await ecran(ctx, f(T.retirer_question, { nom: echapper(m.display_name) }),
        clavier([{ text: T.bouton_retirer, callback_data: `sh!:${slug}:r:${arg}` }, { text: C.non, callback_data: `sh:${slug}:p:${arg}` }]));
      return;
    }
    if (tropAncien(ctx, 5) && ctx.callbackQuery?.message?.text?.startsWith(f(T.retirer_question, { nom: "" }).slice(0, 10))) { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
    const ok = await retirerAcces(ctx, slug, Number(arg), p.id, ctx.session.support ? "support" : "bot");
    await ecran(ctx, ok ? f(T.retire_ok, { nom: echapper(m.display_name) }) : T.dernier_proprietaire);
  } else if (quoi === "i") {
    const inv = await un(`SELECT token FROM app.invitations WHERE tenant_slug = $1 AND kind = 'join' AND token LIKE $2 || '%' AND used_at IS NULL AND revoked_at IS NULL`, [slug, arg]);
    if (!inv) { await ecranPartage(ctx, slug); return; }
    if (!conf) {
      await ecran(ctx, T.bouton_invitation, clavier([{ text: T.bouton_annuler_invitation, callback_data: `sh!:${slug}:i:${arg}` }, { text: C.retour, callback_data: `fm:${slug}:p` }]));
      return;
    }
    await q(`UPDATE app.invitations SET revoked_at = now() WHERE token = $1`, [inv.token]);
    await ecran(ctx, T.invitation_annulee, clavier([{ text: C.retour, callback_data: `fm:${slug}:p` }]));
  }
  void t;
}

/** Retire un accès tout de suite, puis le job retirer_acces (spec §6.4). false : dernier propriétaire. */
export async function retirerAcces(ctx: Ctx, slug: string, personId: number, par: number, via: "bot" | "admin" | "support"): Promise<boolean> {
  const m = await un(`SELECT m.role, p.display_name, p.telegram_user_id, p.grafana_user_id FROM app.memberships m JOIN app.people p ON p.id = m.person_id
                      WHERE m.person_id = $1 AND m.tenant_slug = $2`, [personId, slug]);
  if (!m) return true;
  const ok = await tx(async c => {
    if (m.role === "proprietaire") {
      const n = await c.query(`SELECT count(*)::int AS n FROM app.memberships WHERE tenant_slug = $1 AND role = 'proprietaire' AND status = 'actif'`, [slug]);
      if (n.rows[0].n <= 1) return false;
    }
    await c.query(`DELETE FROM app.memberships WHERE person_id = $1 AND tenant_slug = $2`, [personId, slug]);
    await creerJob(c, { kind: "retirer_acces", tenant: slug, params: { person_id: personId, grafana_user_id: m.grafana_user_id }, requested_by: par });
    await audit(c, { acteur: par, via, tenant: slug, action: "accès retiré", details: { person_id: personId, nom: m.display_name } });
    return true;
  });
  if (ok && m.telegram_user_id && personId !== par) {
    await envoyer(ctx.s, "client", Number(m.telegram_user_id), f(T.plus_acces, { ferme: echapper((await lireFerme(slug)).display_name) }));
  }
  return ok;
}

async function reponseConseiller(ctx: Ctx, slug: string, accepte: boolean, personId: number) {
  const a = await droit(ctx, slug, "proprietaire");
  if (!a) return;
  const m = await un(`SELECT m.*, p.display_name, p.telegram_user_id FROM app.memberships m JOIN app.people p ON p.id = m.person_id
                      WHERE m.person_id = $1 AND m.tenant_slug = $2 AND m.status = 'en_attente_accord'`, [personId, slug]);
  if (!m) { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
  await tx(async c => {
    if (accepte) {
      await c.query(`UPDATE app.memberships SET status = 'actif', granted_by = $3, granted_at = now() WHERE person_id = $1 AND tenant_slug = $2`, [personId, slug, ctx.personne!.id]);
      if (m.telegram_user_id) await creerJob(c, { kind: "grafana_personne", tenant: slug, params: { person_id: personId }, requested_by: ctx.personne!.id });
    } else {
      await c.query(`DELETE FROM app.memberships WHERE person_id = $1 AND tenant_slug = $2`, [personId, slug]);
    }
    await notifier(c, { audience: "admin", kind: "conseiller_reponse", tenant: slug, details: { accepte, nom: m.display_name,
      proprietaire: ctx.personne!.display_name, admin_id: m.granted_by } });
  });
  if (accepte) {
    await ecran(ctx, f(T.nouvel_acces, { nom: echapper(m.display_name), role: T.role_conseiller }), clavier([{ text: T.bouton_retirer, callback_data: `sh!:${slug}:r:${personId}` },
      { text: C.retour, callback_data: `fm:${slug}:p` }]));
    if (m.telegram_user_id) {
      const t = await lireFerme(slug);
      await envoyer(ctx.s, "client", Number(m.telegram_user_id), f(T.bienvenue_conseiller, { prenom: echapper(prenom(m.display_name)), ferme: echapper(t.display_name),
        proprietaire: echapper(ctx.personne!.display_name) }), { inline_keyboard: [[{ text: C.oui, callback_data: `cv:${slug}:1` }, { text: C.non, callback_data: `cv:${slug}:0` }]] });
    }
  } else await ecran(ctx, T.refuse_ok, clavier([{ text: C.retour, callback_data: `fm:${slug}:p` }]));
}

// ===================================================================== premier contact (§4.3)

async function accueil(ctx: Ctx) {
  const p = ctx.personne;
  if (!p) {
    await dire(ctx, T.inconnu, { reply_markup: clavier([{ text: T.bouton_demander_acces, callback_data: "rq" }]) });
    return;
  }
  const f0 = await choisirFerme(ctx, "c");
  if (f0) await ecranListe(ctx, f0.slug);
}

async function start(ctx: Ctx, param: string) {
  const lien = lireParametre(param);
  if (!lien) { await accueil(ctx); return; }
  const from = ctx.from!;
  const nom = nomTelegram(from);
  if (lien.kind === "groupe") { await lierGroupeParLien(ctx, lien.empreinte); return; }
  if (lien.kind === "admin") { await dire(ctx, T.lien_mort); return; }
  // Une seule transaction rapide (spec §6.3).
  const res = await tx(async c => {
    const existant = (await c.query(`SELECT id FROM app.people WHERE telegram_user_id = $1`, [from.id])).rows[0];
    const inv = await consommer(c, lien.empreinte, lien.kind, existant?.id ?? null);
    if (!inv) return { mort: true } as any;
    let personId: number;
    if (inv.kind === "activation" && inv.payload?.person_id) {
      const prevu = Number(inv.payload.person_id);
      if (existant && existant.id !== prevu) {
        // Ce Telegram appartient déjà à quelqu'un : ses adhésions récupèrent celles de la personne prévue (spec §6.3).
        await c.query(`INSERT INTO app.memberships (person_id, tenant_slug, role, grafana_role, receives_alerts, status, source, granted_by)
                       SELECT $1, tenant_slug, role, grafana_role, receives_alerts, status, source, granted_by FROM app.memberships WHERE person_id = $2
                       ON CONFLICT (person_id, tenant_slug) DO UPDATE SET role = EXCLUDED.role, grafana_role = EXCLUDED.grafana_role`, [existant.id, prevu]);
        const prevuL = (await c.query(`SELECT grafana_user_id, grafana_login FROM app.people WHERE id = $1`, [prevu])).rows[0];
        await c.query(`DELETE FROM app.memberships WHERE person_id = $1`, [prevu]);
        await c.query(`UPDATE app.invitations SET used_by = $1 WHERE used_by = $2`, [existant.id, prevu]);
        await c.query(`DELETE FROM app.people WHERE id = $1 AND telegram_user_id IS NULL`, [prevu]).catch(() => undefined);
        personId = existant.id;
        if (prevuL?.grafana_user_id && ctx.s.grafana.configure) await ctx.s.grafana.supprimerUtilisateur(Number(prevuL.grafana_user_id)).catch(() => undefined);
      } else {
        await c.query(`UPDATE app.people SET telegram_user_id = $1, display_name = $2, unreachable_since = NULL WHERE id = $3 AND telegram_user_id IS NULL`, [from.id, nom, prevu]);
        personId = prevu;
      }
    } else {
      const r = await c.query(`INSERT INTO app.people (telegram_user_id, display_name, source) VALUES ($1, $2, 'bot')
                               ON CONFLICT (telegram_user_id) DO UPDATE SET display_name = EXCLUDED.display_name, unreachable_since = NULL RETURNING id`, [from.id, nom]);
      personId = Number(r.rows[0].id);
    }
    await c.query(`UPDATE app.invitations SET used_by = $2 WHERE token = $1`, [lien.empreinte, personId]);
    if (inv.kind === "activation") {
      await c.query(`INSERT INTO app.memberships (person_id, tenant_slug, role, grafana_role, receives_alerts, status, source)
                     VALUES ($1, $2, 'proprietaire', 'Admin', true, 'actif', 'bot')
                     ON CONFLICT (person_id, tenant_slug) DO UPDATE SET role = 'proprietaire', grafana_role = 'Admin', receives_alerts = true, status = 'actif'`,
        [personId, inv.tenant_slug]);
      const act = await c.query(`UPDATE app.tenants SET status = 'actif', activated_at = now() WHERE slug = $1 AND status = 'en_attente_activation' RETURNING slug`, [inv.tenant_slug]);
      await creerJob(c, { kind: "grafana_personne", tenant: inv.tenant_slug, params: { person_id: personId } });
      if (act.rowCount) await notifier(c, { audience: "admin", kind: "ferme_activee", tenant: inv.tenant_slug, details: { nom } });
      await audit(c, { acteur: personId, tenant: inv.tenant_slug, action: "activation" });
    } else if (inv.kind === "join") {
      const role = inv.payload?.role === "conseiller" ? "conseiller" : "membre";
      await c.query(`INSERT INTO app.memberships (person_id, tenant_slug, role, grafana_role, receives_alerts, status, source, granted_by)
                     VALUES ($1, $2, $3, $4, $5, 'actif', 'bot', $6)
                     ON CONFLICT (person_id, tenant_slug) DO UPDATE SET role = EXCLUDED.role, grafana_role = EXCLUDED.grafana_role, status = 'actif'
                     WHERE app.memberships.role <> 'proprietaire'`,
        [personId, inv.tenant_slug, role, inv.payload?.grafana_role || "Viewer", role === "membre", inv.created_by]);
      await creerJob(c, { kind: "grafana_personne", tenant: inv.tenant_slug, params: { person_id: personId } });
      await audit(c, { acteur: personId, tenant: inv.tenant_slug, action: "accès par lien", details: { role } });
    }
    return { inv, personId };
  });
  ctx.personne = await chargerPersonne(from.id);
  if (res.mort) {
    const slug = await fermeDuLien(lien.empreinte);
    const a = slug && ctx.personne ? await adhesion(ctx.personne.id, slug) : null;
    if (a && a.status === "actif") { await dire(ctx, f(T.deja_acces, { ferme: echapper(a.display_name) })); await accueil(ctx); }
    else await dire(ctx, T.lien_mort);
    return;
  }
  const inv = res.inv;
  if (inv.kind === "new_client") {
    demarrer(ctx, "nom_ferme", "nom", "/start", { invite_par: inv.created_by });
    await dire(ctx, f(inv.payload?.demande ? T.nom_ferme_question_accepte : T.nom_ferme_question, { prenom: echapper(prenom(nom)) }),
      { reply_markup: { force_reply: true, input_field_placeholder: T.nom_ferme_exemple } });
    return;
  }
  const t = await lireFerme(inv.tenant_slug);
  if (inv.kind === "activation") {
    await dire(ctx, f(T.active, { prenom: echapper(prenom(nom)), ferme: echapper(t.display_name) }));
    const n = await un(`SELECT count(*)::int AS n FROM app.devices WHERE tenant_slug = $1 AND ttn_status <> 'supprime'`, [t.slug]);
    if (n.n) await ecranListe(ctx, t.slug); else await dire(ctx, T.premier_capteur);
    // Conseillers proposés pendant que la ferme attendait (spec §4.3 a).
    for (const c of await q(`SELECT m.person_id, p.display_name, p.profile FROM app.memberships m JOIN app.people p ON p.id = m.person_id
                             WHERE m.tenant_slug = $1 AND m.status = 'en_attente_accord'`, [t.slug])) {
      const org = c.profile?.organisme ? ` (${c.profile.organisme})` : "";
      await dire(ctx, f(T.propose_conseiller, { nom: echapper(c.display_name + org) }),
        { reply_markup: clavier([{ text: T.bouton_accepter, callback_data: `sh:${t.slug}:ok:${c.person_id}` }, { text: T.bouton_refuser, callback_data: `sh:${t.slug}:no:${c.person_id}` }]) });
    }
    return;
  }
  // join
  const proprio = (await proprietaires(t.slug))[0];
  const role = inv.payload?.role === "conseiller" ? "conseiller" : "membre";
  if (role === "conseiller") {
    await dire(ctx, f(T.bienvenue_conseiller, { prenom: echapper(prenom(nom)), ferme: echapper(t.display_name), proprietaire: echapper(proprio?.display_name || "") }),
      { reply_markup: clavier([{ text: C.oui, callback_data: `cv:${t.slug}:1` }, { text: C.non, callback_data: `cv:${t.slug}:0` }]) });
  } else {
    await dire(ctx, f(T.bienvenue_collegue, { prenom: echapper(prenom(nom)), ferme: echapper(t.display_name), proprietaire: echapper(proprio?.display_name || "") }));
    await ecranListe(ctx, t.slug);
  }
  // Le propriétaire est prévenu, avec de quoi défaire (spec §4.9).
  for (const pr of await proprietaires(t.slug)) {
    if (!pr.telegram_user_id || pr.id === res.personId) continue;
    await envoyer(ctx.s, "client", Number(pr.telegram_user_id), f(T.nouvel_acces, { nom: echapper(nom), role: ROLE_TXT[role] }),
      { inline_keyboard: [[{ text: T.bouton_retirer, callback_data: `sh!:${t.slug}:r:${res.personId}` }]] });
  }
}

async function nomFermeSaisi(ctx: Ctx, texte: string) {
  const nom = texte.trim();
  if (nom.length < 2 || nom.length > 60) { await dire(ctx, T.nom_ferme_invalide); return; }
  const conv = ctx.session.conv!;
  finir(ctx);
  const m = await dire(ctx, T.ferme_en_preparation);
  await tx(async c => {
    const slug = (await c.query(`SELECT 'f' || lpad(n::text, greatest(4, length(n::text)), '0') AS slug FROM nextval('app.tenant_slug_seq') AS n`)).rows[0].slug;
    await creerJob(c, { kind: "creer_client", tenant: slug, requested_by: ctx.personne!.id, chat_id: ctx.chat!.id, message_id: m.message_id,
      params: { nom, person_id: ctx.personne!.id, origine: "n_", invite_par: conv.donnees.invite_par ?? null } });
  });
}

// ===================================================================== groupes (§4.11)

async function lierGroupeParLien(ctx: Ctx, e: string) {
  if (!ctx.chat || ctx.chat.type === "private") { await dire(ctx, T.lien_mort); return; }
  const inv = await un(`SELECT * FROM app.invitations WHERE token = $1 AND kind = 'groupe' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [e]);
  if (!inv) { await dire(ctx, T.lien_mort); return; }
  const p = ctx.personne;
  const a = p ? await adhesion(p.id, inv.tenant_slug) : null;
  const parAdmin = Boolean(inv.payload?.admin) || Boolean((await un(`SELECT is_admin FROM app.people WHERE id = $1`, [inv.created_by]))?.is_admin);
  if (!parAdmin && (!a || a.status !== "actif" || a.role === "conseiller")) { await dire(ctx, T.groupe_refus_lien); return; }
  await tx(async c => {
    const u = await consommer(c, e, "groupe", p?.id ?? null);
    if (!u) return;
    await lierGroupe(ctx, c, inv.tenant_slug, ctx.chat!.id, (ctx.chat as any).title || "");
  });
}

async function lierGroupe(ctx: Ctx, c: any, slug: string, chatId: number, titre: string) {
  const ancien = (await c.query(`SELECT alert_chat_id, display_name FROM app.tenants WHERE slug = $1`, [slug])).rows[0];
  await c.query(`UPDATE app.tenants SET alert_chat_id = $2, alert_chat_unreachable_since = NULL,
                 config = config || jsonb_build_object('groupe_titre', $3::text) WHERE slug = $1`, [slug, chatId, titre.slice(0, 60)]);
  await audit(c, { acteur: ctx.personne?.id, tenant: slug, action: "groupe lié" });
  if (ancien?.alert_chat_id && Number(ancien.alert_chat_id) !== chatId) {
    await envoyer(ctx.s, "client", Number(ancien.alert_chat_id), f(T.groupe_remplace, { ferme: echapper(ancien.display_name) }));
  }
  await dire(ctx, f(T.groupe_lie, { ferme: echapper(ancien.display_name) }));
}

async function commandeLier(ctx: Ctx) {
  if (!ctx.chat || ctx.chat.type === "private") { await dire(ctx, f(T.en_prive, { bot: `@${ctx.me.username}` })); return; }
  const deja = await q(`SELECT slug, display_name FROM app.tenants WHERE alert_chat_id = $1 AND status NOT IN ('supprime')`, [ctx.chat.id]);
  if (deja.length) {
    await dire(ctx, f(T.groupe_deja, { ferme: echapper(deja.map(x => x.display_name).join(", ")) }),
      { reply_markup: clavier(deja.map(x => ({ text: T.bouton_arreter, callback_data: `gp!:${x.slug}` }))) });
    return;
  }
  const p = ctx.personne;
  const l = p ? (await fermesDe(p.id)).filter(x => x.role !== "conseiller" && x.status !== "suspendu") : [];
  if (!l.length) { await dire(ctx, T.groupe_refus_lier); return; }
  if (l.length === 1) { await tx(c => lierGroupe(ctx, c, l[0].slug, ctx.chat!.id, (ctx.chat as any).title || "")); return; }
  await dire(ctx, T.quelle_ferme, { reply_markup: clavier(l.map(x => ({ text: x.display_name, callback_data: `fm:${x.slug}:l` }))) });
}

// ===================================================================== graphiques (§4.12)

async function graphiques(ctx: Ctx) {
  const p = ctx.personne;
  if (!p) { await accueil(ctx); return; }
  if (ctx.chat?.type !== "private") {
    await dire(ctx, T.reponse_en_prive);
    if (!(await envoyer(ctx.s, "client", ctx.from!.id, "…"))) await dire(ctx, f(T.ouvrez_bot, { bot: `@${ctx.me.username}` }));
    return;
  }
  const l = await fermesDe(p.id);
  if (!l.length) { await accueil(ctx); return; }
  const adresse = ctx.s.cfg.grafana.publicUrl;
  const k = new InlineKeyboard();
  for (const x of l) if (x.grafana_org_id && x.status !== "suspendu") k.url(l.length > 1 ? x.display_name : T.bouton_ouvrir_graphiques, `${adresse}/?orgId=${x.grafana_org_id}`).row();
  if (!p.grafana_user_id && !p.grafana_password_sent_at) {
    const enEchec = await un(`SELECT 1 FROM app.jobs WHERE kind = 'grafana_personne' AND (params->>'person_id')::bigint = $1 AND status = 'echec'`, [p.id]);
    if (enEchec) { await dire(ctx, T.graphiques_pas_prets); return; }
  }
  if (!p.grafana_password_sent_at) {
    const m = await dire(ctx, T.graphiques_en_cours);
    await creerJob(db(), { kind: "mdp_grafana", params: { person_id: p.id, premier: true, tenant: l[0].slug }, requested_by: p.id, chat_id: ctx.chat.id, message_id: m.message_id });
    return;
  }
  k.text(T.bouton_nouveau_mdp, "pw");
  await dire(ctx, f(T.graphiques_deja, { adresse, login: echapper(p.grafana_login || "?"), date: jour(p.grafana_password_sent_at) }), { reply_markup: k });
}

// ===================================================================== actionneurs (§4.6, §6.8)

async function actionneur(ctx: Ctx, conf: boolean, dev: string, i: number) {
  const x = await droitCapteur(ctx, dev, "regler");
  if (!x) return;
  const { d } = x;
  const m = modeleDe(d.model_key);
  const ac = [...(m?.actions || []), ...((d.config?.actions || []) as any[])][i];
  if (!ac) return;
  const enCours = await un(`SELECT id, requested_at FROM app.commands WHERE dev_eui = $1 AND status IN ('demandee', 'envoyee')`, [dev]);
  if (enCours) {
    await ecran(ctx, f(T.ordre_deja, { heure: heure(enCours.requested_at) }), clavier([{ text: T.bouton_annuler_ordre, callback_data: `ax:${enCours.id}` }, { text: C.retour, callback_data: `dv:${dev}` }]));
    return;
  }
  const verbe = String(ac.bouton);
  if (!conf) {
    const lignesTxt = [f(T.action_question, { action: echapper(verbe), capteur: echapper(d.name) })];
    if (ctx.session.support) lignesTxt.push(f(T.vous_agissez_pour, { ferme: echapper(d.ferme) }));
    await ecran(ctx, lignesTxt.join("\n"), clavier([{ text: f(T.bouton_action_oui, { action: verbe.toLowerCase() }), callback_data: `ac!:${dev}:${i}` }, { text: C.non, callback_data: `dv:${dev}` }]));
    return;
  }
  if (tropAncien(ctx, 2)) { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
  const classeC = (ac.classe || "A") === "C";
  const texte = classeC ? T.ordre_classe_c : f(T.ordre_demande, { delai: `${ac.delai_typique_min || 10} min` });
  await passerOrdre(ctx, d, { cle: ac.cle, f_port: ac.f_port, payload_hex: String(ac.payload_hex).toLowerCase(), confirmed: ac.confirmed !== false,
    expire_min: Number(ac.expire_min || 60), texte });
}

/** Enregistre l'ordre, son envoi et son expiration ; le message « ⏳ » est mis à jour au fil de l'ordre (§6.8).
 *  `remplacer` : ce message prend la place de l'écran de confirmation au lieu de s'y ajouter. */
async function passerOrdre(ctx: Ctx, d: any, o: { cle: string; f_port: number; payload_hex: string; confirmed: boolean; expire_min: number; texte: string;
  remplacer?: boolean }) {
  const dev = d.dev_eui;
  const retour = clavier([{ text: C.retour, callback_data: `dv:${dev}` }]);
  const msg = { message_id: 0 };
  const ecranConf = o.remplacer ? ctx.callbackQuery?.message : undefined;
  if (ecranConf) {
    try { await ctx.editMessageText(o.texte, { parse_mode: "HTML", reply_markup: retour }); msg.message_id = ecranConf.message_id; } catch { /* nouveau message ci-dessous */ }
  }
  if (!msg.message_id) msg.message_id = (await dire(ctx, o.texte, { reply_markup: retour })).message_id;
  try {
    await tx(async c => {
      const r = await c.query(
        `WITH n AS (SELECT nextval(pg_get_serial_sequence('app.commands', 'id')) AS id)
         INSERT INTO app.commands (id, dev_eui, action, f_port, payload_hex, correlation_id, requested_by, via, status, requested_at, expires_at, chat_id, message_id)
         OVERRIDING SYSTEM VALUE
         SELECT n.id, $1, $2, $3, $4, 'mobilab:cmd:' || n.id, $5, $6, 'demandee', now(), now() + make_interval(mins => $7), $8, $9 FROM n
         RETURNING id, expires_at`,
        [dev, o.cle, o.f_port, o.payload_hex, ctx.personne!.id, ctx.session.support ? "support" : "bot",
         o.expire_min, ctx.chat!.id, msg.message_id]);
      const id = Number(r.rows[0].id);
      await creerJob(c, { kind: "commande", tenant: d.tenant_slug, dev_eui: dev, params: { command_id: id, confirmed: o.confirmed }, requested_by: ctx.personne!.id });
      await creerJob(c, { kind: "commande_expiree", tenant: d.tenant_slug, dev_eui: dev, params: { command_id: id }, run_after: new Date(r.rows[0].expires_at) });
      await audit(c, { acteur: ctx.personne!.id, via: ctx.session.support ? "support" : "bot", tenant: d.tenant_slug, dev_eui: dev, action: `ordre ${o.cle}` });
    });
  } catch (e: any) {
    if (e?.code === "23505") await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, f(T.ordre_deja, { heure: heure(new Date()) }), { reply_markup: retour });
    else throw e;
  }
}

/** Après « Annuler » au milieu d'une saisie : on rouvre l'écran d'où elle est partie, pour ne jamais finir sans issue. */
async function revenirApresAnnulation(ctx: Ctx, conv: Session["conv"]) {
  const dn = conv?.donnees || {};
  if (conv?.nom === "intervalle" && dn.dev) await ecranIntervalle(ctx, dn.dev);
  else if (conv?.nom === "renommer" && dn.dev) await ecranReglages(ctx, dn.dev);
  else if (conv?.nom === "seuil" && dn.dev) await ecranAlertesCapteur(ctx, dn.dev);
  else if (conv?.nom === "corriger" && dn.dev_eui_origine) await ecranReglages(ctx, String(dn.dev_eui_origine).toLowerCase());
  else if (conv?.nom === "ajouter" && dn.ferme) await ecranListe(ctx, dn.ferme);
}

// ===================================================================== intervalle d'envoi (downlink « 01 » + secondes)

/** Intervalle actuel : mesuré sur les dernières trames, sinon celui réglé (app.devices.intervalle_s), sinon le catalogue. */
function intervalleActuel(d: any, m: Modele | null): number {
  return Number(d.config?.detected?.intervalle_s || d.intervalle_s || m?.intervalle_defaut_s || 1200);
}

/** Arrondi à la minute au-delà de 2 min : la médiane mesurée vaut souvent 1203 s pour 20 min. */
function texteEnviron(s: number): string {
  return texteIntervalle(s >= 120 ? Math.round(s / 60) * 60 : s);
}

async function ecranIntervalle(ctx: Ctx, dev: string) {
  const x = await droitCapteur(ctx, dev, "regler");
  if (!x) return;
  const { d } = x;
  const m = modeleDe(d.model_key);
  if (!intervalleReglable(m)) return;
  const enCours = await un(`SELECT id, requested_at FROM app.commands WHERE dev_eui = $1 AND status IN ('demandee', 'envoyee')`, [dev]);
  if (enCours) {
    await ecran(ctx, f(T.ordre_deja, { heure: heure(enCours.requested_at) }), clavier([{ text: T.bouton_annuler_ordre, callback_data: `ax:${enCours.id}` }, { text: C.retour, callback_data: `st:${dev}` }]));
    return;
  }
  const texte = d.intervalle_s ? f(T.intervalle_titre_regle, { capteur: echapper(d.name), actuel: texteIntervalle(d.intervalle_s) })
    : f(T.intervalle_titre, { capteur: echapper(d.name), actuel: texteEnviron(intervalleActuel(d, m)) });
  const k = clavier([...INTERVALLE.proposes_s.map(s => ({ text: texteIntervalle(s), callback_data: `iv:${dev}:${s}` })),
    { text: T.bouton_intervalle_autre, callback_data: `iv:${dev}:a` }], 3);
  k.row().text(C.retour, `st:${dev}`);
  await ecran(ctx, texte, k);
}

/** Question de confirmation ; `nouveau` : réponse à une saisie (nouveau message), sinon on remplace l'écran. */
async function questionIntervalle(ctx: Ctx, d: any, s: number, nouveau = false) {
  const l = [f(T.intervalle_question, { capteur: echapper(d.name), duree: texteIntervalle(s) })];
  if (s < 300) l.push(T.intervalle_pile);
  if (ctx.session.support) l.push(f(T.vous_agissez_pour, { ferme: echapper(d.ferme) }));
  const k = clavier([{ text: T.bouton_intervalle_oui, callback_data: `iv!:${d.dev_eui}:${s}` }, { text: C.non, callback_data: `iv:${d.dev_eui}` }]);
  if (nouveau) await dire(ctx, l.join("\n"), { reply_markup: k }); else await ecran(ctx, l.join("\n"), k);
}

async function envoyerIntervalle(ctx: Ctx, dev: string, s: number) {
  const x = await droitCapteur(ctx, dev, "regler");
  if (!x) return;
  const { d } = x;
  const m = modeleDe(d.model_key);
  if (!intervalleReglable(m) || !Number.isInteger(s) || s < INTERVALLE.min_s || s > INTERVALLE.max_s) return;
  if (tropAncien(ctx, 5)) { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
  const enCours = await un(`SELECT id, requested_at FROM app.commands WHERE dev_eui = $1 AND status IN ('demandee', 'envoyee')`, [dev]);
  if (enCours) {
    await ecran(ctx, f(T.ordre_deja, { heure: heure(enCours.requested_at) }), clavier([{ text: T.bouton_annuler_ordre, callback_data: `ax:${enCours.id}` }, { text: C.retour, callback_data: `st:${dev}` }]));
    return;
  }
  // L'ordre part au prochain message (ancien intervalle) ; l'accusé arrive au message suivant (nouvel intervalle).
  const actuel = intervalleActuel(d, m);
  const expire_min = Math.max(60, Math.ceil(1.5 * (actuel + Math.max(actuel, s)) / 60));
  await passerOrdre(ctx, d, { cle: `intervalle:${s}`, f_port: INTERVALLE.f_port, payload_hex: ordreIntervalle(s), confirmed: true, expire_min,
    texte: f(T.intervalle_demande, { capteur: echapper(d.name), duree: texteIntervalle(s), delai: texteEnviron(actuel) }), remplacer: true });
}

async function annulerOrdre(ctx: Ctx, id: number) {
  const cmd = await un(`SELECT c.*, d.tenant_slug, d.name, d.config AS dconfig FROM app.commands c JOIN app.devices d ON d.dev_eui = c.dev_eui WHERE c.id = $1`, [id]);
  if (!cmd) return;
  if (!(await droit(ctx, cmd.tenant_slug, "regler"))) return;
  const retour = clavier([{ text: C.retour, callback_data: `dv:${cmd.dev_eui}` }]);
  if (!["demandee", "envoyee"].includes(cmd.status)) { await ecran(ctx, T.ordre_annule, retour); return; }
  await ctx.s.ttn.viderFile(await appDe(db(), cmd.tenant_slug), idTtn({ dev_eui: cmd.dev_eui, config: cmd.dconfig })).catch(() => undefined);
  await q(`UPDATE app.commands SET status = 'annulee' WHERE id = $1 AND status IN ('demandee', 'envoyee')`, [id]);
  await ecran(ctx, T.ordre_annule, retour);
  if (cmd.chat_id && cmd.message_id) await ctx.api.editMessageText(cmd.chat_id, cmd.message_id, T.ordre_annule, { reply_markup: retour }).catch(() => undefined);
}

// ===================================================================== modèle choisi (§4.4, §7.6)

async function modeleChoisi(ctx: Ctx, dev: string, choix: string, montage = false) {
  const x = await droitCapteur(ctx, dev, "regler");
  if (!x) return;
  const { d } = x;
  if (choix === "l") {
    const l = montagesMobilab();
    await ecran(ctx, T.montage_question, clavier([...l.map((m, i) => ({ text: boutonModele(m), callback_data: `mt:${dev}:${i}` })), { text: T.bouton_autre, callback_data: `md:${dev}:a` }], 1));
    return;
  }
  if (choix === "a") {
    await tx(async c => {
      await c.query(`INSERT INTO app.anomalies (raison, tenant_slug, dev_eui, details) VALUES ('modele_inconnu', $1, $2, '{"client":"autre"}')
                     ON CONFLICT (raison, coalesce(tenant_slug, ''), coalesce(dev_eui, ''), coalesce(gateway_id, '')) WHERE resolved_at IS NULL
                     DO UPDATE SET details = app.anomalies.details || '{"client":"autre"}'`, [d.tenant_slug, dev]);
    });
    await ecran(ctx, T.modele_autre, clavier([{ text: C.retour, callback_data: `dv:${dev}` }]));
    return;
  }
  const l = montage ? montagesMobilab() : modelesProposes(dev);
  const m = l[Number(choix)];
  if (!m) return;
  await tx(async c => {
    await c.query(`UPDATE app.devices SET model_key = $2, config = config || '{"model_source":"client"}' WHERE dev_eui = $1`, [dev, m.cle]);
    await creerJob(c, { kind: "mise_en_service", tenant: d.tenant_slug, dev_eui: dev, params: { redecoder: true, annonce: true }, requested_by: ctx.personne?.id });
    await c.query(`UPDATE app.anomalies SET resolved_at = now(), resolved_by = $2 WHERE dev_eui = $1 AND raison = 'modele_inconnu' AND resolved_at IS NULL`, [dev, ctx.personne?.id]);
    await audit(c, { acteur: ctx.personne?.id, tenant: d.tenant_slug, dev_eui: dev, action: "modèle choisi", details: { model_key: m.cle } });
  });
  await ecran(ctx, f(T.modele_note, { modele: echapper(m.libelle) }));
}

// ===================================================================== le bot

export function creerBotClient(s: Services): Bot<Ctx> {
  const bot = new Bot<Ctx>(s.cfg.telegram.clientToken || "0:test", { botInfo: s.cfg.telegram.clientToken ? undefined : ({ id: 1, is_bot: true, first_name: "Mobilab", username: s.noms.client || "MobilabBot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any) });

  bot.use(async (ctx, next) => {
    ctx.s = s;
    ctx.personne = ctx.from ? await chargerPersonne(ctx.from.id) : null;
    if (ctx.personne && ctx.chat?.type === "private") {
      await q(`UPDATE app.people SET unreachable_since = NULL WHERE id = $1 AND unreachable_since IS NOT NULL`, [ctx.personne.id]);
    }
    await next();
  });
  bot.use(session({ initial: (): Session => ({}), storage: stockage("client"),
    getSessionKey: ctx => (ctx.chat ? (ctx.chat.type === "private" ? String(ctx.chat.id) : `${ctx.chat.id}:${ctx.from?.id ?? 0}`) : undefined) }));

  // Erreur interne : une ligne à la personne, l'identifiant aux admins (spec §4.14).
  bot.catch(async err => {
    const code = codeErreur();
    log.error(`bot client ${code} : ${err.error instanceof Error ? err.error.stack || err.error.message : String(err.error)}`);
    try {
      if (err.ctx.callbackQuery) await err.ctx.answerCallbackQuery().catch(() => undefined);
      await err.ctx.reply(C.erreur_interne);
      await notifier(db(), { audience: "admin", kind: "erreur_interne", details: { code, ou: `bot client, ${err.ctx.callbackQuery?.data?.split(":")[0] || err.ctx.message?.text?.split(" ")[0] || "?"}` } });
    } catch { /* rien */ }
  });

  // Groupes : seules /lier, /aide et /start g_ ; le reste : « En privé » (spec §4.11).
  bot.on("my_chat_member", async ctx => {
    const n = ctx.myChatMember.new_chat_member.status;
    if (ctx.chat.type !== "private" && (n === "member" || n === "administrator")) await dire(ctx, T.groupe_bonjour).catch(() => undefined);
    if (ctx.chat.type !== "private" && (n === "left" || n === "kicked")) {
      await q(`UPDATE app.tenants SET alert_chat_unreachable_since = now() WHERE alert_chat_id = $1 AND alert_chat_unreachable_since IS NULL`, [ctx.chat.id]);
    }
  });
  bot.on("message:migrate_to_chat_id", async ctx => {
    await q(`UPDATE app.tenants SET alert_chat_id = $2 WHERE alert_chat_id = $1`, [ctx.chat.id, ctx.message.migrate_to_chat_id]);
  });

  bot.command("start", async ctx => {
    finir(ctx);
    const param = (ctx.match || "").trim();
    if (ctx.chat.type !== "private") {
      if (param.startsWith("g_")) await start(ctx, param); else await dire(ctx, T.groupe_bonjour);
      return;
    }
    await retirerClavier(ctx);
    await start(ctx, param);
  });
  bot.command("lier", ctx => commandeLier(ctx));
  bot.command("aide", async ctx => { finir(ctx); await dire(ctx, T.aide, { reply_markup: ctx.chat.type === "private" ? sansClavier : undefined }); });
  bot.command("annuler", async ctx => { finir(ctx); await dire(ctx, C.annule, { reply_markup: sansClavier }); });

  // Hors conversation privée, les autres commandes renvoient en privé.
  bot.on("message", async (ctx, next) => {
    if (ctx.chat.type !== "private") {
      if (ctx.message.text?.startsWith("/")) await dire(ctx, f(T.en_prive, { bot: `@${ctx.me.username}` }));
      return;
    }
    await next();
  });
  bot.command("capteurs", async ctx => { finir(ctx); if (!ctx.personne) return accueil(ctx); const f0 = await choisirFerme(ctx, "c"); if (f0) await ecranListe(ctx, f0.slug); });
  bot.command("ajouter", async ctx => { finir(ctx); if (!ctx.personne) return accueil(ctx); await lancerAjout(ctx); });
  bot.command("alertes", async ctx => { finir(ctx); if (!ctx.personne) return accueil(ctx); const f0 = await choisirFerme(ctx, "a"); if (f0) await ecranAlertes(ctx, f0.slug); });
  bot.command("graphiques", async ctx => { finir(ctx); await graphiques(ctx); });
  bot.command("partager", async ctx => { finir(ctx); if (!ctx.personne) return accueil(ctx); const f0 = await choisirFerme(ctx, "p"); if (f0) await ecranPartage(ctx, f0.slug); });
  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) { finir(ctx); await dire(ctx, T.commande_inconnue); return; }
    await next();
  });

  // Conversations en cours
  bot.on("message:text", async ctx => {
    const texte = ctx.message.text;
    if (/^(annuler|stop)$/i.test(texte.trim()) || texte === C.annuler) {
      const avant = ctx.session.conv;
      finir(ctx);
      await dire(ctx, C.annule, { reply_markup: sansClavier });
      await revenirApresAnnulation(ctx, avant);
      return;
    }
    const conv = conversation(ctx);
    if (!conv) {
      const o = ctx.session.oubliee;
      if (o && o.jusqua > Date.now()) { delete ctx.session.oubliee; await dire(ctx, f(C.trop_attente, { commande: o.commande }), { reply_markup: sansClavier }); return; }
      if (!ctx.personne) { await accueil(ctx); return; }
      // Texte libre : message à Mobilab (spec §4.13).
      ctx.session.texteLibre = texte.slice(0, 2000);
      await dire(ctx, T.envoyer_mobilab, { reply_markup: clavier([{ text: C.oui, callback_data: "sp:1" }, { text: C.non, callback_data: "sp:0" }]) });
      return;
    }
    if (conv.nom === "ajouter" || conv.nom === "corriger") return etapeAjout(ctx, texte);
    if (conv.nom === "nom_ferme") return nomFermeSaisi(ctx, texte);
    if (conv.nom === "renommer") {
      const nom = texte.trim();
      const dev = conv.donnees.dev;
      const x = await droitCapteur(ctx, dev, "regler");
      if (!x) { finir(ctx); return; }
      if (nom.length < 1 || nom.length > 40) { await dire(ctx, T.nom_invalide); return; }
      if (!(await nomLibre(x.d.tenant_slug, nom, dev))) { await dire(ctx, T.nom_pris); return; }
      finir(ctx);
      await tx(async c => {
        await c.query(`UPDATE app.devices SET name = $2 WHERE dev_eui = $1`, [dev, nom]);
        await creerJob(c, { kind: "renommer_capteur", tenant: x.d.tenant_slug, dev_eui: dev, requested_by: ctx.personne!.id });
        await audit(c, { acteur: ctx.personne!.id, via: ctx.session.support ? "support" : "bot", tenant: x.d.tenant_slug, dev_eui: dev, action: "renommé", details: { avant: x.d.name, apres: nom } });
      });
      await dire(ctx, f(T.renomme, { capteur: echapper(nom) }), { reply_markup: sansClavier });
      await ecranFiche(ctx, dev, true);
      return;
    }
    if (conv.nom === "intervalle") {
      const dev = conv.donnees.dev;
      const x = await droitCapteur(ctx, dev, "regler");
      if (!x) { finir(ctx); return; }
      const sec = lireIntervalle(texte);
      if (sec === null) { await dire(ctx, T.intervalle_pas_compris); return; }
      if (sec < INTERVALLE.min_s || sec > INTERVALLE.max_s) {
        await dire(ctx, f(T.intervalle_hors_bornes, { min: texteIntervalle(INTERVALLE.min_s), max: texteIntervalle(INTERVALLE.max_s) }));
        return;
      }
      finir(ctx);
      await retirerClavier(ctx);
      await questionIntervalle(ctx, x.d, sec, true);
      return;
    }
    if (conv.nom === "seuil") {
      const { dev, metric } = conv.donnees;
      const x = await droitCapteur(ctx, dev, "regler");
      if (!x) { finir(ctx); return; }
      const m = modeleDe(x.d.model_key);
      const def = definition(m, metric);
      const lim = lireLimite(texte, x.d.last_values?.[metric]?.v);
      if (!lim) { await dire(ctx, T.seuil_pas_compris); return; }
      const autres = (await regles(dev)).filter(r => r.kind === "threshold" && r.metric === metric);
      const hi = autres.find(r => r.max !== null), lo = autres.find(r => r.min !== null);
      if ((lim.sens === "lo" && hi && lim.valeur >= Number(hi.max)) || (lim.sens === "hi" && lo && lim.valeur <= Number(lo.min))) {
        await dire(ctx, f(T.seuil_bas_haut, { valeur: avecUnite(Number(lim.sens === "lo" ? hi.max : lo.min), def) }));
        return;
      }
      finir(ctx);
      await poserSeuil(ctx, dev, metric, lim.sens, lim.valeur);
      await dire(ctx, f(T.seuil_ok, { regle: `${lim.sens === "lo" ? "&lt;" : "&gt;"} ${avecUnite(lim.valeur, def)}` }), { reply_markup: sansClavier });
      return;
    }
    finir(ctx);
  });

  bot.on("message:photo", async ctx => {
    const conv = conversation(ctx);
    if (conv && (conv.nom === "ajouter" || conv.nom === "corriger") && ["appeui", "appkey", "deveui"].includes(conv.etape)) {
      // Lecture de l'étiquette (étape 3b de la spec) : pas encore disponible, on demande la saisie.
      await dire(ctx, T.photo_illisible);
      conv.etape = "appeui";
      return;
    }
    if (!ctx.personne) { await accueil(ctx); return; }
    await dire(ctx, T.photo_ajouter, { reply_markup: clavier([{ text: T.bouton_oui_ok, callback_data: "ad:p:1" }, { text: C.non, callback_data: "ad:p:0" }]) });
  });
  bot.on("message", async ctx => { if (ctx.chat.type === "private") await dire(ctx, T.que_texte_photo); });

  // ------------------------------------------------------------------ boutons (§4.15)
  bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data;
    const [verbe0, ...a] = data.split(":");
    const conf = verbe0.endsWith("!");
    const verbe = verbe0.replace(/!$/, "");
    const repondre = () => ctx.answerCallbackQuery().catch(() => undefined);
    if (!ctx.personne && !["rq", "ct", "rc", "rs", "dv", "ag"].includes(verbe)) { await ctx.answerCallbackQuery({ text: T.plus_acces_bouton }); return; }
    switch (verbe) {
      case "fm": {
        const [slug, ecr] = a;
        if (!SLUG.test(slug)) break;
        if (ecr === "c") await ecranListe(ctx, slug);
        else if (ecr === "a") await ecranAlertes(ctx, slug);
        else if (ecr === "p") await ecranPartage(ctx, slug);
        else if (ecr === "j") { const x = (await fermesDe(ctx.personne!.id)).find(z => z.slug === slug); if (x) await lancerAjout(ctx, x); }
        else if (ecr === "l" && ctx.chat && ctx.chat.type !== "private") {
          if (await droit(ctx, slug, "regler")) await tx(c => lierGroupe(ctx, c, slug, ctx.chat!.id, (ctx.chat as any).title || ""));
        }
        break;
      }
      case "ls": if (SLUG.test(a[0])) await ecranListe(ctx, a[0], Number(a[1]) || 0); break;
      case "dv": {
        if (ctx.chat?.type !== "private") {
          // Dans un groupe, la fiche part en privé (spec §4.8).
          const x = DEVEUI.test(a[0]) ? await lireCapteur(a[0]) : null;
          const ad = x && ctx.personne ? await adhesion(ctx.personne.id, x.tenant_slug) : null;
          if (!ad) { await ctx.answerCallbackQuery({ text: T.reserve_ferme }); return; }
          const { texte } = await texteFiche(x, ad.role === "conseiller");
          const ok = await envoyer(s, "client", ctx.from.id, texte, { inline_keyboard: [[{ text: T.bouton_alertes, callback_data: `al:${x.dev_eui}` }]] });
          await ctx.answerCallbackQuery({ text: ok ? T.envoyee_prive : f(T.ouvrez_bot, { bot: `@${ctx.me.username}` }) });
          return;
        }
        await ecranFiche(ctx, a[0], Boolean(ctx.callbackQuery.message && "reply_markup" in ctx.callbackQuery.message && (ctx.callbackQuery.message.text || "").startsWith("⚠️")));
        break;
      }
      case "st": await ecranReglages(ctx, a[0]); break;
      case "iv": {
        const [dev, choix] = a;
        if (conf) { await envoyerIntervalle(ctx, dev, Number(choix)); break; }
        if (!choix) { await ecranIntervalle(ctx, dev); break; }
        const x = await droitCapteur(ctx, dev, "regler");
        if (!x || !intervalleReglable(modeleDe(x.d.model_key))) break;
        if (choix === "a") {
          demarrer(ctx, "intervalle", "duree", "/capteurs", { dev });
          await repondre();
          await dire(ctx, T.intervalle_saisie, { reply_markup: clavierAnnuler(C.annuler, "15 min") });
          return;
        }
        if (!INTERVALLE.proposes_s.includes(Number(choix))) break;
        await questionIntervalle(ctx, x.d, Number(choix));
        break;
      }
      case "rn": {
        const x = await droitCapteur(ctx, a[0], "regler");
        if (!x) break;
        demarrer(ctx, "renommer", "nom", "/capteurs", { dev: a[0] });
        await repondre();
        await dire(ctx, f(T.renommer_question, { capteur: echapper(x.d.name) }), { reply_markup: clavierAnnuler(C.annuler, T.q_nom_exemple) });
        return;
      }
      case "ck": {
        const x = await droitCapteur(ctx, a[0], "regler");
        if (!x) break;
        if (x.d.last_seen) { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
        demarrer(ctx, "corriger", "appeui", "/capteurs", { ferme: x.d.tenant_slug, nom: x.d.name, dev_eui_origine: x.d.dev_eui.toUpperCase() });
        await repondre();
        await dire(ctx, T.corriger_codes_question, { reply_markup: clavierAnnuler(C.annuler) });
        return;
      }
      case "pb": await ecranBranchements(ctx, a[0]); break;
      case "pc": {
        const x = await droitCapteur(ctx, a[0], "regler");
        if (!x) break;
        const m = modeleDe(x.d.model_key);
        const voie = voiesDe(m, x.d.mode_override || x.d.config?.detected?.mode_lu || null)[Number(a[1]) - 1];
        if (!voie) break;
        const b = sondesPour(m, voie).map(z => ({ text: z.sonde.libelle, callback_data: `ps:${a[0]}:${a[1]}:${z.rang}` }));
        b.push({ text: T.bouton_rien, callback_data: `ps:${a[0]}:${a[1]}:r` });
        await ecran(ctx, f(T.sonde_question, { n: a[1], capteur: echapper(x.d.name) }), clavier([...b, { text: C.retour, callback_data: `pb:${a[0]}` }]));
        break;
      }
      case "ps": {
        const premiere = /p$/.test(a[2] || "");
        await choisirSonde(ctx, a[0], Number(a[1]), String(a[2] || "").replace(/p$/, ""), premiere);
        return;
      }
      case "mo": {
        const x = await droitCapteur(ctx, a[0], "regler");
        if (!x) break;
        const modes = modesDe(modeleDe(x.d.model_key));
        await ecran(ctx, T.bouton_mode, clavier([{ text: T.bouton_automatique, callback_data: `ms:${a[0]}:a` },
          ...modes.map((m, i) => ({ text: m.libelle, callback_data: `ms:${a[0]}:${i}` })), { text: C.retour, callback_data: `pb:${a[0]}` }]));
        break;
      }
      case "ms": {
        const x = await droitCapteur(ctx, a[0], "regler");
        if (!x) break;
        const modes = modesDe(modeleDe(x.d.model_key));
        const choix = a[1] === "a" ? null : modes[Number(a[1])]?.code ?? null;
        if (a[1] !== "a" && choix === null) break;
        await tx(async c => {
          await c.query(`UPDATE app.devices SET mode_override = $2 WHERE dev_eui = $1`, [a[0], choix]);
          await creerJob(c, { kind: "mise_en_service", tenant: x.d.tenant_slug, dev_eui: a[0], requested_by: ctx.personne!.id });
          await audit(c, { acteur: ctx.personne!.id, tenant: x.d.tenant_slug, dev_eui: a[0], action: "mode", details: { mode: choix } });
        });
        await ecran(ctx, choix ? f(T.mode_force_ok, { mode: echapper(modes[Number(a[1])].libelle.toLowerCase()) }) : T.mode_auto_ok,
          clavier([{ text: C.retour, callback_data: `pb:${a[0]}` }]));
        break;
      }
      case "md": await modeleChoisi(ctx, a[0], a[1]); break;
      case "mt": await modeleChoisi(ctx, a[0], a[1], true); break;
      case "dl": {
        const x = await droitCapteur(ctx, a[0], "proprietaire");
        if (!x) return;
        if (!conf) {
          await ecran(ctx, f(T.supprimer_question, { capteur: echapper(x.d.name) }), clavier([{ text: T.bouton_supprimer, callback_data: `dl!:${a[0]}` }, { text: C.non, callback_data: `st:${a[0]}` }]));
          break;
        }
        if (tropAncien(ctx, 5)) { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
        await tx(async c => {
          await c.query(`UPDATE app.devices SET ttn_status = 'supprime' WHERE dev_eui = $1`, [a[0]]);
          await creerJob(c, { kind: "supprimer_capteur", tenant: x.d.tenant_slug, dev_eui: a[0], requested_by: ctx.personne!.id, params: { via: ctx.session.support ? "support" : "bot" } });
        });
        await ecran(ctx, f(T.supprime, { capteur: echapper(x.d.name) }));
        break;
      }
      case "ac": await actionneur(ctx, conf, a[0], Number(a[1])); break;
      case "ax": await annulerOrdre(ctx, Number(a[0])); break;
      case "al": await ecranAlertesCapteur(ctx, a[0]); break;
      case "am": await ecranSeuil(ctx, a[0], a[1]); break;
      case "th": {
        const [dev, metric, sens, i] = a;
        const x = await droitCapteur(ctx, dev, "regler");
        if (!x) return;
        const m = modeleDe(x.d.model_key);
        const def = definition(m, metric);
        if (!def) break;
        if (sens === "x") {
          await poserSeuil(ctx, dev, metric, "x", null);
          await repondre();
          await ecran(ctx, f(T.seuil_enleve, { mesure: echapper((def.libelle || metric).toLowerCase()) }), clavier([{ text: C.retour, callback_data: `al:${dev}` }]));
          return;
        }
        if (def.alerte === "debit") {
          const h = sens === "lo" ? 12 : 24;
          await poserSeuil(ctx, dev, metric, sens as "lo" | "hi", 0.1, h * 60);
          await q(`DELETE FROM app.alert_rules WHERE dev_eui = $1 AND kind = 'threshold' AND metric = $2 AND ${sens === "lo" ? "max" : "min"} IS NOT NULL`, [dev, metric]);
          await repondre();
          await ecran(ctx, f(sens === "lo" ? T.debit_arret_ok : T.debit_fuite_ok, { h }),
            clavier([{ text: T.bouton_changer_duree, callback_data: `du:${dev}:${metric}:${sens}` }, { text: C.retour, callback_data: `al:${dev}` }]));
          return;
        }
        const liste = sens === "lo" ? def.seuils_proposes?.min : def.seuils_proposes?.max;
        const v = liste?.[Number(i)];
        if (v === undefined) break;
        await poserSeuil(ctx, dev, metric, sens as "lo" | "hi", v, 0, true);
        await ctx.answerCallbackQuery({ text: f(T.seuil_ok, { regle: `${sens === "lo" ? "<" : ">"} ${avecUnite(v, def)}` }).slice(0, 190) });
        await ecranAlertesCapteur(ctx, dev);
        return;
      }
      case "tv": {
        const x = await droitCapteur(ctx, a[0], "regler");
        if (!x) break;
        demarrer(ctx, "seuil", "valeur", "/alertes", { dev: a[0], metric: a[1] });
        await repondre();
        await dire(ctx, T.seuil_saisie, { reply_markup: clavierAnnuler(C.annuler, "< 3") });
        return;
      }
      case "du": {
        const [dev, metric, sens, h] = a;
        if (!h) {
          await ecran(ctx, T.duree_question, clavier([3, 12, 24].map(n => ({ text: `${n} h`, callback_data: `du:${dev}:${metric}:${sens}:${n}` })), 3));
          break;
        }
        const x = await droitCapteur(ctx, dev, "regler");
        if (!x || ![3, 12, 24].includes(Number(h))) break;
        await poserSeuil(ctx, dev, metric, sens as "lo" | "hi", 0.1, Number(h) * 60);
        await ecran(ctx, f(sens === "lo" ? T.debit_arret_ok : T.debit_fuite_ok, { h }), clavier([{ text: C.retour, callback_data: `al:${dev}` }]));
        break;
      }
      case "ai": {
        const [dev, quoi, metric] = a;
        const x = await droitCapteur(ctx, dev, "regler");
        if (!x) return;
        const kind = quoi === "s" ? "silence" : "state";
        await tx(async c => {
          const r = await c.query(`INSERT INTO app.alert_rules (dev_eui, kind, metric, enabled, created_by) VALUES ($1, $2, $3, true, $4)
                                   ON CONFLICT (dev_eui, kind, coalesce(metric, '')) WHERE kind <> 'threshold'
                                   DO UPDATE SET enabled = NOT app.alert_rules.enabled, params = app.alert_rules.params - 'en_pause_depuis'
                                   RETURNING id, enabled`,
            [dev, kind, kind === "state" ? metric : null, ctx.personne!.id]);
          // Un état qu'on (ré)active repart de « normal », sans message. « Pas de nouvelles » garde son état : réactivée
          // pendant un silence déjà signalé, elle ne resonne pas ; elle dira « de nouveau en ligne » au retour du capteur.
          if (kind === "silence") await c.query(`INSERT INTO app.alert_state (rule_id) VALUES ($1) ON CONFLICT (rule_id) DO NOTHING`, [r.rows[0].id]);
          else await c.query(`INSERT INTO app.alert_state (rule_id) VALUES ($1) ON CONFLICT (rule_id) DO UPDATE SET state = 'ok', since = now(), pending_since = NULL`, [r.rows[0].id]);
          await audit(c, { acteur: ctx.personne!.id, tenant: x.d.tenant_slug, dev_eui: dev, action: r.rows[0].enabled ? "alerte activée" : "alerte désactivée", details: { kind, metric: kind === "state" ? metric : null } });
        });
        await repondre();
        if (kind === "silence" && metric === "r") await ecranReglages(ctx, dev); else await ecranAlertesCapteur(ctx, dev);
        return;
      }
      case "cp": {
        // Pile : plus de rappel jusqu'à la pile neuve (la règle repasse « normale » et se réarme toute seule).
        const n = await un(`SELECT * FROM app.notifications WHERE id = $1 AND kind = 'alerte'`, [Number(a[0])]);
        const ad = n && ctx.personne ? await adhesion(ctx.personne.id, n.tenant_slug) : null;
        if (!ad || ad.status !== "actif" || ad.role === "conseiller") { await ctx.answerCallbackQuery({ text: T.reserve_ferme }); return; }
        await q(`UPDATE app.alert_state SET muted_until = 'infinity', muted_by = $2
                 WHERE rule_id IN (SELECT id FROM app.alert_rules WHERE dev_eui = $1 AND kind = 'battery')`, [n.dev_eui, ctx.personne!.id]);
        await ctx.answerCallbackQuery({ text: T.pile_coupee });
        for (const dst of (n.destinataires || []) as any[]) {
          if (dst.message_id) await ctx.api.editMessageReplyMarkup(dst.chat_id, dst.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
        }
        return;
      }
      case "aj": {
        const conv = conversation(ctx);
        if (!conv || conv.nom !== "ajouter") { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
        if (a[0] === "m" && conv.etape === "marque") {
          const mq = marques().find(m => m.cle === a[1]);
          if (!mq) break;
          conv.donnees.marque_bouton = mq.bouton;
          await repondre();
          if (!typesDeMarque(mq.cle).length) {
            conv.etape = "nom";
            await ecran(ctx, f(T.relecture_type, { type: echapper(libelleType(conv.donnees)) }));
            await dire(ctx, T.q_nom, { reply_markup: clavierAnnuler(C.annuler, T.q_nom_exemple) });
            return;
          }
          conv.etape = await apresMarque(ctx, mq.cle);
          return;
        }
        if (a[0] === "k" && (conv.etape === "categorie" || conv.etape === "type")) {
          await repondre();
          if (!a[2]) { conv.etape = "categorie"; await questionCategorie(ctx, a[1]); return; }
          conv.etape = "type";
          await questionType(ctx, a[1], "", a[2]);
          return;
        }
        if (a[0] === "t" && (conv.etape === "type" || conv.etape === "categorie")) {
          const m = a[1] === "a" ? null : modeleDe(a[1]);
          conv.donnees.modele = m ? m.cle : null;
          conv.etape = "nom";
          await repondre();
          await ecran(ctx, f(T.relecture_type, { type: echapper(libelleType(conv.donnees)) }));
          await dire(ctx, T.q_nom, { reply_markup: clavierAnnuler(C.annuler, T.q_nom_exemple) });
          return;
        }
        break;
      }
      case "ct": await couper(ctx, Number(a[0]), false); return;
      case "rs": await reactiverSilence(ctx, Number(a[0])); return;
      case "rc": await couper(ctx, Number(a[0]), true); return;
      case "ag": {
        const n = await un(`SELECT * FROM app.notifications WHERE id = $1`, [Number(a[0])]);
        const devs = [n?.dev_eui, ...((n?.details?.groupe || []) as string[])].filter(Boolean);
        const ad = n && ctx.personne ? await adhesion(ctx.personne.id, n.tenant_slug) : null;
        if (!ad) { await ctx.answerCallbackQuery({ text: T.reserve_ferme }); return; }
        const caps = await q(`SELECT dev_eui, name FROM app.devices WHERE dev_eui = ANY($1::text[])`, [devs]);
        await repondre();
        await envoyer(s, "client", ctx.from.id, f(T.alertes_titre, { ferme: echapper(ad.display_name) }), clavier(caps.map(c => ({ text: c.name, callback_data: `dv:${c.dev_eui}` }))));
        return;
      }
      case "rv": {
        const [slug, v] = a;
        const ad = await droit(ctx, slug, "voir");
        if (!ad) return;
        if (v === "0" && !conf) {
          const autres = await un(`SELECT count(*)::int AS n FROM app.memberships m JOIN app.people p ON p.id = m.person_id
                                   WHERE m.tenant_slug = $1 AND m.receives_alerts AND m.status = 'actif' AND p.telegram_user_id IS NOT NULL AND m.person_id <> $2`, [slug, ctx.personne!.id]);
          const t = await lireFerme(slug);
          if (!autres.n && !t.alert_chat_id) {
            await ecran(ctx, T.dernier_destinataire, clavier([{ text: C.oui, callback_data: `rv!:${slug}:0` }, { text: C.non, callback_data: `fm:${slug}:a` }]));
            break;
          }
        }
        await q(`UPDATE app.memberships SET receives_alerts = $3 WHERE person_id = $1 AND tenant_slug = $2`, [ctx.personne!.id, slug, v === "1"]);
        await repondre();
        await ecranAlertes(ctx, slug);
        return;
      }
      case "gp": {
        const slug = a[0];
        if (!(await droit(ctx, slug, "regler"))) return;
        if (!conf) {
          await ecran(ctx, T.bouton_arreter_groupe, clavier([{ text: T.bouton_arreter_groupe, callback_data: `gp!:${slug}` }, { text: C.retour, callback_data: `fm:${slug}:a` }]));
          break;
        }
        const t = await lireFerme(slug);
        await q(`UPDATE app.tenants SET alert_chat_id = NULL, alert_chat_unreachable_since = NULL WHERE slug = $1`, [slug]);
        if (t.alert_chat_id && ctx.chat?.id !== Number(t.alert_chat_id)) await envoyer(s, "client", Number(t.alert_chat_id), T.groupe_delie);
        await ecran(ctx, T.groupe_delie, clavier([{ text: C.retour, callback_data: `fm:${slug}:a` }]));
        break;
      }
      case "ad": {
        if (a[0] === "ok") { await validerAjout(ctx); return; }
        if (a[0] === "fx") {
          await ecran(ctx, T.corriger_quoi, clavier([{ text: T.champ_nom, callback_data: "ad:f:n" }, { text: "AppEUI", callback_data: "ad:f:a" },
            { text: "AppKey", callback_data: "ad:f:k" }, { text: "DevEUI", callback_data: "ad:f:d" }]));
          break;
        }
        if (a[0] === "f") {
          const conv = conversation(ctx);
          if (!conv) { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
          const champ = ({ n: "nom", a: "appeui", k: "appkey", d: "deveui" } as Record<string, string>)[a[1]];
          if (!champ || (conv.nom === "corriger" && champ === "nom")) break;
          delete conv.donnees[champ];
          conv.etape = champ;
          await repondre();
          await dire(ctx, ({ nom: T.q_nom, appeui: T.q_appeui, appkey: T.q_appkey, deveui: T.q_deveui } as Record<string, string>)[champ]);
          return;
        }
        if (a[0] === "p") {
          await repondre();
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
          if (a[1] === "1") await lancerAjout(ctx);
          return;
        }
        break;
      }
      case "sh": await actionPartage(ctx, conf, a[0], a[1], a[2]); break;
      case "lv": {
        const slug = a[0];
        const ad = await droit(ctx, slug, "voir");
        if (!ad) return;
        if (ad.role === "proprietaire") { await ctx.answerCallbackQuery({ text: T.dernier_proprietaire }); return; }
        if (!conf) {
          await ecran(ctx, f(T.quitter_question, { ferme: echapper(ad.display_name) }), clavier([{ text: T.bouton_quitter_ok, callback_data: `lv!:${slug}` }, { text: C.non, callback_data: `fm:${slug}:p` }]));
          break;
        }
        await retirerAcces(ctx, slug, ctx.personne!.id, ctx.personne!.id, "bot");
        await ecran(ctx, T.quitte_ok);
        for (const pr of await proprietaires(slug)) if (pr.telegram_user_id) await envoyer(s, "client", Number(pr.telegram_user_id), f(T.parti, { nom: echapper(ctx.personne!.display_name) }));
        break;
      }
      case "rq": {
        await repondre();
        const from = ctx.from;
        const nom = nomTelegram(from);
        const res = await tx(async c => {
          const r = await c.query(`INSERT INTO app.people (telegram_user_id, display_name, source) VALUES ($1, $2, 'bot')
                                   ON CONFLICT (telegram_user_id) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id, access_requested_at`, [from.id, nom]);
          const p = r.rows[0];
          if (p.access_requested_at && Date.now() - new Date(p.access_requested_at).getTime() < 86400000) return { deja: true, id: p.id };
          await c.query(`UPDATE app.people SET access_requested_at = now() WHERE id = $1`, [p.id]);
          const n = await c.query(`INSERT INTO app.notifications (audience, expediteur, kind, transition, details, statut)
                                   VALUES ('admin', 'service', 'demande_acces', 'admin', $1::jsonb, 'en_cours') RETURNING id`, [json({ person_id: p.id, nom })]);
          return { deja: false, id: p.id, notif: Number(n.rows[0].id) };
        });
        await ecran(ctx, res.deja ? T.demande_deja : T.demande_envoyee);
        if (!res.deja) {
          const pseudo = from.username ? ` (@${from.username})` : "";
          await avertirAdmins(s, f((await import("../textes.fr.js")).admin.notif_demande_acces, { nom: echapper(nom), pseudo: echapper(pseudo) }), {
            notificationId: res.notif, clavier: { inline_keyboard: [[{ text: T.bouton_accepter, callback_data: `a:ntf:${res.notif}:ok` }, { text: T.bouton_refuser, callback_data: `a:ntf:${res.notif}:no` }]] } });
        }
        return;
      }
      case "cv": {
        const [slug, v] = a;
        const ad = ctx.personne ? await adhesion(ctx.personne.id, slug) : null;
        if (!ad) { await ctx.answerCallbackQuery({ text: T.plus_acces_bouton }); return; }
        await q(`UPDATE app.memberships SET receives_alerts = $3 WHERE person_id = $1 AND tenant_slug = $2`, [ctx.personne!.id, slug, v === "1"]);
        await repondre();
        await ecran(ctx, T.note);
        await ecranListe(ctx, slug).catch(() => undefined);
        return;
      }
      case "pw": {
        const p = ctx.personne!;
        if (!conf) {
          await ecran(ctx, T.nouveau_mdp_question, clavier([{ text: C.oui, callback_data: "pw!" }, { text: C.non, callback_data: "no" }]));
          break;
        }
        if (tropAncien(ctx, 5)) { await ctx.answerCallbackQuery({ text: C.trop_ancien }); return; }
        await repondre();
        await ecran(ctx, T.graphiques_en_cours);
        await creerJob(db(), { kind: "mdp_grafana", params: { person_id: p.id }, requested_by: p.id, chat_id: ctx.chat!.id, message_id: ctx.callbackQuery.message?.message_id });
        return;
      }
      case "sp": {
        const texte = ctx.session.texteLibre;
        delete ctx.session.texteLibre;
        await repondre();
        if (a[0] !== "1" || !texte) { await ecran(ctx, C.annule); return; }
        const p = ctx.personne!;
        const slug = ctx.session.ferme || (await fermesDe(p.id))[0]?.slug || null;
        const fermeNom = slug ? (await lireFerme(slug))?.display_name : "(sans ferme)";
        const n = await un(`INSERT INTO app.notifications (audience, expediteur, kind, tenant_slug, transition, details, statut)
                            VALUES ('admin', 'service', 'message_client', $1, 'admin', $2::jsonb, 'en_cours') RETURNING id`,
          [slug, json({ person_id: p.id, texte, nom: p.display_name })]);
        await ecran(ctx, T.envoye_mobilab);
        await avertirAdmins(s, f((await import("../textes.fr.js")).admin.notif_message_client, { nom: echapper(p.display_name), ferme: echapper(fermeNom), texte: echapper(texte) }), {
          notificationId: n!.id, clavier: { inline_keyboard: [[{ text: (await import("../textes.fr.js")).admin.bouton_repondre, callback_data: `a:ntf:${n!.id}:r` },
            ...(slug ? [{ text: (await import("../textes.fr.js")).admin.bouton_voir_fiche, callback_data: `a:cli:${slug}` }] : [])]] } });
        return;
      }
      case "no": {
        await repondre();
        await ecran(ctx, C.annule);
        return;
      }
      default:
        break;
    }
    await repondre();
  });

  return bot;
}

/** Commandes du menu (spec §4.2) : 6 en privé, /lier et /aide dans les groupes. */
export async function publierCommandesClient(bot: Bot<Ctx>) {
  const m = T.menu;
  await bot.api.setMyCommands([
    { command: "capteurs", description: m.capteurs }, { command: "ajouter", description: m.ajouter },
    { command: "alertes", description: m.alertes }, { command: "graphiques", description: m.graphiques },
    { command: "partager", description: m.partager }, { command: "aide", description: m.aide },
  ], { scope: { type: "all_private_chats" } });
  await bot.api.setMyCommands([{ command: "lier", description: m.lier }, { command: "aide", description: m.aide }], { scope: { type: "all_group_chats" } });
  await bot.api.setMyDescription(T.description).catch(() => undefined);
  await bot.api.setMyShortDescription(T.a_propos).catch(() => undefined);
}

export type { Update };
