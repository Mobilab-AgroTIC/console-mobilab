// Tests unitaires du service (spec §12.1 : textes courts, callback_data ≤ 64 octets, codes, secrets, tableau).
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { controler, nettoyer, groupes, rangerCodes, lireListe } from "../src/codes.js";
import { chiffrer, dechiffrer, jeton, empreinte, verificateurScram, motDePasseLisible } from "../src/crypto.js";
import * as textes from "../src/textes.fr.js";
import { lireParametre } from "../src/invitations.js";
import { chargerCatalogue, catalogue, definition, pourcentagePile, pileFaible, modele, boutonModele, nomCommercial } from "../src/catalogue.js";
import { construireTableau, construireResume, sqlPourcentage } from "../src/tableau.js";
import { racineDepot } from "../src/config.js";
import { duree, nombre, reception, loginDepuisNom } from "../src/format.js";
import { idDepuisNom, idCapteur, idsApplication, ID_TTS } from "../src/identifiants.js";

const racine = racineDepot();

describe("codes de l'étiquette (spec §4.4)", () => {
  it("nettoie espaces, tirets, 0x, et corrige O, I, L", () => {
    expect(nettoyer("a8-40 41:0x00 0O1I L")).toBe("A840410000111");
    expect(controler("appeui", "A840 4100 0000 0101")).toEqual({ ok: true, valeur: "A840410000000101" });
  });
  it("refuse une mauvaise longueur et range 32 caractères comme AppKey", () => {
    expect(controler("deveui", "A84041")).toMatchObject({ ok: false, erreur: "longueur16" });
    expect(controler("appeui", "2B7E151628AED2A6ABF7158809CF4F3C")).toMatchObject({ ok: false, erreur: "appkey_a_la_place" });
    expect(controler("deveui", "0000000000000000")).toMatchObject({ ok: false, erreur: "interdit" });
  });
  it("affiche par groupes de 4", () => { expect(groupes("a84041f21c5b3d2e")).toBe("A840 41F2 1C5B 3D2E"); });
  it("range les 3 codes collés ensemble (raccourci admin)", () => {
    expect(rangerCodes("A840410000000101 2B7E151628AED2A6ABF7158809CF4F3C A84041F21C5B3D2E"))
      .toEqual({ appeui: "A840410000000101", appkey: "2B7E151628AED2A6ABF7158809CF4F3C", deveui: "A84041F21C5B3D2E" });
  });
  it("lit une liste collée avec titres", () => {
    const l = lireListe("nom;joineui;appkey;deveui\nSerre;A840410000000101;2B7E151628AED2A6ABF7158809CF4F3C;A84041F21C5B3D2E\nPuits;A840410000000101;2B7E;A84041F21C5B3D2F");
    expect(l[0].erreurs).toEqual([]);
    expect(l[1].erreurs[0]).toMatch(/AppKey de 4 caractères, 32 attendus/);
  });
});

describe("secrets (spec §6.1, §10.5)", () => {
  it("chiffre et déchiffre l'AppKey (AES-GCM)", () => {
    const k = crypto.randomBytes(32);
    const p = chiffrer(k, "2B7E151628AED2A6ABF7158809CF4F3C");
    expect(p.includes(Buffer.from("2B7E"))).toBe(false);
    expect(dechiffrer(k, p)).toBe("2B7E151628AED2A6ABF7158809CF4F3C");
  });
  it("jeton de 43 caractères, préfixe le plus long sous 64", () => {
    const j = jeton();
    expect(j).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(("adm_" + j).length).toBeLessThanOrEqual(64);
    expect(lireParametre("j_" + j)).toEqual({ kind: "join", empreinte: empreinte(j) });
    expect(lireParametre("x_" + j)).toBeNull();
  });
  it("vérificateur SCRAM au format Postgres", () => {
    expect(verificateurScram("secret")).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  });
  it("mot de passe Grafana conforme à password_policy", () => {
    for (let i = 0; i < 50; i++) {
      const m = motDePasseLisible();
      expect(m.length).toBeGreaterThanOrEqual(12);
      expect(m).toMatch(/[A-Z]/); expect(m).toMatch(/[a-z]/); expect(m).toMatch(/[0-9]/); expect(m).toMatch(/[^A-Za-z0-9]/);
    }
  });
});

describe("textes (spec §4.1, §12.1)", () => {
  const tous: [string, string][] = [];
  const parcourir = (o: any, p: string) => { for (const [k, v] of Object.entries(o)) typeof v === "string" ? tous.push([`${p}.${k}`, v]) : parcourir(v, `${p}.${k}`); };
  parcourir(textes.client, "client"); parcourir(textes.admin, "admin"); parcourir(textes.alertes, "alertes"); parcourir(textes.commun, "commun");
  it("un texte client fait deux lignes au plus, sauf les listes", () => {
    const listes = new Set(["client.aide", "client.description"]);
    for (const [k, v] of tous.filter(([k]) => (k.startsWith("client") || k.startsWith("alertes")) && !listes.has(k))) expect(v.split("\n").length, k).toBeLessThanOrEqual(2);
  });
  it("le HTML des textes est valide pour Telegram (b, i, code seulement)", () => {
    for (const [k, v] of tous) expect(/[<>]/.test(v.replace(/<\/?(b|i|code)>/g, "")), k).toBe(false);
  });
  it("ingest/textes-alertes.json est la copie de textes.fr.ts", () => {
    const json = JSON.parse(fs.readFileSync(path.join(racine, "ingest", "textes-alertes.json"), "utf8"));
    expect(json).toEqual(textes.alertes);
  });
  it("callback_data le plus long sous 64 octets", () => {
    const slug = "f" + "9".repeat(27), id = "9".repeat(19), dev = "a84041f21c5b3d2e";
    for (const cb of [`sh!:${slug}:r:${id}`, `th:${dev}:temperature_probe2:lo:2`, `a:per:${slug}:${"9".repeat(16)}`, `a:ps:${dev}:3:12p`, `du:${dev}:soil_moisture_adc1:hi:24`]) {
      expect(Buffer.byteLength(cb), cb).toBeLessThanOrEqual(64);
    }
  });
});

describe("identifiants TTS lisibles", () => {
  it("application au nom de la ferme, capteur nom-4 derniers caractères", () => {
    expect(idDepuisNom("Ferme des Prés")).toBe("ferme-des-pres");
    expect(idsApplication("Saint-Thomas", "f0001")).toEqual(["saint-thomas-000001", "ferme-000001"]);
    expect(idCapteur("lht52", "a84041f21c5b3d2e")).toBe("lht52-3d2e");
    expect(idCapteur(null, "a84041f21c5b3d2e")).toBe("autre-3d2e");
    expect(idCapteur("milesight", "a84041f21c5b3d2e")).toBe("milesight-3d2e");
    const long = idCapteur("Un préfixe vraiment très très long pour un type", "a84041f21c5b3d2e");
    expect(long.length).toBeLessThanOrEqual(36);
    expect(long).toMatch(ID_TTS);
    for (const id of idsApplication("A".repeat(60), "f12345")) expect(id).toMatch(ID_TTS);
  });
});

describe("format", () => {
  it("nombres et durées à la française", () => {
    expect(nombre(14.25, 1)).toBe("14,3");
    expect(nombre(-0.04, 1)).toBe("0,0");
    expect(duree(3 * 3600000)).toBe("3 h");
    expect(duree(50 * 3600000)).toBe("2 j");
    expect(reception(-97, 7.5)).toBe("bonne");
    expect(reception(-120, -3)).toBe("faible");
    expect(loginDepuisNom("Jérôme Dupré")).toBe("jerome.dupre");
  });
});

describe("tableau « Mes capteurs » (spec §9.5)", () => {
  beforeAll(() => { chargerCatalogue(path.join(racine, "catalogue"), path.join(racine, "ingest")); });
  it("même entrée, même sortie ; une rangée par capteur ; mesure jamais reçue absente", () => {
    const capteurs = [
      { dev_eui: "a84041000181b2c3", name: "Serre nord", model_key: "dragino-lht52", ttn_status: "connecte",
        last_values: { temperature: { v: 14 }, humidity: { v: 80 }, battery_mv: { v: 3100 }, resume: "14,0 °C · 80 %" } },
      { dev_eui: "a84041000181b2c4", name: "Cuve", model_key: null, ttn_status: "enregistre", last_values: {} },
    ];
    const a = construireTableau({ slug: "f0042", display_name: "Ferme des Prés" }, capteurs, catalogue(), (m, n) => definition(m, n));
    const b = construireTableau({ slug: "f0042", display_name: "Ferme des Prés" }, capteurs, catalogue(), (m, n) => definition(m, n));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const json = JSON.stringify(a);
    expect(a.uid).toBe("capteurs-f0042");
    expect(json).toContain("Serre nord");
    expect(json).not.toContain("temperature_probe");
    expect(json).not.toContain("tenant");
    // Un bloc par capteur reçu (comme le tableau Saint Thomas) : rangée, courbes, jauge, pile, signal
    const p = a.panels as any[];
    expect(p.filter(x => x.type === "row").map(x => x.title)).toEqual(["Serre nord"]);
    expect(p.map(x => [x.type, x.title, x.gridPos.x, x.gridPos.w, x.gridPos.h])).toEqual([
      ["row", "Serre nord", 0, 24, 1], ["timeseries", "Température & Humidité", 0, 12, 8], ["gauge", "Pile", 12, 3, 8],
      ["timeseries", "Pile", 15, 9, 4], ["timeseries", "Signal radio", 15, 9, 4]]);
    // Chaque graphique a sa bulle d'aide (i)
    expect(p.filter(x => x.type !== "row").every(x => x.description?.length > 40)).toBe(true);
    expect(p[2].description).toMatch(/2 × Alcaline 1,5 V \(AA, AAA\)\. Sa tension baisse régulièrement/);
    expect(p[1].description).toMatch(/À gauche : Humidité\. À droite : Température\./);
    // Toutes les courbes sur un seul graphique : couleurs du catalogue, humidité à gauche, température à droite
    const courbes = p[1];
    const props = (nom: string) => Object.fromEntries(courbes.fieldConfig.overrides.find((o: any) => o.matcher.options === nom).properties.map((q: any) => [q.id, q.value]));
    expect(props("temperature")).toMatchObject({ displayName: "Température", unit: "celsius", "custom.axisPlacement": "right",
      color: { mode: "fixed", fixedColor: "green" }, "custom.axisSoftMin": -5, "custom.axisSoftMax": 40 });
    expect(props("humidity")).toMatchObject({ unit: "percent", "custom.axisPlacement": "left", color: { mode: "fixed", fixedColor: "blue" } });
    // Pile en % (courbe du modèle) : couleurs des seuils (rouge sous 20 %), seuils en pointillés ; tension brute en V
    // Jauge en % ; la tension, étiquette du champ, s'affiche sous le pourcentage
    expect(p[2].fieldConfig.defaults).toMatchObject({ unit: "percent", displayName: "${__field.labels.tension}" });
    expect(p[2].targets[0].rawSql).toContain(`replace(to_char(value / 1000.0, 'FM0.00'), '.', ',') || ' V' AS tension`);
    expect(p[3].fieldConfig.defaults.thresholds.steps.map((x: any) => [x.color, x.value])).toEqual([["red", null], ["orange", 20], ["#EAB839", 40], ["green", 60]]);
    expect(p[3].fieldConfig.defaults.custom).toMatchObject({ gradientMode: "scheme", thresholdsStyle: { mode: "dashed" } });
    // Signal : fond aux couleurs du RSSI, SNR en pointillés sur l'axe de droite
    const rssi = p[4].fieldConfig.overrides.find((o: any) => o.matcher.options === "RSSI").properties;
    expect(rssi).toContainEqual({ id: "custom.thresholdsStyle", value: { mode: "area" } });
    expect((a as any).links[0].url).toBe("/d/resume-f0042");
  });
  it("Résumé : état de tous les capteurs (pile en %), piles et signal radio", () => {
    const capteurs = [
      { dev_eui: "a84041000181b2c3", name: "Serre nord", model_key: "dragino-lht52", ttn_status: "connecte", last_values: { temperature: { v: 14 } } },
      { dev_eui: "a84041000181b2c5", name: "Alambic", model_key: "dragino-lsn50v2-d2x", ttn_status: "connecte", last_values: { temp_red: { v: 80 } } },
    ];
    const r = construireResume({ slug: "f0042", display_name: "Ferme des Prés" }, capteurs, catalogue()) as any;
    expect(r.uid).toBe("resume-f0042");
    expect(r.panels.map((x: any) => x.title)).toEqual(["", "État de mes capteurs", "Piles", "Signal radio : RSSI (dBm)", "Signal radio : SNR (dB)"]);
    const json = JSON.stringify(r);
    expect(json).toContain(`WHEN 'dragino-lht52' THEN (SELECT CASE WHEN p > 0 THEN greatest(5, round(p / 5) * 5) ELSE 0 END FROM (SELECT CASE WHEN battery_mv >= 3100 THEN 100`);
    expect(json).toContain(`CASE c.model_key WHEN 'dragino-lht52' THEN round(CASE WHEN avg(m.value) >= 3100`);
    expect(json).not.toContain("tenant");
  });
  it("choix du modèle : un bouton par modèle, ce qui est écrit sur l'étiquette puis l'usage", () => {
    const b = (cle: string) => boutonModele(modele(cle)!);
    expect(b("dragino-lht52")).toBe("LHT52 · thermomètre");
    expect(b("dragino-d20-lb")).toBe("D20-LB, D20S-LB · thermomètre 1 sonde");
    expect(b("dragino-d2x-lb")).toBe("D22-LB, D23-LB · thermomètre 2 ou 3 sondes");
    expect(b("dragino-lsn50v2-d20")).toBe("LSN50v2-D20 · thermomètre 1 sonde");
    expect(b("dragino-lsn50v2-d2x")).toBe("LSN50v2-D22, D23 · thermomètre 2 ou 3 sondes");
    expect(b("dragino-lds02")).toBe("LDS02 · détecteur d'ouverture");
    expect(nomCommercial(modele("dragino-d2x-lb")!)).toBe("Dragino D22-LB, D23-LB");
  });

  it("sondes de l'alambic : blanc, rouge, noir, sur un seul graphique", () => {
    const c = { dev_eui: "a84041000181b2c5", name: "Alambic", model_key: "dragino-lsn50v2-d2x", ttn_status: "connecte",
      last_values: { temp_white: { v: 20 }, temp_red: { v: 80 }, temp_black: { v: 60 }, battery_mv: { v: 3640 } } };
    const t = construireTableau({ slug: "f0001", display_name: "Saint-Thomas" }, [c], catalogue(), (m, n) => definition(m, n)) as any;
    const g = t.panels.find((x: any) => x.type === "timeseries");
    expect(g.title).toBe("Sonde blanche & Sonde rouge & Sonde noire");
    expect(g.fieldConfig.overrides.map((o: any) => o.properties.find((q: any) => q.id === "color").value.fixedColor)).toEqual(["text", "red", "#7c7c7c"]);
  });
  it("pile en % : même calcul dans le bot et dans Grafana", () => {
    const m = modele("dragino-lht52");
    expect(pourcentagePile(m, 2694)).toBe(55);
    expect(pileFaible(m, 2694)).toBe(false);
    expect(pileFaible(m, 2400)).toBe(true);
    expect(pourcentagePile(m, null)).toBeNull();
    expect(sqlPourcentage("v", [[3000, 100], [2000, 0]])).toBe("round(CASE WHEN v >= 3000 THEN 100 WHEN v >= 2000 THEN 0 + (v - 2000) * 100.0 / 1000 ELSE 0 END)");
  });
});
