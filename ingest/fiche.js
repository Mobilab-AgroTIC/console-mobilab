"use strict";
// Ajouter ou modifier un capteur depuis Node-RED (page « V3 · Catalogue ») : la fiche YAML, son décodeur
// et ses trames d'essai sont d'abord essayés dans une copie du catalogue (contrôle complet + décodage des
// essais). Rien n'est écrit dans le vrai catalogue tant que tout ne passe pas, et sans « publier ».
const fs = require("fs");
const os = require("os");
const path = require("path");
const YAML = require("yaml");
const catalogueLib = require("./catalogue");
const N = require("./normaliser");
const { decoderSource } = require("./decodeur");

const proche = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

/** Décode une trame d'essai ({nom, f_port, hex, attendu, absent, mode_force, probes}) et la compare à l'attendu. */
function essayerCas(cat, modele, cas) {
    const r = { nom: cas.nom || `port ${cas.f_port}`, ok: true, problemes: [] };
    try {
        const brut = Buffer.from(String(cas.hex || "").replace(/\s/g, ""), "hex");
        const octets = N.forcerMode(modele, brut, cas.mode_force || null);
        const decode = decoderSource(modele.sources[modele.sources.length - 1], octets, Number(cas.f_port));
        const norm = N.normaliser(cat, modele, decode, { fPort: Number(cas.f_port), octets: brut, probes: cas.probes || {},
            modeForce: cas.mode_force || null, detected: {}, time: new Date().toISOString() });
        r.decode = decode;
        r.mesures = norm.mesures;
        for (const [k, v] of Object.entries(cas.attendu || {})) {
            if (norm.mesures[k] === undefined) r.problemes.push(`${k} absent`);
            else if (!proche(norm.mesures[k], v)) r.problemes.push(`${k} = ${norm.mesures[k]}, attendu ${v}`);
        }
        for (const k of cas.absent || []) if (norm.mesures[k] !== undefined) r.problemes.push(`${k} ne devrait pas être là`);
    } catch (e) {
        r.problemes.push(`décodage : ${e.message}`);
    }
    r.ok = r.problemes.length === 0;
    return r;
}

function versionSuivante(v) {
    return /^\d+$/.test(v) ? String(Number(v) + 1) : `${v}.1`;
}

/**
 * Essaie une fiche, et la publie si `publier` et si tout passe.
 * Entrée : { fiche: texte YAML, decodeur?: texte JS, essais?: texte YAML (liste de trames), publier?: booléen }.
 * Renvoie { ok, publie, cle, marque, fichiers, erreurs, essais, version? }.
 */
function ficheCapteur(catalogueDir, { fiche, decodeur, essais, publier } = {}) {
    const res = { ok: false, publie: false, cle: null, marque: null, fichiers: [], erreurs: [], essais: [] };
    let doc;
    try { doc = YAML.parse(String(fiche || "")); } catch (e) {
        res.erreurs.push(`fiche : YAML illisible (${e.message.split("\n")[0]})`);
        return res;
    }
    if (!doc || typeof doc !== "object" || !doc.cle || !doc.marque) {
        res.erreurs.push("fiche : « cle » et « marque » sont obligatoires");
        return res;
    }
    res.cle = doc.cle;
    const dossier = catalogueLib.dossierMarque(doc.marque);
    res.marque = dossier;
    const aEcrire = [[path.join("modeles", dossier, `${doc.cle}.yaml`), String(fiche)]];
    const jsDecodeur = String(decodeur || "").trim();
    if (jsDecodeur) {
        const chemin = ((doc.decodeurs || [])[0] || {}).fichier;
        if (!chemin) res.erreurs.push("décodeur fourni, mais la fiche n'a pas de « decodeurs: - fichier: … »");
        else if (!chemin.startsWith(`decodeurs/${dossier}/`) || !chemin.endsWith(".js") || chemin.includes("..")) {
            res.erreurs.push(`décodeur : le fichier doit être decodeurs/${dossier}/<nom>.js`);
        } else aEcrire.push([chemin, jsDecodeur + "\n"]);
    }
    let cas = [];
    const texteEssais = String(essais || "").trim();
    if (texteEssais) {
        try { cas = YAML.parse(texteEssais); } catch (e) { res.erreurs.push(`trames d'essai : YAML illisible (${e.message.split("\n")[0]})`); }
        if (!Array.isArray(cas)) { res.erreurs.push("trames d'essai : une liste (- nom: …, f_port: …, hex: …)"); cas = []; }
        aEcrire.push([path.join("tests", dossier, `${doc.cle}.yaml`), texteEssais + "\n"]);
    } else {
        res.erreurs.push("trames d'essai : au moins une, pour vérifier le décodage");
    }
    res.fichiers = aEcrire.map(([f]) => f);
    if (res.erreurs.length) return res;

    // Essai dans une copie du catalogue : le vrai n'est pas touché.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fiche-"));
    try {
        fs.cpSync(catalogueDir, tmp, { recursive: true });
        for (const [f, texte] of aEcrire) {
            fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
            fs.writeFileSync(path.join(tmp, f), texte);
        }
        let cat;
        try { cat = catalogueLib.charger(tmp); } catch (e) {
            res.erreurs.push(String(e.message).split(tmp).join("catalogue"));
            return res;
        }
        const modele = cat.modeles.get(doc.cle);
        res.essais = cas.map(c => essayerCas(cat, modele, c));
        for (const e of res.essais.filter(x => !x.ok)) res.erreurs.push(`essai « ${e.nom} » : ${e.problemes.join(", ")}`);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    res.ok = res.erreurs.length === 0;
    if (!publier || !res.ok) return res;
    if (/^exemple/.test(doc.cle)) {
        res.ok = false;
        res.erreurs.push("c'est la fiche d'exemple : remplacez-la par celle de votre capteur avant de publier");
        return res;
    }
    // Publication : les fichiers, puis VERSION (la console et Node-RED rechargent le catalogue).
    res.remplace = fs.existsSync(path.join(catalogueDir, aEcrire[0][0]));
    for (const [f, texte] of aEcrire) {
        fs.mkdirSync(path.dirname(path.join(catalogueDir, f)), { recursive: true });
        fs.writeFileSync(path.join(catalogueDir, f), texte);
    }
    const fv = path.join(catalogueDir, "VERSION");
    const avant = fs.existsSync(fv) ? fs.readFileSync(fv, "utf8").trim() : "0";
    res.version = versionSuivante(avant);
    fs.writeFileSync(fv, res.version + "\n");
    res.publie = true;
    return res;
}

module.exports = { ficheCapteur, essayerCas };
