// Console Mobilab : réglages de Node-RED.
//
// Aucun secret ici : le compte de l'éditeur et la clé de chiffrement viennent du .env.
// Les flux sont rangés dans ce dossier du dépôt (monté sur /mobilab) : chaque Deploy
// modifie node-red/flows.json, à commiter. Les identifiants des nœuds, chiffrés avec
// NR_CREDENTIAL_SECRET, vont dans node-red/flows_cred.json (hors git).
// Modules installés et contexte restent dans ./data/node-red (/data).
module.exports = {
    flowFile: '/mobilab/flows.json',
    flowFilePretty: true,
    credentialSecret: process.env.NR_CREDENTIAL_SECRET,

    adminAuth: {
        type: "credentials",
        users: [{
            username: process.env.NR_ADMIN_USER,
            password: process.env.NR_ADMIN_PASS_HASH,
            permissions: "*"
        }]
    },

    uiPort: process.env.PORT || 1880,
    diagnostics: { enabled: true, ui: true },
    runtimeState: { enabled: false, ui: false },
    logging: { console: { level: "info", metrics: false, audit: false } },
    contextStorage: {
        default: { module: "memory" },
        file: { module: "localfilesystem" }
    },
    exportGlobalContextKeys: false,
    externalModules: {},
    editorTheme: {
        theme: "dark",
        palette: {},
        projects: { enabled: false, workflow: { mode: "manual" } },
        codeEditor: { lib: "monaco", options: {} },
        markdownEditor: { mermaid: { enabled: true } },
        multiplayer: { enabled: false }
    },
    functionExternalModules: true,
    functionTimeout: 0,
    // V3 : module ingest/ (secret, décodage, normalisation, alertes), lu par global.get("ingest").
    // Vaut null tant que la V3 n'est pas configurée : la V2 n'en dépend pas.
    functionGlobalContext: { ingest: require("./ingest-v3.js")() },
    debugMaxLength: 1000,
    mqttReconnectTime: 15000,
    serialReconnectTime: 15000
};
