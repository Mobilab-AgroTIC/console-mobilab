// Les jobs du service (spec V3 §6) : création d'une ferme, accès Grafana, ajout et mise en service d'un capteur,
// corrections, suppression, commandes, cycle de vie d'une ferme, contrôle de nuit, mots de passe.
import type pg from "pg";
import { definir, creerJob, ErreurMetier, chiffrerSecret, lireSecret, messageErreur, etapeSuivante, type Ctx, type Job } from "./moteur.js";
import { db, q, un, json, notifier, audit } from "../db.js";
import { ErreurApi, type VersionIds } from "../ttn.js";
import { verificateurScram, motDePasseTechnique, motDePasseLisible } from "../crypto.js";
import { creerLien } from "../invitations.js";
import { construireTableau, construireResume, sqlEmpreinte } from "../tableau.js";
import { catalogue, modele as modeleDe, definition, actionDe } from "../catalogue.js";
import { client as TC, admin as TA, f } from "../textes.fr.js";
import { echapper, jour, loginDepuisNom, heure, duree } from "../format.js";
import { groupes } from "../codes.js";
import { envoyer, modifier, avertirAdmins, envoyerAuxMembres, lienBot, nomFerme, effacerPlusTard, envoyerDocument, retourFiche,
  type Services, type QuelBot } from "../services.js";
import { fichePdf, type PageFiche } from "../fiche.js";
import { log } from "../log.js";
import { idCapteur, idsApplication } from "../identifiants.js";

/** Repli quand la ferme n'a pas encore d'application notée (jamais de préfixe mobilab-). */
export const appId = (slug: string) => slug;

/** Application TTS d'une ferme : celle notée en base (app reprise telle quelle), sinon mobilab-<slug>. */
export async function appDe(c: pg.PoolClient | pg.Pool, slug: string): Promise<string> {
  const r = await c.query(`SELECT ttn_app_id FROM app.tenants WHERE slug = $1`, [slug]);
  return r.rows[0]?.ttn_app_id || appId(slug);
}

/** Identifiant TTS du capteur : son DevEUI, sauf pour un capteur repris d'une app existante (ex. lht52-9962). */
export function idTtn(d: { dev_eui: string; config?: any }): string {
  return d.config?.ttn_device_id || d.dev_eui;
}

/** Nom dans TTS : type + nom choisi (« lht52 Cave »), comme les capteurs nommés à la main.
 *  Pas de préfixe en double si le nom commence déjà par le type (« lht52 Ferment »). */
export function nomTtn(d: { name: string; model_key?: string | null }): string {
  const p = modeleDe(d.model_key ?? null)?.prefixe_id;
  const nom = String(d.name).trim();
  return (p && !new RegExp(`^${p}\\b`, "i").test(nom) ? `${p} ${nom}` : nom).slice(0, 50);
}
const SLUG = /^f[0-9]{4,}$/;

function versionIds(cle: string | null | undefined): VersionIds | null {
  const m = modeleDe(cle);
  return m?.dr ? { brand_id: m.dr.brand_id, model_id: m.dr.model_id, firmware_version: m.dr.firmware_version, band_id: m.dr.band_id } : null;
}

// ======================================================================= Postgres : rôle de la ferme (§3.7, §6.2)

export async function creerRole(c: pg.PoolClient, slug: string) {
  if (!SLUG.test(slug)) throw new ErreurMetier("SLUG", "slug invalide");
  const existe = await c.query(`SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1`, [slug]);
  if (existe.rowCount) {
    if (existe.rows[0].rolbypassrls || existe.rows[0].rolsuper) throw new ErreurMetier("ROLE_DANGEREUX", "rôle de ferme avec BYPASSRLS ou SUPERUSER");
    return;
  }
  // Seule fonction qui crée un rôle de ferme : jamais BYPASSRLS (spec §3.7, §10.2). Slug contrôlé puis cité.
  await c.query(`SELECT 1`);
  await c.query(`CREATE ROLE ${ident(slug)} LOGIN CONNECTION LIMIT 10`);
  await c.query(`GRANT clients TO ${ident(slug)} WITH INHERIT TRUE, SET FALSE`);
  await c.query(`ALTER ROLE ${ident(slug)} SET statement_timeout = '30s'`);
}

function ident(slug: string) {
  if (!SLUG.test(slug)) throw new ErreurMetier("SLUG", "slug invalide");
  return `"${slug}"`;
}

async function poserMotDePasseRole(c: pg.PoolClient, slug: string, motDePasse: string) {
  const v = verificateurScram(motDePasse);
  if (!/^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(v)) throw new Error("vérificateur SCRAM inattendu");
  await c.query(`ALTER ROLE ${ident(slug)} PASSWORD '${v}'`);
}

// ======================================================================= Grafana (§6.3, §9)

async function orgDe(c: pg.PoolClient, slug: string): Promise<number> {
  const t = await c.query(`SELECT grafana_org_id FROM app.tenants WHERE slug = $1`, [slug]);
  const id = t.rows[0]?.grafana_org_id;
  if (!id) throw new ErreurMetier("ORG_ABSENTE", "organisation Grafana absente");
  return Number(id);
}

export async function etapeOrg(c: pg.PoolClient, s: Services, slug: string, nom: string) {
  const t = await c.query(`SELECT grafana_org_id FROM app.tenants WHERE slug = $1`, [slug]);
  let id: number | null = t.rows[0]?.grafana_org_id ?? null;
  if (id && !(await s.grafana.org(id))) id = null;
  if (!id) {
    const parNom = await s.grafana.orgParNom(slug);
    id = parNom ? Number(parNom.id) : await s.grafana.creerOrg(slug);
    await c.query(`UPDATE app.tenants SET grafana_org_id = $2 WHERE slug = $1`, [slug, id]);
  }
  const actuel = await s.grafana.org(id);
  if (actuel && actuel.name === slug) {
    try { await s.grafana.renommerOrg(id, nom); } catch (e) {
      if (e instanceof ErreurApi && !e.temporaire) await s.grafana.renommerOrg(id, `${nom} (${slug})`); else throw e;
    }
  }
  for (const login of [s.cfg.grafana.user, ...s.cfg.grafana.staffLogins]) {
    if (!login) continue;
    try { await s.grafana.poserRole(id, login, null, "Admin"); } catch (e) {
      if (!(e instanceof ErreurApi) || e.temporaire) throw e;
      log.warn(`compte Mobilab ${login} non ajouté à l'org ${id} : ${e.code}`);
    }
  }
  return id;
}

async function etapeSource(c: pg.PoolClient, s: Services, slug: string) {
  const org = await orgDe(c, slug);
  const mdp = motDePasseTechnique();                     // généré, posé des deux côtés, puis oublié
  await poserMotDePasseRole(c, slug, mdp);
  await s.grafana.ecrireSource(org, slug, mdp);
  if (!(await s.grafana.santeSource(org, slug))) throw new ErreurMetier("SOURCE_GRAFANA", "la source Grafana ne joint pas Postgres", true);
}

/** Régénère « Mes capteurs » et « Résumé » (spec §9.5) ; copie de sauvegarde si quelqu'un les a modifiés.
 *  Un seul à la fois par ferme : deux régénérations croisées laissaient une version notée fausse, puis une copie inutile. */
export async function regenererTableau(c0: pg.PoolClient | pg.Pool, s: Services, slug: string) {
  const c = "release" in c0 ? c0 : await (c0 as pg.Pool).connect();
  await c.query(`SELECT pg_advisory_lock(hashtext($1))`, [`tableau:${slug}`]);
  try { await ecrireTableaux(c, s, slug); } finally {
    await c.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`tableau:${slug}`]).catch(() => undefined);
    if (c !== c0) (c as pg.PoolClient).release();
  }
}

async function ecrireTableaux(c: pg.PoolClient, s: Services, slug: string) {
  const t = (await c.query(`SELECT slug, display_name, grafana_org_id, config FROM app.tenants WHERE slug = $1`, [slug])).rows[0];
  if (!t?.grafana_org_id) throw new ErreurMetier("ORG_ABSENTE", "organisation Grafana absente");
  const org = Number(t.grafana_org_id);
  await s.grafana.dossier(org);
  const mesures = (await c.query(`SELECT ${sqlEmpreinte("$1")} AS e`, [slug])).rows[0].e;
  const devices = (await c.query(`SELECT dev_eui, name, model_key, last_values, probes, ttn_status FROM app.devices WHERE tenant_slug = $1`, [slug])).rows;
  const g = t.config?.grafana || {};
  const ecrire = async (tableau: any, ecrit: number) => {
    const existant = await s.grafana.lireTableau(org, tableau.uid);
    if (existant && ecrit && Number(existant.dashboard?.version) > ecrit) {
      const copie = { ...existant.dashboard, id: null, uid: undefined, title: `${tableau.title} (copie du ${jour(new Date())})`, editable: true };
      await s.grafana.ecrireTableau(org, copie, null, "copie avant régénération");
    }
    return s.grafana.ecrireTableau(org, tableau, "mobilab-auto", "généré par la console Mobilab");
  };
  const version = await ecrire(construireTableau(t, devices, catalogue(), (m, nom) => definition(m, nom)), Number(g.dashboard_version || 0));
  const resume = await ecrire(construireResume(t, devices, catalogue()), Number(g.resume_version || 0));
  await c.query(`UPDATE app.tenants SET config = jsonb_set(config, '{grafana}', coalesce(config->'grafana', '{}'::jsonb) || $2::jsonb) WHERE slug = $1`,
    [slug, json({ dashboard_version: version, resume_version: resume, catalogue: catalogue().version, mesures })]);
}

async function loginLibre(s: Services, base: string): Promise<string> {
  for (let i = 1; i < 50; i++) {
    const l = i === 1 ? base : `${base}${i}`;
    const pris = await s.grafana.utilisateurParLogin(l);
    const enBase = await un(`SELECT 1 FROM app.people WHERE grafana_login = $1`, [l]);
    if (!pris && !enBase) return l;
  }
  return `${base}.${Date.now() % 10000}`;
}

/** Compte Grafana d'une personne dans l'org d'une ferme (étapes trouver → noter, spec §6.3). Idempotent. */
export async function grafanaPersonne(c: pg.PoolClient | pg.Pool, s: Services, personId: number, slug: string, roleForce?: string): Promise<number> {
  const p = (await c.query(`SELECT id, display_name, grafana_login, grafana_user_id FROM app.people WHERE id = $1`, [personId])).rows[0];
  if (!p) throw new ErreurMetier("PERSONNE", "personne introuvable");
  const m = (await c.query(`SELECT grafana_role FROM app.memberships WHERE person_id = $1 AND tenant_slug = $2`, [personId, slug])).rows[0];
  const role = roleForce || m?.grafana_role || "Viewer";
  const org = await orgDe(c as pg.PoolClient, slug);
  // trouver
  let compte = p.grafana_user_id ? await s.grafana.utilisateur(Number(p.grafana_user_id)) : null;
  if (!compte && p.grafana_login) compte = await s.grafana.utilisateurParLogin(p.grafana_login);
  // creer
  let userId: number;
  let login: string = p.grafana_login;
  if (!compte) {
    login = p.grafana_login || await loginLibre(s, loginDepuisNom(p.display_name));
    userId = await s.grafana.creerUtilisateur({ name: p.display_name, login, email: login.includes("@") ? login : undefined,
      password: motDePasseTechnique() + "aA1!", orgId: org });
  } else {
    userId = Number(compte.id);
    login = compte.login;
  }
  // role
  await s.grafana.poserRole(org, login, userId, role);
  // org_courante + hors_main_org
  const orgs = await s.grafana.orgsUtilisateur(userId);
  if (orgs.length <= 2) await s.grafana.orgCourante(userId, org).catch(() => undefined);
  if (orgs.some(o => Number(o.orgId) === 1) && org !== 1) await s.grafana.retirerMembre(1, userId).catch(() => undefined);
  // noter
  await c.query(`UPDATE app.people SET grafana_login = $2, grafana_user_id = $3 WHERE id = $1`, [personId, login, userId]);
  return userId;
}

// ======================================================================= creer_client (§6.2)

const ETAPES_CREER = ["tenant_row", "pg_role", "ttn_app", "ttn_webhook", "grafana_org", "grafana_datasource", "grafana_tableau",
  "grafana_preferences", "grafana_user", "invitation", "capteurs", "mot_de_passe", "fin"];

function ecranCreation(job: Job, nom: string, slug: string): string {
  const fait = (e: string) => (job.step && ETAPES_CREER.indexOf(job.step) >= ETAPES_CREER.indexOf(e) ? "✅" : "⏳");
  const capteurs = (job.params.capteurs || []) as unknown[];
  const lignes = [f(TA.creation_titre, { ferme: echapper(nom) }), f(TA.etape_base, { etat: fait("pg_role") }),
    f(TA.etape_ttn, { etat: fait("ttn_webhook"), app: job.result?.app || "TTN" }), f(TA.etape_grafana, { etat: fait("grafana_user") })];
  if (capteurs.length) lignes.push(f(TA.etape_capteurs, { fait: (job.result?.capteurs_faits || []).length, total: capteurs.length }));
  return lignes.join("\n");
}

definir("creer_client", {
  etapes: ETAPES_CREER,
  async executer(ctx) {
    const { job, s, c } = ctx;
    const slug = job.tenant_slug!;
    const p = job.params;
    const nom: string = p.nom;
    const admin = p.origine === "admin";
    const maj = async () => { if (admin && !p.lot) await modifier(s, "admin", job.chat_id, job.message_id, ecranCreation(job, nom, slug)); };

    await ctx.etape("tenant_row", async () => {
      await c.query(`INSERT INTO app.tenants (slug, display_name, status, pg_role, created_by) VALUES ($1, $2, 'en_creation', $1, $3)
                     ON CONFLICT (slug) DO NOTHING`, [slug, nom, job.requested_by]);
      await c.query(`INSERT INTO app.memberships (person_id, tenant_slug, role, grafana_role, receives_alerts, status, source)
                     VALUES ($1, $2, 'proprietaire', 'Admin', true, 'actif', 'bot') ON CONFLICT (person_id, tenant_slug) DO NOTHING`,
        [p.person_id, slug]);
    });
    await ctx.etape("pg_role", () => creerRole(c, slug));
    await maj();
    await ctx.etape("ttn_app", async () => { await ctx.noter({ app: await creerAppFerme(c, s, slug, nom) }); });
    await ctx.etape("ttn_webhook", async () => { await s.ttn.ecrireWebhook(await appDe(c, slug)); });
    await maj();
    await ctx.etape("grafana_org", async () => { await etapeOrg(c, s, slug, nom); });
    await ctx.etape("grafana_datasource", () => etapeSource(c, s, slug));
    await ctx.etape("grafana_tableau", () => regenererTableau(c, s, slug));
    await ctx.etape("grafana_preferences", async () => {
      await s.grafana.preferences(await orgDe(c, slug), { homeDashboardUID: `capteurs-${slug}`, timezone: "Europe/Paris" });
    });
    await ctx.etape("grafana_user", async () => { await grafanaPersonne(c, s, p.person_id, slug, "Admin"); });
    await maj();
    if (admin) {
      await ctx.etape("invitation", async () => {
        const l = await creerLien(c, "activation", { tenant: slug, payload: { person_id: p.person_id }, par: job.requested_by });
        ctx.memoire.lien = lienBot(s, "client", l.parametre);
      }, { memoire: "lien" });
    } else await ctx.etape("invitation", async () => undefined);
    await ctx.etape("capteurs", async () => {
      const capteurs: any[] = p.capteurs || [];
      if (!capteurs.length) return;
      const cles: Record<string, string> = JSON.parse(ctx.secret() || "{}");
      for (const cap of capteurs) {
        if ((job.result?.capteurs_faits || []).includes(cap.deveui)) continue;
        const appkey = cles[cap.deveui.toUpperCase()] || cles[cap.deveui];
        try {
          if (!appkey) throw new ErreurMetier("APPKEY", "AppKey absente");
          await enregistrerCapteur(c, s, { slug, nom: cap.nom, devEui: cap.deveui.toLowerCase(), joinEui: cap.appeui.toLowerCase(),
            appKey: appkey, modele: cap.modele || null, par: job.requested_by });
          await finEnregistrement(c, s, { slug, devEui: cap.deveui.toLowerCase(), modele: cap.modele || null, par: job.requested_by });
        } catch (e) {
          // Capteur refusé : rangé dans un job ajouter_capteur à part, en échec, avec son AppKey (spec §6.2, étape 11).
          await c.query(`UPDATE app.devices SET ttn_status = 'echec' WHERE dev_eui = $1 AND ttn_status = 'en_creation'`, [cap.deveui.toLowerCase()]);
          const id = await creerJob(c, { kind: "ajouter_capteur", tenant: slug, dev_eui: cap.deveui.toLowerCase(), requested_by: job.requested_by,
            params: { nom: cap.nom, appeui: cap.appeui.toLowerCase(), modele: cap.modele || null, bot: "admin", origine: "admin" },
            secret: appkey ? chiffrerSecret(s, appkey) : null });
          await c.query(`UPDATE app.jobs SET status = 'echec', error = $2 WHERE id = $1`, [id, messageErreur(e)]);
        }
        delete cles[cap.deveui.toUpperCase()];
        await ctx.ecrireSecret(Object.keys(cles).length ? JSON.stringify(cles) : null);
        await ctx.noter({ capteurs_faits: [...(job.result?.capteurs_faits || []), cap.deveui] });
        await maj();
      }
      await ctx.ecrireSecret(null);
    });
    if (admin) {
      await ctx.etape("mot_de_passe", async () => {
        const per = (await c.query(`SELECT grafana_user_id FROM app.people WHERE id = $1`, [p.person_id])).rows[0];
        const mdp = motDePasseLisible();
        await s.grafana.motDePasse(Number(per.grafana_user_id), mdp);
        await c.query(`UPDATE app.people SET grafana_password_sent_at = now() WHERE id = $1`, [p.person_id]);
        ctx.memoire.mdp = mdp;
      }, { memoire: "mdp" });
    } else await ctx.etape("mot_de_passe", async () => undefined);
    await ctx.etape("fin", async () => {
      if (admin) {
        await c.query(`UPDATE app.tenants SET status = 'en_attente_activation' WHERE slug = $1 AND status = 'en_creation'`, [slug]);
      } else {
        await c.query(`UPDATE app.tenants SET status = 'actif', activated_at = now() WHERE slug = $1 AND status = 'en_creation'`, [slug]);
      }
      await audit(c, { acteur: job.requested_by, via: admin ? "admin" : "bot", tenant: slug, action: "ferme créée", details: { nom } });
    });

    // Messages de fin (spec §4.3 b, §5.4)
    if (admin) {
      const per = (await c.query(`SELECT grafana_login FROM app.people WHERE id = $1`, [p.person_id])).rows[0];
      const nbCapteurs = (job.result?.capteurs_faits || []).length;
      const adresse = s.cfg.grafana.publicUrl;
      const page: PageFiche = { ferme: nom, lien: String(ctx.memoire.lien), adresse, login: per.grafana_login, motDePasse: String(ctx.memoire.mdp) };
      if (p.lot) {
        await finLot(s, p.lot, job.id, page, `✅ ${echapper(nom)} (${slug})`);
      } else {
        const texte = [f(TA.creation_ok, { ferme: echapper(nom), slug }),
          nbCapteurs ? f(TA.creation_capteurs, { n: nbCapteurs }) : null,
          f(TA.creation_graphiques, { adresse }),
          f(TA.creation_login, { login: echapper(per.grafana_login), mdp: echapper(String(ctx.memoire.mdp)) }),
          f(TA.creation_activation, { lien: String(ctx.memoire.lien) })].filter(Boolean).join("\n");
        await modifier(s, "admin", job.chat_id, job.message_id, texte,
          { inline_keyboard: [[{ text: TA.bouton_fiche_imprimer, callback_data: `a:fic:${job.id}` }, { text: TA.bouton_voir_fiche, callback_data: `a:cli:${slug}` }]] });
        if (job.chat_id && job.message_id) await effacerPlusTard("admin", job.chat_id, job.message_id);
        s.memoire.set(-job.id, { fiche: [page] });             // pour [Fiche à imprimer], en mémoire seulement
      }
    } else {
      await modifier(s, "client", job.chat_id, job.message_id, f(TC.ferme_prete, { ferme: echapper(nom) }));
      const per = (await c.query(`SELECT display_name FROM app.people WHERE id = $1`, [p.person_id])).rows[0];
      const par = p.invite_par ? (await c.query(`SELECT display_name FROM app.people WHERE id = $1`, [p.invite_par])).rows[0]?.display_name : "—";
      await notifier(c, { audience: "admin", kind: "nouveau_client", tenant: slug, details: { nom: per?.display_name, par } });
    }
  },
  async echec(ctx, e) {
    const { job, s } = ctx;
    const nom = job.params.nom;
    const etape = etapeSuivante(ETAPES_CREER, job.step);
    if (job.params.origine === "admin") {
      if (job.params.lot) await finLot(s, job.params.lot, job.id, null, `❌ ${echapper(nom)} : ${etape}`);
      else await modifier(s, "admin", job.chat_id, job.message_id, f(TA.creation_bloquee, { ferme: echapper(nom), etape, erreur: messageErreur(e) }),
        { inline_keyboard: [[{ text: TA.bouton_relancer, callback_data: `a:job:r:${job.id}` }, { text: TA.bouton_annuler, callback_data: `a:job:x:${job.id}` }]] });
    } else {
      await modifier(s, "client", job.chat_id, job.message_id, TC.ferme_echec);
    }
  },
  async annuler(job, s) {
    if (job.tenant_slug) await creerJob(await import("../db.js").then(m => m.db()), { kind: "purger_client", tenant: job.tenant_slug, params: { creation_annulee: true } });
  },
});

/** Création de plusieurs fermes d'un coup : un message édité, puis un seul PDF (spec §5.4). */
async function finLot(s: Services, lot: string, jobId: number, page: PageFiche | null, ligne: string) {
  const l = s.lots.get(lot);
  if (!l) return;
  l.lignes[jobId] = ligne;
  if (page) l.pages.push(page);
  const faits = Object.keys(l.lignes).length;
  const texte = faits < l.total ? f(TA.creation_n, { fait: faits, total: l.total }) + "\n" + Object.values(l.lignes).join("\n")
    : Object.values(l.lignes).join("\n");
  await modifier(s, "admin", l.chat, l.message, texte);
  if (faits >= l.total) {
    if (l.pages.length) {
      const pdf = await fichePdf(l.pages as PageFiche[]);
      const id = await envoyerDocument(s, "admin", l.chat, pdf, "fiches-mobilab.pdf");
      if (id) await effacerPlusTard("admin", l.chat, id);
    }
    s.lots.delete(lot);
  }
}

// ======================================================================= ajouter_capteur (§6.5)

/**
 * Application TTS de la ferme, nommée comme elle (« ferme-des-pres »), sinon « ferme-des-pres-f0042 ».
 * L'id choisi est noté avant la création : une reprise retrouve le même. Une app qui existe sans porter
 * mobilab_ferme = <slug> est à quelqu'un d'autre : on passe à l'id suivant.
 */
async function creerAppFerme(c: pg.PoolClient, s: Services, slug: string, nom: string): Promise<string> {
  const deja = (await c.query(`SELECT ttn_app_id FROM app.tenants WHERE slug = $1`, [slug])).rows[0]?.ttn_app_id;
  for (const id of [...new Set([deja, ...idsApplication(nom, slug)].filter(Boolean))] as string[]) {
    const ex = await s.ttn.lireApplication(id);
    if (ex && ex.attributes?.mobilab_ferme !== slug) continue;
    await c.query(`UPDATE app.tenants SET ttn_app_id = $2 WHERE slug = $1`, [slug, id]);
    if (!ex) {
      const r = await s.ttn.creerApplication(id, nom, slug);
      if (r?.existe && (await s.ttn.lireApplication(id))?.attributes?.mobilab_ferme !== slug) continue;
    }
    return id;
  }
  throw new ErreurMetier("APP_ID", "aucun identifiant d'application libre dans TTN");
}

interface Enr { slug: string; nom: string; devEui: string; joinEui: string; appKey: string; modele: string | null; par: number | null;
  marque?: string | null }

/** Préfixe de l'id TTS : celui du type (catalogue), sinon « autre » (choix du 19/11 : pas de préfixe de marque). */
function prefixeCapteur(modele: string | null): string {
  const m = modeleDe(modele);
  return m?.prefixe_id || "autre";
}

/** Étapes db_device à ttn_as, partagées avec creer_client. Retour en arrière AS, NS, JS, IS si TTN refuse. */
async function enregistrerCapteur(c: pg.PoolClient, s: Services, e: Enr, ctx?: Ctx) {
  const app = await appDe(c, e.slug);
  const m = modeleDe(e.modele);
  const v = versionIds(e.modele);
  const pas = async (nom: string, fn: () => Promise<unknown>) => (ctx ? ctx.etape(nom, async () => { await fn(); }) : fn());
  // Id du capteur dans TTS : « serre-nord-3d2e » ; un capteur qui revient garde le sien.
  const avant = (await c.query(`SELECT config->>'ttn_device_id' AS id FROM app.devices WHERE dev_eui = $1`, [e.devEui])).rows[0];
  let devId: string = avant?.id || idCapteur(prefixeCapteur(e.modele), e.devEui);
  await pas("db_device", async () => {
    const r = await c.query(
      `INSERT INTO app.devices (dev_eui, tenant_slug, name, join_eui, model_key, ttn_status, created_by, config)
       VALUES ($1, $2, $3, $4, $5, 'en_creation', $6, jsonb_build_object('appkey_hint', $7::text, 'ttn_device_id', $8::text))
       ON CONFLICT (dev_eui) DO UPDATE
         SET tenant_slug = EXCLUDED.tenant_slug, name = EXCLUDED.name, join_eui = EXCLUDED.join_eui,
             model_key = coalesce(EXCLUDED.model_key, app.devices.model_key), ttn_status = 'en_creation',
             created_by = EXCLUDED.created_by, config = app.devices.config || EXCLUDED.config
         WHERE app.devices.ttn_status IN ('supprime', 'echec')
            OR (app.devices.ttn_status = 'en_creation' AND app.devices.tenant_slug = EXCLUDED.tenant_slug)
       RETURNING dev_eui`, [e.devEui, e.slug, e.nom, e.joinEui, e.modele, e.par, e.appKey.slice(-4).toUpperCase(), devId]);
    if (!r.rowCount) throw new ErreurMetier("DEJA_ENREGISTRE", "DevEUI déjà actif ailleurs");
    // Ferme différente : les règles de l'ancienne ferme partent (spec §6.5, doublons).
    await c.query(`DELETE FROM app.alert_rules WHERE dev_eui = $1 AND kind = 'threshold'`, [e.devEui]).catch(() => undefined);
  });
  try {
    await pas("ttn_is", async () => {
      try {
        // Nom dans TTS = type + nom choisi (« lht52 Serre nord », choix du 19/11) ; l'id reste « lht52-3d2e ».
        const nomTts = nomTtn({ name: e.nom, model_key: e.modele });
        const r = await s.ttn.creerDeviceIS(app, e.devEui, e.joinEui, nomTts, e.slug, e.modele, v, devId);
        // Id déjà pris dans l'app par un autre capteur : on prend le DevEUI (toujours unique).
        if (r?.existe) {
          const x = await s.ttn.lireDevice("is", app, devId);
          if (x && String(x.ids?.dev_eui || "").toLowerCase() !== e.devEui) {
            devId = e.devEui;
            await c.query(`UPDATE app.devices SET config = config || jsonb_build_object('ttn_device_id', $2::text) WHERE dev_eui = $1`, [e.devEui, devId]);
            await s.ttn.creerDeviceIS(app, e.devEui, e.joinEui, nomTts, e.slug, e.modele, v, devId);
          }
        }
      } catch (err) {
        if (err instanceof ErreurApi && err.code === "end_device_euis_taken") throw new ErreurMetier("EUIS_PRIS", "end_device_euis_taken");
        throw err;
      }
    });
    await pas("ttn_js", () => s.ttn.ecrireCleJS(app, e.devEui, e.joinEui, e.appKey, devId));
    await pas("ttn_ns", () => s.ttn.ecrireNS(app, e.devEui, e.joinEui, m?.lorawan || {}, v, devId));
    await pas("ttn_as", () => s.ttn.ecrireAS(app, e.devEui, e.joinEui, v, devId));
  } catch (err) {
    const definitif = !(err instanceof ErreurApi && err.temporaire);
    if (definitif && !(err instanceof ErreurMetier && err.code === "EUIS_PRIS")) {
      await s.ttn.supprimerPartout(app, devId).catch(() => undefined);
    }
    throw err;
  }
}

async function finEnregistrement(c: pg.PoolClient, s: Services, e: { slug: string; devEui: string; modele: string | null; par: number | null }) {
  await c.query(`UPDATE app.devices SET ttn_status = 'enregistre' WHERE dev_eui = $1 AND ttn_status = 'en_creation'`, [e.devEui]);
  const m = modeleDe(e.modele);
  const delai = Number(m?.delai_connexion_min || 15);
  await c.query(`UPDATE app.jobs SET status = 'annule' WHERE kind = 'verifier_join' AND dev_eui = $1 AND status = 'en_attente'`, [e.devEui]);
  for (const palier of [delai, 60]) {
    await creerJob(c, { kind: "verifier_join", tenant: e.slug, dev_eui: e.devEui, params: { palier }, requested_by: e.par,
      run_after: new Date(Date.now() + palier * 60000) });
  }
  if (e.modele) await creerJob(c, { kind: "mise_en_service", tenant: e.slug, dev_eui: e.devEui, requested_by: e.par });
  await audit(c, { acteur: e.par, tenant: e.slug, dev_eui: e.devEui, action: "capteur ajouté" });
}

const ETAPES_AJOUT = ["db_device", "ttn_is", "ttn_js", "ttn_ns", "ttn_as", "fin"];

definir("ajouter_capteur", {
  etapes: ETAPES_AJOUT,
  async executer(ctx) {
    const { job, s, c } = ctx;
    const p = job.params;
    const appKey = ctx.secret();
    if (!appKey && ETAPES_AJOUT.indexOf(job.step || "") < ETAPES_AJOUT.indexOf("ttn_js")) {
      throw new ErreurMetier("APPKEY_EXPIREE", "AppKey effacée : redemander l'étiquette");
    }
    const avant = await un(`SELECT ttn_status, tenant_slug FROM app.devices WHERE dev_eui = $1`, [job.dev_eui], c);
    const reprise = Boolean(avant && avant.ttn_status === "supprime" && avant.tenant_slug === job.tenant_slug);
    await enregistrerCapteur(c, s, { slug: job.tenant_slug!, nom: p.nom, devEui: job.dev_eui!, joinEui: p.appeui, appKey: appKey || "",
      modele: p.modele || null, marque: p.marque || null, par: job.requested_by }, ctx);
    await ctx.etape("fin", () => finEnregistrement(c, s, { slug: job.tenant_slug!, devEui: job.dev_eui!, modele: p.modele || null, par: job.requested_by }));
    const nom = echapper(p.nom);
    const m = modeleDe(p.modele);
    if (p.bot === "admin") {
      const ferme = echapper(await nomFerme(job.tenant_slug!));
      await modifier(s, "admin", job.chat_id, job.message_id, reprise || p.reprise ? f(TA.revient, { capteur: nom }) : f(TA.enregistre_admin_ok, { capteur: nom, ferme }));
    } else {
      const texte = reprise || p.reprise ? f(TC.de_retour, { capteur: nom })
        : m?.allumage ? f(TC.enregistre_ok, { capteur: nom, allumage: echapper(m.allumage) }) : f(TC.enregistre_ok_sans_modele, { capteur: nom });
      await modifier(s, "client", job.chat_id, job.message_id, texte);
    }
  },
  async echec(ctx, e) {
    const { job, s, c } = ctx;
    await c.query(`UPDATE app.devices SET ttn_status = 'echec' WHERE dev_eui = $1 AND ttn_status = 'en_creation'`, [job.dev_eui]);
    // [Relancer] repart de ttn_is : tout a été défait côté TTN (spec §6.5).
    if (job.step && ETAPES_AJOUT.indexOf(job.step) >= 1) await c.query(`UPDATE app.jobs SET step = 'db_device' WHERE id = $1`, [job.id]);
    const nom = echapper(job.params.nom);
    const deja = e instanceof ErreurMetier && (e.code === "DEJA_ENREGISTRE" || e.code === "EUIS_PRIS");
    if (deja) {
      await notifier(c, { audience: "admin", kind: "deja_enregistre", tenant: job.tenant_slug, dev_eui: job.dev_eui,
        details: { code: e.code, requested_by: job.requested_by } });
    }
    if (job.params.bot === "admin") {
      const etape = etapeSuivante(ETAPES_AJOUT, job.step);
      await modifier(s, "admin", job.chat_id, job.message_id, f(TA.ttn_refus, { capteur: nom, etape, erreur: messageErreur(e) }),
        { inline_keyboard: [[{ text: TA.bouton_relancer, callback_data: `a:job:r:${job.id}` }]] });
    } else {
      await modifier(s, "client", job.chat_id, job.message_id, deja ? TC.deja_chez_nous : f(TC.enregistre_echec, { capteur: nom }));
    }
  },
  async annuler(job, s) {
    if (job.tenant_slug && job.dev_eui) await s.ttn.supprimerPartout(await appDe(db(), job.tenant_slug), job.dev_eui).catch(() => undefined);
    await q(`UPDATE app.devices SET ttn_status = 'echec' WHERE dev_eui = $1 AND ttn_status IN ('en_creation')`, [job.dev_eui]);
  },
});

// ======================================================================= mise_en_service (§6.5)

definir("mise_en_service", {
  etapes: ["ttn_version_ids", "regles_alerte", "redecodage", "grafana_tableau", "annonce", "fin"],
  silencieux: true,
  async executer(ctx) {
    const { job, s, c } = ctx;
    const d = await un(`SELECT * FROM app.devices WHERE dev_eui = $1`, [job.dev_eui], c);
    if (!d || d.ttn_status === "supprime") return;
    const m = modeleDe(d.model_key);
    if (!m) return;
    const v = versionIds(d.model_key);
    await ctx.etape("ttn_version_ids", async () => {
      // Capteur repris d'une app existante : on ne touche pas à sa configuration radio, qui marche.
      if (d.config?.reprise) return;
      if (!v || JSON.stringify(d.config?.version_ids_ecrits || null) === JSON.stringify(v)) return;
      const app = await appDe(c, d.tenant_slug);
      // Type identifié après coup : l'id reste « autre-ff32 » (figé dans TTS), le nom devient « lht52 Serre nord ».
      const nom = /^autre-/.test(idTtn(d)) && m.prefixe_id ? nomTtn(d) : null;
      await s.ttn.ecrireIS(app, idTtn(d), nom ? { name: nom, version_ids: v } : { version_ids: v });
      await s.ttn.ecrireNS(app, d.dev_eui, d.join_eui || "0000000000000000", m.lorawan || {}, v, idTtn(d));
      await s.ttn.ecrireAS(app, d.dev_eui, d.join_eui || "0000000000000000", v, idTtn(d));
      await c.query(`UPDATE app.devices SET config = config || jsonb_build_object('version_ids_ecrits', $2::jsonb) WHERE dev_eui = $1`, [d.dev_eui, json(v)]);
    });
    await ctx.etape("regles_alerte", async () => {
      const lignes: [string, string | null, number | null][] = [["silence", null, null]];
      const pileKey = m.batterie && (m.batterie as any).faible_mv;
      if (pileKey) lignes.push(["battery", "battery_mv", Number(pileKey)]);
      for (const def of Object.values(m.mesures)) if (def.alerte === "etat") lignes.push(["state", def.nom, null]);
      for (const [kind, metric, min] of lignes) {
        const r = await c.query(
          // Par défaut : la pile et « pas de nouvelles » (deux messages manqués, 27/11) ; les états s'activent depuis le bot.
          `INSERT INTO app.alert_rules (dev_eui, kind, metric, min, enabled) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (dev_eui, kind, coalesce(metric, '')) WHERE kind <> 'threshold' DO NOTHING RETURNING id`,
          [d.dev_eui, kind, metric, min, kind === "battery" || kind === "silence"]);
        if (r.rowCount) await c.query(`INSERT INTO app.alert_state (rule_id) VALUES ($1) ON CONFLICT DO NOTHING`, [r.rows[0].id]);
      }
    });
    await ctx.etape("redecodage", async () => {
      if (d.config?.mise_en_service_at && !job.params.redecoder) return;
      await redecoder(s, d.dev_eui, job.params.depuis || d.created_at);
    });
    await ctx.etape("grafana_tableau", () => regenererTableau(c, s, d.tenant_slug));
    await ctx.etape("annonce", async () => {
      if (!job.params.annonce) return;
      await annoncerPremiereMesure(s, d.dev_eui);
    });
    await ctx.etape("fin", async () => {
      await c.query(`UPDATE app.devices SET config = config || jsonb_build_object('mise_en_service_at', now()) WHERE dev_eui = $1`, [d.dev_eui]);
    });
  },
});

export async function redecoder(s: Services, devEui: string, depuis: string | Date) {
  let rep: Response;
  try {
    rep = await fetch(`${s.cfg.nodeRedUrl}/redecode`, { method: "POST", headers: { "content-type": "application/json", "x-mobilab-secret": s.cfg.ttn.webhookSecret },
      body: JSON.stringify({ dev_eui: devEui, depuis: new Date(depuis).toISOString() }), signal: AbortSignal.timeout(10000) });
  } catch {
    throw new ErreurMetier("NODE_RED", "Node-RED injoignable pour le redécodage", true);
  }
  if (rep.status >= 500) throw new ErreurMetier("NODE_RED", `redécodage refusé (${rep.status})`, true);
  if (rep.status >= 400) throw new ErreurMetier("NODE_RED", `redécodage refusé (${rep.status})`);
}

/** Message de première mesure (spec §4.4, §5.8), envoyé par le service. */
export async function annoncerPremiereMesure(s: Services, devEui: string) {
  const d = await un(`SELECT d.*, t.display_name AS ferme, t.status AS statut_ferme FROM app.devices d JOIN app.tenants t ON t.slug = d.tenant_slug
                      WHERE d.dev_eui = $1`, [devEui]);
  if (!d) return;
  const valeurs = echapper(d.last_values?.resume || "");
  const auteur = d.created_by ? await un(`SELECT id, telegram_user_id, is_admin FROM app.people WHERE id = $1`, [d.created_by]) : null;
  const parAdmin = auteur?.is_admin && !(await un(`SELECT 1 FROM app.memberships WHERE person_id = $1 AND tenant_slug = $2`, [auteur.id, d.tenant_slug]));
  if (parAdmin) {
    await avertirAdmins(s, f(TA.premiere_mesure_admin, { capteur: echapper(d.name), ferme: echapper(d.ferme), valeurs }), { seulement: auteur.id });
    if (d.statut_ferme === "actif") {
      await envoyerAuxMembres(s, d.tenant_slug, f(TC.premiere_mesure_mobilab, { capteur: echapper(d.name), valeurs }), ["proprietaire", "membre"]);
    }
  } else if (auteur?.telegram_user_id) {
    await envoyer(s, "client", Number(auteur.telegram_user_id), f(TC.premiere_mesure, { capteur: echapper(d.name), valeurs }));
  }
}

// ======================================================================= verifier_join (§6.6)

definir("verifier_join", {
  etapes: ["controle"],
  verrou: false,
  silencieux: true,
  async executer(ctx) {
    const { job, s } = ctx;
    const d = await un(`SELECT d.*, t.display_name AS ferme FROM app.devices d JOIN app.tenants t ON t.slug = d.tenant_slug WHERE dev_eui = $1`, [job.dev_eui]);
    if (!d || d.ttn_status === "supprime" || d.last_seen) return;
    const auteur = d.created_by ? await un(`SELECT id, telegram_user_id, is_admin FROM app.people WHERE id = $1`, [d.created_by]) : null;
    const client = auteur && auteur.telegram_user_id && !(auteur.is_admin && !(await un(`SELECT 1 FROM app.memberships WHERE person_id = $1 AND tenant_slug = $2`, [auteur.id, d.tenant_slug])));
    const nom = echapper(d.name);
    if (Number(job.params.palier) < 60) {
      if (d.ttn_status === "enregistre" && client) {
        await envoyer(s, "client", Number(auteur.telegram_user_id), f(TC.rien_de_join, { capteur: nom }),
          { inline_keyboard: [[{ text: TC.bouton_corriger_codes, callback_data: `ck:${d.dev_eui}` }]] });
      }
      return;
    }
    if (client) await envoyer(s, "client", Number(auteur.telegram_user_id), f(TC.pas_encore_marche, { capteur: nom }));
    await avertirAdmins(s, f(TA.pas_connecte_60, { capteur: nom, ferme: echapper(d.ferme) }), {
      seulement: auteur?.is_admin && !client ? auteur.id : null,
      clavier: { inline_keyboard: [[{ text: TA.bouton_diagnostic, callback_data: `a:dev:${d.dev_eui}:d` }, { text: TA.bouton_corriger_codes, callback_data: `a:dev:${d.dev_eui}:k` }]] } });
  },
});

// ======================================================================= corriger, renommer, supprimer (§6.7)

definir("corriger_codes", {
  etapes: ["ttn", "fin"],
  async executer(ctx) {
    const { job, s, c } = ctx;
    const d = await un(`SELECT * FROM app.devices WHERE dev_eui = $1`, [job.dev_eui], c);
    if (!d) throw new ErreurMetier("CAPTEUR", "capteur disparu");
    const app = await appDe(c, d.tenant_slug);
    const appKey = ctx.secret();
    await ctx.etape("ttn", async () => {
      if (!appKey) throw new ErreurMetier("APPKEY_EXPIREE", "AppKey effacée");
      const joinEui = String(job.params.appeui).toLowerCase();
      if (joinEui === d.join_eui) {
        await s.ttn.ecrireCleJS(app, d.dev_eui, joinEui, appKey, idTtn(d));
      } else {
        await s.ttn.supprimerPartout(app, idTtn(d));
        await c.query(`UPDATE app.devices SET config = config - 'reprise' WHERE dev_eui = $1`, [d.dev_eui]);
        await c.query(`UPDATE app.devices SET join_eui = $2 WHERE dev_eui = $1`, [d.dev_eui, joinEui]);
        const v = versionIds(d.model_key);
        await s.ttn.creerDeviceIS(app, d.dev_eui, joinEui, nomTtn(d), d.tenant_slug, d.model_key, v, idTtn(d));
        await s.ttn.ecrireCleJS(app, d.dev_eui, joinEui, appKey, idTtn(d));
        await s.ttn.ecrireNS(app, d.dev_eui, joinEui, modeleDe(d.model_key)?.lorawan || {}, v, idTtn(d));
        await s.ttn.ecrireAS(app, d.dev_eui, joinEui, v, idTtn(d));
      }
      await c.query(`UPDATE app.devices SET config = config || jsonb_build_object('appkey_hint', $2::text) WHERE dev_eui = $1`, [d.dev_eui, appKey.slice(-4)]);
    });
    await ctx.etape("fin", async () => {
      await c.query(`UPDATE app.devices SET ttn_status = 'enregistre' WHERE dev_eui = $1 AND ttn_status IN ('enregistre', 'echec', 'connecte') AND last_seen IS NULL`, [d.dev_eui]);
      await finEnregistrement(c, s, { slug: d.tenant_slug, devEui: d.dev_eui, modele: null, par: job.requested_by });
    });
    const texte = job.params.bot === "admin" ? "✅ Codes corrigés. Redémarrez le capteur pour qu'il se reconnecte." : TC.codes_corriges;
    await modifier(s, job.params.bot === "admin" ? "admin" : "client", job.chat_id, job.message_id, texte);
  },
  async echec(ctx, e) {
    const { job, s } = ctx;
    await modifier(s, job.params.bot === "admin" ? "admin" : "client", job.chat_id, job.message_id,
      f(TC.enregistre_echec, { capteur: echapper(job.params.nom || "") }));
  },
});

definir("renommer_capteur", {
  // Le nom dans TTS suit : « lht52 <nouveau nom> » (choix du 19/11). L'id TTS, lui, ne change jamais.
  etapes: ["ttn_is", "grafana_tableau"],
  silencieux: true,
  async executer(ctx) {
    const { job, s, c } = ctx;
    const d = await un(`SELECT * FROM app.devices WHERE dev_eui = $1`, [job.dev_eui], c);
    if (!d || d.ttn_status === "supprime") return;
    await ctx.etape("ttn_is", async () => s.ttn.ecrireIS(await appDe(c, d.tenant_slug), idTtn(d), { name: nomTtn(d) }));
    await ctx.etape("grafana_tableau", () => regenererTableau(c, s, d.tenant_slug));
  },
});

definir("supprimer_capteur", {
  etapes: ["db", "ttn_as", "ttn_ns", "ttn_js", "ttn_is", "grafana_tableau"],
  async executer(ctx) {
    const { job, s, c } = ctx;
    const d = await un(`SELECT * FROM app.devices WHERE dev_eui = $1`, [job.dev_eui], c);
    if (!d) return;
    const app = await appDe(c, d.tenant_slug);
    await ctx.etape("db", async () => {
      await c.query(`UPDATE app.devices SET ttn_status = 'supprime' WHERE dev_eui = $1`, [d.dev_eui]);
      await c.query(`UPDATE app.commands SET status = 'annulee' WHERE dev_eui = $1 AND status IN ('demandee', 'envoyee')`, [d.dev_eui]);
      await c.query(`UPDATE app.jobs SET status = 'annule' WHERE kind = 'verifier_join' AND dev_eui = $1 AND status = 'en_attente'`, [d.dev_eui]);
      await audit(c, { acteur: job.requested_by, via: job.params.via || "bot", tenant: d.tenant_slug, dev_eui: d.dev_eui, action: "capteur supprimé", details: { nom: d.name } });
    });
    await ctx.etape("ttn_as", () => s.ttn.supprimerDevice("as", app, idTtn(d)));
    await ctx.etape("ttn_ns", () => s.ttn.supprimerDevice("ns", app, idTtn(d)));
    await ctx.etape("ttn_js", () => s.ttn.supprimerDevice("js", app, idTtn(d)));
    await ctx.etape("ttn_is", () => s.ttn.supprimerDevice("is", app, idTtn(d)));
    await ctx.etape("grafana_tableau", () => regenererTableau(c, s, d.tenant_slug));
  },
});

// ======================================================================= commandes (§6.8)

definir("commande", {
  etapes: ["push"],
  verrou: false,
  async executer(ctx) {
    const { job, s, c } = ctx;
    const cmd = await un(`SELECT c.*, d.tenant_slug, d.config AS dconfig FROM app.commands c JOIN app.devices d ON d.dev_eui = c.dev_eui WHERE c.id = $1`, [job.params.command_id], c);
    if (!cmd || cmd.status !== "demandee") return;
    await ctx.etape("push", async () => {
      try {
        await s.ttn.pousserDownlink(await appDe(c, cmd.tenant_slug), idTtn({ dev_eui: cmd.dev_eui, config: cmd.dconfig }), { f_port: cmd.f_port, payload_hex: cmd.payload_hex,
          confirmed: job.params.confirmed !== false, correlation: cmd.correlation_id });
      } catch (e) {
        // Jamais de renvoi à l'aveugle (spec §6.8) : on regarde si l'ordre est dans la file.
        if (e instanceof ErreurApi && e.temporaire) {
          const file = await s.ttn.lireFile(await appDe(c, cmd.tenant_slug), idTtn({ dev_eui: cmd.dev_eui, config: cmd.dconfig })).catch(() => []);
          if (file.some((x: any) => (x.correlation_ids || []).includes(cmd.correlation_id))) return;
        }
        await c.query(`UPDATE app.commands SET status = 'echec', error = $2 WHERE id = $1`, [cmd.id, messageErreur(e)]);
        throw new ErreurMetier("COMMANDE", messageErreur(e));
      }
    });
  },
  async echec(ctx) {
    const { job, s } = ctx;
    const cmd = await un(`SELECT c.*, d.name FROM app.commands c JOIN app.devices d ON d.dev_eui = c.dev_eui WHERE c.id = $1`, [job.params.command_id]);
    const bot: QuelBot = cmd?.via === "admin" ? "admin" : "client";
    if (cmd) await modifier(s, bot, cmd.chat_id, cmd.message_id, f(TC.ordre_echec, { capteur: echapper(cmd.name) }), retourFiche(bot, cmd.dev_eui));
  },
});

definir("commande_expiree", {
  etapes: ["controle"],
  verrou: false,
  async executer(ctx) {
    const { job, s, c } = ctx;
    const cmd = await un(`SELECT c.*, d.name, d.tenant_slug, d.model_key, d.config AS dconfig, t.display_name AS ferme FROM app.commands c JOIN app.devices d ON d.dev_eui = c.dev_eui
                          JOIN app.tenants t ON t.slug = d.tenant_slug WHERE c.id = $1`, [job.params.command_id], c);
    if (!cmd || !["demandee", "envoyee"].includes(cmd.status)) return;
    if (cmd.status === "demandee") await s.ttn.viderFile(await appDe(c, cmd.tenant_slug), idTtn({ dev_eui: cmd.dev_eui, config: cmd.dconfig })).catch(() => undefined);
    const r = await c.query(`UPDATE app.commands SET status = 'echec', error = 'expirée' WHERE id = $1 AND status IN ('demandee', 'envoyee') RETURNING id`, [cmd.id]);
    if (!r.rowCount) return;
    const texte = cmd.status === "demandee" ? f(TC.ordre_expire, { capteur: echapper(cmd.name) }) : f(TC.ordre_echec, { capteur: echapper(cmd.name) });
    const bot: QuelBot = cmd.via === "admin" ? "admin" : "client";
    await modifier(s, bot, cmd.chat_id, cmd.message_id, texte, retourFiche(bot, cmd.dev_eui));
    const delai = duree(new Date(cmd.expires_at).getTime() - new Date(cmd.requested_at).getTime());
    await avertirAdmins(s, f(TA.notif_commande_echec, { action: echapper(actionDe({ model_key: cmd.model_key, config: cmd.dconfig }, cmd.action)),
      capteur: echapper(cmd.name), ferme: echapper(cmd.ferme), raison: cmd.status === "demandee" ? `pas parti en ${delai}, annulé` : "pas confirmé" }), { urgent: true });
  },
});

// ======================================================================= accès (§6.3, §6.4)

definir("grafana_personne", {
  etapes: ["compte"],
  silencieux: true,
  async executer(ctx) {
    const { job, s, c } = ctx;
    const m = await un(`SELECT status FROM app.memberships WHERE person_id = $1 AND tenant_slug = $2`, [job.params.person_id, job.tenant_slug], c);
    if (!m || m.status !== "actif") return;
    await grafanaPersonne(c, s, Number(job.params.person_id), job.tenant_slug!);
  },
});

definir("retirer_acces", {
  etapes: ["grafana"],
  silencieux: true,
  async executer(ctx) {
    const { job, s, c } = ctx;
    if (!job.params.grafana_user_id) return;
    const org = await orgDe(c, job.tenant_slug!);
    await s.grafana.retirerMembre(org, Number(job.params.grafana_user_id));
  },
});

definir("mdp_grafana", {
  etapes: ["compte", "mot_de_passe"],
  async executer(ctx) {
    const { job, s, c } = ctx;
    const p = job.params;
    const per = await un(`SELECT * FROM app.people WHERE id = $1`, [p.person_id], c);
    if (!per) return;
    let userId = per.grafana_user_id ? Number(per.grafana_user_id) : null;
    await ctx.etape("compte", async () => {
      if (userId && (await s.grafana.utilisateur(userId))) return;
      const ferme = p.tenant || (await un(`SELECT tenant_slug FROM app.memberships WHERE person_id = $1 AND status = 'actif' ORDER BY granted_at LIMIT 1`, [per.id], c))?.tenant_slug;
      if (!ferme) throw new ErreurMetier("SANS_FERME", "aucune ferme");
      userId = await grafanaPersonne(c, s, per.id, ferme);
    });
    if (!userId) userId = Number((await un(`SELECT grafana_user_id FROM app.people WHERE id = $1`, [per.id], c))?.grafana_user_id);
    const mdp = motDePasseLisible();
    await s.grafana.motDePasse(userId, mdp);
    await c.query(`UPDATE app.people SET grafana_password_sent_at = now() WHERE id = $1`, [per.id]);
    const login = (await un(`SELECT grafana_login FROM app.people WHERE id = $1`, [per.id], c))?.grafana_login;
    const bouton = { inline_keyboard: [[{ text: TC.bouton_ouvrir_graphiques, url: s.cfg.grafana.publicUrl || "https://grafana.com" }]] };
    if (p.afficher_admin) {
      await modifier(s, "admin", job.chat_id, job.message_id, f(TA.mdp_affiche, { nom: echapper(per.display_name), mdp: echapper(mdp) }));
      if (job.chat_id && job.message_id) await effacerPlusTard("admin", job.chat_id, job.message_id);
    } else if (per.telegram_user_id) {
      const texte = p.premier
        ? [f(TC.graphiques, { adresse: s.cfg.grafana.publicUrl, login: echapper(login) }), f(TC.graphiques_mdp, { mdp: echapper(mdp) })].join("\n")
        : f(TC.nouveau_mdp, { mdp: echapper(mdp) });
      if (job.message_id && Number(job.chat_id) === Number(per.telegram_user_id)) await modifier(s, "client", job.chat_id, job.message_id, texte, bouton);
      else await envoyer(s, "client", Number(per.telegram_user_id), texte, bouton);
      if (p.par_admin) await modifier(s, "admin", job.params.admin_chat, job.params.admin_message, f(TA.mdp_envoye_client, { nom: echapper(per.display_name) }));
    }
  },
  async echec(ctx) {
    const { job, s } = ctx;
    if (!job.params.afficher_admin && job.chat_id && job.message_id) await modifier(s, "client", job.chat_id, job.message_id, TC.graphiques_pas_prets);
  },
});

// ======================================================================= cycle de vie d'une ferme (§6.9)

async function fermerSessions(c: pg.PoolClient, slug: string) {
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [slug]).catch(() => undefined);
}

definir("suspendre_client", {
  etapes: ["db", "role", "messages"],
  async executer(ctx) {
    const { job, s, c } = ctx;
    const slug = job.tenant_slug!;
    await ctx.etape("db", async () => { await c.query(`UPDATE app.tenants SET status = 'suspendu' WHERE slug = $1 AND status IN ('actif', 'en_attente_activation')`, [slug]); });
    await ctx.etape("role", async () => { await c.query(`ALTER ROLE ${ident(slug)} NOLOGIN`); await fermerSessions(c, slug); });
    await ctx.etape("messages", async () => {
      await envoyerAuxMembres(s, slug, f(TC.ferme_pause, { ferme: echapper(await nomFerme(slug)) }), ["proprietaire", "membre", "conseiller"]);
    });
    await modifier(s, "admin", job.chat_id, job.message_id, f(TA.suspendue, { ferme: echapper(await nomFerme(slug)) }));
  },
});

definir("reactiver_client", {
  etapes: ["role", "db", "messages"],
  async executer(ctx) {
    const { job, s, c } = ctx;
    const slug = job.tenant_slug!;
    await ctx.etape("role", async () => { await c.query(`ALTER ROLE ${ident(slug)} LOGIN`); });
    await ctx.etape("db", async () => {
      await c.query(`UPDATE app.tenants SET status = CASE WHEN activated_at IS NULL THEN 'en_attente_activation' ELSE 'actif' END, purge_after = NULL
                     WHERE slug = $1 AND status IN ('suspendu', 'suppression')`, [slug]);
      await c.query(`UPDATE app.jobs SET status = 'annule' WHERE kind = 'purger_client' AND tenant_slug = $1 AND status = 'en_attente'`, [slug]);
    });
    await ctx.etape("messages", async () => {
      await envoyerAuxMembres(s, slug, f(TC.ferme_retablie, { ferme: echapper(await nomFerme(slug)) }), ["proprietaire", "membre", "conseiller"]);
    });
    await modifier(s, "admin", job.chat_id, job.message_id, f(TA.reactivee, { ferme: echapper(await nomFerme(slug)) }));
  },
});

definir("supprimer_client", {
  etapes: ["db", "messages", "purge"],
  async executer(ctx) {
    const { job, s, c } = ctx;
    const slug = job.tenant_slug!;
    await ctx.etape("db", async () => {
      await c.query(`UPDATE app.tenants SET status = 'suppression', purge_after = now() + interval '30 days' WHERE slug = $1 AND status = 'suspendu'`, [slug]);
      await c.query(`ALTER ROLE ${ident(slug)} NOLOGIN`).catch(() => undefined);
    });
    await ctx.etape("messages", async () => {
      await envoyerAuxMembres(s, slug, f(TC.ferme_fermee, { ferme: echapper(await nomFerme(slug)) }), ["proprietaire", "membre", "conseiller"]);
    });
    await ctx.etape("purge", async () => {
      const t = await un(`SELECT purge_after FROM app.tenants WHERE slug = $1`, [slug], c);
      await creerJob(c, { kind: "purger_client", tenant: slug, run_after: t?.purge_after ? new Date(t.purge_after) : null, requested_by: job.requested_by });
    });
  },
});

definir("purger_client", {
  etapes: ["controle", "ttn_devices", "ttn_webhook", "ttn_app", "grafana_org", "pg_role", "mesures", "app"],
  async executer(ctx) {
    const { job, s, c } = ctx;
    const slug = job.tenant_slug!;
    const t = await un(`SELECT * FROM app.tenants WHERE slug = $1`, [slug], c);
    if (!t) return;
    await ctx.etape("controle", async () => {
      const mesures = await un(`SELECT 1 FROM public.measures WHERE tenant = $1 LIMIT 1`, [slug], c);
      if (t.status !== "suppression" && mesures) throw new ErreurMetier("PURGE_REFUSEE", "ferme avec des mesures et pas en suppression");
    });
    const app = t.ttn_app_id || appId(slug);
    await ctx.etape("ttn_devices", async () => {
      const devs = await q(`SELECT dev_eui, config FROM app.devices WHERE tenant_slug = $1 AND ttn_status <> 'supprime'`, [slug], c);
      for (const d of devs) await s.ttn.supprimerPartout(app, idTtn(d));
    });
    await ctx.etape("ttn_webhook", async () => { await s.ttn.supprimerWebhook(app); });
    await ctx.etape("ttn_app", async () => { await s.ttn.supprimerApplication(app); });
    await ctx.etape("grafana_org", async () => {
      if (t.grafana_org_id) await s.grafana.supprimerOrg(Number(t.grafana_org_id));
      const personnes = await q(`SELECT p.id, p.grafana_user_id, p.grafana_login FROM app.memberships m JOIN app.people p ON p.id = m.person_id
                                 WHERE m.tenant_slug = $1 AND p.grafana_user_id IS NOT NULL`, [slug], c);
      for (const p of personnes) {
        if ([s.cfg.grafana.user, ...s.cfg.grafana.staffLogins].includes(p.grafana_login)) continue;
        const orgs = await s.grafana.orgsUtilisateur(Number(p.grafana_user_id)).catch(() => []);
        if (!orgs.filter(o => Number(o.orgId) !== 1).length) {
          await s.grafana.supprimerUtilisateur(Number(p.grafana_user_id));
          await c.query(`UPDATE app.people SET grafana_user_id = NULL, grafana_login = NULL WHERE id = $1`, [p.id]);
        }
      }
    });
    await ctx.etape("pg_role", async () => {
      await fermerSessions(c, slug);
      const existe = await un(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [slug], c);
      if (existe) await c.query(`DROP ROLE ${ident(slug)}`);
    });
    await ctx.etape("mesures", async () => {
      await c.query(`DELETE FROM public.measures WHERE tenant = $1`, [slug]);
      await c.query(`DELETE FROM public.uplinks WHERE tenant = $1`, [slug]);
    });
    await ctx.etape("app", async () => {
      await c.query(`DELETE FROM app.commands WHERE dev_eui IN (SELECT dev_eui FROM app.devices WHERE tenant_slug = $1)`, [slug]);
      await c.query(`DELETE FROM app.devices WHERE tenant_slug = $1`, [slug]);
      await c.query(`DELETE FROM app.memberships WHERE tenant_slug = $1`, [slug]);
      await c.query(`DELETE FROM app.invitations WHERE tenant_slug = $1`, [slug]);
      await c.query(`UPDATE app.tenants SET status = 'supprime', purge_after = NULL, alert_chat_id = NULL WHERE slug = $1`, [slug]);
      await audit(c, { acteur: job.requested_by, via: "admin", tenant: slug, action: "ferme effacée" });
    });
    if (job.chat_id) await modifier(s, "admin", job.chat_id, job.message_id, f(TA.suppression_immediate, { ferme: echapper(t.display_name) }));
  },
});

// ======================================================================= contrôle de nuit (§6.10) et tableaux

definir("verifier_ferme", {
  etapes: ["controle"],
  silencieux: true,
  async executer(ctx) {
    const { job, s, c } = ctx;
    const slug = job.tenant_slug!;
    const t = await un(`SELECT * FROM app.tenants WHERE slug = $1`, [slug], c);
    if (!t) return;
    const sante: Record<string, string> = {};
    const reparations: string[] = [];
    const role = await un(`SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1`, [slug], c);
    if (["suspendu", "suppression"].includes(t.status)) {
      if (role?.rolcanlogin) { await c.query(`ALTER ROLE ${ident(slug)} NOLOGIN`); reparations.push("rôle remis en NOLOGIN"); }
      await ctx.noter({ sante: { base: "✅" } });
      return;
    }
    if (role && (role.rolbypassrls || role.rolsuper)) {
      await avertirAdmins(s, `❌ Rôle Postgres ${slug} avec BYPASSRLS ou SUPERUSER : à corriger à la main.`, { urgent: true });
    }
    if (!role) { await creerRole(c, slug); await etapeSource(c, s, slug); reparations.push("rôle Postgres"); }
    else if (!role.rolcanlogin) { await c.query(`ALTER ROLE ${ident(slug)} LOGIN`); await etapeSource(c, s, slug); reparations.push("rôle en LOGIN"); }
    sante.base = "✅";
    try {
      const org = await etapeOrg(c, s, slug, t.display_name);
      if (!(await s.grafana.santeSource(org, slug))) { await etapeSource(c, s, slug); reparations.push("source Grafana"); }
      const tab = await s.grafana.lireTableau(org, `capteurs-${slug}`);
      const res = await s.grafana.lireTableau(org, `resume-${slug}`);
      if (!tab || Number(tab.dashboard?.version) !== Number(t.config?.grafana?.dashboard_version)
          || !res || Number(res.dashboard?.version) !== Number(t.config?.grafana?.resume_version)) { await regenererTableau(c, s, slug); reparations.push("tableau"); }
      // Catalogue changé, ou mesure nouvelle (sonde branchée…) : pas une panne.
      else if (t.config?.grafana?.catalogue !== catalogue().version
               || t.config?.grafana?.mesures !== (await c.query(`SELECT ${sqlEmpreinte("$1")} AS e`, [slug])).rows[0].e) await regenererTableau(c, s, slug);
      const prefs = await s.grafana.lirePreferences(org);
      if (prefs?.homeDashboardUID !== `capteurs-${slug}`) {
        await s.grafana.preferences(org, { homeDashboardUID: `capteurs-${slug}`, timezone: "Europe/Paris" });
        reparations.push("accueil Grafana");
      }
      await synchroniserAcces(c, s, slug, org);
      sante.grafana = "✅";
    } catch (e) { sante.grafana = "❌"; log.warn(`contrôle Grafana ${slug} : ${messageErreur(e)}`); }
    try {
      const app = await appDe(c, slug);
      const w = await s.ttn.lireWebhook(app);
      const malade = !w || w.health_status?.unhealthy;
      if (malade) { await s.ttn.ecrireWebhook(app); reparations.push("webhook"); }
      sante.ttn = "✅"; sante.webhook = w?.health_status?.unhealthy ? "❌" : "✅";
      const ttnDevs = new Set(await s.ttn.listerDevices(app));
      const base = await q(`SELECT dev_eui FROM app.devices WHERE tenant_slug = $1 AND ttn_status NOT IN ('supprime', 'echec', 'en_creation')`, [slug], c);
      for (const d of base) if (!ttnDevs.has(d.dev_eui)) {
        await c.query(`INSERT INTO app.anomalies (raison, tenant_slug, dev_eui, details) VALUES ('derive', $1, $2, $3::jsonb)
                       ON CONFLICT (raison, coalesce(tenant_slug, ''), coalesce(dev_eui, ''), coalesce(gateway_id, '')) WHERE resolved_at IS NULL
                       DO UPDATE SET count = app.anomalies.count + 1, last_seen = now()`, [slug, d.dev_eui, json({ absent_de: "ttn" })]);
      }
    } catch (e) { sante.ttn = "❌"; sante.webhook = "?"; log.warn(`contrôle TTN ${slug} : ${messageErreur(e)}`); }
    await c.query(`UPDATE app.tenants SET config = config || jsonb_build_object('sante', $2::jsonb, 'sante_at', now()) WHERE slug = $1`, [slug, json(sante)]);
    await ctx.noter({ sante, reparations });
  },
});

/** Accès donnés ou retirés directement dans Grafana (spec §6.4). */
export async function synchroniserAcces(c: pg.PoolClient | pg.Pool, s: Services, slug: string, org: number) {
  const caches = new Set([s.cfg.grafana.user, ...s.cfg.grafana.staffLogins].filter(Boolean));
  const membresG = (await s.grafana.membres(org)).filter(m => !caches.has(m.login) && m.login !== "admin");
  const adhesions = await q(`SELECT m.person_id, m.role, m.grafana_role, m.source, p.grafana_user_id, p.grafana_login, p.display_name
                             FROM app.memberships m JOIN app.people p ON p.id = m.person_id
                             WHERE m.tenant_slug = $1 AND m.status = 'actif' AND m.grafana_role IS NOT NULL`, [slug], c);
  const parId = new Map(adhesions.filter(a => a.grafana_user_id).map(a => [Number(a.grafana_user_id), a]));
  for (const g of membresG) {
    const a = parId.get(Number(g.userId));
    if (!a) {
      const p = await c.query(`INSERT INTO app.people (display_name, source, grafana_login, grafana_user_id) VALUES ($1, 'grafana', $2, $3)
                               ON CONFLICT (grafana_login) DO UPDATE SET grafana_user_id = EXCLUDED.grafana_user_id RETURNING id`,
        [g.name || g.login, g.login, g.userId]);
      await c.query(`INSERT INTO app.memberships (person_id, tenant_slug, role, grafana_role, receives_alerts, status, source)
                     VALUES ($1, $2, 'conseiller', $3, false, 'actif', 'grafana') ON CONFLICT (person_id, tenant_slug) DO NOTHING`,
        [p.rows[0].id, slug, g.role]);
    } else if (a.grafana_role !== g.role && a.role !== "proprietaire") {
      await c.query(`UPDATE app.memberships SET grafana_role = $3 WHERE person_id = $1 AND tenant_slug = $2`, [a.person_id, slug, g.role]);
    }
  }
  const presents = new Set(membresG.map(g => Number(g.userId)));
  for (const a of adhesions) {
    if (!a.grafana_user_id || presents.has(Number(a.grafana_user_id))) continue;
    if (a.role === "proprietaire") { await s.grafana.poserRole(org, a.grafana_login, Number(a.grafana_user_id), "Admin"); continue; }
    const enCours = await un(`SELECT 1 FROM app.jobs WHERE kind = 'grafana_personne' AND (params->>'person_id')::bigint = $1
                              AND status IN ('en_attente', 'en_cours', 'echec')`, [a.person_id], c);
    if (enCours) continue;
    await c.query(`DELETE FROM app.memberships WHERE person_id = $1 AND tenant_slug = $2`, [a.person_id, slug]);
    await envoyerAuxMembres(s, slug, f(TC.retire_grafana, { nom: echapper(a.display_name) }));
  }
}

definir("regenerer_tableaux", {
  etapes: ["tableaux"],
  verrou: false,
  silencieux: true,
  async executer(ctx) {
    const fermes = await q(`SELECT slug FROM app.tenants WHERE status IN ('actif', 'en_attente_activation') AND grafana_org_id IS NOT NULL ORDER BY slug`);
    for (const t of fermes) await creerJob(ctx.c, { kind: "verifier_ferme", tenant: t.slug, params: { tableau_seulement: true } });
  },
});

export { groupes, heure, lireSecret };
