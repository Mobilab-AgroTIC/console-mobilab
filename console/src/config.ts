// Configuration du service (spec V3 §2.5, §6.1) : uniquement des variables d'environnement,
// jamais en base ni dans les flows. Aucun secret n'est journalisé.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  databaseUrl: string;
  secretsKey: Buffer | null;
  ttn: { host: string; baseUrl: string; orgId: string; apiKey: string; webhookUrl: string; webhookSecret: string;
         frequencyPlan: string; defaultMac: string; defaultPhy: string; consoleUrl: string };
  grafana: { url: string; publicUrl: string; user: string; password: string; dbHost: string; dbName: string;
             staffLogins: string[] };
  telegram: { clientToken: string; adminToken: string; clientBotName: string; adminBotName: string };
  adminBootstrapIds: number[];
  nodeRedUrl: string;
  catalogueDir: string;
  ingestDir: string;
  port: number;
  version: string;
  fuseau: string;
}

/** Racine du dépôt : le dossier qui contient ingest/ et catalogue/. */
export function racineDepot(depuis = path.dirname(fileURLToPath(import.meta.url))): string {
  let d = depuis;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, "ingest", "package.json"))) return d;
    d = path.dirname(d);
  }
  return process.env.REPO_DIR || "/app";
}

function liste(v: string | undefined): string[] {
  return (v || "").split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

export function lireConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const racine = racineDepot();
  const cle = env.SECRETS_KEY || "";
  let secretsKey: Buffer | null = null;
  if (cle) {
    secretsKey = /^[0-9a-fA-F]{64}$/.test(cle) ? Buffer.from(cle, "hex") : Buffer.from(cle, "base64");
    if (secretsKey.length !== 32) throw new Error("SECRETS_KEY : 32 octets attendus (64 caractères hexadécimaux)");
  }
  const publicHost = env.PUBLIC_HOST || "";
  return {
    databaseUrl: env.DATABASE_URL || "",
    secretsKey,
    ttn: {
      host: env.TTN_HOST || "",
      baseUrl: (env.TTN_BASE_URL || (env.TTN_HOST ? `https://${env.TTN_HOST}` : "")).replace(/\/$/, ""),
      orgId: env.TTN_ORG_ID || "mobilab",
      apiKey: env.TTN_API_KEY || "",
      webhookUrl: env.TTN_WEBHOOK_URL || (publicHost ? `https://${publicHost}/ttn/v3` : ""),
      webhookSecret: env.TTN_WEBHOOK_SECRET || "",
      frequencyPlan: env.TTN_FREQUENCY_PLAN || "EU_863_870_TTN",
      defaultMac: env.TTN_DEFAULT_MAC || "MAC_V1_0_3",
      defaultPhy: env.TTN_DEFAULT_PHY || "PHY_V1_0_3_REV_A",
      consoleUrl: env.TTN_CONSOLE_URL || (env.TTN_HOST ? `https://${env.TTN_HOST}/console` : ""),
    },
    grafana: {
      url: (env.GRAFANA_URL || "http://mobilab-grafana:3000").replace(/\/$/, ""),
      publicUrl: (env.GRAFANA_PUBLIC_URL || env.GRAFANA_URL || "").replace(/\/$/, ""),
      user: env.GRAFANA_ADMIN_USER || "",
      password: env.GRAFANA_ADMIN_PASSWORD || "",
      dbHost: env.GRAFANA_DB_HOST || "mobilab-postgres:5432",
      dbName: env.GRAFANA_DB_NAME || "mobilab",
      staffLogins: liste(env.MOBILAB_STAFF_LOGINS),
    },
    telegram: {
      clientToken: env.TELEGRAM_CLIENT_BOT_TOKEN || "",
      adminToken: env.TELEGRAM_ADMIN_BOT_TOKEN || "",
      clientBotName: env.TELEGRAM_CLIENT_BOT_NAME || "",
      adminBotName: env.TELEGRAM_ADMIN_BOT_NAME || "",
    },
    adminBootstrapIds: liste(env.ADMIN_BOOTSTRAP_IDS).map(Number).filter(n => Number.isSafeInteger(n) && n > 0),
    nodeRedUrl: (env.NODE_RED_INTERNAL_URL || "http://mobilab-nodered:1880/ttn/v3").replace(/\/$/, ""),
    catalogueDir: env.CATALOGUE_DIR || path.join(racine, "catalogue"),
    ingestDir: env.INGEST_DIR || path.join(racine, "ingest"),
    port: Number(env.PORT || 8080),
    version: env.GIT_COMMIT || "dev",
    fuseau: "Europe/Paris",
  };
}

/** Ce qui manque pour que chaque partie marche ; affiché dans /etat et au démarrage, sans valeur secrète. */
export function manques(c: Config): string[] {
  const m: string[] = [];
  if (!c.databaseUrl && !process.env.PGPASSWORD) m.push("DATABASE_URL ou PGPASSWORD");
  if (!c.secretsKey) m.push("SECRETS_KEY");
  if (!c.telegram.clientToken) m.push("TELEGRAM_CLIENT_BOT_TOKEN");
  if (!c.telegram.adminToken) m.push("TELEGRAM_ADMIN_BOT_TOKEN");
  if (!c.ttn.host) m.push("TTN_HOST");
  if (!c.ttn.apiKey) m.push("TTN_API_KEY");
  if (!c.ttn.webhookUrl) m.push("TTN_WEBHOOK_URL");
  if (!c.ttn.webhookSecret) m.push("TTN_WEBHOOK_SECRET");
  if (!c.grafana.user || !c.grafana.password) m.push("GRAFANA_ADMIN_USER / GRAFANA_ADMIN_PASSWORD");
  if (!c.adminBootstrapIds.length) m.push("ADMIN_BOOTSTRAP_IDS");
  return m;
}
