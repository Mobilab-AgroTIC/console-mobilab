"use strict";
// Contrôle du catalogue et décodage de toutes les trames de test (spec V3 §7.10, point 5).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { catalogue, normaliser: N, decoderSource } = require("..");

const DIR = process.env.CATALOGUE_DIR || path.join(__dirname, "..", "..", "catalogue");
const cat = catalogue.charger(DIR);

test("le catalogue se charge et chaque modèle a ses trames de test", () => {
    assert.ok(cat.modeles.size >= 10);
    for (const [cle, m] of cat.modeles) {
        assert.ok(fs.existsSync(path.join(DIR, "tests", m.dossier, `${cle}.yaml`)), `tests/${m.dossier}/${cle}.yaml manquant`);
    }
});

// Trames de test, rangées comme les fiches : tests/<marque>/<cle>.yaml
const fichiersTest = fs.readdirSync(path.join(DIR, "tests"), { withFileTypes: true }).filter(d => d.isDirectory())
    .flatMap(d => fs.readdirSync(path.join(DIR, "tests", d.name)).filter(f => f.endsWith(".yaml")).map(f => path.join(d.name, f)));
test("chaque fichier de test correspond à une fiche", () => {
    assert.ok(fichiersTest.length >= cat.modeles.size);
    for (const f of fs.readdirSync(path.join(DIR, "tests")).filter(f => f.endsWith(".yaml"))) assert.fail(`tests/${f} : à ranger dans tests/<marque>/`);
});

for (const f of fichiersTest) {
    const cle = path.basename(f, ".yaml");
    const cas = YAML.parse(fs.readFileSync(path.join(DIR, "tests", f), "utf8"));
    for (const c of cas) {
        test(`${cle} : ${c.nom}`, () => {
            const modele = cat.modeles.get(cle);
            assert.ok(modele, `modèle ${cle} absent`);
            const brut = Buffer.from(String(c.hex), "hex");
            const octets = N.forcerMode(modele, brut, c.mode_force || null);
            const dec = decoderSource(modele.sources[modele.sources.length - 1], octets, c.f_port);
            const r = N.normaliser(cat, modele, dec, { fPort: c.f_port, octets: brut, probes: c.probes || {},
                modeForce: c.mode_force || null, detected: c.detected || {}, time: c.time || "2026-11-17T12:00:00Z" });
            for (const [k, v] of Object.entries(c.attendu || {})) {
                assert.ok(r.mesures[k] !== undefined, `${k} absent (reçu ${JSON.stringify(r.mesures)})`);
                assert.ok(Math.abs(r.mesures[k] - v) < 0.01, `${k} = ${r.mesures[k]}, attendu ${v}`);
            }
            for (const k of c.absent || []) assert.equal(r.mesures[k], undefined, `${k} ne devrait pas être là`);
            if (c.voies_sans_sonde) assert.deepEqual(r.voiesSansSonde, c.voies_sans_sonde);
            if (c.mode_lu !== undefined) assert.equal(r.modeLu, c.mode_lu);
            if (c.mode_non_decrit !== undefined) assert.equal(r.modeNonDecrit, c.mode_non_decrit);
            if (c.port5) for (const [k, v] of Object.entries(c.port5)) assert.equal(r.port5[k], v, `port5.${k}`);
            for (const k of Object.keys(r.mesures)) assert.match(k, /^[a-z0-9_]{1,20}$/);
        });
    }
}

test("le port 5 identifie le modèle par son premier octet", () => {
    assert.equal(cat.parPort5.get(0x1C), "dragino-sn50v3-lb");
    assert.equal(cat.parPort5.get(0x09), "dragino-lht52");
});

test("les version_ids identifient le modèle, avec ou sans -lb/-ls", () => {
    assert.equal(catalogue.modeleParVersionIds(cat, { brand_id: "dragino", model_id: "lht52" }), "dragino-lht52");
    assert.equal(catalogue.modeleParVersionIds(cat, { brand_id: "dragino", model_id: "sn50v3-ls" }), "dragino-sn50v3-lb");
    assert.equal(catalogue.modeleParVersionIds(cat, { brand_id: "dragino", model_id: "lsn50v2-d20-d22-d23" }), "dragino-lsn50v2-d2x");
    assert.equal(catalogue.modeleParVersionIds(cat, { brand_id: "acme", model_id: "x" }), null);
});

test("intervalle d'envoi : catalogue, puis celui réglé par downlink, puis la médiane mesurée", () => {
    const m = cat.modeles.get("dragino-lht52");
    assert.equal(N.intervalle({}, m, "2026-11-17T12:00:00Z").intervalle_s, 1200);
    let det = { ecarts_s: [], derniere_mesure: "2026-11-17T12:00:00Z" };
    det = { ...det, ...N.intervalle(det, m, "2026-11-18T12:00:00Z", 86400) };
    assert.equal(det.intervalle_s, 86400);
    det = { ...det, ...N.intervalle(det, m, "2026-11-19T12:00:00Z", 86400) };
    det = { ...det, ...N.intervalle(det, m, "2026-11-20T12:30:00Z", 86400) };
    assert.deepEqual(det.ecarts_s, [86400, 86400, 88200]);
    assert.equal(det.intervalle_s, 86400);
});

test("« pas de nouvelles » : deux messages manqués, jamais avant 10 min ; « Désactiver » sous l'alerte et le retour", () => {
    const A = require("../alertes");
    assert.equal(A.delaiSilence({}), 3000);                                   // 20 min mesurées par défaut : 50 min
    assert.equal(A.delaiSilence({ intervalle_s: 60, mesure_s: 60 }), 600);    // capteur d'une minute : 10 min
    assert.equal(A.delaiSilence({ intervalle_s: 86400, mesure_s: 1200 }), 216000);
    assert.equal(A.delaiSilence({ mesure_s: 600, delai_min: 180 }), 10800);   // délai fixé par un admin
    const T = require("../textes-alertes.json");
    const n = { id: 7, dev_eui: "a84041000181b2c3", transition: "alarme", details: { items: [{ rule_id: 3, kind: "silence" }], duree: "3 h" } };
    const voir = [{ text: "Voir le capteur", callback_data: "dv:a84041000181b2c3" }];
    assert.deepEqual(A.boutons(T, n), [[{ text: "🔕 Désactiver cette alerte", callback_data: "ds:7" }], voir]);
    assert.deepEqual(A.boutons(T, { ...n, transition: "retour" }), [[{ text: "🔕 Désactiver cette alerte", callback_data: "ds:7" }], voir]);
    assert.deepEqual(A.boutons(T, n, { conseiller: true }), [voir]);
    assert.equal(A.boutons(T, { ...n, transition: "retour" }, { conseiller: true }), null);
    const groupe = { ...n, details: { ...n.details, groupe: ["a", "b"] } };
    assert.equal(A.boutons(T, groupe)[0][0].text, "🔕 Désactiver ces alertes");
    const ctx = { nomCapteur: () => "Serre", modele: () => null };
    assert.equal(A.rediger(T, cat, n, ctx), "📡 <b>Serre</b> : pas de nouvelles depuis 3 h.");
    assert.equal(A.rediger(T, cat, { ...n, transition: "retour" }, ctx), "✅ <b>Serre</b> : de nouveau en ligne.");
});

test("VERSION : la première ligne est la version, le journal « # » est ignoré", () => {
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "version-"));
    fs.writeFileSync(path.join(dir, "VERSION"), "\n3.1.4\n# Journal\n# 3.1.4  passage à Grafana 13\n");
    assert.equal(catalogue.lireVersion(dir), "3.1.4");
    fs.writeFileSync(path.join(dir, "VERSION"), "# rien que des commentaires\n");
    assert.equal(catalogue.lireVersion(dir), null);
    fs.rmSync(dir, { recursive: true });
    assert.equal(catalogue.lireVersion(dir), null);
    assert.match(cat.version, /^\d+\.\d+\.\d+$/);    // le vrai fichier du dépôt
});

test("résumé à la française des mesures principales", () => {
    const m = cat.modeles.get("dragino-lht52");
    assert.equal(N.resume(cat, m, { temperature: { v: 14.78 }, humidity: { v: 60.4 } }), "14,8 °C · 60 %");
    const p = cat.modeles.get("dragino-lds02");
    assert.equal(N.resume(cat, p, { door: { v: 1 } }), "ouverte");
});

test("pile : pourcentage selon la courbe de la chimie, pas selon la tension brute", () => {
    const lht52 = cat.modeles.get("dragino-lht52");          // 2 alcalines AAA
    const lsn = cat.modeles.get("dragino-lsn50v2-d2x");      // lithium 3,6 V
    const P = mv => catalogue.pourcentagePile(lht52, mv);
    assert.equal(P(3200), 100);
    assert.equal(P(3000), 90);
    assert.equal(P(2694), 55);          // Salon, 19/11
    assert.equal(P(2676), 50);          // Chambre, 19/11
    assert.equal(P(2000), 0);           // 2 V : pile morte, pas « 60 % »
    assert.equal(P(2305), 5);           // jamais 0 % tant qu'il reste un peu
    assert.equal(catalogue.pourcentagePile(lsn, 3642), 100);
    assert.equal(catalogue.pourcentagePile(lsn, 3300), 20);
    assert.equal(catalogue.pourcentagePile(null, 3000), null);
    // seuil « à changer » : même pourcentage pour toutes les piles
    assert.equal(cat.piles.a_changer_pct, 20);
    assert.equal(lht52.batterie.faible_mv, 2462);
    assert.equal(lsn.batterie.faible_mv, 3300);
    assert.equal(Math.round(catalogue.pourcentageBrut(lht52, lht52.batterie.faible_mv)), 20);
    for (const m of cat.modeles.values()) assert.ok(m.batterie && m.batterie.courbe, `${m.cle} : pile sans courbe`);
});

test("pile : une courbe mal écrite ou une pile inconnue refusent le catalogue", () => {
    const os = require("os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piles-"));
    fs.cpSync(DIR, tmp, { recursive: true });
    const piles = path.join(tmp, "piles.yaml");
    const original = fs.readFileSync(piles, "utf8");
    fs.writeFileSync(piles, original.replace("[1450, 80]", "[1600, 80]"));
    assert.throws(() => catalogue.charger(tmp), /alcaline : tension et % décroissent/);
    fs.writeFileSync(piles, original);
    const lht = path.join(tmp, "modeles", "dragino", "dragino-lht52.yaml");
    fs.writeFileSync(lht, fs.readFileSync(lht, "utf8").replace("pile: alcaline", "pile: plomb"));
    assert.throws(() => catalogue.charger(tmp), /pile inconnue plomb/);
    fs.rmSync(tmp, { recursive: true, force: true });
});
