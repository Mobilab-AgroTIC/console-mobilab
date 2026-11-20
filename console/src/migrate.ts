// Commande migrate (spec V3 §11.8) : applique db/migrations/*.sql dans l'ordre, une fois chacune, en
// superutilisateur ; puis pose les mots de passe des comptes techniques depuis l'environnement (vérificateur SCRAM :
// le mot de passe en clair ne passe jamais dans une requête).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { racineDepot } from "./config.js";
import { verificateurScram } from "./crypto.js";

async function principal() {
  // Compte superutilisateur : MIGRATE_DATABASE_URL, sinon les variables PGHOST, PGUSER, PGPASSWORD, PGDATABASE.
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url && !process.env.PGPASSWORD) throw new Error("MIGRATE_DATABASE_URL ou PGHOST/PGUSER/PGPASSWORD manquants (superutilisateur)");
  const dir = process.env.MIGRATIONS_DIR || path.join(racineDepot(), "db", "migrations");
  const c = new pg.Client({ ...(url ? { connectionString: url } : {}), application_name: "mobilab-migrate" });
  await c.connect();
  try {
    const existe = (await c.query(`SELECT to_regclass('app.schema_migrations') IS NOT NULL AS ok`)).rows[0].ok;
    const faites = new Set<string>(existe ? (await c.query(`SELECT version FROM app.schema_migrations`)).rows.map(r => r.version) : []);
    for (const fichier of fs.readdirSync(dir).filter(f => /^\d{3}_.+\.sql$/.test(f)).sort()) {
      const version = fichier.replace(/\.sql$/, "");
      if (faites.has(version)) continue;
      console.log(`migration ${version}…`);
      await c.query("BEGIN");
      try {
        await c.query(fs.readFileSync(path.join(dir, fichier), "utf8"));
        await c.query(`INSERT INTO app.schema_migrations (version) VALUES ($1)`, [version]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    }
    for (const [role, variable] of [["mobilab_owner", "PG_OWNER_PASSWORD"], ["svc_nodered", "PG_SVC_NODERED_PASSWORD"], ["svc_console", "PG_SVC_CONSOLE_PASSWORD"]]) {
      const mdp = process.env[variable];
      if (!mdp) { console.log(`${role} : ${variable} absent, compte laissé sans connexion`); continue; }
      const v = verificateurScram(mdp);
      if (!/^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(v)) throw new Error("vérificateur inattendu");
      await c.query(`ALTER ROLE ${role} LOGIN PASSWORD '${v}'`);
      console.log(`${role} : mot de passe posé`);
    }
    console.log("migrations à jour");
  } finally {
    await c.end();
  }
}

principal().catch(e => { console.error(`migrate : ${e?.message || e}`); process.exit(1); });
