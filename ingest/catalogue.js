"use strict";
// Lecture et contrôle du catalogue (spec V3 §7.8). Aucune donnée de client ici.
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { verifierTrame, portsDeTrame, typeFiche } = require("./trame");

const NOM_MESURE = /^[a-z0-9_]{1,20}$/;
const ROLES_PORT = new Set(["mesures", "statut", "config"]);
const ALERTES = new Set(["seuil", "debit", "etat", "aucune"]);
const TYPES = new Set(["capteur", "interface", "actionneur"]);
const PANNEAUX = new Set(["courbe", "batterie", "radio", "voies"]);
const CONVERSIONS = new Set(["lineaire", "log", "table"]);
// Rangement du choix du type dans le bot quand une marque en a beaucoup (choix du 19/11 : pas de catégorie « sol »).
const CATEGORIES = new Set(["temperature", "niveau", "porte", "autre"]);

/** Dossier d'une marque dans modeles/ : « Dragino » -> dragino, « Makerfabs » -> makerfabs. */
const dossierMarque = m => String(m || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

class ErreurCatalogue extends Error {
    constructor(fichier, message) {
        super(`${fichier} : ${message}`);
        this.fichier = fichier;
    }
}

function lireYaml(fichier) {
    const doc = YAML.parseDocument(fs.readFileSync(fichier, "utf8"), { prettyErrors: true });
    if (doc.errors.length) {
        const e = doc.errors[0];
        const ligne = e.linePos && e.linePos[0] ? `, ligne ${e.linePos[0].line}` : "";
        throw new ErreurCatalogue(fichier, `YAML illisible${ligne} (${e.code})`);
    }
    return doc.toJS();
}

function verifierModele(m, fichier, dir, piles) {
    const err = msg => { throw new ErreurCatalogue(fichier, msg); };
    // Un montage Mobilab décrit sa trame (section « trame ») au lieu d'avoir un décodeur JS.
    for (const champ of ["cle", "marque", "modele", "libelle", "type", "lorawan", ...(m.trame ? [] : ["decodeurs"]), "ports",
        "intervalle_defaut_s", "mesures", "grafana"]) {
        if (m[champ] === undefined) err(`champ « ${champ} » manquant`);
    }
    if (m.trame) {
        const e = verifierTrame(m.trame);
        if (e) err(e);
        if (m.decodeurs) err("trame ou decodeurs, pas les deux");
        const champs = new Set([...(m.trame.champs || []).map(c => c.cle), "pile_mv"]);
        for (const cle of Object.keys(m.mesures)) if (!champs.has(cle)) err(`mesure ${cle} : pas dans trame.champs`);
    }
    if (!/^[a-z0-9-]{3,40}$/.test(m.cle)) err("cle : minuscules, chiffres et tirets");
    if (path.basename(fichier, ".yaml") !== m.cle) err("le nom du fichier doit être <cle>.yaml");
    if (m.prefixe_id !== undefined && !/^[a-z0-9](?:-?[a-z0-9]){1,24}$/.test(String(m.prefixe_id))) err("prefixe_id : minuscules, chiffres, tirets");
    if (!TYPES.has(m.type)) err(`type inconnu : ${m.type}`);
    if (m.categorie !== undefined && !CATEGORIES.has(m.categorie)) err(`categorie : ${[...CATEGORIES].join(", ")}`);
    if (!m.trame) {
        if (!Array.isArray(m.decodeurs) || !m.decodeurs.length) err("decodeurs : liste vide");
        for (const d of m.decodeurs) {
            if (!d.fichier) err("decodeurs : fichier manquant");
            if (!fs.existsSync(path.join(dir, d.fichier))) err(`décodeur introuvable : ${d.fichier}`);
        }
    }
    for (const [port, role] of Object.entries(m.ports)) {
        if (port !== "defaut" && !/^\d+$/.test(port)) err(`ports : ${port} n'est pas un numéro`);
        if (!ROLES_PORT.has(role)) err(`ports : rôle inconnu ${role}`);
    }
    const noms = new Set();
    for (const [cle, def] of Object.entries(m.mesures)) {
        if (!def || !NOM_MESURE.test(def.nom || "")) err(`mesure ${cle} : nom invalide (^[a-z0-9_]{1,20}$)`);
        if (def.alerte && !ALERTES.has(def.alerte)) err(`mesure ${cle} : alerte inconnue ${def.alerte}`);
        if (def.type === "etat" && !def.etats) err(`mesure ${cle} : etats manquants`);
        if (def.couleur !== undefined && !/^(#[0-9a-fA-F]{6}|[a-z-]+)$/.test(String(def.couleur))) err(`mesure ${cle} : couleur, nom Grafana ou #rrggbb`);
        noms.add(def.nom);
    }
    for (const d of m.derivees || []) {
        if (d.type !== "compteur_impulsions") err(`derivee inconnue : ${d.type}`);
        for (const n of [d.volume, d.debit]) if (n && !m.mesures[n]) err(`derivee : mesure ${n} non décrite`);
    }
    if (m.modes) {
        for (const [code, mode] of Object.entries(m.modes)) {
            for (const n of mode.mesures || []) if (!noms.has(n)) err(`mode ${code} : mesure inconnue ${n}`);
            for (const voie of Object.keys(mode.voies || {})) {
                if (!/^[a-z0-9]{1,6}$/.test(voie)) err(`mode ${code} : voie invalide ${voie}`);
                if (!(m.type_voies || {})[voie]) err(`mode ${code} : type de la voie ${voie} manquant`);
            }
        }
    }
    for (const p of (m.grafana && m.grafana.panneaux) || []) {
        if (!PANNEAUX.has(p.type)) err(`panneau inconnu : ${p.type}`);
        for (const n of p.mesures || []) if (!noms.has(n)) err(`panneau : mesure inconnue ${n}`);
    }
    if (m.batterie && !(m.batterie.cle || m.batterie.cle_statut)) err("batterie : cle ou cle_statut");
    if (m.batterie && m.batterie.pile !== undefined) {
        if (!piles.piles[m.batterie.pile]) err(`batterie : pile inconnue ${m.batterie.pile} (voir piles.yaml)`);
        if (m.batterie.faible_mv !== undefined) err("batterie : faible_mv ou pile, pas les deux");
        if (m.batterie.elements !== undefined && !(Number.isInteger(m.batterie.elements) && m.batterie.elements >= 1)) {
            err("batterie : elements, nombre entier de piles en série");
        }
    }
    for (const a of m.actions || []) {
        if (!a.cle || !a.bouton || !Number.isInteger(a.f_port) || !/^([0-9a-fA-F]{2})+$/.test(String(a.payload_hex || ""))) {
            err("actions : cle, bouton, f_port et payload_hex requis");
        }
    }
}

function verifierSonde(cle, s, fichier) {
    const err = msg => { throw new ErreurCatalogue(fichier, `${cle} : ${msg}`); };
    if (!s.libelle || !Array.isArray(s.pour)) err("libelle et pour requis");
    if (s.brut_seulement) return;
    if (!NOM_MESURE.test(s.mesure || "")) err("mesure invalide");
    if (!s.conversion || !CONVERSIONS.has(s.conversion.type)) err("conversion lineaire, log ou table");
}

/** piles.yaml : courbes de décharge par chimie (tension d'un élément en mV → % restant). */
function lirePiles(dir) {
    const fichier = path.join(dir, "piles.yaml");
    const p = fs.existsSync(fichier) ? lireYaml(fichier) || {} : {};
    const err = msg => { throw new ErreurCatalogue(fichier, msg); };
    const piles = { a_changer_pct: p.a_changer_pct ?? 20, piles: p.piles || {} };
    if (!(piles.a_changer_pct > 0 && piles.a_changer_pct < 100)) err("a_changer_pct entre 1 et 99");
    for (const [cle, pile] of Object.entries(piles.piles)) {
        const c = pile && pile.courbe;
        if (!Array.isArray(c) || c.length < 2 || !c.every(pt => Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite))) {
            err(`${cle} : courbe, liste de [mV, %]`);
        }
        if (c[0][1] !== 100 || c[c.length - 1][1] !== 0) err(`${cle} : la courbe va de 100 % à 0 %`);
        for (let i = 1; i < c.length; i++) {
            if (!(c[i][0] < c[i - 1][0] && c[i][1] < c[i - 1][1])) err(`${cle} : tension et % décroissent d'un point à l'autre`);
        }
    }
    return piles;
}

/** Courbe de la pile du modèle (élément × nombre en série) et seuil « à changer » en mV qui en découle. */
function preparerPile(m, piles) {
    const b = m.batterie;
    if (!b || !b.pile) return;
    const n = b.elements || 1;
    b.courbe = piles.piles[b.pile].courbe.map(([mv, pct]) => [mv * n, pct]);
    b.faible_mv = Math.round(mvPourPct(b.courbe, piles.a_changer_pct));
}

function mvPourPct(courbe, pct) {
    for (let i = 1; i < courbe.length; i++) {
        const [mvH, pH] = courbe[i - 1], [mvB, pB] = courbe[i];
        if (pct <= pH && pct >= pB) return mvB + (pct - pB) * (mvH - mvB) / (pH - pB);
    }
    return courbe[courbe.length - 1][0];
}

/** % restant estimé (0 à 100), sans arrondi ; null si le modèle n'a pas de courbe de pile. */
function pourcentageBrut(modele, mv) {
    const c = modele && modele.batterie && modele.batterie.courbe;
    if (!c || mv === null || mv === undefined || !Number.isFinite(Number(mv))) return null;
    const v = Number(mv);
    if (v >= c[0][0]) return 100;
    for (let i = 1; i < c.length; i++) {
        const [mvH, pH] = c[i - 1], [mvB, pB] = c[i];
        if (v >= mvB) return pB + (v - mvB) * (pH - pB) / (mvH - mvB);
    }
    return 0;
}

/** % restant affiché : par pas de 5 (c'est une estimation), jamais 0 tant que le capteur émet. */
function pourcentagePile(modele, mv) {
    const p = pourcentageBrut(modele, mv);
    if (p === null) return null;
    return p > 0 ? Math.max(5, Math.round(p / 5) * 5) : 0;
}

/**
 * Charge tout le catalogue. Lève ErreurCatalogue (avec le fichier en cause) s'il est invalide :
 * l'appelant garde alors l'ancien (spec §7.10).
 */
function charger(dir) {
    const modeles = new Map();
    const parDr = new Map();
    const parPort5 = new Map();
    const parMobilab = new Map();   // type de la fiche Mobilab (port 10, AA <type>) -> cle
    const dossier = path.join(dir, "modeles");
    const piles = lirePiles(dir);
    // Une fiche par modèle, rangée dans le dossier de sa marque : modeles/dragino/dragino-lht52.yaml.
    const fiches = [];
    for (const d of fs.readdirSync(dossier, { withFileTypes: true }).filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        for (const f of fs.readdirSync(path.join(dossier, d.name)).filter(f => f.endsWith(".yaml")).sort()) fiches.push([d.name, f]);
    }
    for (const f of fs.readdirSync(dossier).filter(f => f.endsWith(".yaml"))) {
        throw new ErreurCatalogue(path.join(dossier, f), "à ranger dans le dossier de sa marque (modeles/<marque>/)");
    }
    for (const [sousDossier, f] of fiches) {
        const fichier = path.join(dossier, sousDossier, f);
        const m = lireYaml(fichier);
        if (m && dossierMarque(m.marque) !== sousDossier) {
            throw new ErreurCatalogue(fichier, `marque ${m.marque} : à ranger dans modeles/${dossierMarque(m.marque)}/`);
        }
        if (m && m.trame) {
            // Ports et pile déduits de la trame : le YAML d'un montage reste court.
            if (!m.ports) m.ports = portsDeTrame(m.trame);
            if (m.trame.format === "mobilab") {
                m.batterie = { cle: "pile_mv", cle_statut: "pile_mv", facteur_mv: 1, ...(m.batterie || {}) };
                m.port5 = { cle_firmware: "version", ...(m.port5 || {}) };
            }
        }
        verifierModele(m, fichier, dir, piles);
        preparerPile(m, piles);
        if (modeles.has(m.cle)) throw new ErreurCatalogue(fichier, `cle en double : ${m.cle}`);
        m.dossier = sousDossier;
        m.sources = m.trame ? [{ trame: m.trame }] : m.decodeurs.map(d => ({ ...d, chemin: path.join(dir, d.fichier) }));
        if (m.trame && m.trame.format === "mobilab") {
            if (parMobilab.has(m.trame.type)) throw new ErreurCatalogue(fichier, `trame.type déjà pris : ${m.trame.type}`);
            parMobilab.set(m.trame.type, m.cle);
        }
        modeles.set(m.cle, m);
        for (const id of [m.dr && m.dr.model_id, ...(m.dr_alias || [])].filter(Boolean)) {
            const cle = `${(m.dr && m.dr.brand_id) || m.marque.toLowerCase()}/${id}`;
            if (!parDr.has(cle)) parDr.set(cle, m.cle);
        }
        if (m.port5 && m.port5.code !== undefined) {
            if (parPort5.has(m.port5.code)) throw new ErreurCatalogue(fichier, `port5.code déjà pris : ${m.port5.code}`);
            parPort5.set(Number(m.port5.code), m.cle);
        }
    }
    const fichierSondes = path.join(dir, "sondes.yaml");
    const sondes = fs.existsSync(fichierSondes) ? lireYaml(fichierSondes) || {} : {};
    for (const [cle, s] of Object.entries(sondes)) verifierSonde(cle, s, fichierSondes);
    const version = lireVersion(dir) || "0";
    return { dir, version, modeles, parDr, parPort5, parMobilab, sondes, ordreSondes: Object.keys(sondes), piles };
}

/** Version du catalogue : première ligne de VERSION qui n'est ni vide ni un commentaire « # » (le reste du fichier
 *  est le journal des versions). Quand elle change, la console et Node-RED rechargent le catalogue. null si absent. */
function lireVersion(dir) {
    let texte;
    try { texte = fs.readFileSync(path.join(dir, "VERSION"), "utf8"); } catch { return null; }
    return texte.split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#")) || null;
}

/** Modèle identifié par les version_ids d'un uplink (spec §7.6, cas 3). */
function modeleParVersionIds(cat, v) {
    if (!v || !v.model_id) return null;
    const marque = String(v.brand_id || "").toLowerCase();
    const id = String(v.model_id).toLowerCase();
    return cat.parDr.get(`${marque}/${id}`) || null;
}

/**
 * Identification du modèle d'un capteur (spec §7.6) : model_key, modèle déjà lu, port 5 (Dragino),
 * fiche du port 10 (montage Mobilab : AA puis le type), version_ids. `u` : { fPort, octets, versionIds }.
 */
function identifierModele(cat, dev, u) {
    const det = (dev.config && dev.config.detected) || {};
    const parCle = k => (k && cat.modeles.get(k)) || null;
    let modele = parCle(dev.model_key) || parCle(det.modele_lu);
    let source = dev.model_key ? "model_key" : det.modele_lu ? "detecte" : null;
    let lu = null;
    if (u.fPort === 5 && u.octets.length) {
        const k = cat.parPort5.get(u.octets[0]);
        if (k) lu = { cle: k, par: "port5" };
    }
    const tf = typeFiche(u.fPort, u.octets);
    if (!lu && tf !== null && cat.parMobilab) {
        const k = cat.parMobilab.get(tf);
        if (k) lu = { cle: k, par: "fiche_mobilab" };
    }
    if (!lu && u.versionIds) {
        const k = modeleParVersionIds(cat, u.versionIds);
        if (k) lu = { cle: k, par: "version_ids" };
    }
    if (!modele && lu) { modele = cat.modeles.get(lu.cle); source = lu.par; }
    return { modele, source, lu };
}

module.exports = { charger, lireVersion, modeleParVersionIds, identifierModele, ErreurCatalogue, NOM_MESURE, pourcentagePile, pourcentageBrut };
