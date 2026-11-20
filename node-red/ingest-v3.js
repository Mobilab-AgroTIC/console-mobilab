// Charge le module ingest/ de la V3 pour les flows (spec §7.3 : « Node-RED le charge par functionGlobalContext »).
// Sans configuration V3 (PG_SVC_NODERED_PASSWORD absent), ou si le module manque, renvoie null :
// Node-RED démarre quand même et la V2 continue sans rien remarquer.
module.exports = function chargerIngest() {
    const dossier = process.env.INGEST_DIR || "/mobilab-ingest";
    if (!process.env.PG_SVC_NODERED_PASSWORD) {
        console.log("[mobilab V3] PG_SVC_NODERED_PASSWORD absent : réception V3 inactive");
        return null;
    }
    try {
        const { Pool } = require(require.resolve("pg", { paths: [dossier] }));
        const ingest = require(dossier);
        const pool = new Pool({
            host: process.env.PG_HOST || "mobilab-postgres",
            database: process.env.PG_DATABASE || "mobilab",
            user: process.env.PG_USER || "svc_nodered",
            password: process.env.PG_SVC_NODERED_PASSWORD,
            max: 5,
            application_name: "mobilab-nodered-v3",
        });
        pool.on("error", e => console.error(`[mobilab V3] postgres : ${e.message}`));
        const instance = ingest.creer({
            pool,
            catalogueDir: process.env.CATALOGUE_DIR || "/mobilab-catalogue",
            spoolDir: process.env.SPOOL_DIR || "/data/spool",
            env: process.env,
            log: { info: m => console.log(`[mobilab V3] ${m}`), warn: m => console.warn(`[mobilab V3] ${m}`), error: m => console.error(`[mobilab V3] ${m}`) },
        });
        console.log(`[mobilab V3] module ingest chargé, catalogue ${instance.catalogue.version}`);
        return instance;
    } catch (e) {
        console.error(`[mobilab V3] module ingest non chargé : ${e.message}`);
        return null;
    }
};
