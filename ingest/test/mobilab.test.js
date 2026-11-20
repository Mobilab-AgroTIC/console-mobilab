"use strict";
// Trames des montages Mobilab (catalogue/trame-mobilab.md) : lecture des champs, fiche du port 10,
// format « libre » des anciennes cartes, contrôle du catalogue et identification par la fiche.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { catalogue, normaliser: N, decoderSource, trame: T } = require("..");

const hex = h => Buffer.from(h.replace(/\s/g, ""), "hex");

// Un catalogue de test : le vrai, plus un montage au format Mobilab et une ancienne carte au format libre.
const ESSAI = `
cle: mobilab-essai
prefixe_id: essai
marque: Mobilab
modele: Essai
libelle: Montage d'essai Mobilab Essai
bouton: Essai
type: capteur
lorawan: {mac: MAC_V1_0_3, phy: PHY_V1_0_3_REV_A, classe: A}
intervalle_defaut_s: 1200
trame:
  format: mobilab
  type: 1
  champs:
    - {cle: temperature, octets: 2}
    - {cle: humidite, octets: 2, signe: false}
    - {cle: impulsions, octets: 4, signe: false}
    - {cle: niveau, octets: 1, signe: false}
batterie: {pile: lithium}
mesures:
  temperature: {nom: temperature, libelle: Température, unite: "°C", decimales: 1, facteur: 0.1, principale: true, alerte: seuil, hysteresis: 0.5}
  humidite: {nom: humidity, libelle: Humidité, unite: "%", decimales: 0, facteur: 0.1, principale: true, alerte: seuil, hysteresis: 3}
  impulsions: {nom: count, libelle: Impulsions, unite: "", decimales: 0, alerte: aucune}
  niveau: {nom: level, libelle: Niveau, unite: "%", decimales: 0, alerte: aucune}
grafana: {panneaux: [{type: courbe, mesures: [temperature, humidity]}, {type: batterie}, {type: radio}]}
`;
const ANCIENNE = `
cle: mobilab-ancienne
marque: Mobilab
modele: Ancienne
libelle: Carte d'avant le format Mobilab Ancienne
type: capteur
lorawan: {mac: MAC_V1_0_3, phy: PHY_V1_0_3_REV_A, classe: A}
intervalle_defaut_s: 1200
trame:
  format: libre
  port: 1
  champs:
    - {cle: pile, octets: 1, signe: false}
    - {cle: valeur, octets: 2, signe: false}
batterie: {cle: pile, facteur_mv: 50, pile: lithium}
mesures:
  valeur: {nom: points, libelle: Points, unite: "", decimales: 0, alerte: aucune}
grafana: {panneaux: [{type: courbe, mesures: [points]}, {type: batterie}]}
`;

function catalogueDeTest(extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-"));
    fs.cpSync(path.join(__dirname, "..", "..", "catalogue"), dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "modeles", "mobilab"));
    for (const [nom, texte] of Object.entries({ "mobilab-essai": ESSAI, "mobilab-ancienne": ANCIENNE, ...extra })) {
        fs.writeFileSync(path.join(dir, "modeles", nom === "rangee-a-la-racine" ? "" : "mobilab", `${nom}.yaml`), texte);
    }
    return catalogue.charger(dir);
}

function normaliser(cat, cle, h, fPort) {
    const m = cat.modeles.get(cle);
    const dec = decoderSource(m.sources[0], hex(h), fPort);
    return N.normaliser(cat, m, dec, { fPort, octets: hex(h), probes: {}, modeForce: null, detected: {}, time: "2026-11-19T12:00:00Z" });
}

test("champs : 1, 2, 4 octets, signés ou non, 7FFF absent, trame courte", () => {
    const t = { format: "mobilab", type: 1, champs: [{ cle: "a" }, { cle: "b", signe: false }, { cle: "c", octets: 4 }, { cle: "d", octets: 1 }] };
    assert.deepEqual(T.decoderTrame(t, hex("0E10 FF9C FF9C FFFFFFFE 80"), 11), { pile_mv: 3600, a: -100, b: 65436, c: -2, d: -128 });
    assert.deepEqual(T.decoderTrame(t, hex("0E10 7FFF 0001 7FFFFFFF"), 11), { pile_mv: 3600, a: null, b: 1, c: null });
    assert.deepEqual(T.decoderTrame(t, hex("0E10 00C8"), 11), { pile_mv: 3600, a: 200 });
    assert.throws(() => T.decoderTrame(t, hex("0E10"), 2), /port 2/);
});

test("fiche du port 10 (exemple de la spec V2) : AA, type, version, pile", () => {
    const t = { format: "mobilab", type: 1, champs: [{ cle: "a" }] };
    assert.deepEqual(T.decoderTrame(t, hex("AA 01 01 0B 3A"), 10), { type: 1, version: 1, pile_mv: 2874 });
    assert.throws(() => T.decoderTrame(t, hex("AA 02 01 0B 3A"), 10), /type 2, attendu 1/);
    assert.throws(() => T.decoderTrame(t, hex("09 01 00 01 0B 3A"), 10), /AA/);
    assert.equal(T.typeFiche(10, hex("AA 01 01 0B 3A")), 1);
    assert.equal(T.typeFiche(5, hex("AA 01 01 0B 3A")), null);    // le port 5 reste aux Dragino
    assert.equal(T.typeFiche(10, hex("09 01")), null);
});

test("contrôle des trames du catalogue", () => {
    assert.match(T.verifierTrame({ format: "x" }), /mobilab ou libre/);
    assert.match(T.verifierTrame({ format: "mobilab", type: 0, champs: [{ cle: "a" }] }), /1 à 255/);
    assert.match(T.verifierTrame({ format: "mobilab", type: 3, port: 10, champs: [{ cle: "a" }] }), /sauf 10/);
    assert.match(T.verifierTrame({ format: "libre", champs: [{ cle: "a" }] }), /trame.port/);
    assert.match(T.verifierTrame({ format: "mobilab", type: 3, champs: [{ cle: "a", octets: 3 }] }), /1, 2 ou 4/);
    assert.match(T.verifierTrame({ format: "mobilab", type: 3, champs: [{ cle: "pile_mv" }] }), /réservé/);
    assert.equal(T.verifierTrame({ format: "mobilab", type: 3, champs: [{ cle: "a" }] }), null);
    // Deux montages ne peuvent pas avoir le même type
    assert.throws(() => catalogueDeTest({ "mobilab-double": ESSAI.replace("cle: mobilab-essai", "cle: mobilab-double") }), /trame.type déjà pris : 1/);
    // Une fiche se range dans le dossier de sa marque
    assert.throws(() => catalogueDeTest({ "rangee-a-la-racine": ESSAI.replace("cle: mobilab-essai", "cle: rangee-a-la-racine").replace("type: 1\n", "type: 2\n") }),
        /à ranger dans le dossier de sa marque/);
    // Une mesure doit venir d'un champ de la trame
    assert.throws(() => catalogueDeTest({ "mobilab-essai": ESSAI.replace("  niveau: {nom: level", "  inconnu: {nom: level") }), /inconnu : pas dans trame.champs/);
});

test("montage au format Mobilab : ports et pile déduits, mesures avec facteurs", () => {
    const cat = catalogueDeTest();
    const m = cat.modeles.get("mobilab-essai");
    assert.deepEqual(m.ports, { 10: "statut", 11: "mesures" });
    assert.equal(cat.parMobilab.get(1), "mobilab-essai");
    assert.equal(m.batterie.faible_mv, 3300);    // courbe lithium de piles.yaml
    const fiche = normaliser(cat, "mobilab-essai", "AA 01 01 0B 3A", 10);
    assert.deepEqual(fiche.mesures, { battery_mv: 2874 });
    assert.equal(fiche.port5.firmware, 1);
    const r = normaliser(cat, "mobilab-essai", "0E10 FF9C 0258 00012345 07", 11);
    assert.deepEqual(r.mesures, { temperature: -10, humidity: 60, count: 74565, level: 7, battery_mv: 3600 });
    const sansSonde = normaliser(cat, "mobilab-essai", "0E10 7FFF 0258", 11);
    assert.deepEqual(sansSonde.mesures, { humidity: 60, battery_mv: 3600 });
});

test("ancienne carte au format libre : pile sur 1 octet × 50 mV", () => {
    const cat = catalogueDeTest();
    assert.deepEqual(cat.modeles.get("mobilab-ancienne").ports, { 1: "mesures" });
    assert.deepEqual(normaliser(cat, "mobilab-ancienne", "4A 0FA0", 1).mesures, { points: 4000, battery_mv: 3700 });
});

test("identification : la fiche AA du port 10 reconnaît le montage, sans gêner les Dragino", () => {
    const cat = catalogueDeTest();
    const inconnu = { model_key: null, config: {} };
    const r = catalogue.identifierModele(cat, inconnu, { fPort: 10, octets: hex("AA 01 01 0B 3A"), versionIds: null });
    assert.equal(r.modele.cle, "mobilab-essai");
    assert.deepEqual(r.lu, { cle: "mobilab-essai", par: "fiche_mobilab" });
    // Type absent du catalogue : rien d'identifié
    assert.equal(catalogue.identifierModele(cat, inconnu, { fPort: 10, octets: hex("AA 63 01 0B 3A"), versionIds: null }).modele, null);
    // Un AA sur le port 5 n'est pas une fiche Mobilab, et la fiche LHT52 du port 5 reste reconnue
    assert.equal(catalogue.identifierModele(cat, inconnu, { fPort: 5, octets: hex("AA 01 01 0B 3A"), versionIds: null }).modele, null);
    assert.equal(catalogue.identifierModele(cat, inconnu, { fPort: 5, octets: hex("09 01 00 01 FF 0C 3A"), versionIds: null }).modele.cle, "dragino-lht52");
});
