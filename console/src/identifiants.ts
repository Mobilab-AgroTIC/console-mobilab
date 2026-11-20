// Identifiants lisibles dans The Things Stack (choix de Simon, 19/11/2026) :
//  - application : nom de la ferme suivi de son numéro sur 6 chiffres (« saint-thomas-000001 ») ;
//  - capteur : type suivi des 4 derniers caractères du DevEUI (« lht52-ff32 ») ; type inconnu : « autre-ff32 ».
// Les fermes ne voient jamais TTS : les rôles Postgres et les uid Grafana gardent le code neutre f0001 (spec §6.2).

/** Motif des identifiants TTS : minuscules, chiffres, tirets simples, 3 à 36 caractères. */
export const ID_TTS = /^[a-z0-9](?:-?[a-z0-9]){2,35}$/;

/** « Ferme des Prés » → « ferme-des-pres » (sans accents, `max` caractères au plus). */
export function idDepuisNom(nom: string, max = 36): string {
  return String(nom || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
}

/** Numéro de la ferme sur 6 chiffres : f0001 → 000001. */
export function numeroFerme(slug: string): string {
  return slug.replace(/^f/, "").padStart(6, "0");
}

/** Identifiants d'application à essayer : « saint-thomas-000001 », sinon « ferme-000001 ». */
export function idsApplication(nom: string, slug: string): string[] {
  const num = numeroFerme(slug);
  const base = idDepuisNom(nom, 36 - num.length - 1);
  return [...new Set([base ? `${base}-${num}` : "", `ferme-${num}`])].filter(id => ID_TTS.test(id));
}

/** Identifiant TTS d'un capteur : « lht52-ff32 » (préfixe du type, de la marque, ou « autre »), sinon son DevEUI. */
export function idCapteur(prefixe: string | null | undefined, devEui: string): string {
  const dev = String(devEui).toLowerCase();
  const p = idDepuisNom(prefixe || "autre", 31) || "autre";
  const id = `${p}-${dev.slice(-4)}`;
  return ID_TTS.test(id) ? id : dev;
}
