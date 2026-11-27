// Le service lit le même catalogue que Node-RED, avec le même code (module ingest/, spec V3 §7.8) :
// libellés, unités, seuils proposés, panneaux Grafana, actions, sondes.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { texteIntervalle } from "./format.js";

const require = createRequire(import.meta.url);

export interface DefMesure { nom: string; emoji?: string; couleur?: string; libelle?: string; unite?: string; decimales?: number; type?: string;
  etats?: Record<string, string>; alerte?: string; hysteresis?: number; principale?: boolean;
  seuils_proposes?: { min?: number[]; max?: number[] }; sonde?: boolean }
export interface Modele { cle: string; prefixe_id?: string; marque: string; modele: string; libelle: string; bouton?: string; type: string;
  categorie?: string;
  ordre?: number; allumage?: string; dr?: Record<string, string>; lorawan: { mac?: string; phy?: string; classe?: string };
  ports: Record<string, string>; intervalle_defaut_s: number; delai_connexion_min?: number;
  batterie?: { faible_mv?: number; pile?: string; elements?: number; courbe?: [number, number][] }; mode?: Record<string, unknown>;
  modes?: Record<string, { libelle?: string; mesures?: string[]; voies?: Record<string, string>; demander_sondes?: boolean }>;
  mesures: Record<string, DefMesure>; type_voies?: Record<string, string>;
  grafana: { panneaux: { type: string; mesures?: string[] }[] };
  actions?: Action[]; variantes?: string[]; trame?: { format?: string } }
export interface Action { cle: string; bouton: string; f_port: number; payload_hex: string; confirmed?: boolean;
  classe?: string; delai_typique_min?: number; expire_min?: number; etat_attendu?: { metric: string; value: number } }
export interface Sonde { libelle: string; pour: string[]; mesure?: string; libelle_mesure?: string; unite?: string;
  decimales?: number; brut_seulement?: boolean; alerte?: string; seuils_proposes?: { min?: number[]; max?: number[] };
  hysteresis?: number }
export interface Catalogue { dir: string; version: string; modeles: Map<string, Modele>; parDr: Map<string, string>;
  parPort5: Map<number, string>; sondes: Record<string, Sonde>; ordreSondes: string[];
  piles: { a_changer_pct: number; piles: Record<string, { libelle?: string; aide?: string; courbe: [number, number][] }> } }

type Ingest = {
  catalogue: { charger(dir: string): Catalogue; pourcentagePile(m: Modele | null, mv: number | null): number | null;
               pourcentageBrut(m: Modele | null, mv: number | null): number | null };
  normaliser: { definitionMesure(cat: Catalogue, m: Modele | null, nom: string): DefMesure | null;
                resume(cat: Catalogue, m: Modele | null, v: Record<string, { v: number }>): string };
  format: { nombre(v: number, d?: number): string; avecUnite(v: number, def?: DefMesure | null): string;
            heure(d: Date | string): string; jour(d: Date | string): string; duree(ms: number): string;
            echapper(s: string): string };
  alertes: { rediger(T: unknown, cat: Catalogue, notif: unknown, ctx: unknown): string;
             boutons(T: unknown, notif: unknown, o?: unknown): unknown;
             delaiSilence(o: { intervalle_s?: number | null; mesure_s?: number | null; delai_min?: number | null }): number };
};

let ingest: Ingest | null = null;
export function moduleIngest(dir?: string): Ingest {
  if (!ingest) ingest = require(path.resolve(dir || process.env.INGEST_DIR || path.join(process.cwd(), "..", "ingest"))) as Ingest;
  return ingest;
}

let courant: Catalogue | null = null;

export function chargerCatalogue(dir: string, ingestDir?: string): Catalogue {
  const c = moduleIngest(ingestDir).catalogue.charger(dir);
  courant = c;
  return c;
}

export function catalogue(): Catalogue {
  if (!courant) throw new Error("catalogue non chargé");
  return courant;
}

export function versionSurDisque(dir: string): string | null {
  try { return fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim(); } catch { return null; }
}

export function modele(cle: string | null | undefined): Modele | null {
  return (cle && catalogue().modeles.get(cle)) || null;
}

/** % de pile restant estimé d'après la courbe de la pile du modèle (piles.yaml), par pas de 5 ; null si inconnu. */
export function pourcentagePile(m: Modele | null, mv: number | null | undefined): number | null {
  return mv ? moduleIngest().catalogue.pourcentagePile(m, mv) : null;
}

/** Pile sous le seuil « à changer » (tiré de la courbe, ou faible_mv du modèle). */
export function pileFaible(m: Modele | null, mv: number | null | undefined): boolean {
  const faible = Number(m?.batterie?.faible_mv || 0);
  return Boolean(mv && faible && mv < faible);
}

export function definition(m: Modele | null, nom: string): DefMesure | null {
  return moduleIngest().normaliser.definitionMesure(catalogue(), m, nom);
}

/** Modèles proposés à la question « Quel est ce capteur ? » (champ ordre, spec §4.4). Dragino d'abord si A84041. */
export const libelleModele = (m: Modele) => m.bouton || m.modele;

/** Le libellé est « usage + marque + modèle » (« Thermomètre 1 sonde Dragino D20-LB ») : on le coupe à la marque. */
function coupeLibelle(m: Modele): { usage: string; nom: string } {
  const i = m.marque ? m.libelle.indexOf(m.marque) : -1;
  return i > 0 ? { usage: m.libelle.slice(0, i).trim(), nom: m.libelle.slice(i) } : { usage: "", nom: m.libelle };
}
/** « Dragino D22-LB, D23-LB » : sous le nom du capteur, sur sa fiche. */
export const nomCommercial = (m: Modele) => coupeLibelle(m).nom;

/** Bouton d'un modèle, un par ligne : le code de l'étiquette puis l'usage (« LHT52 · thermomètre »). */
export function boutonModele(m: Modele): string {
  const code = libelleModele(m).replace(/\s*\(.*\)$/, "");
  const { usage } = coupeLibelle(m);
  return usage ? `${code} · ${usage.charAt(0).toLowerCase()}${usage.slice(1)}` : code;
}
const parLibelle = (a: Modele, b: Modele) => libelleModele(a).localeCompare(libelleModele(b), "fr", { numeric: true, sensitivity: "base" });

/** Modèles proposés à la question « Quel est ce capteur ? » : tout le catalogue hors montages maison, par ordre alphabétique. */
export function modelesProposes(_devEui?: string): Modele[] {
  return [...catalogue().modeles.values()].filter(m => m.marque !== "Mobilab").sort(parLibelle);
}

// Marques proposées à l'ajout d'un capteur : tirées du catalogue, donc un nouveau fichier de modèle
// (nouvelle marque comprise) apparaît tout seul dans le bot, dès le rechargement du catalogue.
const LIBELLE_MARQUE: Record<string, string> = { Mobilab: "Auto-construit" };
const MARQUES_TOUJOURS = ["Dragino", "Milesight", "Mobilab"];

export const cleMarque = (m: string) => m.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
export const libelleMarque = (m: string | null | undefined) => (m ? LIBELLE_MARQUE[m] || m : "Autre");

export function marques(): { cle: string; bouton: string; marque: string | null }[] {
  const noms = new Set([...MARQUES_TOUJOURS, ...[...catalogue().modeles.values()].map(m => m.marque)]);
  const l = [...noms].map(m => ({ cle: cleMarque(m), bouton: libelleMarque(m), marque: m as string | null }))
    .sort((a, b) => a.bouton.localeCompare(b.bouton, "fr"));
  return [...l, { cle: "autre", bouton: "Autre", marque: null }];
}

/** Types d'une marque, par ordre alphabétique ; ceux d'une catégorie seulement si elle est donnée. */
export function typesDeMarque(cle: string, categorie?: string): Modele[] {
  const marque = marques().find(x => x.cle === cle)?.marque;
  if (!marque) return [];
  return [...catalogue().modeles.values()].filter(m => m.marque === marque && (!categorie || (m.categorie || "autre") === categorie))
    .sort(parLibelle);
}

/** Catégories du choix du type, dans cet ordre (champ « categorie » des fiches ; choix du 19/11 : pas de « sol »). */
export const CATEGORIES = ["temperature", "niveau", "porte", "autre"] as const;

/** Catégories à proposer avant le type : seulement pour une marque à plus de 8 types, rangés dans 2 catégories au moins. */
export function categoriesDeMarque(cle: string): string[] {
  if (typesDeMarque(cle).length <= 8) return [];
  const l = CATEGORIES.filter(c => typesDeMarque(cle, c).length > 0);
  return l.length >= 2 ? l : [];
}

/** Changement de l'intervalle d'envoi par downlink : « 01 » puis les secondes sur 3 octets, poids fort en premier
 *  (commande TDC des Dragino, reprise par les montages au format Mobilab), sur le port 1. De 1 min à 7 jours. */
export const INTERVALLE = { f_port: 1, min_s: 60, max_s: 7 * 86400, proposes_s: [60, 180, 300, 600, 1200, 3600, 21600, 43200, 86400] };

export function intervalleReglable(m: Modele | null): boolean {
  return Boolean(m && (m.marque === "Dragino" || m.trame?.format === "mobilab"));
}

export function ordreIntervalle(secondes: number): string {
  return "01" + Math.round(secondes).toString(16).padStart(6, "0");
}

/** Secondes d'un ordre d'intervalle (action « intervalle:1200 »), null pour un autre ordre. */
export function secondesOrdre(action: string): number | null {
  const m = /^intervalle:(\d+)$/.exec(action || "");
  return m ? Number(m[1]) : null;
}

/** Libellé d'un ordre : bouton du catalogue, « Intervalle d'envoi 20 min », sinon sa clé. */
export function actionDe(d: any, cle: string): string {
  const s = secondesOrdre(cle);
  if (s !== null) return `Intervalle d'envoi ${texteIntervalle(s)}`;
  const m = modele(d?.model_key);
  const a = [...(m?.actions || []), ...((d?.config?.actions || []) as any[])].find((x: any) => x.cle === cle);
  return a?.bouton || cle;
}

export function montagesMobilab(): Modele[] {
  return [...catalogue().modeles.values()].filter(m => m.marque === "Mobilab").sort((a, b) => (a.ordre ?? 99) - (b.ordre ?? 99));
}

/** Mesures sur lesquelles le bot propose une alerte (seuil ou débit), la principale d'abord (spec §8.2). */
export function mesuresAlertables(m: Modele | null, valeurs: Record<string, unknown>): DefMesure[] {
  const res: DefMesure[] = [];
  const vus = new Set<string>();
  const defs = Object.values(m?.mesures || {}).filter(d => d.alerte === "seuil" || d.alerte === "debit");
  defs.sort((a, b) => Number(Boolean(b.principale)) - Number(Boolean(a.principale)));
  for (const d of defs) if (valeurs[d.nom] !== undefined && !vus.has(d.nom)) { res.push(d); vus.add(d.nom); }
  for (const nom of Object.keys(valeurs)) {
    const d = definition(m, nom);
    if (d && d.sonde && d.alerte === "seuil" && !vus.has(nom)) { res.push({ ...d, nom }); vus.add(nom); }
  }
  return res;
}

/** Modes proposés pour le forçage, avec des libellés simples (spec §4.5). */
export function modesDe(m: Modele | null): { code: string; libelle: string }[] {
  return Object.entries(m?.modes || {}).map(([code, x]) => ({ code, libelle: x.libelle || code }));
}

/** Voies d'un mode (entrées où se branche une sonde). */
export function voiesDe(m: Modele | null, mode: string | null): string[] {
  if (!m) return [];
  if (mode && m.modes?.[mode]?.voies) return Object.keys(m.modes[mode].voies!);
  const toutes = new Set<string>();
  for (const x of Object.values(m.modes || {})) for (const v of Object.keys(x.voies || {})) toutes.add(v);
  return [...toutes];
}

/** Sondes compatibles avec une voie : celles de sondes.yaml qui acceptent son type (spec §7.6). */
export function sondesPour(m: Modele | null, voie: string): { cle: string; rang: number; sonde: Sonde }[] {
  const type = m?.type_voies?.[voie];
  const cat = catalogue();
  return cat.ordreSondes.map((cle, rang) => ({ cle, rang, sonde: cat.sondes[cle] }))
    .filter(x => !type || x.sonde.pour.includes(type));
}
