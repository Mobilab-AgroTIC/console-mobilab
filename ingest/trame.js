"use strict";
// Trames des montages Mobilab, lues d'après leur fiche du catalogue (section « trame »), sans décodeur JS.
// Format décrit pour ceux qui programment les cartes dans catalogue/trame-mobilab.md.
//
//  - format « mobilab » :
//      port 10 (fiche)   : AA, type du montage, version du programme, pile en mV (2 octets)
//      port 11 (mesures) : pile en mV (2 octets), puis les champs, dans l'ordre du catalogue
//  - format « libre » : un port, des champs dans l'ordre (cartes d'avant ce format, pile comprise).
//
// Champ : 1, 2 ou 4 octets, poids fort en premier, signé sauf « signe: false ».
// Valeur absente : 7FFF (2 octets), 7FFFFFFF (4 octets), ou la valeur « absent » du champ.

const MARQUE = 0xaa;
const PORT_FICHE = 10;
const PORT_MESURES = 11;
const ABSENT = { 2: 0x7fff, 4: 0x7fffffff };

function lireEntier(octets, i, n, signe) {
    if (i + n > octets.length) return undefined;
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + octets[i + k];
    if (signe && v >= 2 ** (8 * n - 1)) v -= 2 ** (8 * n);
    return v;
}

/** Lit les champs à partir de `debut`. Une trame plus courte laisse les champs suivants de côté. */
function lireChamps(champs, octets, debut) {
    const res = {};
    let i = debut;
    for (const c of champs) {
        const n = c.octets ?? 2;
        const brut = lireEntier(octets, i, n, false);
        if (brut === undefined) break;
        const absent = c.absent ?? ABSENT[n];
        res[c.cle] = absent !== undefined && brut === absent ? null : lireEntier(octets, i, n, c.signe !== false);
        i += n;
    }
    return res;
}

/** La trame est-elle une fiche Mobilab (port 10, commence par AA) ? Renvoie le type, sinon null. */
function typeFiche(fPort, octets) {
    return fPort === PORT_FICHE && octets.length >= 2 && octets[0] === MARQUE ? octets[1] : null;
}

/** Décode une trame d'un montage. Lève une erreur si elle ne suit pas le format attendu. */
function decoderTrame(trame, octets, fPort) {
    const o = Array.from(octets);
    if (trame.format === "mobilab") {
        if (fPort === PORT_FICHE) {
            if (o.length < 5 || o[0] !== MARQUE) throw new Error("fiche Mobilab : AA, type, version, pile (5 octets)");
            if (o[1] !== trame.type) throw new Error(`fiche Mobilab : type ${o[1]}, attendu ${trame.type}`);
            return { type: o[1], version: o[2], pile_mv: lireEntier(o, 3, 2, false) };
        }
        if (fPort === (trame.port ?? PORT_MESURES)) {
            if (o.length < 2) throw new Error("trame Mobilab : pile manquante");
            return { pile_mv: lireEntier(o, 0, 2, false), ...lireChamps(trame.champs || [], o, 2) };
        }
        throw new Error(`port ${fPort} : ni fiche (10) ni mesures (${trame.port ?? PORT_MESURES})`);
    }
    if (trame.format === "libre") {
        if (fPort !== trame.port) throw new Error(`port ${fPort} : mesures attendues sur le port ${trame.port}`);
        const res = lireChamps(trame.champs || [], o, 0);
        if (!Object.keys(res).length) throw new Error("trame vide");
        return res;
    }
    throw new Error(`format de trame inconnu : ${trame.format}`);
}

/** Ports d'un montage, déduits de sa trame (le YAML n'a pas à les répéter). */
function portsDeTrame(trame) {
    if (trame.format === "mobilab") return { [PORT_FICHE]: "statut", [trame.port ?? PORT_MESURES]: "mesures" };
    return { [trame.port]: "mesures" };
}

/** Vérifie la section « trame » d'un modèle. Renvoie un message d'erreur, ou null. */
function verifierTrame(t) {
    if (!t || typeof t !== "object") return "trame : section attendue";
    if (!["mobilab", "libre"].includes(t.format)) return "trame.format : mobilab ou libre";
    if (t.format === "mobilab" && !(Number.isInteger(t.type) && t.type >= 1 && t.type <= 255)) return "trame.type : entier de 1 à 255";
    if (t.format === "libre" && !(Number.isInteger(t.port) && t.port >= 1 && t.port <= 223)) return "trame.port : port LoRaWAN de 1 à 223";
    if (t.format === "mobilab" && t.port !== undefined && (t.port === PORT_FICHE || !(t.port >= 1 && t.port <= 223))) return "trame.port : de 1 à 223, sauf 10";
    if (!Array.isArray(t.champs) || !t.champs.length) return "trame.champs : liste de champs";
    const vus = new Set(["pile_mv", "type", "version"]);
    for (const c of t.champs) {
        if (!c || !/^[a-z0-9_]{1,30}$/.test(String(c.cle || ""))) return "trame.champs : cle en minuscules, chiffres, _";
        if (vus.has(c.cle)) return `trame.champs : ${c.cle} en double ou réservé`;
        vus.add(c.cle);
        if (c.octets !== undefined && ![1, 2, 4].includes(c.octets)) return `trame.champs ${c.cle} : 1, 2 ou 4 octets`;
    }
    return null;
}

module.exports = { decoderTrame, typeFiche, portsDeTrame, verifierTrame, MARQUE, PORT_FICHE, PORT_MESURES };
