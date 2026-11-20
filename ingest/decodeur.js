"use strict";
// Exécution des décodeurs officiels dans un bac à sable vm, limité à 50 ms (spec V3 §7.3, étape 8).
// Deux signatures existent : decodeUplink(input) et l'ancienne Decoder(bytes, port) (§7.1).
const fs = require("fs");
const vm = require("vm");

const cache = new Map();   // chemin -> { script, appel, mtime }

// Un contexte neuf à chaque trame : certains décodeurs officiels gardent des variables globales
// d'un appel à l'autre (vu sur CPL03-LB), ce qui fausserait la trame suivante d'un autre capteur.
function nouveauContexte(script) {
    const ctx = vm.createContext({});
    script.runInContext(ctx, { timeout: 50 });
    return ctx;
}

function charger(chemin) {
    const mtime = fs.statSync(chemin).mtimeMs;
    const deja = cache.get(chemin);
    if (deja && deja.mtime === mtime) return deja;
    const source = fs.readFileSync(chemin, "utf8");
    const script = new vm.Script(source, { filename: chemin });
    const ctx = nouveauContexte(script);
    let appel;
    if (vm.runInContext("typeof decodeUplink", ctx) === "function") appel = "decodeUplink(__entree)";
    else if (vm.runInContext("typeof Decoder", ctx) === "function") appel = "Decoder(__entree.bytes, __entree.fPort)";
    else if (vm.runInContext("typeof Decode", ctx) === "function") appel = "Decode(__entree.fPort, __entree.bytes)";
    else throw new Error(`aucune fonction de décodage dans ${chemin}`);
    const entree = { script, appel, mtime, signature: appel.split("(")[0] };
    cache.set(chemin, entree);
    return entree;
}

/**
 * Décode une trame. Renvoie un objet simple (copié hors du bac à sable), ou lève une erreur
 * (décodeur qui plante, dépasse 50 ms, ou ne rend rien).
 */
function decoder(chemin, octets, fPort) {
    const d = charger(chemin);
    const ctx = nouveauContexte(d.script);
    ctx.__entree = { bytes: Array.from(octets), fPort };
    const brut = vm.runInContext(`JSON.stringify(${d.appel})`, ctx, { timeout: 50 });
    if (brut === undefined) throw new Error("décodeur sans résultat");
    let res = JSON.parse(brut);
    if (d.signature === "decodeUplink") {
        if (!res || (res.errors && res.errors.length && !res.data)) {
            throw new Error(`décodeur : ${(res && res.errors && res.errors.join(", ")) || "aucune donnée"}`);
        }
        res = res.data;
    }
    if (!res || typeof res !== "object" || Array.isArray(res) || Object.keys(res).length === 0) {
        throw new Error("décodeur : résultat vide");
    }
    return res;
}

/** Décode avec la source choisie : un décodeur officiel (fichier JS) ou la trame décrite d'un montage Mobilab. */
function decoderSource(source, octets, fPort) {
    if (source.trame) return require("./trame").decoderTrame(source.trame, octets, fPort);
    return decoder(source.chemin, octets, fPort);
}

module.exports = { decoder, decoderSource, charger };
