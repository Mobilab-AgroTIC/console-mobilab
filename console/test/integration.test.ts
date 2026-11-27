// Test d'intégration de bout en bout (spec §12.3–12.7, « Fini quand ») sur des conteneurs JETABLES :
// Postgres/Timescale de test, Grafana 12.1.1 de test, faux The Things Stack (serveur local) et faux Telegram.
// Lancé seulement avec IT=1 et une base dont le nom finit par _it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { Api } from "grammy";
import { lireConfig } from "../src/config.js";
import { ouvrir, db, q, un } from "../src/db.js";
import { chargerCatalogue, modele, moduleIngest, catalogue, definition } from "../src/catalogue.js";
import { sqlPourcentage, construireTableau, construireResume } from "../src/tableau.js";
import { creerServices, type Services } from "../src/services.js";
import { Moteur, creerJob, chiffrerSecret, type Job } from "../src/jobs/moteur.js";
import { nomTtn } from "../src/jobs/taches.js";
import { creerBotClient } from "../src/bots/client.js";
import { creerBotAdmin, amorcerAdmins } from "../src/bots/admin.js";
import { Distributeur } from "../src/notifications.js";
import { fermesAMettreAJour } from "../src/surveillance.js";

const IT = process.env.IT === "1" && /_it$/.test(process.env.DATABASE_URL || "");

interface Appel { methode: string; chemin: string; corps: any }
const ttnAppels: Appel[] = [];
const appsCreees = new Map<string, any>();
const telegram: { methode: string; corps: any }[] = [];
const nonModifiables = new Set<number>();
let mid = 1000;

function fauxTelegram(api: Api) {
  api.config.use(async (_prev, methode, payload: any) => {
    // Comme Telegram : en HTML, tout < ou > hors balise permise fait échouer l'envoi (« can't parse entities »).
    if (payload?.parse_mode === "HTML" && typeof payload.text === "string") {
      const reste = payload.text.replace(/<\/?(b|i|u|s|code|pre|tg-spoiler|blockquote)>|<a href="[^"]*">|<\/a>/g, "");
      if (/[<>]/.test(reste)) return { ok: false, error_code: 400, description: `Bad Request: can't parse entities in « ${payload.text} »` } as any;
    }
    // Comme Telegram : un message envoyé avec un clavier de réponse (posé ou retiré) ne se modifie plus.
    if (methode === "editMessageText" && nonModifiables.has(Number(payload?.message_id))) {
      return { ok: false, error_code: 400, description: "Bad Request: message can't be edited" } as any;
    }
    telegram.push({ methode, corps: payload });
    const message = { message_id: ++mid, date: Math.floor(Date.now() / 1000), chat: { id: payload?.chat_id ?? 0, type: "private" }, text: payload?.text };
    if (methode === "sendMessage" && (payload?.reply_markup?.remove_keyboard || payload?.reply_markup?.keyboard)) nonModifiables.add(mid);
    const r: any = ["sendMessage", "sendDocument", "sendPhoto"].includes(methode) ? message : true;
    return { ok: true, result: r } as any;
  });
}

function update(from: number, texte: string, id = Math.floor(Math.random() * 1e9)) {
  return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: from, type: "private", first_name: "Jean" },
    from: { id: from, is_bot: false, first_name: "Jean", last_name: "Dupont" }, text: texte,
    entities: texte.startsWith("/") ? [{ type: "bot_command", offset: 0, length: texte.split(" ")[0].length }] : undefined } } as any;
}

function bouton(from: number, data: string, id = Math.floor(Math.random() * 1e9)) {
  return { update_id: id, callback_query: { id: String(id), chat_instance: "x", data, from: { id: from, is_bot: false, first_name: "Jean" },
    message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: from, type: "private" }, text: "…" } } } as any;
}

const derniers = (n = 5) => telegram.slice(-n).map(t => t.corps?.text || "").join("\n---\n");

describe.skipIf(!IT)("intégration : ferme, capteur, bots, Grafana réel", () => {
  let s: Services;
  let moteur: Moteur;
  let serveur: http.Server;
  let su: pg.Pool;
  let slug = "";

  async function executerTout(max = 30) {
    for (let i = 0; i < max; i++) {
      const job = await un<Job>(`UPDATE app.jobs SET status = 'en_cours' WHERE id = (SELECT id FROM app.jobs WHERE status = 'en_attente' AND run_after <= now()
                                  ORDER BY id LIMIT 1) RETURNING *`);
      if (!job) return;
      await moteur.executer(job);
    }
  }

  beforeAll(async () => {
    serveur = http.createServer((req, res) => {
      let corps = "";
      req.on("data", d => (corps += d));
      req.on("end", () => {
        const url = req.url || "";
        ttnAppels.push({ methode: req.method!, chemin: url, corps: corps ? JSON.parse(corps) : null });
        res.setHeader("content-type", "application/json");
        // Faux TTS : une application existe si elle a été créée, ou si c'est « deja-prise » (à quelqu'un d'autre)
        if (req.method === "POST" && /\/organizations\/[^/]+\/applications$/.test(url)) {
          const a = JSON.parse(corps).application;
          appsCreees.set(a.ids.application_id, a);
          res.end("{}"); return;
        }
        const ga = /^\/api\/v3\/applications\/([^/?]+)\?field_mask=attributes/.exec(url);
        if (req.method === "GET" && ga) {
          if (ga[1].startsWith("ferme-essai-")) { res.statusCode = 403; res.end(JSON.stringify({ code: 7, message: "no rights" })); return; }
          const a = appsCreees.get(ga[1]);
          if (!a) { res.statusCode = 404; res.end(JSON.stringify({ code: 5 })); return; }
          res.end(JSON.stringify({ attributes: a.attributes })); return;
        }
        if (url.startsWith("/redecode")) { res.statusCode = 202; res.end("{}"); return; }
        if (url.startsWith("/health")) { res.end(JSON.stringify({ ok: true, rejets: 0, spool_octets: 0 })); return; }
        if (url.includes("frequency-plans")) { res.end(JSON.stringify({ frequency_plans: [{ id: "EU_863_870_TTN" }] })); return; }
        if (url.includes("/rights")) { res.end(JSON.stringify({ rights: ["RIGHT_APPLICATION_ALL"] })); return; }
        if (req.method === "GET" && url.includes("/webhooks/")) { res.end(JSON.stringify({ base_url: "x", health_status: {} })); return; }
        if (req.method === "GET" && /\/devices\?/.test(url)) { res.end(JSON.stringify({ end_devices: [] })); return; }
        res.end("{}");
      });
    });
    await new Promise<void>(r => serveur.listen(0, "127.0.0.1", () => r()));
    const port = (serveur.address() as any).port;
    Object.assign(process.env, {
      TTN_HOST: "ttn.test", TTN_BASE_URL: `http://127.0.0.1:${port}`, TTN_API_KEY: "NNSXS.TEST", TTN_WEBHOOK_URL: "https://exemple.test/ttn/v3",
      TTN_WEBHOOK_SECRET: "s3cret", SECRETS_KEY: crypto.randomBytes(32).toString("hex"), NODE_RED_INTERNAL_URL: `http://127.0.0.1:${port}`,
      TELEGRAM_CLIENT_BOT_TOKEN: "", TELEGRAM_ADMIN_BOT_TOKEN: "", TELEGRAM_CLIENT_BOT_NAME: "MobilabTestBot", TELEGRAM_ADMIN_BOT_NAME: "MobilabAdminTestBot",
      ADMIN_BOOTSTRAP_IDS: "9001", GRAFANA_PUBLIC_URL: "https://graphiques.exemple.test",
    });
    const cfg = lireConfig();
    ouvrir(cfg.databaseUrl, 6);
    su = new pg.Pool({ connectionString: process.env.SUPER_DATABASE_URL });
    await su.query(`TRUNCATE app.notifications, app.anomalies, app.alert_state, app.alert_rules, app.commands, app.devices, app.memberships,
                    app.invitations, app.jobs, app.audit, app.bot_sessions, app.tenants, app.people CASCADE`);
    await su.query(`TRUNCATE public.measures`);
    chargerCatalogue(cfg.catalogueDir, cfg.ingestDir);
    s = creerServices(cfg);
    s.api.client = new Api("0:client"); fauxTelegram(s.api.client);
    s.api.admin = new Api("0:admin"); fauxTelegram(s.api.admin);
    s.noms = { client: "MobilabTestBot", admin: "MobilabAdminTestBot" };
    await amorcerAdmins(s);
    moteur = new Moteur(s);
  }, 60000);

  afterAll(async () => {
    serveur?.close();
    await su?.end();
    await db()?.end().catch(() => undefined);
  });

  it("le compte du service n'a ni SUPERUSER ni accès aux mesures sans BYPASSRLS", async () => {
    const r = await un(`SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user`);
    expect(r).toEqual({ rolsuper: false, rolbypassrls: true, rolcreaterole: true });
  });

  it("/creer_client : ferme prête (base, TTN, Grafana, compte, lien, capteur)", async () => {
    const admin = await un(`SELECT id FROM app.people WHERE telegram_user_id = 9001`);
    const r = await un(`SELECT 'f' || lpad(n::text, greatest(4, length(n::text)), '0') AS slug FROM nextval('app.tenant_slug_seq') AS n`);
    slug = r.slug;
    const p = await un(`INSERT INTO app.people (display_name, source, grafana_login) VALUES ('jean@exemple.fr', 'admin', 'jean@exemple.fr') RETURNING id`);
    const appkey = "2B7E151628AED2A6ABF7158809CF4F3C";
    await creerJob(db(), { kind: "creer_client", tenant: slug, requested_by: admin.id, chat_id: 9001, message_id: 1,
      params: { nom: "Ferme Essai", email: "jean@exemple.fr", person_id: p.id, origine: "admin",
        capteurs: [{ nom: "Serre nord", appeui: "a840410000000101", deveui: "a84041f21c5b3d2e", modele: "dragino-lht52" }] },
      secret: chiffrerSecret(s, JSON.stringify({ A84041F21C5B3D2E: appkey })) });
    await executerTout();
    const job = await un(`SELECT status, step, error, secret FROM app.jobs WHERE kind = 'creer_client'`);
    expect(job.error).toBeNull();
    expect(job).toMatchObject({ status: "ok", step: "fin", secret: null });
    const t = await un(`SELECT * FROM app.tenants WHERE slug = $1`, [slug]);
    expect(t.status).toBe("en_attente_activation");
    // « ferme-essai-00000N » est déjà prise par une app d'un autre (403) : on passe à « ferme-00000N »
    const num = slug.slice(1).padStart(6, "0");
    expect(t.ttn_app_id).toBe(`ferme-${num}`);
    // Rôle Postgres de la ferme : LOGIN, membre de clients, jamais BYPASSRLS
    const role = await su.query(`SELECT r.rolcanlogin, r.rolbypassrls, pg_has_role(r.oid, 'clients', 'MEMBER') AS membre FROM pg_roles r WHERE rolname = $1`, [slug]);
    expect(role.rows[0]).toEqual({ rolcanlogin: true, rolbypassrls: false, membre: true });
    // Appels TTN : app, webhook avec l'en-tête secret, puis IS, JS (AppKey), NS, AS
    const chemins = ttnAppels.map(a => `${a.methode} ${a.chemin.split("?")[0]}`);
    expect(chemins).toContain("POST /api/v3/organizations/mobilab/applications");
    expect(appsCreees.get(`ferme-${num}`).attributes).toEqual({ mobilab_ferme: slug });
    const wh = ttnAppels.find(a => a.methode === "PUT" && a.chemin.includes("/as/webhooks/"));
    expect(wh!.corps.webhook.headers["X-Mobilab-Secret"]).toBe("s3cret");
    expect(wh!.corps.webhook.base_url).toBe("https://exemple.test/ttn/v3");
    const js = ttnAppels.find(a => a.methode === "PUT" && a.chemin.startsWith(`/api/v3/js/applications/ferme-${num}/devices/lht52-3d2e`));
    expect(js!.corps.end_device.ids.dev_eui).toBe("A84041F21C5B3D2E");
    // Dans TTS : id « lht52-3d2e », nom « lht52 Serre nord » (type + nom choisi)
    const is = ttnAppels.find(a => a.methode === "POST" && a.chemin === `/api/v3/applications/ferme-${num}/devices`);
    expect(is!.corps.end_device.ids.device_id).toBe("lht52-3d2e");
    expect(is!.corps.end_device.name).toBe("lht52 Serre nord");
    expect(js!.corps.end_device.root_keys.app_key.key).toBe(appkey);
    expect(ttnAppels.some(a => a.methode === "PUT" && a.chemin.startsWith(`/api/v3/ns/`))).toBe(true);
    expect(ttnAppels.some(a => a.methode === "PUT" && a.chemin.startsWith(`/api/v3/as/applications/`))).toBe(true);
    // Capteur enregistré, suivi de connexion planifié, AppKey gardée seulement en indice
    const d = await un(`SELECT ttn_status, config FROM app.devices WHERE dev_eui = 'a84041f21c5b3d2e'`);
    expect(d.ttn_status).toBe("enregistre");
    expect(d.config.appkey_hint).toBe("4F3C");
    expect(d.config.ttn_device_id).toBe("lht52-3d2e");
    expect((await q(`SELECT run_after FROM app.jobs WHERE kind = 'verifier_join'`)).length).toBe(2);
    // Message de résultat : login, mot de passe, lien d'activation
    const fin = telegram.filter(x => x.methode === "editMessageText").pop()!.corps.text;
    expect(fin).toMatch(/Ferme Essai est prête/);
    expect(fin).toMatch(/Login : jean@exemple\.fr · Mot de passe : [A-Za-z]+-[A-Za-z]+-[A-Za-z]+-\d+./);
    expect(fin).toMatch(/start=a_[A-Za-z0-9_-]{43}/);
    // Aucun mot de passe en base
    const dump = JSON.stringify(await q(`SELECT params, result FROM app.jobs`));
    expect(dump).not.toMatch(/Mot de passe|SCRAM|2B7E1516/);
  }, 120000);

  it("Grafana : org renommée, source saine, tableau, accueil, propriétaire Admin, Mobilab Admin", async () => {
    const t = await un(`SELECT grafana_org_id, config FROM app.tenants WHERE slug = $1`, [slug]);
    const org = Number(t.grafana_org_id);
    expect((await s.grafana.org(org)).name).toBe("Ferme Essai");
    expect(await s.grafana.santeSource(org, slug)).toBe(true);
    const tab = await s.grafana.lireTableau(org, `capteurs-${slug}`);
    expect(tab.dashboard.title).toBe("Mes capteurs");
    expect(Number(t.config.grafana.dashboard_version), JSON.stringify(t.config.grafana)).toBe(Number(tab.dashboard.version));
    const res = await s.grafana.lireTableau(org, `resume-${slug}`);
    expect(res.dashboard.title).toBe("Résumé");
    expect(Number(t.config.grafana.resume_version), JSON.stringify(t.config.grafana)).toBe(Number(res.dashboard.version));
    expect((await s.grafana.lirePreferences(org)).homeDashboardUID).toBe(`capteurs-${slug}`);
    const membres = await s.grafana.membres(org);
    expect(membres.find(m => m.login === "jean@exemple.fr")?.role).toBe("Admin");
    expect(membres.find(m => m.login === "mobilab-svc")?.role).toBe("Admin");
  }, 60000);

  it("RLS : à travers sa source Grafana, une ferme ne voit que ses mesures", async () => {
    await su.query(`INSERT INTO public.measures (time, tenant, dev_eui, metric, value) VALUES
                    (now(), $1, 'a84041f21c5b3d2e', 'temperature', 14.2), (now(), 'f0999', 'a84041f21c5b3d2f', 'temperature', 99)`, [slug]);
    const t = await un(`SELECT grafana_org_id FROM app.tenants WHERE slug = $1`, [slug]);
    const rep = await fetch(`${s.cfg.grafana.url}/api/ds/query`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Grafana-Org-Id": String(t.grafana_org_id),
        authorization: "Basic " + Buffer.from(`${s.cfg.grafana.user}:${s.cfg.grafana.password}`).toString("base64") },
      body: JSON.stringify({ from: "now-1h", to: "now", queries: [{ refId: "A", datasource: { uid: `pg-${slug}` }, rawSql:
        "SELECT tenant, count(*) AS n FROM public.measures GROUP BY tenant", format: "table" }] }),
    });
    const json: any = await rep.json();
    const valeurs = json.results.A.frames[0].data.values;
    expect(valeurs[0]).toEqual([slug]);
    // Et rien du schéma app
    const rep2 = await fetch(`${s.cfg.grafana.url}/api/ds/query`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Grafana-Org-Id": String(t.grafana_org_id),
        authorization: "Basic " + Buffer.from(`${s.cfg.grafana.user}:${s.cfg.grafana.password}`).toString("base64") },
      body: JSON.stringify({ from: "now-1h", to: "now", queries: [{ refId: "A", datasource: { uid: `pg-${slug}` }, rawSql: "SELECT count(*) FROM app.people", format: "table" }] }),
    });
    const j2: any = await rep2.json();
    expect(JSON.stringify(j2)).toMatch(/permission denied/i);
  }, 60000);

  it("tableaux : chaque requête de « Mes capteurs » et du « Résumé » passe dans Grafana, par la source de la ferme", async () => {
    const t = await un(`SELECT grafana_org_id, display_name FROM app.tenants WHERE slug = $1`, [slug]);
    await su.query(`INSERT INTO public.measures (time, tenant, dev_eui, metric, value) VALUES
                    (now(), $1, 'a84041f21c5b3d2e', 'humidity', 80), (now(), $1, 'a84041f21c5b3d2e', 'battery_mv', 2694)`, [slug]);
    await su.query(`UPDATE app.devices SET battery_mv = 2694 WHERE dev_eui = 'a84041f21c5b3d2e'`);
    const capteurs = [{ dev_eui: "a84041f21c5b3d2e", name: "Serre", model_key: "dragino-lht52", ttn_status: "connecte",
      last_values: { temperature: { v: 14.2 }, humidity: { v: 80 }, battery_mv: { v: 2694 } } }];
    const ferme = { slug, display_name: t.display_name };
    const requete = async (sql: string, format: string) => {
      const rep = await fetch(`${s.cfg.grafana.url}/api/ds/query`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Grafana-Org-Id": String(t.grafana_org_id),
          authorization: "Basic " + Buffer.from(`${s.cfg.grafana.user}:${s.cfg.grafana.password}`).toString("base64") },
        body: JSON.stringify({ from: "now-7d", to: "now", queries: [{ refId: "A", datasource: { uid: `pg-${slug}` }, rawSql: sql, format,
          intervalMs: 600000, maxDataPoints: 500 }] }),
      });
      return { statut: rep.status, json: (await rep.json()) as any };
    };
    const valeursDe = (j: any, champ: string) => {
      const f = j.results.A.frames[0];
      const i = f.schema.fields.findIndex((x: any) => x.name === champ);
      return f.data.values[i];
    };
    let n = 0;
    for (const tab of [construireTableau(ferme, capteurs, catalogue(), (m, nom) => definition(m, nom)), construireResume(ferme, capteurs, catalogue())] as any[]) {
      for (const p of tab.panels) for (const q of p.targets || []) {
        const r = await requete(q.rawSql, q.format);
        expect(r.json.results?.A?.error, `${tab.title} / ${p.title} : ${q.rawSql}`).toBeUndefined();
        expect(r.statut).toBe(200);
        n++;
        if (p.type === "gauge") {
          // La colonne texte devient l'étiquette « tension » du champ Pile : la jauge l'affiche sous le %
          const champ = r.json.results.A.frames[0].schema.fields.find((x: any) => x.type === "number");
          expect(champ.labels).toEqual({ tension: "2,69 V" });
          expect(r.json.results.A.frames[0].data.values[1]).toEqual([55]);
        }
        if (p.title === "État de mes capteurs") expect(valeursDe(r.json, "Pile")).toEqual([55]);
      }
    }
    expect(n).toBe(8);    // 4 dans « Mes capteurs » (courbes, jauge, pile, signal), 4 dans le « Résumé »
  }, 60000);

  it("pile : le % calculé par Postgres (Grafana) est celui du bot", async () => {
    const m = modele("dragino-lht52")!;
    const sql = sqlPourcentage("v", m.batterie!.courbe!);
    for (const mv of [3300, 3100, 3000, 2694, 2676, 2462, 2350, 2300, 2000]) {
      const r = await q(`SELECT ${sql} AS p FROM (SELECT ${mv}::numeric AS v) x`);
      expect(Number(r[0].p), `${mv} mV`).toBe(Math.round(moduleIngest().catalogue.pourcentageBrut(m, mv)!));
      const r5 = await q(`SELECT ${sqlPourcentage("v", m.batterie!.courbe!, true)} AS p FROM (SELECT ${mv}::numeric AS v) x`);
      expect(Number(r5[0].p), `${mv} mV, par 5 %`).toBe(moduleIngest().catalogue.pourcentagePile(m, mv));
    }
  });

  it("bot client : activation par le lien a_, puis /capteurs", async () => {
    const fin = telegram.filter(x => x.methode === "editMessageText").map(x => x.corps.text).find(t => /start=a_/.test(t))!;
    const param = /start=(a_[A-Za-z0-9_-]{43})/.exec(fin)![1];
    const bot = creerBotClient(s);
    fauxTelegram(bot.api);
    await bot.handleUpdate(update(5555, `/start ${param}`));
    const t = await un(`SELECT status, activated_at FROM app.tenants WHERE slug = $1`, [slug]);
    expect(t.status).toBe("actif");
    const p = await un(`SELECT id, telegram_user_id, display_name FROM app.people WHERE telegram_user_id = 5555`);
    expect(p.display_name).toBe("Jean Dupont");
    expect(derniers(4)).toMatch(/Bonjour Jean !\nVous êtes relié à « <b>Ferme Essai<\/b> »\./);
    // La liste, ce sont les boutons : un capteur par ligne, avec son état
    const liste = telegram.slice(-4).map(x => x.corps?.reply_markup?.inline_keyboard).find(k => k?.some((r: any[]) => /Serre nord/.test(r[0]?.text)));
    expect(liste.find((r: any[]) => /Serre nord/.test(r[0].text))).toEqual([{ text: "⏳ Serre nord · pas encore connecté", callback_data: "dv:a84041f21c5b3d2e" }]);
    // Le même lien rouvert : « Vous avez déjà accès »
    await bot.handleUpdate(update(5555, `/start ${param}`));
    expect(derniers(3)).toMatch(/Vous avez déjà accès à « Ferme Essai »/);
    // Un autre compte : lien mort
    await bot.handleUpdate(update(7777, `/start ${param}`));
    expect(derniers(1)).toMatch(/Ce lien ne marche plus/);
    // Sans lien, inconnu
    await bot.handleUpdate(update(7778, `/start`));
    expect(derniers(1)).toMatch(/réservé aux clients Mobilab/);
  }, 60000);

  it("bot client : /ajouter, 4 questions, relecture, job ajouter_capteur", async () => {
    const bot = creerBotClient(s);
    fauxTelegram(bot.api);
    await bot.handleUpdate(update(5555, "/ajouter"));
    expect(derniers(1)).toMatch(/Quelle marque de capteur/);
    await bot.handleUpdate(bouton(5555, "aj:m:dragino"));
    // Beaucoup de types Dragino : d'abord le genre de capteur (pas de catégorie « sol »)
    const genres = telegram.filter(x => x.methode === "editMessageText").pop()!;
    expect(genres.corps.text).toMatch(/Quel genre de capteur Dragino/);
    expect(genres.corps.reply_markup.inline_keyboard.map((r: any[]) => r.map(b => b.text))).toEqual([["🌡️ Température, humidité"],
      ["📏 Niveau, distance"], ["🚪 Porte, fuite, contact"], ["📦 Autres"], ["❓ Pas dans la liste"]]);
    await bot.handleUpdate(bouton(5555, "aj:k:dragino:temperature"));
    const types = telegram.filter(x => x.methode === "editMessageText").pop()!;
    expect(types.corps.text).toMatch(/Quel type de Dragino/);
    const lignesTypes = types.corps.reply_markup.inline_keyboard.map((r: any[]) => r.map(b => b.text));
    expect(lignesTypes.every((r: string[]) => r.length === 1)).toBe(true);
    expect(lignesTypes.flat()).toContain("LHT52 · thermomètre");
    expect(lignesTypes.flat()).not.toContain("LDS02 · détecteur d'ouverture");
    expect(lignesTypes.flat().slice(-2)).toEqual(["Autre", "⬅️ Retour"]);
    await bot.handleUpdate(bouton(5555, "aj:t:dragino-lht52"));
    expect(derniers(1)).toMatch(/Quel nom pour ce capteur/);
    await bot.handleUpdate(update(5555, "Serre nord"));
    expect(derniers(1)).toMatch(/Ce nom est déjà pris/);
    await bot.handleUpdate(update(5555, "Chambre froide"));
    await bot.handleUpdate(update(5555, "A840 4100 0000 0101"));
    await bot.handleUpdate(update(5555, "2b7e151628aed2a6abf7158809cf4f3"));
    expect(derniers(1)).toMatch(/Il faut 32 caractères/);
    await bot.handleUpdate(update(5555, "2b7e151628aed2a6abf7158809cf4f3c"));
    await bot.handleUpdate(update(5555, "a8-40-41-f2-1c-5b-3d-2f"));
    expect(derniers(1)).toMatch(/AppKey  <code>2B7E 1516 28AE D2A6 ABF7 1588 09CF 4F3C<\/code>/);
    expect(derniers(1)).toMatch(/Type : LHT52 \(Dragino\)/);
    await bot.handleUpdate(bouton(5555, "ad:ok"));
    expect(derniers(1)).toMatch(/J'enregistre <b>Chambre froide<\/b>/);
    const j = await un(`SELECT kind, params, secret IS NOT NULL AS secret FROM app.jobs WHERE dev_eui = 'a84041f21c5b3d2f'`);
    expect(j).toMatchObject({ kind: "ajouter_capteur", secret: true });
    expect(JSON.stringify(j.params)).not.toMatch(/2B7E/i);
    await executerTout();
    const ch = await un(`SELECT ttn_status, model_key, config FROM app.devices WHERE dev_eui = 'a84041f21c5b3d2f'`);
    expect(ch).toMatchObject({ ttn_status: "enregistre", model_key: "dragino-lht52" });
    expect(ch.config.ttn_device_id).toBe("lht52-3d2f");
    expect(telegram.filter(x => x.methode === "editMessageText").pop()!.corps.text).toMatch(/<b>Chambre froide<\/b> est enregistré\.\nAllumez-le : appui long/);
    expect((await un(`SELECT secret FROM app.jobs WHERE dev_eui = 'a84041f21c5b3d2f' AND kind = 'ajouter_capteur'`)).secret).toBeNull();
  }, 60000);

  it("renommer : nouveau nom en base et dans TTN, l'id TTN ne change pas", async () => {
    const bot = creerBotClient(s);
    fauxTelegram(bot.api);
    await bot.handleUpdate(bouton(5555, "rn:a84041f21c5b3d2f"));
    await bot.handleUpdate(update(5555, "Cave à vin"));
    expect(telegram.filter(x => x.methode === "sendMessage").map(x => x.corps.text).join("\n")).toMatch(/Renommé : <b>Cave à vin<\/b>/);
    const n = ttnAppels.length;
    await executerTout();
    expect((await un(`SELECT name FROM app.devices WHERE dev_eui = 'a84041f21c5b3d2f'`)).name).toBe("Cave à vin");
    const put = ttnAppels.slice(n).find(a => a.methode === "PUT" && /^\/api\/v3\/applications\/[^/]+\/devices\/lht52-3d2f$/.test(a.chemin.split("?")[0]));
    expect(put?.corps).toMatchObject({ end_device: { ids: { device_id: "lht52-3d2f" }, name: "lht52 Cave à vin" }, field_mask: { paths: ["name"] } });
    expect(nomTtn({ name: "lht52 Ferment", model_key: "dragino-lht52" })).toBe("lht52 Ferment");
    expect(nomTtn({ name: "Alambic", model_key: "dragino-lsn50v2-d2x" })).toBe("d23 Alambic");
    expect(nomTtn({ name: "Cuve", model_key: null })).toBe("Cuve");
    expect(await un(`SELECT status FROM app.jobs WHERE kind = 'renommer_capteur' AND dev_eui = 'a84041f21c5b3d2f'`)).toMatchObject({ status: "ok" });
    await q(`UPDATE app.devices SET name = 'Chambre froide' WHERE dev_eui = 'a84041f21c5b3d2f'`);   // nom attendu plus loin
  });

  it("mise en service : règles intégrées, et le seuil se règle en 2 taps", async () => {
    await q(`UPDATE app.devices SET last_values = '{"temperature":{"v":14.2},"humidity":{"v":81}}' WHERE dev_eui = 'a84041f21c5b3d2e'`);
    await executerTout();
    const rs = await q(`SELECT kind, metric, min FROM app.alert_rules WHERE dev_eui = 'a84041f21c5b3d2e' ORDER BY kind`);
    expect(rs.map(r => r.kind)).toEqual(["battery", "silence"]);
    expect(Number(rs[0].min)).toBe(2462);   // 20 % sur la courbe de 2 alcalines (piles.yaml)
    // Par défaut : la pile et « pas de nouvelles » ; chacune se désactive d'un tap
    expect((await q(`SELECT kind, enabled FROM app.alert_rules WHERE dev_eui = 'a84041f21c5b3d2e' ORDER BY kind`)).map(r => r.enabled)).toEqual([true, true]);
    expect(ttnAppels.some(a => a.chemin.startsWith("/redecode"))).toBe(true);
    const bot = creerBotClient(s);
    fauxTelegram(bot.api);
    await bot.handleUpdate(bouton(5555, "am:a84041f21c5b3d2e:temperature"));
    expect(telegram.filter(x => x.methode === "editMessageText").pop()!.corps.text).toMatch(/Température de <b>Serre nord<\/b> \(14,2 °C\)\.\nPrévenir si :/);
    await bot.handleUpdate(bouton(5555, "th:a84041f21c5b3d2e:temperature:lo:1"));
    const seuil = await un(`SELECT min, max FROM app.alert_rules WHERE dev_eui = 'a84041f21c5b3d2e' AND kind = 'threshold'`);
    expect(Number(seuil.min)).toBe(2);
    // La fiche affiche le seuil (« Alerte si < 2 °C ») sans casser le HTML
    await bot.handleUpdate(bouton(5555, "dv:a84041f21c5b3d2e"));
    expect(telegram.filter(x => x.methode === "editMessageText").pop()!.corps.text).toMatch(/Alerte si &lt; 2,0 °C/);
    // « Autre valeur » puis une limite tapée
    await bot.handleUpdate(bouton(5555, "tv:a84041f21c5b3d2e:temperature"));
    expect(derniers(1)).toMatch(/Tapez la limite, ex\. &lt; 3/);
    await bot.handleUpdate(update(5555, "> 30"));
    expect(derniers(1)).toMatch(/Alerte si &gt; 30,0 °C/);
    expect((await q(`SELECT 1 FROM app.alert_rules WHERE dev_eui = 'a84041f21c5b3d2e' AND kind = 'threshold'`)).length).toBe(2);
    // Désactiver puis réactiver « pas de nouvelles » d'un tap
    await bot.handleUpdate(bouton(5555, "ai:a84041f21c5b3d2e:s"));
    expect((await un(`SELECT enabled FROM app.alert_rules WHERE dev_eui = 'a84041f21c5b3d2e' AND kind = 'silence'`)).enabled).toBe(false);
    await bot.handleUpdate(bouton(5555, "ai:a84041f21c5b3d2e:s"));
    expect((await un(`SELECT enabled FROM app.alert_rules WHERE dev_eui = 'a84041f21c5b3d2e' AND kind = 'silence'`)).enabled).toBe(true);
    expect(await un(`SELECT state FROM app.alert_state s JOIN app.alert_rules r ON r.id = s.rule_id WHERE r.kind = 'threshold'`)).toEqual({ state: "ok" });
    // Un conseiller ne peut pas régler (bouton forgé)
    await q(`INSERT INTO app.people (telegram_user_id, display_name) VALUES (8888, 'Paul Martin')`);
    await q(`INSERT INTO app.memberships (person_id, tenant_slug, role, grafana_role, receives_alerts) SELECT id, $1, 'conseiller', 'Viewer', false FROM app.people WHERE telegram_user_id = 8888`, [slug]);
    await bot.handleUpdate(bouton(8888, "th:a84041f21c5b3d2e:temperature:hi:0"));
    expect(telegram.filter(x => x.methode === "answerCallbackQuery").pop()!.corps.text).toBe("Réservé à la ferme.");
    expect((await q(`SELECT 1 FROM app.alert_rules WHERE dev_eui = 'a84041f21c5b3d2e' AND kind = 'threshold'`)).length).toBe(2);
  }, 60000);

  it("sonde branchée en cours de route : courbe ajoutée au tableau ; valeur ancienne marquée sur la fiche", async () => {
    await creerJob(db(), { kind: "verifier_ferme", tenant: slug });
    await executerTout();
    expect(await fermesAMettreAJour()).not.toContain(slug);
    const il_y_a_3j = new Date(Date.now() - 3 * 86400000).toISOString();
    await q(`UPDATE app.devices SET last_seen = now(), last_values = jsonb_build_object(
               'temperature', jsonb_build_object('v', 14.2, 't', now()), 'humidity', jsonb_build_object('v', 81, 't', now()),
               'temperature_probe', jsonb_build_object('v', 9.5, 't', $1::text)) WHERE dev_eui = 'a84041f21c5b3d2e'`, [il_y_a_3j]);
    expect(await fermesAMettreAJour()).toContain(slug);
    await creerJob(db(), { kind: "verifier_ferme", tenant: slug, params: { tableau_seulement: true } });
    await executerTout();
    expect(await fermesAMettreAJour()).not.toContain(slug);
    const t = await un(`SELECT grafana_org_id FROM app.tenants WHERE slug = $1`, [slug]);
    const tab = await s.grafana.lireTableau(Number(t.grafana_org_id), `capteurs-${slug}`);
    expect(JSON.stringify(tab.dashboard.panels)).toMatch(/Température sonde/);
    // Fiche : la sonde débranchée depuis 3 jours garde sa valeur, mais avec son âge
    const bot = creerBotClient(s);
    fauxTelegram(bot.api);
    await bot.handleUpdate(bouton(5555, "dv:a84041f21c5b3d2e"));
    const fiche = telegram.filter(x => /Température sonde/.test(x.corps?.text || "")).pop()!.corps.text;
    expect(fiche).toMatch(/Température sonde : <b>9,5 °C<\/b> <i>\(il y a 3 j\)<\/i>/);
    expect(fiche).toMatch(/Température : <b>14,2 °C<\/b>\n/);
    expect(fiche).toMatch(/<i>Dragino LHT52<\/i>/);
  });

  it("intervalle d'envoi : choix, confirmation, downlink 01 + secondes ; durée tapée ; accusé", async () => {
    const dev = "a84041f21c5b3d2e";
    const bot = creerBotClient(s);
    fauxTelegram(bot.api);
    const dernierEcran = () => telegram.filter(x => x.methode === "editMessageText").pop()!.corps;
    await bot.handleUpdate(bouton(5555, `st:${dev}`));
    expect(dernierEcran().reply_markup.inline_keyboard.flat()).toContainEqual({ text: "⏱️ Intervalle d'envoi", callback_data: `iv:${dev}` });
    await bot.handleUpdate(bouton(5555, `iv:${dev}`));
    expect(dernierEcran().text).toMatch(/<b>Serre nord<\/b> envoie un message toutes les 20 min environ\./);
    expect(dernierEcran().reply_markup.inline_keyboard.map((r: any[]) => r.map(b => b.text))).toEqual([["1 min", "3 min", "5 min"],
      ["10 min", "20 min", "1 h"], ["6 h", "12 h", "24 h"], ["Autre…"], ["⬅️ Retour"]]);
    await bot.handleUpdate(bouton(5555, `iv:${dev}:3600`));
    expect(dernierEcran().text).toBe("Passer Serre nord à un message toutes les 1 h ?");
    await bot.handleUpdate(bouton(5555, `iv!:${dev}:3600`));
    expect(dernierEcran().text).toMatch(/C'est demandé : Serre nord enverra un message toutes les 1 h\.\nL'ordre part à son prochain message \(souvent moins de 20 min\)/);
    const retourFiche = [[{ text: "⬅️ Retour", callback_data: `dv:${dev}` }]];
    expect(dernierEcran().reply_markup.inline_keyboard).toEqual(retourFiche);
    const cmd = await un(`SELECT id, action, f_port, payload_hex, status, round(extract(epoch FROM expires_at - requested_at) / 60) AS min FROM app.commands WHERE dev_eui = $1`, [dev]);
    expect(cmd).toMatchObject({ action: "intervalle:3600", f_port: 1, payload_hex: "01000e10", status: "demandee", min: "120" });
    const n = ttnAppels.length;
    await executerTout();
    const push = ttnAppels.slice(n).find(a => a.chemin.endsWith("/devices/lht52-3d2e/down/push"));
    expect(push!.corps.downlinks[0]).toMatchObject({ f_port: 1, frm_payload: Buffer.from("01000e10", "hex").toString("base64"), confirmed: true,
      correlation_ids: [`mobilab:cmd:${cmd.id}`] });
    // Un ordre en cours : pas de second ordre, on peut l'annuler
    await bot.handleUpdate(bouton(5555, `iv:${dev}`));
    expect(dernierEcran().text).toMatch(/^Déjà demandé à /);
    // Accusé du capteur (Node-RED) : le message « ⏳ » devient « ✅ »
    await q(`UPDATE app.commands SET status = 'confirmee', confirmed_at = now() WHERE id = $1`, [cmd.id]);
    await q(`INSERT INTO app.notifications (audience, expediteur, kind, tenant_slug, dev_eui, transition, details) VALUES ('client', 'service', 'commande', $1, $2, 'info', $3)`,
      [slug, dev, JSON.stringify({ command_id: Number(cmd.id), statut: "confirmee" })]);
    await new Distributeur(s).traiter();
    expect(dernierEcran().text).toMatch(/^✅ Serre nord envoie maintenant un message toutes les 1 h \(\d\d:\d\d\)\.$/);
    expect(dernierEcran().reply_markup.inline_keyboard).toEqual(retourFiche);
    // Intervalle gardé en base (posé par Node-RED à l'accusé) : affiché tel quel
    await q(`UPDATE app.devices SET intervalle_s = 3600 WHERE dev_eui = $1`, [dev]);
    await bot.handleUpdate(bouton(5555, `iv:${dev}`));
    expect(dernierEcran().text).toMatch(/<b>Serre nord<\/b> est réglé sur un message toutes les 1 h\./);
    // « Autre… » puis « Annuler » : retour à l'écran de l'intervalle, pas de cul-de-sac
    await bot.handleUpdate(bouton(5555, `iv:${dev}:a`));
    await bot.handleUpdate(update(5555, "Annuler"));
    expect(telegram.slice(-3).map(x => x.corps?.text || "").join("\n")).toMatch(/Annulé\.[\s\S]*est réglé sur un message toutes les 1 h/);
    // « Autre… » : une durée tapée, avec son unité
    await bot.handleUpdate(bouton(5555, `iv:${dev}:a`));
    expect(derniers(1)).toMatch(/Combien de temps entre deux messages \?/);
    await bot.handleUpdate(update(5555, "15"));
    expect(derniers(1)).toMatch(/Je n'ai pas compris/);
    await bot.handleUpdate(update(5555, "30 s"));
    expect(derniers(1)).toBe("Entre 1 min et 168 h, s'il vous plaît.");
    await bot.handleUpdate(update(5555, "90 s"));
    const q90 = telegram.filter(x => x.methode === "sendMessage").pop()!.corps;
    expect(q90.text).toBe("Passer Serre nord à un message toutes les 1 min 30 s ?\nLa pile s'usera bien plus vite.");
    expect(q90.reply_markup.inline_keyboard[0][0]).toEqual({ text: "Oui, changer", callback_data: `iv!:${dev}:90` });
    await bot.handleUpdate(bouton(5555, `iv!:${dev}:90`));
    const c2 = await un(`SELECT id, payload_hex, status FROM app.commands WHERE dev_eui = $1 AND action = 'intervalle:90'`, [dev]);
    expect(c2).toMatchObject({ payload_hex: "0100005a", status: "demandee" });
    await bot.handleUpdate(bouton(5555, `ax:${c2.id}`));
    expect((await un(`SELECT status FROM app.commands WHERE id = $1`, [c2.id])).status).toBe("annulee");
    expect(dernierEcran()).toMatchObject({ text: "Ordre annulé.", reply_markup: { inline_keyboard: retourFiche } });
    // Un conseiller n'a pas le bouton et ne peut pas forcer l'ordre
    const avant = telegram.length;
    await bot.handleUpdate(bouton(8888, `iv!:${dev}:600`));
    expect(telegram.slice(avant).some(x => x.methode === "answerCallbackQuery" && x.corps.text === "Réservé à la ferme.")).toBe(true);
    expect((await q(`SELECT 1 FROM app.commands WHERE dev_eui = $1 AND action = 'intervalle:600'`, [dev])).length).toBe(0);
  }, 60000);

  it("partage : lien j_ d'un collègue, compte Grafana Viewer, le propriétaire est prévenu", async () => {
    const bot = creerBotClient(s);
    fauxTelegram(bot.api);
    await bot.handleUpdate(bouton(5555, `sh:${slug}:m`));
    const lien = /start=(j_[A-Za-z0-9_-]{43})/.exec(telegram.filter(x => x.methode === "editMessageText").pop()!.corps.text)![1];
    await bot.handleUpdate(update(6666, `/start ${lien}`));
    expect(derniers(4)).toMatch(/Vous avez accès à « Ferme Essai » \(Jean Dupont\)/);
    expect(telegram.some(x => x.corps?.chat_id === 5555 && /a maintenant accès \(collègue\)/.test(x.corps.text || ""))).toBe(true);
    await executerTout();
    const p = await un(`SELECT grafana_login, grafana_user_id FROM app.people WHERE telegram_user_id = 6666`);
    expect(p.grafana_login).toBe("jean.dupont");
    const t = await un(`SELECT grafana_org_id FROM app.tenants WHERE slug = $1`, [slug]);
    expect((await s.grafana.membres(Number(t.grafana_org_id))).find(m => m.userId === Number(p.grafana_user_id))?.role).toBe("Viewer");
    // /graphiques : premier mot de passe, envoyé une fois, jamais stocké
    await bot.handleUpdate(update(6666, "/graphiques"));
    await executerTout();
    const msg = telegram.filter(x => x.methode === "editMessageText").pop()!.corps.text;
    expect(msg).toMatch(/Identifiant : <code>jean\.dupont<\/code>\n🔑 Mot de passe : /);
    expect((await un(`SELECT grafana_password_sent_at IS NOT NULL AS ok FROM app.people WHERE telegram_user_id = 6666`)).ok).toBe(true);
  }, 90000);

  it("notifications Node-RED → service : première mesure envoyée à l'auteur", async () => {
    const d = new Distributeur(s);
    await q(`UPDATE app.devices SET last_values = '{"temperature":{"v":3.1},"resume":"3,1 °C · 90 %"}', created_by = (SELECT id FROM app.people WHERE telegram_user_id = 5555)
             WHERE dev_eui = 'a84041f21c5b3d2f'`);
    await q(`INSERT INTO app.notifications (audience, expediteur, kind, tenant_slug, dev_eui, details) VALUES ('client', 'service', 'premiere_mesure', $1, 'a84041f21c5b3d2f', '{}')`, [slug]);
    await d.traiter();
    expect(telegram.some(x => x.corps?.chat_id === 5555 && /🎉 <b>Chambre froide<\/b> marche : 3,1 °C · 90 %/.test(x.corps.text || ""))).toBe(true);
  }, 30000);

  it("bot admin : réservé à l'équipe, /etat et fiche client", async () => {
    const bot = creerBotAdmin(s);
    fauxTelegram(bot.api);
    await bot.handleUpdate(update(5555, "/etat"));
    expect(derniers(1)).toBe("Ce bot est réservé à l'équipe Mobilab.");
    await bot.handleUpdate(update(5555, "/etat"));
    expect(derniers(1)).toBe("Ce bot est réservé à l'équipe Mobilab.");     // pas de 2e réponse le même jour
    expect(telegram.filter(x => x.corps?.chat_id === 5555 && x.corps.text === "Ce bot est réservé à l'équipe Mobilab.").length).toBe(1);
    await bot.handleUpdate(update(9001, "/etat"));
    expect(derniers(1)).toMatch(/^État · /);
    await bot.handleUpdate(update(9001, "/client essai"));
    expect(derniers(1)).toMatch(/Ferme Essai · f\d{4}/);
  }, 30000);

  it("suspendre puis réactiver : rôle en NOLOGIN puis LOGIN", async () => {
    await creerJob(db(), { kind: "suspendre_client", tenant: slug });
    await executerTout();
    expect((await su.query(`SELECT rolcanlogin FROM pg_roles WHERE rolname = $1`, [slug])).rows[0].rolcanlogin).toBe(false);
    expect((await un(`SELECT status FROM app.tenants WHERE slug = $1`, [slug])).status).toBe("suspendu");
    const bot = creerBotClient(s);
    fauxTelegram(bot.api);
    await bot.handleUpdate(update(5555, "/capteurs"));
    expect(derniers(1)).toMatch(/L'accès à « Ferme Essai » est en pause/);
    await creerJob(db(), { kind: "reactiver_client", tenant: slug });
    await executerTout();
    expect((await su.query(`SELECT rolcanlogin FROM pg_roles WHERE rolname = $1`, [slug])).rows[0].rolcanlogin).toBe(true);
    expect((await un(`SELECT status FROM app.tenants WHERE slug = $1`, [slug])).status).toBe("actif");
  }, 60000);

  it("ferme d'essai sans mesure : purge complète (TTN, Grafana, rôle), slug jamais repris", async () => {
    const admin = await un(`SELECT id FROM app.people WHERE telegram_user_id = 9001`);
    const r = await un(`SELECT 'f' || lpad(n::text, greatest(4, length(n::text)), '0') AS slug FROM nextval('app.tenant_slug_seq') AS n`);
    const p = await un(`INSERT INTO app.people (display_name, source, grafana_login) VALUES ($1, 'admin', $1) RETURNING id`, [r.slug]);
    await creerJob(db(), { kind: "creer_client", tenant: r.slug, requested_by: admin.id, params: { nom: "Essai jetable", person_id: p.id, origine: "admin", capteurs: [] } });
    await executerTout();
    const org = Number((await un(`SELECT grafana_org_id FROM app.tenants WHERE slug = $1`, [r.slug])).grafana_org_id);
    await creerJob(db(), { kind: "purger_client", tenant: r.slug, requested_by: admin.id });
    await executerTout();
    expect((await un(`SELECT status FROM app.tenants WHERE slug = $1`, [r.slug])).status).toBe("supprime");
    expect((await su.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [r.slug])).rowCount).toBe(0);
    expect(await s.grafana.org(org)).toBeNull();
    expect(ttnAppels.some(a => a.methode === "DELETE" && a.chemin === `/api/v3/applications/essai-jetable-${r.slug.slice(1).padStart(6, "0")}`)).toBe(true);
  }, 90000);
});
