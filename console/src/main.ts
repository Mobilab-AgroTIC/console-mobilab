// Service console Mobilab V3 (spec §2) : deux bots en long polling, moteur de jobs, distributeur de notifications,
// surveillance, et GET /health sur le réseau interne seulement.
import http from "node:http";
import { GrammyError } from "grammy";
import { lireConfig, manques } from "./config.js";
import { ouvrir, db, q } from "./db.js";
import { log } from "./log.js";
import { chargerCatalogue, versionSurDisque, catalogue } from "./catalogue.js";
import { creerServices, avertirAdmins } from "./services.js";
import { Moteur, creerJob } from "./jobs/moteur.js";
import "./jobs/taches.js";
import { Distributeur } from "./notifications.js";
import { controler, demarrerSurveillance, etatCourant } from "./surveillance.js";
import { creerBotClient, publierCommandesClient } from "./bots/client.js";
import { creerBotAdmin, majCommandesAdmin, amorcerAdmins } from "./bots/admin.js";
import { admin as TA, f } from "./textes.fr.js";

async function principal() {
  const cfg = lireConfig();
  const manque = manques(cfg);
  if (manque.length) log.warn(`configuration incomplète : ${manque.join(", ")}`);
  if (!cfg.databaseUrl && !process.env.PGPASSWORD) throw new Error("DATABASE_URL ou PGHOST/PGUSER/PGPASSWORD manquants");
  ouvrir(cfg.databaseUrl);
  await q("SELECT 1");
  chargerCatalogue(cfg.catalogueDir, cfg.ingestDir);
  log.info(`catalogue ${catalogue().version} : ${catalogue().modeles.size} modèles`);
  const s = creerServices(cfg);
  await amorcerAdmins(s);

  const moteur = new Moteur(s);
  await moteur.demarrer();
  const distributeur = new Distributeur(s);
  await distributeur.demarrer();

  const bots: { client: ReturnType<typeof creerBotClient> | null; admin: ReturnType<typeof creerBotAdmin> | null } = { client: null, admin: null };
  if (cfg.telegram.clientToken) bots.client = creerBotClient(s);
  if (cfg.telegram.adminToken) bots.admin = creerBotAdmin(s);
  const polling = { client: false, admin: false };

  const lancer = (nom: "client" | "admin") => {
    const b = bots[nom];
    if (!b) return;
    b.start({
      allowed_updates: ["message", "callback_query", "my_chat_member"],
      onStart: info => { polling[nom] = true; log.info(`bot ${nom} @${info.username} démarré`); if (nom === "client") s.noms.client = info.username; else s.noms.admin = info.username; },
    }).catch(e => {
      polling[nom] = false;
      // Deux lecteurs sur le même jeton : erreur 409, le processus s'arrête et Docker le relance (spec §2.5).
      if (e instanceof GrammyError && e.error_code === 409) { log.error(`bot ${nom} : conflit 409 (un autre processus lit ce jeton)`); process.exit(1); }
      log.error(`bot ${nom} arrêté : ${e?.message || e}`);
      process.exit(1);
    });
  };
  if (bots.client) { await bots.client.init(); s.noms.client = bots.client.botInfo.username; await publierCommandesClient(bots.client).catch(e => log.warn(`commandes client : ${e.message}`)); lancer("client"); }
  if (bots.admin) { await bots.admin.init(); s.noms.admin = bots.admin.botInfo.username; await majCommandesAdmin(bots.admin, s).catch(e => log.warn(`commandes admin : ${e.message}`)); lancer("admin"); }

  // Contrôles au démarrage (spec §2.5, §6.1) : les admins sont prévenus d'un échec.
  const erreurs = await controler(s);
  for (const e of erreurs) log.warn(`contrôle de démarrage : ${e}`);
  if (erreurs.length && bots.admin) await avertirAdmins(s, f(TA.notif_demarrage, { erreur: erreurs.join(" · ") }), { urgent: true }).catch(() => undefined);
  const surveillance = demarrerSurveillance(s);

  // Rechargement à chaud du catalogue quand VERSION change (spec §7.10).
  const veille = setInterval(async () => {
    const v = versionSurDisque(cfg.catalogueDir);
    if (!v || v === catalogue().version) return;
    try {
      chargerCatalogue(cfg.catalogueDir, cfg.ingestDir);
      log.info(`catalogue ${v} rechargé`);
      await creerJob(db(), { kind: "regenerer_tableaux" });
    } catch (e: any) {
      log.error(`catalogue refusé : ${e.message}`);
      await avertirAdmins(s, f(TA.notif_catalogue_refuse, { erreur: e.message })).catch(() => undefined);
    }
  }, 60000);

  const serveur = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      let base = true;
      try { await q("SELECT 1"); } catch { base = false; }
      const ok = base && (!bots.client || polling.client) && (!bots.admin || polling.admin);
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok, base, bots: polling, version: cfg.version, catalogue: catalogue().version, etat: etatCourant()?.calcule ?? null }));
      return;
    }
    res.writeHead(404).end();
  });
  serveur.listen(cfg.port, () => log.info(`santé sur :${cfg.port}/health`));

  const arreter = async () => {
    log.info("arrêt demandé");
    clearInterval(surveillance); clearInterval(veille);
    await bots.client?.stop().catch(() => undefined);
    await bots.admin?.stop().catch(() => undefined);
    await moteur.arreter();
    await distributeur.arreter();
    serveur.close();
    await db().end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", arreter);
  process.on("SIGINT", arreter);
}

principal().catch(e => {
  log.error(`démarrage impossible : ${e?.stack || e?.message || e}`);
  process.exit(1);
});
