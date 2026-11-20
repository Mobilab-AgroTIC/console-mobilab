"use strict";
// Le bloc « Mobilab » de Node-RED (node-red/noeuds/mobilab.*) : une étape du module, choisie dans une liste.
// Ici : la liste des étapes (nom, aide), ce que chacune lit et écrit dans le message, et le résumé
// affiché sous le bloc. Le bloc lui-même ne contient aucune logique.
//
// Le message transporte « msg.trame » d'une étape à l'autre : on peut l'afficher (nœud debug), la détourner
// vers un autre traitement, ou la réinjecter à l'étape suivante.

const ETAPES = [
    { groupe: "Trames des capteurs", cle: "recevoir_uplink", libelle: "Recevoir une trame",
        aide: "Entrée : msg.payload = message de TTN (webhook uplink), msg.req = la requête.\n" +
            "Vérifie le secret, lit la trame, cherche le capteur, écrit la trame brute (ou le fichier de secours si la base est absente).\n" +
            "Sortie : msg.statusCode (réponse à TTN, à envoyer tout de suite), msg.trame.suite (à traiter ?) et msg.trame.raison (pourquoi on s'arrête)." },
    { groupe: "Trames des capteurs", cle: "identifier", libelle: "Identifier le modèle",
        aide: "Modèle déclaré, ou reconnu dans la trame (port 5 Dragino, fiche Mobilab du port 10, version_ids).\n" +
            "Sortie : msg.trame.modele (null si inconnu), msg.trame.identifie_par." },
    { groupe: "Trames des capteurs", cle: "modele_inconnu", libelle: "Noter un modèle inconnu",
        aide: "Trame notée « modèle inconnu », le client est invité à choisir le modèle, les admins sont prévenus une fois." },
    { groupe: "Trames des capteurs", cle: "decoder", libelle: "Décoder",
        aide: "Décodeur officiel du modèle (catalogue/decodeurs) ou trame Mobilab décrite dans la fiche.\n" +
            "Sortie : msg.trame.decode (ce que rend le décodeur) ou msg.trame.erreur_decodage." },
    { groupe: "Trames des capteurs", cle: "erreur_decodage", libelle: "Noter l'erreur de décodage",
        aide: "Erreur écrite avec la trame brute ; anomalie pour les admins si le port porte des mesures." },
    { groupe: "Trames des capteurs", cle: "normaliser", libelle: "Normaliser (catalogue)",
        aide: "Des champs du décodeur aux mesures de la fiche : noms, unités, facteurs, valeurs ignorées, sondes, pile, mode.\n" +
            "Sortie : msg.trame.mesures, msg.trame.batterie_mv, msg.trame.last_values.resume." },
    { groupe: "Trames des capteurs", cle: "enregistrer", libelle: "Enregistrer en base",
        aide: "En une seule fois : trame décodée, mesures, état du capteur, première mesure, messages pour la console.\n" +
            "Sortie : msg.trame.premiere, msg.trame.alertes_a_evaluer." },
    { groupe: "Trames des capteurs", cle: "alertes", libelle: "Évaluer les alertes",
        aide: "Règles d'alerte du capteur (seuils, pile, état…) ; écrit les alertes à envoyer.\nSortie : msg.trame.alertes (combien)." },
    { groupe: "Trames des capteurs", cle: "expedier", libelle: "Envoyer les alertes (Telegram)",
        aide: "Envoie les alertes prêtes aux membres de la ferme (1 message par seconde au plus).\nSortie : msg.envoyees." },
    { groupe: "Trames des capteurs", cle: "noter_erreur", libelle: "Noter une erreur",
        aide: "À brancher derrière un nœud « catch » : compte l'erreur pour la santé et l'écrit dans le journal." },
    { groupe: "Connexions et commandes", cle: "recevoir_join", libelle: "Recevoir une connexion (join)",
        aide: "Webhook « join accept » de TTN : le capteur passe « connecté ». Sortie : msg.statusCode." },
    { groupe: "Connexions et commandes", cle: "recevoir_downlink", libelle: "Recevoir le suivi d'une commande",
        aide: "Webhooks downlink de TTN (envoyée, confirmée, échec) : met à jour la commande et prévient la console. Sortie : msg.statusCode." },
    { groupe: "Tâches", cle: "recharger_catalogue", libelle: "Recharger le catalogue",
        aide: "Relit le catalogue si son fichier VERSION a changé (fiche ajoutée ou modifiée)." },
    { groupe: "Tâches", cle: "chercher_muets", libelle: "Chercher les capteurs muets",
        aide: "Capteurs sans nouvelles depuis 3 intervalles (3 h au moins) : alerte « pas de nouvelles »." },
    { groupe: "Tâches", cle: "fins_de_coupure", libelle: "Fins de coupure et rappels",
        aide: "Alertes coupées dont la coupure est finie : un rappel si l'alerte dure encore." },
    { groupe: "Tâches", cle: "rejouer_spool", libelle: "Rejouer le fichier de secours",
        aide: "Trames reçues pendant une panne de la base : traitées dans l'ordre, avec les mêmes étapes." },
    { groupe: "Tâches", cle: "relances_7_jours", libelle: "Relances (muets 7 jours, piles)",
        aide: "Chaque jour : relance des capteurs muets depuis 7 jours, rappel hebdomadaire des piles à changer." },
    { groupe: "Tâches", cle: "purge_nocturne", libelle: "Purger les vieilles alertes",
        aide: "Efface les alertes envoyées il y a plus d'un an." },
    { groupe: "Supervision", cle: "sante", libelle: "Santé de la réception",
        aide: "Pour la console : dernière trame, compteurs, fichier de secours, catalogue. Vérifie l'en-tête secret si msg.req existe." },
    { groupe: "Supervision", cle: "redecoder", libelle: "Redécoder un capteur",
        aide: "msg.payload = { dev_eui, depuis } : redécode ses trames depuis cette date (après un changement de fiche).\n" +
            "Depuis un webhook : répond 202 tout de suite et travaille ensuite. Depuis un inject : msg.payload = nombre de trames." },
    { groupe: "Catalogue", cle: "essayer_trame", libelle: "Décoder une trame d'essai",
        aide: "msg.payload = { modele, f_port, hex } : décode et normalise, sans rien écrire en base.\nSortie : msg.payload = mesures, résumé, sortie du décodeur." },
    { groupe: "Catalogue", cle: "fiche_capteur", libelle: "Essayer ou publier une fiche",
        aide: "msg.fiche = fiche YAML, msg.decodeur = décodeur JS (facultatif), msg.essais = trames d'essai (YAML), msg.publier = true pour publier.\n" +
            "La fiche est essayée dans une copie du catalogue ; publiée seulement si tout passe. Sortie : msg.payload = le compte rendu." },
    { groupe: "Catalogue", cle: "lister_catalogue", libelle: "Lister le catalogue",
        aide: "msg.payload = les modèles du catalogue, par marque." },
];
const PAR_CLE = new Map(ETAPES.map(e => [e.cle, e]));

const heure = () => new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const vert = texte => ({ fill: "green", shape: "dot", text: `${heure()} ${texte}` });
const jaune = texte => ({ fill: "yellow", shape: "ring", text: `${heure()} ${texte}` });
const gris = texte => ({ fill: "grey", shape: "ring", text: `${heure()} ${texte}` });
const rouge = texte => ({ fill: "red", shape: "dot", text: `${heure()} ${String(texte).slice(0, 60)}` });
const court = s => (String(s || "").length > 50 ? `${String(s).slice(0, 49)}…` : String(s || ""));
const nomDe = t => (t && t.capteur && t.capteur.name) || (t && t.u && t.u.devEui) || "?";

function secretOk(msg, env) {
    if (!msg.req) return true;                    // inject depuis l'éditeur : pas de secret
    const s = env.TTN_WEBHOOK_SECRET;
    return Boolean(s) && (msg.req.headers || {})["x-mobilab-secret"] === s;
}

function trameRequise(msg) {
    if (!msg.trame || msg.trame.type !== "uplink") throw new Error("msg.trame manquant : brancher après « Recevoir une trame »");
    return msg.trame;
}

/**
 * Exécute une étape sur le message. Renvoie { statut, ensuite? } : statut = état affiché sous le bloc,
 * ensuite = promesse d'un nouvel état pour un travail qui continue après l'envoi (redécodage).
 */
async function executer(ing, etape, msg, { env = process.env } = {}) {
    if (!PAR_CLE.has(etape)) throw new Error(`étape inconnue : ${etape}`);
    const reponseHttp = ["recevoir_uplink", "recevoir_join", "recevoir_downlink", "sante", "redecoder"].includes(etape);
    if (!ing) {
        if (reponseHttp && msg.req) { msg.statusCode = 503; msg.payload = ""; return { statut: rouge("réception V3 inactive") }; }
        throw new Error("module ingest absent (PG_SVC_NODERED_PASSWORD manquant ?)");
    }
    const E = ing.etapes;
    switch (etape) {
        case "recevoir_uplink": {
            const t = await E.recevoir(msg.payload, (msg.req || {}).headers);
            msg.trame = t;
            msg.statusCode = t.statut;
            msg.payload = "";
            if (t.statut !== 200) return { statut: rouge(`${t.statut} : ${t.raison}`) };
            return { statut: t.suite ? vert(`${nomDe(t)} · port ${t.u.fPort}`) : gris(`${nomDe(t)} : ${court(t.raison)}`) };
        }
        case "identifier": {
            const t = E.identifier(trameRequise(msg));
            return { statut: t.modele ? vert(`${nomDe(t)} · ${t.modele}`) : jaune(`${nomDe(t)} : modèle inconnu`) };
        }
        case "modele_inconnu": {
            const t = await E.modeleInconnu(trameRequise(msg));
            return { statut: jaune(`${nomDe(t)} : modèle à choisir`) };
        }
        case "decoder": {
            const t = E.decoder(trameRequise(msg));
            return { statut: t.erreur_decodage === null ? vert(`${nomDe(t)} · ${court(t.decodeur)}`) : rouge(`${nomDe(t)} : ${t.erreur_decodage}`) };
        }
        case "erreur_decodage": {
            const t = await E.erreurDecodage(trameRequise(msg));
            return { statut: jaune(`${nomDe(t)} : erreur notée`) };
        }
        case "normaliser": {
            const t = E.normaliser(trameRequise(msg));
            const resume = t.last_values && t.last_values.resume;
            const n = Object.keys(t.mesures || {}).length;
            return { statut: vert(`${nomDe(t)} · ${resume ? court(resume) : `${n} valeur${n > 1 ? "s" : ""} (${t.role || "port ignoré"})`}`) };
        }
        case "enregistrer": {
            const t = await E.enregistrer(trameRequise(msg));
            return { statut: vert(`${nomDe(t)} enregistrée${t.premiere ? " (première mesure)" : ""}`) };
        }
        case "alertes": {
            const t = await E.alertes(trameRequise(msg));
            return { statut: t.alertes ? jaune(`${nomDe(t)} : ${t.alertes} alerte${t.alertes > 1 ? "s" : ""} à envoyer`) : vert(`${nomDe(t)} : rien à signaler`) };
        }
        case "expedier": {
            msg.envoyees = await ing.expedier();
            return { statut: msg.envoyees ? jaune(`${msg.envoyees} alerte${msg.envoyees > 1 ? "s" : ""} envoyée${msg.envoyees > 1 ? "s" : ""}`) : gris("rien à envoyer") };
        }
        case "noter_erreur": {
            const e = msg.error || {};
            E.noterErreur(msg.trame, { message: e.message || String(e), stack: e.stack });
            const ou = (e.source && e.source.name) || (e.source && e.source.type) || "?";
            return { statut: rouge(`${nomDe(msg.trame)} : ${ou} : ${e.message || e}`) };
        }
        case "recevoir_join":
        case "recevoir_downlink": {
            const r = etape === "recevoir_join" ? await ing.recevoirJoin(msg.payload, (msg.req || {}).headers)
                : await ing.recevoirDownlink(msg.payload, (msg.req || {}).headers);
            const qui = ((msg.payload || {}).end_device_ids || {}).device_id || "?";
            msg.statusCode = r.statut;
            msg.payload = "";
            return { statut: r.statut === 200 ? vert(`${qui}${r.spool ? " (fichier de secours)" : ""}`) : rouge(`${r.statut} : ${qui}`) };
        }
        case "recharger_catalogue": {
            const change = ing.rechargerCatalogue();
            msg.payload = { catalogue: ing.catalogue.version, recharge: change };
            const err = ing.sante().catalogue_erreur;
            if (err) return { statut: rouge(`catalogue refusé : ${err}`) };
            return { statut: change ? jaune(`catalogue ${ing.catalogue.version} chargé`) : gris(`catalogue ${ing.catalogue.version}`) };
        }
        case "chercher_muets":
        case "fins_de_coupure":
        case "rejouer_spool":
        case "relances_7_jours":
        case "purge_nocturne": {
            const f = { chercher_muets: ing.chercherMuets, fins_de_coupure: ing.finsDeCoupure, rejouer_spool: ing.rejouerSpool,
                relances_7_jours: ing.relances7Jours, purge_nocturne: ing.purgeNocturne }[etape];
            const n = await f();
            msg.payload = { [etape]: n };
            return { statut: n ? jaune(`${n}`) : gris("rien") };
        }
        case "sante": {
            if (!secretOk(msg, env)) { msg.statusCode = 401; msg.payload = ""; return { statut: rouge("401 : secret absent ou faux") }; }
            msg.payload = ing.sante();
            msg.statusCode = 200;
            return { statut: msg.payload.ok ? vert(`${msg.payload.recues} trames reçues`) : rouge(msg.payload.catalogue_erreur || "catalogue refusé") };
        }
        case "redecoder": {
            if (!secretOk(msg, env)) { msg.statusCode = 401; msg.payload = ""; return { statut: rouge("401 : secret absent ou faux") }; }
            const { dev_eui, depuis } = msg.payload || {};
            if (!/^[0-9a-f]{16}$/.test(String(dev_eui || ""))) {
                if (msg.req) { msg.statusCode = 400; msg.payload = ""; return { statut: rouge("400 : dev_eui (16 caractères hexa, minuscules)") }; }
                throw new Error("msg.payload.dev_eui : 16 caractères hexadécimaux, en minuscules");
            }
            if (msg.req) {
                msg.statusCode = 202;
                msg.payload = "";
                const ensuite = ing.redecoder(dev_eui, depuis).then(n => vert(`${dev_eui} : ${n} trames redécodées`));
                return { statut: gris(`${dev_eui} : en cours`), ensuite };
            }
            const n = await ing.redecoder(dev_eui, depuis);
            msg.payload = { dev_eui, trames: n };
            return { statut: vert(`${dev_eui} : ${n} trames redécodées`) };
        }
        case "essayer_trame": {
            msg.payload = ing.essayerTrame(msg.payload || {});
            return { statut: vert(court(`${msg.payload.modele} : ${msg.payload.resume || JSON.stringify(msg.payload.mesures)}`)) };
        }
        case "fiche_capteur": {
            const r = ing.ficheCapteur({ fiche: msg.fiche, decodeur: msg.decodeur, essais: msg.essais, publier: msg.publier === true });
            msg.payload = r;
            if (r.publie) return { statut: vert(`${r.cle} publiée (catalogue ${r.version})`) };
            if (!r.ok) return { statut: rouge(`${r.cle || "fiche"} : ${r.erreurs[0]}`) };
            return { statut: jaune(`${r.cle} : essais OK, pas encore publiée`) };
        }
        case "lister_catalogue": {
            msg.payload = ing.listerCatalogue();
            return { statut: gris(`${msg.payload.modeles} modèles (catalogue ${msg.payload.version})`) };
        }
        default:
            throw new Error(`étape non prise en charge : ${etape}`);
    }
}

module.exports = { ETAPES, executer };
