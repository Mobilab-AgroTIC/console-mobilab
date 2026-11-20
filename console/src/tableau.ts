// Tableaux Grafana d'une ferme (spec V3 §9.5), fonctions pures : mêmes entrées, même sortie.
//  - « Mes capteurs » (page d'accueil) : un bloc par capteur, sur le modèle du tableau Saint Thomas de Simon :
//    toutes ses courbes sur un seul graphique, jauge de pile, courbe de pile, signal radio ;
//  - « Résumé » : état de tous les capteurs, piles et signal radio côte à côte.
import type { Catalogue, Modele, DefMesure } from "./catalogue.js";
import { nomCommercial } from "./catalogue.js";

/** Empreinte des mesures reçues par une ferme (« dev:mesure,… »), en SQL. Le tableau en dépend : une sonde branchée
 *  ou une nouvelle voie la change, et la surveillance refait alors le tableau. `ferme` : expression SQL du slug. */
export function sqlEmpreinte(ferme: string): string {
  return `(SELECT coalesce(string_agg(d.dev_eui || ':' || k, ',' ORDER BY d.dev_eui, k), '')
           FROM app.devices d, jsonb_object_keys(d.last_values) k WHERE d.tenant_slug = ${ferme} AND k <> 'resume')`;
}

export interface CapteurTableau { dev_eui: string; name: string; model_key: string | null; last_values: Record<string, unknown>;
  probes?: Record<string, unknown>; ttn_status: string }
type Ferme = { slug: string; display_name: string };
type Definition = (m: Modele, nom: string) => DefMesure | null;

const UNITES: Record<string, string> = {
  "°C": "celsius", "%": "percent", mV: "mvolt", V: "volt", kPa: "pressurekpa", lx: "lux", L: "litre", dBm: "dBm",
  min: "m", Pa: "pressurepa", hPa: "pressurehpa", ppm: "ppm",
};
// Couleurs par défaut, quand le catalogue n'en donne pas (champ « couleur » d'une mesure).
const COULEURS: Record<string, string> = { temperature: "green", humidity: "blue", temperature_probe: "yellow" };
// Échelle minimale de l'axe (Grafana l'élargit si les valeurs sortent) : reprise du tableau Saint Thomas.
const AXES: Record<string, [number, number]> = { "°C": [-5, 40], "%": [0, 100] };

// Seuils du signal radio, repris du tableau Saint Thomas pour le RSSI (dBm) : trop loin sous -120, très bon au-dessus de -50.
const SEUILS_RSSI = { mode: "absolute", steps: [{ color: "dark-red", value: null }, { color: "orange", value: -120 },
  { color: "#EAB839", value: -110 }, { color: "green", value: -80 }, { color: "#6ED0E0", value: -50 }] };
// SNR (dB) : bon au-dessus de 0, ça passe jusqu'à -10, à la limite en dessous.
const SEUILS_SNR = { mode: "absolute", steps: [{ color: "red", value: null }, { color: "orange", value: -10 }, { color: "green", value: 0 }] };

// Bulles d'aide (i) des graphiques, en markdown.
const AIDE = {
  pile: (aChanger: number) => "Niveau de pile au fil du temps, en %. Les couleurs suivent les seuils : vert au-dessus de 60 %, " +
    `jaune de 40 à 60 %, orange de ${aChanger} à 40 %, rouge sous ${aChanger} % : pile à changer.\n\n` +
    "Le froid fait baisser la tension : une petite baisse la nuit ou en hiver est normale.",
  signal: "Qualité de réception des messages de ce capteur par l'antenne (passerelle).\n\n" +
    "**RSSI** (dBm, axe de gauche, fond coloré) : puissance du signal reçu, de -50 (très bon) à -120 (faible). " +
    "En dessous de -120, le capteur est trop loin : des messages risquent de se perdre.\n\n" +
    "**SNR** (dB, axe de droite, pointillés) : netteté du signal par rapport au bruit. Au-dessus de 0, très bon ; " +
    "jusqu'à -10, ça passe ; en dessous, c'est la limite.",
  etat: (aChanger: number) => "Un capteur par ligne : dernières valeurs reçues, niveau de pile " +
    `(en rouge sous ${aChanger} % : à changer) et heure du dernier message. Un clic sur un en-tête trie le tableau.`,
  piles: (aChanger: number) => "Niveau de pile de chaque capteur, en %. Pointillés : 60 %, 40 % et " +
    `${aChanger} % ; sous ${aChanger} %, la pile est à changer.`,
  rssi: "Puissance du signal reçu de chaque capteur (dBm). Fond coloré : bleu au-dessus de -50 (très bon), vert jusqu'à -80, " +
    "jaune jusqu'à -110, orange jusqu'à -120, rouge en dessous : capteur trop loin, des messages se perdent.",
  snr: "Netteté du signal de chaque capteur par rapport au bruit (dB). Vert au-dessus de 0 (très bon), " +
    "orange de 0 à -10 (ça passe), rouge en dessous (à la limite).",
};

function uniteGrafana(u?: string): { unit?: string; suffixe?: string } {
  if (!u) return {};
  return UNITES[u] ? { unit: UNITES[u] } : { suffixe: u };
}

const sqlTexte = (s: string) => `'${s.replace(/'/g, "''")}'`;
const source = (slug: string) => ({ type: "grafana-postgresql-datasource", uid: `pg-${slug}` });

function cible(slug: string, sql: string, format: "time_series" | "table" = "time_series") {
  return { refId: "A", datasource: source(slug), editorMode: "code", format, rawQuery: true, rawSql: sql };
}

function definitionDe(m: Modele, nom: string, def?: Definition): DefMesure {
  return (def && def(m, nom)) || { nom, libelle: nom };
}

const trier = (capteurs: CapteurTableau[]) => capteurs.filter(c => c.ttn_status !== "supprime")
  .sort((a, b) => a.name.localeCompare(b.name, "fr") || a.dev_eui.localeCompare(b.dev_eui));

/** Expression SQL : tension (mV) → % restant, en suivant la courbe de la pile (piles.yaml).
 *  parPas5 : arrondi comme dans le bot (par 5 %, jamais 0 tant qu'il reste un peu). */
export function sqlPourcentage(v: string, courbe: [number, number][], parPas5 = false): string {
  const cas = [`WHEN ${v} >= ${courbe[0][0]} THEN 100`];
  for (let i = 1; i < courbe.length; i++) {
    const [mvH, pH] = courbe[i - 1], [mvB, pB] = courbe[i];
    cas.push(`WHEN ${v} >= ${mvB} THEN ${pB} + (${v} - ${mvB}) * ${pH - pB}.0 / ${mvH - mvB}`);
  }
  const p = `CASE ${cas.join(" ")} ELSE 0 END`;
  return parPas5 ? `(SELECT CASE WHEN p > 0 THEN greatest(5, round(p / 5) * 5) ELSE 0 END FROM (SELECT ${p} AS p) x)` : `round(${p})`;
}

/** Mesures tracées pour un capteur : celles des panneaux « courbe » et « voies » du modèle, déjà reçues. */
function mesuresTracees(m: Modele, recues: Set<string>): string[] {
  const noms: string[] = [];
  for (const p of m.grafana.panneaux || []) {
    if (p.type === "courbe") noms.push(...(p.mesures || []).filter(n => recues.has(n)));
    else if (p.type === "voies") noms.push(...[...recues].filter(n => /_(adc\d|sonde\d|in\d)$/.test(n) || /^brut_/.test(n)).sort());
  }
  return [...new Set(noms)];
}

/** Toutes les courbes d'un capteur sur un seul graphique : couleurs du catalogue, un axe par unité. */
function panneauCourbes(slug: string, c: CapteurTableau, defs: DefMesure[], m?: Modele) {
  const sql = `SELECT $__timeGroupAlias(time, $__interval), metric, avg(value) AS value\nFROM public.measures\n` +
    `WHERE $__timeFilter(time)\n  AND dev_eui = ${sqlTexte(c.dev_eui)}\n  AND metric IN (${defs.map(d => sqlTexte(d.nom)).join(", ")})\n` +
    `GROUP BY 1, 2\nORDER BY 1`;
  const unites = new Set(defs.filter(d => !/^brut_/.test(d.nom)).map(d => d.unite || ""));
  const overrides = defs.map(d => {
    const u = uniteGrafana(d.unite);
    const props: any[] = [{ id: "displayName", value: d.libelle || d.nom }];
    if (u.unit) props.push({ id: "unit", value: u.unit });
    if (u.suffixe) props.push({ id: "unit", value: `suffix: ${u.suffixe}` });
    if (d.decimales !== undefined) props.push({ id: "decimals", value: d.decimales });
    const couleur = d.couleur || COULEURS[d.nom];
    if (couleur) props.push({ id: "color", value: { mode: "fixed", fixedColor: couleur } });
    if (unites.size > 1) props.push({ id: "custom.axisPlacement", value: d.unite === "%" ? "left" : "right" });
    const axe = AXES[d.unite || ""];
    if (axe) props.push({ id: "custom.axisSoftMin", value: axe[0] }, { id: "custom.axisSoftMax", value: axe[1] });
    if (d.type === "etat") props.push({ id: "custom.lineInterpolation", value: "stepAfter" });
    // Tension brute d'une entrée : dans la légende (un clic l'affiche), pas sur le graphique.
    if (/^brut_/.test(d.nom)) props.push({ id: "custom.hideFrom", value: { legend: false, tooltip: false, viz: true } });
    return { matcher: { id: "byName", options: d.nom }, properties: props };
  });
  const libelles = defs.filter(d => !/^brut_/.test(d.nom)).map(d => d.libelle || d.nom);
  const visibles = defs.filter(d => !/^brut_/.test(d.nom));
  const axes = unites.size > 1
    ? ` À gauche : ${visibles.filter(d => d.unite === "%").map(d => d.libelle || d.nom).join(", ")}. ` +
      `À droite : ${visibles.filter(d => d.unite !== "%").map(d => d.libelle || d.nom).join(", ")}.` : "";
  const description = `Mesures de ce capteur${m ? ` (${nomCommercial(m)})` : ""}.${axes}\n\n` +
    "Chaque point est la moyenne de l'intervalle affiché : zoomez pour voir chaque mesure. " +
    "Un clic sur un nom de la légende n'affiche que cette courbe.";
  return {
    type: "timeseries", title: libelles.length <= 3 ? libelles.join(" & ") : `${libelles.slice(0, 2).join(" & ")}…`,
    description, datasource: source(slug), targets: [cible(slug, sql)],
    fieldConfig: {
      defaults: {
        color: { mode: "palette-classic" },
        custom: { drawStyle: "line", lineInterpolation: "smooth", lineWidth: 2, fillOpacity: 20, gradientMode: "opacity",
          showPoints: "auto", pointSize: 5, spanNulls: 3600000, axisColorMode: "series" },
      },
      overrides,
    },
    options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "none" } },
  };
}

/** Seuils de couleur de la pile en % : rouge sous le seuil « à changer », puis orange, jaune, vert. */
const seuilsPile = (aChanger: number) => ({ mode: "absolute", steps: [{ color: "red", value: null }, { color: "orange", value: aChanger },
  { color: "#EAB839", value: 40 }, { color: "green", value: 60 }] });

/** Dernière tension de pile : le % pour la jauge, et la tension en texte (« 2,99 V »). En série temporelle, Grafana fait
 *  de cette colonne texte une étiquette du champ « Pile », que la jauge affiche en petit sous le pourcentage. */
function sqlDernierePile(c: CapteurTableau, m: Modele): string {
  const courbe = m.batterie?.courbe;
  const valeur = courbe ? sqlPourcentage("value", courbe, true) : "value";
  const tension = courbe ? `, replace(to_char(value / 1000.0, 'FM0.00'), '.', ',') || ' V' AS tension` : "";
  return `SELECT time, ${valeur} AS "Pile"${tension}\nFROM public.measures\n` +
    `WHERE dev_eui = ${sqlTexte(c.dev_eui)} AND metric = 'battery_mv'\nORDER BY time DESC\nLIMIT 1`;
}

function aideJauge(m: Modele, cat: Catalogue, aChanger: number): string {
  const b = m.batterie || {};
  const pile = b.pile ? cat.piles?.piles?.[b.pile] : undefined;
  const quoi = pile ? `\n\nCe capteur fonctionne avec ${Number(b.elements || 1) > 1 ? `${b.elements} × ` : ""}${pile.libelle || b.pile}. ${pile.aide || ""}` : "";
  return "Niveau de pile estimé d'après la dernière tension reçue (en petit sous le pourcentage) et la courbe d'usure de la pile : " +
    `le pourcentage suit ce qui reste, pas la tension.${quoi}\n\nSous ${aChanger} %, la pile est à changer ` +
    "(une alerte arrive aussi dans Telegram).";
}

/** Jauge : dernier niveau de pile connu, en %, et la tension sous le pourcentage (nom affiché = étiquette « tension »). */
function panneauJaugePile(slug: string, c: CapteurTableau, m: Modele, aChanger: number, cat: Catalogue) {
  const courbe = m.batterie?.courbe;
  return {
    type: "gauge", title: "Pile", description: aideJauge(m, cat, aChanger), datasource: source(slug),
    targets: [cible(slug, sqlDernierePile(c, m))],
    fieldConfig: {
      defaults: courbe ? { unit: "percent", min: 0, max: 100, decimals: 0, color: { mode: "thresholds" }, thresholds: seuilsPile(aChanger),
          displayName: "${__field.labels.tension}" }
        : { unit: "mvolt", decimals: 0, color: { mode: "thresholds" },
            thresholds: { mode: "absolute", steps: [{ color: "red", value: null }, { color: "green", value: Number(m.batterie?.faible_mv || 0) }] } },
      overrides: [],
    },
    options: { reduceOptions: { values: false, calcs: ["lastNotNull"], fields: "" }, showThresholdMarkers: true,
      showThresholdLabels: false, orientation: "auto", text: { titleSize: 14 } },
  };
}

/** Courbe de pile d'un capteur, en % : ligne et remplissage aux couleurs des seuils, seuils en pointillés. */
function panneauBatterie(slug: string, c: CapteurTableau, m: Modele, aChanger: number) {
  const courbe = m.batterie?.courbe;
  const valeur = courbe ? sqlPourcentage("avg(value)", courbe) : "avg(value)";
  const sql = `SELECT $__timeGroupAlias(time, $__interval), ${valeur} AS "Pile"\nFROM public.measures\n` +
    `WHERE $__timeFilter(time)\n  AND dev_eui = ${sqlTexte(c.dev_eui)}\n  AND metric = 'battery_mv'\nGROUP BY 1\nORDER BY 1`;
  const seuils = courbe ? seuilsPile(aChanger)
    : { mode: "absolute", steps: [{ color: "red", value: null }, { color: "green", value: Number(m.batterie?.faible_mv || 2800) }] };
  return {
    type: "timeseries", title: "Pile", description: AIDE.pile(aChanger), datasource: source(slug), targets: [cible(slug, sql)],
    fieldConfig: {
      defaults: {
        ...(courbe ? { unit: "percent", min: 0, max: 100 } : { unit: "mvolt" }), decimals: 0, color: { mode: "thresholds" },
        thresholds: seuils,
        custom: { drawStyle: "line", lineInterpolation: "linear", lineWidth: 2, fillOpacity: 25, gradientMode: "scheme",
          showPoints: "always", pointSize: 4, spanNulls: 2 * 86400000, thresholdsStyle: { mode: "dashed" } },
      },
      overrides: [],
    },
    options: { legend: { showLegend: false, displayMode: "list", placement: "bottom" }, tooltip: { mode: "single", sort: "none" } },
  };
}

/** Signal radio d'un capteur : RSSI (dBm, à gauche, fond aux couleurs des seuils) et SNR (dB, à droite, pointillés). */
function panneauSignal(slug: string, c: CapteurTableau) {
  const sql = `SELECT $__timeGroupAlias(time, $__interval), avg(rssi) AS "RSSI", avg(snr) AS "SNR"\nFROM public.uplinks\n` +
    `WHERE $__timeFilter(time)\n  AND dev_eui = ${sqlTexte(c.dev_eui)}\nGROUP BY 1\nORDER BY 1`;
  const serie = (nom: string, props: { id: string; value: unknown }[]) => ({ matcher: { id: "byName", options: nom }, properties: props });
  return {
    type: "timeseries", title: "Signal radio", description: AIDE.signal, datasource: source(slug), targets: [cible(slug, sql)],
    fieldConfig: {
      defaults: { decimals: 1, custom: { drawStyle: "line", lineInterpolation: "smooth", lineWidth: 2, fillOpacity: 0,
        showPoints: "never", spanNulls: 86400000, thresholdsStyle: { mode: "off" } } },
      overrides: [
        serie("RSSI", [{ id: "unit", value: "dBm" }, { id: "decimals", value: 0 }, { id: "color", value: { mode: "fixed", fixedColor: "text" } },
          { id: "custom.axisPlacement", value: "left" }, { id: "custom.axisSoftMin", value: -130 }, { id: "custom.axisSoftMax", value: -40 },
          { id: "thresholds", value: SEUILS_RSSI }, { id: "custom.thresholdsStyle", value: { mode: "area" } }]),
        serie("SNR", [{ id: "unit", value: "dB" }, { id: "color", value: { mode: "fixed", fixedColor: "purple" } },
          { id: "custom.axisPlacement", value: "right" }, { id: "custom.axisSoftMin", value: -20 }, { id: "custom.axisSoftMax", value: 15 },
          { id: "custom.lineWidth", value: 1 }, { id: "custom.lineStyle", value: { fill: "dash", dash: [10, 10] } }]),
      ] },
    options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "none" } },
  };
}

/** Courbes de toute la ferme, une par capteur (RSSI ou SNR, pour le résumé). */
function panneauRadio(slug: string, champ: "rssi" | "snr") {
  const sql = `SELECT $__timeGroupAlias(u.time, $__interval), c.name AS metric, avg(u.${champ}) AS value\n` +
    `FROM public.uplinks u JOIN public.capteurs c USING (dev_eui)\nWHERE $__timeFilter(u.time) AND c.ttn_status <> 'supprime'\n` +
    `GROUP BY 1, 2\nORDER BY 1`;
  const rssi = champ === "rssi";
  return {
    type: "timeseries", title: rssi ? "Signal radio : RSSI (dBm)" : "Signal radio : SNR (dB)", description: rssi ? AIDE.rssi : AIDE.snr,
    datasource: source(slug), targets: [cible(slug, sql)],
    fieldConfig: { defaults: { unit: rssi ? "dBm" : "dB", decimals: rssi ? 0 : 1, thresholds: rssi ? SEUILS_RSSI : SEUILS_SNR,
      custom: { drawStyle: "line", lineInterpolation: "smooth", lineWidth: 2, fillOpacity: 0, showPoints: "never", spanNulls: 86400000,
        thresholdsStyle: { mode: "area" }, axisSoftMin: rssi ? -130 : -20, axisSoftMax: rssi ? -40 : 15 } }, overrides: [] },
    options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "none" } },
  };
}

/** Modèles de la ferme qui ont une courbe de pile, pour les CASE model_key. */
function modelesAvecCourbe(actifs: CapteurTableau[], cat: Catalogue): Modele[] {
  return [...new Set(actifs.map(c => c.model_key).filter((k): k is string => Boolean(k)))].sort()
    .map(k => cat.modeles.get(k)).filter(m => m?.batterie?.courbe) as Modele[];
}

const liens = (slug: string, vers: "resume" | "capteurs") => [{
  title: vers === "resume" ? "Résumé" : "Mes capteurs", type: "link", icon: "dashboard", keepTime: true, targetBlank: false,
  url: `/d/${vers}-${slug}`, tooltip: "", tags: [], asDropdown: false, includeVars: false,
}];

const enveloppe = (uid: string, titre: string, panels: any[], links: unknown[]) => ({
  uid, title: titre, tags: ["mobilab"], editable: false, timezone: "Europe/Paris", refresh: "5m",
  time: { from: "now-7d", to: "now" }, schemaVersion: 39, version: 0, panels, links,
  templating: { list: [] }, annotations: { list: [] },
});

/**
 * « Mes capteurs », page d'accueil de la ferme : un bloc par capteur (rangée à son nom).
 * À gauche toutes ses courbes ; à droite la jauge de pile, la courbe de pile et le signal radio.
 * Une mesure jamais reçue (absente de last_values) n'est pas tracée ; un capteur sans modèle ni mesure n'a pas de bloc.
 */
export function construireTableau(ferme: Ferme, capteurs: CapteurTableau[], cat: Catalogue, definition: Definition): Record<string, unknown> {
  const slug = ferme.slug;
  const aChanger = cat.piles?.a_changer_pct ?? 20;
  const panneaux: any[] = [];
  let id = 1, y = 0;
  const poser = (p: any, x: number, yy: number, w: number, h: number) => { p.id = id++; p.gridPos = { h, w, x, y: yy }; panneaux.push(p); };

  for (const c of trier(capteurs)) {
    const m = c.model_key ? cat.modeles.get(c.model_key) : null;
    if (!m) continue;
    const recues = new Set(Object.keys(c.last_values || {}).filter(k => k !== "resume"));
    if (!recues.size) continue;
    const noms = mesuresTracees(m, recues);
    const pile = recues.has("battery_mv") && (m.grafana.panneaux || []).some(p => p.type === "batterie");
    const radio = (m.grafana.panneaux || []).some(p => p.type === "radio");
    if (!noms.length && !pile && !radio) continue;

    poser({ type: "row", title: c.name, collapsed: false, panels: [] }, 0, y, 24, 1);
    const haut = y + 1;
    const largeurCourbes = pile ? 12 : 15;
    if (noms.length) poser(panneauCourbes(slug, c, noms.map(n => definitionDe(m, n, definition)), m), 0, haut, largeurCourbes, 8);
    const x = noms.length ? largeurCourbes : 0;
    if (pile) poser(panneauJaugePile(slug, c, m, aChanger, cat), x, haut, 3, 8);
    const xDroite = pile ? x + 3 : x, wDroite = 24 - xDroite;
    if (pile && radio) {
      poser(panneauBatterie(slug, c, m, aChanger), xDroite, haut, wDroite, 4);
      poser(panneauSignal(slug, c), xDroite, haut + 4, wDroite, 4);
    } else if (pile) poser(panneauBatterie(slug, c, m, aChanger), xDroite, haut, wDroite, 8);
    else if (radio) poser(panneauSignal(slug, c), xDroite, haut, wDroite, 8);
    y = haut + 8;
  }
  if (!panneaux.length) {
    poser({ type: "text", title: "", options: { mode: "markdown",
      content: "Aucune mesure pour l'instant : les courbes apparaîtront ici dès le premier message de vos capteurs." } }, 0, 0, 24, 3);
  }
  return enveloppe(`capteurs-${slug}`, "Mes capteurs", panneaux, liens(slug, "resume"));
}

/** « Résumé » : état de chaque capteur (dernières valeurs, pile, dernier message), piles et signal radio de la ferme. */
export function construireResume(ferme: Ferme, capteurs: CapteurTableau[], cat: Catalogue): Record<string, unknown> {
  const slug = ferme.slug;
  const actifs = trier(capteurs);
  const aChanger = cat.piles?.a_changer_pct ?? 20;
  const panneaux: any[] = [];
  let id = 1;
  const poser = (p: any, x: number, y: number, w: number, h: number) => { p.id = id++; p.gridPos = { h, w, x, y }; panneaux.push(p); };

  poser({ type: "text", title: "", options: { mode: "markdown",
    content: "Ces tableaux se mettent à jour tout seuls. Pour en faire votre version, utilisez « Enregistrer sous »." } }, 0, 0, 24, 2);

  // Pile en % selon la courbe de chaque modèle (un modèle sans courbe : case vide).
  const avecCourbe = modelesAvecCourbe(actifs, cat);
  const pileCase = (v: string, pas5: boolean, colonne = "model_key") => avecCourbe.length
    ? `CASE ${colonne} ${avecCourbe.map(m => `WHEN ${sqlTexte(m.cle)} THEN ${sqlPourcentage(v, m.batterie!.courbe!, pas5)}`).join("\n         ")} END`
    : "NULL::numeric";
  const sqlEtat = `SELECT name AS "Capteur", last_values->>'resume' AS "Dernières valeurs",\n` +
    `       ${pileCase("battery_mv", true)} AS "Pile", last_seen AS "Vu"\nFROM public.capteurs WHERE ttn_status <> 'supprime' ORDER BY name`;
  const hEtat = Math.min(16, 4 + Math.max(1, actifs.length));   // titre, en-tête, puis une ligne par capteur
  poser({
    type: "table", title: actifs.length ? "État de mes capteurs" : "Aucun capteur pour l'instant.", description: AIDE.etat(aChanger),
    datasource: source(slug),
    targets: [cible(slug, sqlEtat, "table")],
    fieldConfig: { defaults: {}, overrides: [
      { matcher: { id: "byName", options: "Pile" }, properties: [{ id: "unit", value: "percent" }, { id: "decimals", value: 0 },
        { id: "color", value: { mode: "thresholds" } }, { id: "custom.cellOptions", value: { type: "color-text" } },
        { id: "thresholds", value: seuilsPile(aChanger) }] },
      { matcher: { id: "byName", options: "Vu" }, properties: [{ id: "unit", value: "dateTimeFromNow" }] },
    ] },
    options: { showHeader: true, cellHeight: "sm" },
  }, 0, 2, 24, hEtat);

  const y = 2 + hEtat;
  if (avecCourbe.length) {
    const sqlPiles = `SELECT $__timeGroupAlias(m.time, $__interval), c.name AS metric, ${pileCase("avg(m.value)", false, "c.model_key")} AS value\n` +
      `FROM public.measures m JOIN public.capteurs c USING (dev_eui)\n` +
      `WHERE $__timeFilter(m.time) AND m.metric = 'battery_mv' AND c.ttn_status <> 'supprime'\nGROUP BY 1, 2, c.model_key\nORDER BY 1`;
    poser({
      type: "timeseries", title: "Piles", description: AIDE.piles(aChanger), datasource: source(slug), targets: [cible(slug, sqlPiles)],
      fieldConfig: { defaults: { unit: "percent", min: 0, max: 100, decimals: 0, thresholds: seuilsPile(aChanger),
        custom: { drawStyle: "line", lineInterpolation: "linear", lineWidth: 2, fillOpacity: 0, showPoints: "always", pointSize: 3,
          spanNulls: 2 * 86400000, thresholdsStyle: { mode: "dashed" } } },
        overrides: [] },
      options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "none" } },
    }, 0, y, 8, 8);
  }
  const x0 = avecCourbe.length ? 8 : 0, w = avecCourbe.length ? 8 : 12;
  poser(panneauRadio(slug, "rssi"), x0, y, w, 8);
  poser(panneauRadio(slug, "snr"), x0 + w, y, w, 8);
  return enveloppe(`resume-${slug}`, "Résumé", panneaux, liens(slug, "capteurs"));
}
