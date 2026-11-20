// Codes de l'étiquette (spec V3 §4.4) : nettoyage, contrôle, affichage par groupes de 4.

/** Retire espaces, tirets, deux-points et « 0x » ; O → 0, I et L → 1 ; majuscules. */
export function nettoyer(saisie: string): string {
  return String(saisie || "")
    .replace(/0x/gi, "")
    .replace(/[\s\-:._]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export type Champ = "appeui" | "appkey" | "deveui";

export type Resultat =
  | { ok: true; valeur: string }
  | { ok: false; erreur: "longueur16" | "longueur32" | "interdit"; recu: number }
  | { ok: false; erreur: "appkey_a_la_place"; valeur: string };

export function controler(champ: Champ, saisie: string): Resultat {
  const v = nettoyer(saisie);
  const hex = /^[0-9A-F]+$/.test(v);
  if (champ === "appkey") {
    return v.length === 32 && hex ? { ok: true, valeur: v } : { ok: false, erreur: "longueur32", recu: v.length };
  }
  if (v.length === 32 && hex) return { ok: false, erreur: "appkey_a_la_place", valeur: v };
  if (v.length !== 16 || !hex) return { ok: false, erreur: "longueur16", recu: v.length };
  if (champ === "deveui" && (/^0+$/.test(v) || /^F+$/.test(v))) return { ok: false, erreur: "interdit", recu: 16 };
  return { ok: true, valeur: v };
}

/** « A840 41F2 1C5B 3D2E » */
export function groupes(code: string | null | undefined): string {
  return String(code || "").toUpperCase().replace(/(.{4})(?=.)/g, "$1 ");
}

/** « A840…3D2E » pour les notifications admin. */
export function court(code: string): string {
  const c = String(code || "").toUpperCase();
  return c.length > 8 ? `${c.slice(0, 4)}…${c.slice(-4)}` : c;
}

/**
 * Lit les codes collés en un seul message (raccourci admin, spec §5.8) : 32 caractères = AppKey,
 * premier code de 16 = AppEUI, second = DevEUI.
 */
export function rangerCodes(texte: string): { appeui?: string; appkey?: string; deveui?: string } {
  const morceaux = String(texte).split(/[\s;,\t\n]+/).map(nettoyer).filter(m => /^[0-9A-F]+$/.test(m));
  const r: { appeui?: string; appkey?: string; deveui?: string } = {};
  for (const m of morceaux) {
    if (m.length === 32 && !r.appkey) r.appkey = m;
    else if (m.length === 16 && !r.appeui) r.appeui = m;
    else if (m.length === 16 && !r.deveui) r.deveui = m;
  }
  return r;
}

export interface LigneCapteur { ligne: number; nom: string; appeui?: string; appkey?: string; deveui?: string;
  modele?: string; erreurs: string[] }

/**
 * Liste collée ou fichier .csv (spec §5.8) : une ligne par capteur, « nom ; AppEUI ; AppKey ; DevEUI ; modèle ».
 * Séparateurs ; tabulation ou virgule. Une première ligne de titres impose l'ordre des colonnes.
 */
export function lireListe(texte: string): LigneCapteur[] {
  const lignes = String(texte).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lignes.length) return [];
  const sep = lignes[0].includes(";") ? ";" : lignes[0].includes("\t") ? "\t" : ",";
  let ordre = ["nom", "appeui", "appkey", "deveui", "modele"];
  let debut = 0;
  const titres = lignes[0].split(sep).map(t => t.trim().toLowerCase().replace(/[^a-z]/g, ""));
  if (titres.some(t => ["nom", "name", "appeui", "joineui", "appkey", "deveui"].includes(t))) {
    ordre = titres.map(t => (t === "joineui" ? "appeui" : t === "name" ? "nom" : t === "model" ? "modele" : t));
    debut = 1;
  }
  const res: LigneCapteur[] = [];
  for (let i = debut; i < lignes.length; i++) {
    const cols = lignes[i].split(sep).map(c => c.trim());
    const get = (k: string) => { const j = ordre.indexOf(k); return j >= 0 ? cols[j] || "" : ""; };
    const l: LigneCapteur = { ligne: i + 1, nom: get("nom"), erreurs: [], modele: get("modele") || undefined };
    if (!l.nom || l.nom.length > 40) l.erreurs.push("nom de 1 à 40 caractères");
    for (const champ of ["appeui", "appkey", "deveui"] as Champ[]) {
      const r = controler(champ, get(champ));
      if (r.ok) l[champ] = r.valeur;
      else {
        const attendu = champ === "appkey" ? 32 : 16;
        const nom = champ === "appeui" ? "AppEUI" : champ === "appkey" ? "AppKey" : "DevEUI";
        l.erreurs.push(`${nom} de ${"recu" in r ? r.recu : nettoyer(get(champ)).length} caractères, ${attendu} attendus`);
      }
    }
    res.push(l);
  }
  return res;
}

export function ressembleAUneListe(texte: string): boolean {
  const lignes = String(texte).split(/\r?\n/).filter(l => l.trim());
  return lignes.length > 1 || /[;\t]/.test(texte);
}
