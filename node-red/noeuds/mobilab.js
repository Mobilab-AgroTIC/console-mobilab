// Bloc « Mobilab » : une étape de la réception V3, choisie dans une liste (Recevoir, Décoder, Enregistrer…).
// Aucune logique ici : les étapes sont dans ingest/noeud-red.js et ingest/index.js, testées avec le module.
const path = require("path");

module.exports = function (RED) {
    const dossier = process.env.INGEST_DIR || "/mobilab-ingest";
    let etapes = null;
    try { etapes = require(path.join(dossier, "noeud-red.js")); } catch (e) {
        RED.log.error(`[mobilab] module ingest introuvable dans ${dossier} : ${e.message}`);
    }

    // Liste des étapes pour l'éditeur (nom, groupe, aide).
    RED.httpAdmin.get("/mobilab/etapes", RED.auth.needsPermission("flows.read"), (req, res) => {
        res.json(etapes ? etapes.ETAPES : []);
    });

    function Mobilab(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.on("input", async (msg, send, done) => {
            try {
                if (!etapes) throw new Error("module ingest introuvable");
                const ing = node.context().global.get("ingest");
                const r = await etapes.executer(ing, config.etape, msg, { env: process.env });
                node.status(r.statut);
                send(msg);
                if (r.ensuite) {
                    r.ensuite.then(s => node.status(s)).catch(e => {
                        node.status({ fill: "red", shape: "dot", text: String(e.message).slice(0, 60) });
                        node.error(e.message);
                    });
                }
                done();
            } catch (e) {
                node.status({ fill: "red", shape: "dot", text: String(e.message).slice(0, 60) });
                done(e);
            }
        });
    }
    RED.nodes.registerType("mobilab", Mobilab);
};
