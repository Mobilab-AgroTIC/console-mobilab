"use strict";
// Bloc « Mobilab » de Node-RED (noeud-red.js) et page « V3 · Catalogue » (fiche.js), sans base de données.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { creer } = require("..");
const NR = require("../noeud-red");

const CATALOGUE = path.join(__dirname, "..", "..", "catalogue");

function copieCatalogue() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-nr-"));
    fs.cpSync(CATALOGUE, dir, { recursive: true });
    return dir;
}
const ingest = dir => creer({ pool: null, catalogueDir: dir, spoolDir: os.tmpdir(), env: {}, log: { info() {}, warn() {}, error() {} } });

const FICHE = `
cle: exemple-station
marque: Mobilab
modele: Station d'exemple
libelle: Station d'exemple Mobilab Station
type: capteur
lorawan: {mac: MAC_V1_0_3, phy: PHY_V1_0_3_REV_A, classe: A}
intervalle_defaut_s: 1200
trame:
  format: mobilab
  type: 250
  champs:
    - {cle: temperature, octets: 2}
batterie: {pile: lithium}
mesures:
  temperature: {nom: temperature, libelle: Température, unite: "°C", decimales: 1, facteur: 0.1, principale: true, alerte: seuil, hysteresis: 0.5}
grafana: {panneaux: [{type: courbe, mesures: [temperature]}, {type: batterie}]}
`;
const ESSAIS = `
- nom: "21,5 °C"
  f_port: 11
  hex: "0E10 00D7"
  attendu: {temperature: 21.5, battery_mv: 3600}
`;

test("liste des étapes : clés uniques, chacune avec un nom, un groupe et une aide", () => {
    const cles = NR.ETAPES.map(e => e.cle);
    assert.equal(new Set(cles).size, cles.length);
    for (const e of NR.ETAPES) assert.ok(e.libelle && e.groupe && e.aide, e.cle);
});

test("étape inconnue ou module absent : erreur claire, 503 pour un webhook", async () => {
    await assert.rejects(NR.executer({}, "inconnue", {}), /étape inconnue/);
    const msg = { req: { headers: {} }, payload: {} };
    const r = await NR.executer(null, "recevoir_uplink", msg);
    assert.equal(msg.statusCode, 503);
    assert.equal(r.statut.fill, "red");
    await assert.rejects(NR.executer(null, "decoder", { trame: {} }), /module ingest absent/);
});

test("essayer une trame : décodée et normalisée, sans base", async () => {
    const ing = ingest(CATALOGUE);
    const msg = { payload: { modele: "dragino-lht52", f_port: 2, hex: "04fd03e8059d016afccdf9" } };
    const r = await NR.executer(ing, "essayer_trame", msg);
    assert.equal(r.statut.fill, "green");
    assert.equal(msg.payload.resume, "12,8 °C · 100 %");
    assert.equal(msg.payload.decodeur, "LHT52_TTN_v1.0.js");
    await assert.rejects(NR.executer(ing, "essayer_trame", { payload: { modele: "x", f_port: 2, hex: "00" } }), /absent du catalogue/);
});

test("fiche : essayée dans une copie, l'exemple ne se publie pas, une vraie fiche se publie", async () => {
    const dir = copieCatalogue();
    const ing = ingest(dir);
    const avant = fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim();
    // Essai seul : rien n'est écrit
    let msg = { fiche: FICHE, essais: ESSAIS };
    let r = await NR.executer(ing, "fiche_capteur", msg);
    assert.equal(msg.payload.ok, true, JSON.stringify(msg.payload.erreurs));
    assert.equal(msg.payload.publie, false);
    assert.equal(r.statut.fill, "yellow");
    assert.equal(fs.existsSync(path.join(dir, "modeles", "mobilab", "exemple-station.yaml")), false);
    // L'exemple refuse d'être publié
    msg = { fiche: FICHE, essais: ESSAIS, publier: true };
    await NR.executer(ing, "fiche_capteur", msg);
    assert.equal(msg.payload.publie, false);
    assert.match(msg.payload.erreurs[0], /fiche d'exemple/);
    // Une vraie fiche : publiée, VERSION augmentée, catalogue rechargé
    const vraie = FICHE.replace("cle: exemple-station", "cle: mobilab-station");
    msg = { fiche: vraie, essais: ESSAIS, publier: true };
    r = await NR.executer(ing, "fiche_capteur", msg);
    assert.equal(msg.payload.publie, true, JSON.stringify(msg.payload.erreurs));
    assert.equal(r.statut.fill, "green");
    assert.ok(fs.existsSync(path.join(dir, "modeles", "mobilab", "mobilab-station.yaml")));
    assert.ok(fs.existsSync(path.join(dir, "tests", "mobilab", "mobilab-station.yaml")));
    assert.equal(fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim(), String(Number(avant) + 1));
    assert.ok(ing.catalogue.modeles.has("mobilab-station"));
    fs.rmSync(dir, { recursive: true, force: true });
});

test("fiche refusée : YAML illisible, essai faux, catalogue invalide ; rien n'est écrit", async () => {
    const dir = copieCatalogue();
    const ing = ingest(dir);
    const vraie = FICHE.replace("cle: exemple-station", "cle: mobilab-station");
    const cas = [
        [{ fiche: "cle: [", essais: ESSAIS }, /YAML illisible/],
        [{ fiche: vraie, essais: ESSAIS.replace("21.5", "30") }, /temperature = 21.5, attendu 30/],
        [{ fiche: vraie, essais: "" }, /au moins une/],
        [{ fiche: vraie.replace("type: 250", "type: 0"), essais: ESSAIS }, /trame.type/],
        [{ fiche: vraie, essais: ESSAIS, decodeur: "function decodeUplink(){}" }, /decodeurs: - fichier/],
    ];
    for (const [entree, attendu] of cas) {
        const msg = { ...entree, publier: true };
        await NR.executer(ing, "fiche_capteur", msg);
        assert.equal(msg.payload.publie, false);
        assert.match(msg.payload.erreurs.join(" | "), attendu);
    }
    assert.equal(fs.existsSync(path.join(dir, "modeles", "mobilab")), false);
    fs.rmSync(dir, { recursive: true, force: true });
});
