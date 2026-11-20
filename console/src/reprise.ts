// Reprise d'une ferme V2 dans la V3, sans toucher aux capteurs (même application TTS, mêmes clés, même session).
// Proche de reprise_v1 de la spec (§11.5) : l'application TTS et l'organisation Grafana existantes sont adoptées.
//
//   node dist/src/reprise.js inventaire --app saint-thomas --v2 saint_thomas
//   node dist/src/reprise.js appliquer  --app saint-thomas --v2 saint_thomas --nom "Saint-Thomas" --org 2 \
//                                        --proprietaire 532933548 --grafana-login moinard.simon
//   node dist/src/reprise.js basculer   --app saint-thomas --v2 saint_thomas
//
// Tout est rejouable. Rien n'est supprimé, sauf à la bascule le webhook V2 de l'application (celui qui appelle /ttn/uplink).
import { lireConfig } from "./config.js";
import { ouvrir, db, q, un, tx, json, audit } from "./db.js";
import { chargerCatalogue, catalogue, moduleIngest } from "./catalogue.js";
import { creerServices, type Services } from "./services.js";
import { creerJob } from "./jobs/moteur.js";
import { creerRole, etapeOrg, regenererTableau } from "./jobs/taches.js";
import { motDePasseTechnique, verificateurScram } from "./crypto.js";

// Colonnes des tables V2 → mesures V3 (noms du catalogue, spec §7.5)
const TABLES_V2: Record<string, { colonnes: Record<string, string>; ignorer?: Record<string, number[]> }> = {
  lht52: { colonnes: { temperature: "temperature", humidity: "humidity", temperature_probe: "temperature_probe", battery: "battery_mv" },
           ignorer: { temperature_probe: [327.67] } },
  d2x: { colonnes: { temp_white: "temp_white", temp_red: "temp_red", temp_black: "temp_black", battery: "battery_mv" } },
  sn50v3: { colonnes: { temperature: "temperature_probe", battery: "battery_mv" } },
  ldds45: { colonnes: { distance: "distance_cm", temperature: "temperature_probe", battery: "battery_mv" } },
  lds02: { colonnes: { door_open: "door", open_count: "open_count", last_open_min: "last_open_min", battery: "battery_mv" } },
  lwl02: { colonnes: { leak: "leak", leak_count: "leak_count", last_leak_min: "last_leak_min", battery: "battery_mv" } },
};

function args() {
  const a = process.argv.slice(2);
  const o: Record<string, string> = { mode: a[0] || "inventaire" };
  for (let i = 1; i < a.length; i += 2) o[a[i].replace(/^--/, "")] = a[i + 1];
  return o;
}

/** Modèle d'un capteur repris : version_ids du Device Repository, sinon le début de son id TTS. */
function modeleDe(d: { device_id: string; version_ids: any }): string | null {
  const ing = moduleIngest() as any;
  const parDr = d.version_ids ? ing.catalogue.modeleParVersionIds(catalogue(), d.version_ids) : null;
  if (parDr) return parDr;
  const id = d.device_id.toLowerCase();
  if (/^lht52/.test(id)) return "dragino-lht52";
  if (/^(lsn50v2-)?d2[23]/.test(id)) return "dragino-lsn50v2-d2x";
  if (/^sn50v3/.test(id)) return "dragino-sn50v3-lb";
  if (/^sw3l/.test(id)) return "dragino-sw3l-lb";
  if (/^l?dds45/.test(id)) return "dragino-dds45-lb";
  if (/^lds0[12]/.test(id)) return "dragino-lds02";
  if (/^lwl02/.test(id)) return "dragino-lwl02";
  return null;
}

/** « lht52 Morilles » → « Morilles » : le modèle est déjà sur la fiche du capteur. */
function nomLisible(d: { device_id: string; name: string }): string {
  const n = (d.name || d.device_id).replace(/^(lht52|lsn50v2-d2[023]|d2[023]|sn50v3|sw3l|l?dds45|lds0[12]|lwl02)[\s_-]+/i, "").trim();
  return (n || d.device_id).slice(0, 40);
}

async function inventaire(s: Services, app: string, v2: string) {
  console.log(`\n== Application TTS ${app}`);
  const devs = await s.ttn.devicesDetail(app);
  for (const d of devs) {
    console.log(`  ${d.device_id.padEnd(20)} DevEUI ${d.dev_eui}  JoinEUI ${d.join_eui}  modèle V3 : ${modeleDe(d) || "?"}` +
      (d.name ? `  nom « ${d.name} »` : ""));
  }
  console.log(`\n== Webhooks de ${app}`);
  for (const w of await s.ttn.webhooks(app)) console.log(`  ${w.id.padEnd(20)} ${w.base_url}`);
  console.log(`\n== Organisations Grafana (source Postgres avec le rôle ${v2} = org de la ferme V2)`);
  for (const o of await s.grafana.orgs()) {
    const src = await s.grafana.sources(o.id).catch(() => []);
    const pg = src.filter(x => /postgres/i.test(x.type)).map(x => `${x.name} (rôle ${x.user})`);
    const membres = await s.grafana.membres(o.id).catch(() => []);
    console.log(`  org ${o.id} « ${o.name} » · sources : ${pg.join(", ") || "—"} · membres : ${membres.map(m => `${m.login} (${m.role})`).join(", ")}`);
  }
  console.log(`\n== Mesures V2 du tenant ${v2}`);
  for (const t of Object.keys(TABLES_V2)) {
    const r = await q(`SELECT name, count(*)::int AS n, min(time) AS debut, max(time) AS fin FROM public.${t} WHERE tenant = $1 GROUP BY name ORDER BY name`, [v2]).catch(() => []);
    for (const x of r) console.log(`  ${t.padEnd(8)} ${x.name.padEnd(20)} ${String(x.n).padStart(6)} lignes du ${x.debut.toISOString().slice(0, 10)} au ${x.fin.toISOString().slice(0, 10)}`);
  }
}

/** Copie l'historique V2 dans public.measures (rejouable : ON CONFLICT DO NOTHING). */
async function importerHistorique(slug: string, v2: string, correspondance: Map<string, string>) {
  let total = 0;
  for (const [table, def] of Object.entries(TABLES_V2)) {
    const existe = await un(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
    if (!existe.ok) continue;
    const colonnesTable = new Set((await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table])).map(x => x.column_name));
    for (const [nom, dev] of correspondance) {
      for (const [col, metric] of Object.entries(def.colonnes)) {
        if (!colonnesTable.has(col)) continue;
        const ign = def.ignorer?.[col] || [];
        const r = await db().query(
          `INSERT INTO public.measures (time, tenant, dev_eui, metric, value)
           SELECT time, $1, $2, $3, ${col}::float8 FROM public.${table}
           WHERE tenant = $4 AND name = $5 AND ${col} IS NOT NULL AND NOT (${col}::float8 = ANY($6::float8[]))
           ON CONFLICT (dev_eui, metric, time) DO NOTHING`, [slug, dev, metric, v2, nom, ign]);
        total += r.rowCount || 0;
      }
    }
  }
  // Trames brutes reçues par la V2 depuis le 17/11 : rattachées au capteur, pour « Derniers messages » et le redécodage.
  for (const [nom, dev] of correspondance) {
    await db().query(`UPDATE public.uplinks SET dev_eui = $1, tenant = $2 WHERE name = $3 AND tenant = $4 AND dev_eui IS NULL
                      AND NOT EXISTS (SELECT 1 FROM public.uplinks u2 WHERE u2.dev_eui = $1 AND u2.time = public.uplinks.time)`, [dev, slug, nom, v2]);
  }
  return total;
}

/** Dernier état de chaque capteur d'après ses mesures (last_values, last_seen, pile, radio). */
async function etatDepuisMesures(slug: string, v2: string, correspondance: Map<string, string>) {
  const ing = moduleIngest() as any;
  for (const [nom, dev] of correspondance) {
    const d = await un(`SELECT model_key FROM app.devices WHERE dev_eui = $1`, [dev]);
    const derniers = await q(`SELECT DISTINCT ON (metric) metric, value, time FROM public.measures WHERE dev_eui = $1 ORDER BY metric, time DESC`, [dev]);
    if (!derniers.length) continue;
    const valeurs: Record<string, any> = {};
    for (const x of derniers) valeurs[x.metric] = { v: x.value, t: x.time.toISOString() };
    valeurs.resume = ing.normaliser.resume(catalogue(), catalogue().modeles.get(d?.model_key), valeurs);
    const dernier = derniers.reduce((a, b) => (a.time > b.time ? a : b)).time;
    const radio = await un(`SELECT rssi, snr FROM (SELECT time, rssi, snr FROM public.lht52 WHERE tenant = $1 AND name = $2
                            UNION ALL SELECT time, rssi, snr FROM public.d2x WHERE tenant = $1 AND name = $2) x ORDER BY time DESC LIMIT 1`, [v2, nom]).catch(() => null);
    await q(`UPDATE app.devices SET last_values = $2::jsonb, last_seen = greatest(last_seen, $3::timestamptz), battery_mv = coalesce(battery_mv, $4),
             last_rssi = coalesce(last_rssi, $5), last_snr = coalesce(last_snr, $6) WHERE dev_eui = $1`,
      [dev, json(valeurs), dernier, valeurs.battery_mv?.v ?? null, radio?.rssi ?? null, radio?.snr ?? null]);
  }
}

async function appliquer(s: Services, o: Record<string, string>) {
  const app = o.app, v2 = o.v2, nom = o.nom, org = Number(o.org), tg = Number(o.proprietaire);
  if (!app || !v2 || !nom || !org || !tg) throw new Error("--app, --v2, --nom, --org et --proprietaire sont requis");
  const devs = await s.ttn.devicesDetail(app);
  if (!(await s.grafana.org(org))) throw new Error(`org Grafana ${org} introuvable`);
  const proprio = await un(`SELECT id, display_name FROM app.people WHERE telegram_user_id = $1`, [tg]);
  if (!proprio) throw new Error(`personne ${tg} absente de app.people (elle doit d'abord écrire à un des bots)`);

  // 1. La ferme : slug neutre, app TTS et org Grafana adoptées (jamais créées ni renommées ici).
  let t = await un(`SELECT * FROM app.tenants WHERE ttn_app_id = $1`, [app]);
  if (!t) {
    t = await tx(async c => {
      const slug = (await c.query(`SELECT 'f' || lpad(n::text, greatest(4, length(n::text)), '0') AS slug FROM nextval('app.tenant_slug_seq') AS n`)).rows[0].slug;
      const r = await c.query(
        `INSERT INTO app.tenants (slug, display_name, ttn_app_id, grafana_org_id, pg_role, status, activated_at, created_by, config)
         VALUES ($1, $2, $3, $4, $1, 'actif', now(), $5, $6::jsonb) RETURNING *`,
        [slug, nom, app, org, proprio.id, json({ reprise: { v2_tenant: v2, le: new Date().toISOString() } })]);
      await audit(c, { acteur: proprio.id, via: "admin", tenant: slug, action: "reprise V2", details: { app, org } });
      return r.rows[0];
    });
    console.log(`ferme créée : ${t.slug} « ${nom} »`);
  } else console.log(`ferme déjà là : ${t.slug} « ${t.display_name} »`);
  const slug: string = t.slug;

  // 2. Rôle Postgres de la ferme et source Grafana « Mesures » (la source V2 reste en place pour les anciens tableaux).
  const c = await db().connect();
  try {
    await creerRole(c, slug);
    const mdp = motDePasseTechnique();
    await c.query(`ALTER ROLE "${slug}" PASSWORD '${verificateurScram(mdp)}'`);
    await s.grafana.ecrireSource(org, slug, mdp);
    if (!(await s.grafana.santeSource(org, slug))) throw new Error("la source Grafana « Mesures » ne joint pas Postgres");
    await etapeOrg(c, s, slug, nom);
  } finally { c.release(); }
  console.log(`rôle ${slug} et source Grafana pg-${slug} prêts`);

  // 3. Propriétaire : le compte Grafana existant est repris, son mot de passe n'est pas changé.
  const g = o["grafana-login"] ? await s.grafana.utilisateurParLogin(o["grafana-login"]) : null;
  await tx(async cx => {
    if (g) await cx.query(`UPDATE app.people SET grafana_login = $2, grafana_user_id = $3, grafana_password_sent_at = coalesce(grafana_password_sent_at, now())
                           WHERE id = $1`, [proprio.id, g.login, g.id]);
    await cx.query(`INSERT INTO app.memberships (person_id, tenant_slug, role, grafana_role, receives_alerts, status, source)
                    VALUES ($1, $2, 'proprietaire', 'Admin', true, 'actif', 'bot') ON CONFLICT (person_id, tenant_slug) DO NOTHING`, [proprio.id, slug]);
  });
  if (g) await s.grafana.poserRole(org, g.login, Number(g.id), "Admin");
  console.log(`propriétaire : ${proprio.display_name}${g ? ` (Grafana ${g.login})` : ""}`);

  // 4. Les capteurs, tels qu'ils sont dans TTS.
  const correspondance = new Map<string, string>();
  for (const d of devs) {
    if (!/^[0-9a-f]{16}$/.test(d.dev_eui)) { console.log(`  ${d.device_id} : pas de DevEUI, ignoré`); continue; }
    const modele = modeleDe(d);
    await q(`INSERT INTO app.devices (dev_eui, tenant_slug, name, join_eui, model_key, ttn_status, created_by, config)
             VALUES ($1, $2, $3, $4, $5, 'connecte', $6, $7::jsonb) ON CONFLICT (dev_eui) DO NOTHING`,
      [d.dev_eui, slug, nomLisible(d),  /^[0-9a-f]{16}$/.test(d.join_eui) ? d.join_eui : null, modele, proprio.id,
       json({ ttn_device_id: d.device_id, reprise: true, version_ids_ecrits: d.version_ids, model_source: d.version_ids ? "version_ids" : "reprise" })]);
    correspondance.set(d.device_id, d.dev_eui);
    console.log(`  ${d.device_id.padEnd(20)} → ${d.dev_eui} (${modele || "modèle à choisir"})`);
  }

  // 5. Historique V2, puis dernier état de chaque capteur.
  const n = await importerHistorique(slug, v2, correspondance);
  await etatDepuisMesures(slug, v2, correspondance);
  console.log(`historique : ${n} mesures copiées`);

  // 6. Règles d'alerte intégrées et « Mes capteurs ».
  for (const dev of correspondance.values()) {
    const d = await un(`SELECT model_key, config FROM app.devices WHERE dev_eui = $1`, [dev]);
    if (d?.model_key && !d.config?.mise_en_service_at) await creerJob(db(), { kind: "mise_en_service", tenant: slug, dev_eui: dev, requested_by: proprio.id });
  }
  await regenererTableau(db(), s, slug);
  console.log(`tableau « Mes capteurs » écrit dans l'org ${org}`);
}

async function basculer(s: Services, o: Record<string, string>) {
  const app = o.app, v2 = o.v2;
  const t = await un(`SELECT * FROM app.tenants WHERE ttn_app_id = $1`, [app]);
  if (!t) throw new Error("lancer d'abord « appliquer »");
  await s.ttn.ecrireWebhook(app);
  console.log(`webhook mobilab → ${s.cfg.ttn.webhookUrl}`);
  const aSupprimer = new Set((o.supprimer || "").split(",").map(x => x.trim()).filter(Boolean));
  for (const w of await s.ttn.webhooks(app)) {
    // Seulement les webhooks nommés : un autre webhook peut servir un autre serveur.
    if (w.id !== "mobilab" && aSupprimer.has(w.id)) {
      await s.ttn.supprimerWebhookId(app, w.id);
      console.log(`webhook V2 « ${w.id} » supprimé (${w.base_url})`);
    }
  }
  // Ce que la V2 a encore reçu depuis « appliquer »
  const devs = await q(`SELECT dev_eui, config->>'ttn_device_id' AS id FROM app.devices WHERE tenant_slug = $1 AND config ? 'ttn_device_id'`, [t.slug]);
  const n = await importerHistorique(t.slug, v2, new Map(devs.map(d => [d.id, d.dev_eui])));
  await etatDepuisMesures(t.slug, v2, new Map(devs.map(d => [d.id, d.dev_eui])));
  console.log(`dernières mesures V2 copiées : ${n}`);
  await audit(db(), { via: "admin", tenant: t.slug, action: "bascule V2 → V3", details: { app } });
}

/** Org Grafana adoptée : nommée comme la ferme, « Mes capteurs » en page d'accueil. */
async function finirGrafana(s: Services, o: Record<string, string>) {
  const t = await un(`SELECT * FROM app.tenants WHERE ttn_app_id = $1`, [o.app]);
  if (!t?.grafana_org_id) throw new Error("lancer d'abord « appliquer »");
  const org = Number(t.grafana_org_id);
  try { await s.grafana.renommerOrg(org, t.display_name); } catch { await s.grafana.renommerOrg(org, `${t.display_name} (${t.slug})`); }
  await s.grafana.preferences(org, { homeDashboardUID: `capteurs-${t.slug}`, timezone: "Europe/Paris" });
  console.log(`org ${org} : « ${(await s.grafana.org(org)).name} », accueil « Mes capteurs »`);
}

async function principal() {
  const o = args();
  const cfg = lireConfig();
  ouvrir(cfg.databaseUrl, 3);
  chargerCatalogue(cfg.catalogueDir, cfg.ingestDir);
  const s = creerServices(cfg);
  if (o.mode === "inventaire") await inventaire(s, o.app, o.v2);
  else if (o.mode === "appliquer") await appliquer(s, o);
  else if (o.mode === "basculer") await basculer(s, o);
  else if (o.mode === "grafana") await finirGrafana(s, o);
  else throw new Error("mode : inventaire, appliquer, basculer ou grafana");
  await db().end();
}

principal().catch(async e => { console.error(`reprise : ${e?.message || e}`); await db().end().catch(() => undefined); process.exit(1); });
