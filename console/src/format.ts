// Mise en forme à la française (spec V3 §4.1 point 10, §5.2) : nombres, heures de Paris, durées, HTML.
const TZ = "Europe/Paris";

export function echapper(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function nombre(v: number | null | undefined, decimales = 1): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "?";
  let s = Number(v).toFixed(Math.max(0, Math.min(6, decimales)));
  if (s.startsWith("-") && Number(s) === 0) s = s.slice(1);
  const [ent, dec] = s.split(".");
  const signe = ent.startsWith("-") ? "-" : "";
  const corps = signe ? ent.slice(1) : ent;
  const milliers = corps.length > 4 ? corps.replace(/\B(?=(\d{3})+(?!\d))/g, " ") : corps;
  return signe + milliers + (dec ? "," + dec : "");
}

export function entier(v: number): string {
  return nombre(v, 0);
}

const fHeure = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fJour = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
const fJourHeure = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const fCle = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const fHeureNum = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });

export const heure = (d: Date | string) => fHeure.format(new Date(d));
export const jour = (d: Date | string) => fJour.format(new Date(d));
export const jourHeure = (d: Date | string) => fJourHeure.format(new Date(d)).replace(",", "");
export const jourCle = (d: Date | string) => fCle.format(new Date(d));
export const heureParis = (d: Date | string = new Date()) => Number(fHeureNum.format(new Date(d)));

/** « 12 min », « 3 h », « 2 j » */
export function duree(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return "moins d'1 min";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} j`;
}

/** Intervalle d'envoi exact : « 30 s », « 1 min 30 s », « 20 min », « 1 h 30 min », « 24 h ». */
export function texteIntervalle(secondes: number): string {
  const s = Math.max(0, Math.round(secondes));
  const h = Math.floor(s / 3600), min = Math.floor((s % 3600) / 60), sec = s % 60;
  const l = [h && `${h} h`, min && `${min} min`, sec && `${sec} s`].filter(Boolean);
  return l.length ? l.join(" ") : "0 s";
}

/** Durée tapée : « 90 s », « 15 min », « 2 h », « 1,5 h », « 1h30 » → secondes ; null sans unité ou illisible. */
export function lireIntervalle(texte: string): number | null {
  const t = texte.trim().toLowerCase().replace(",", ".");
  const hm = /^(\d+)\s*h\s*(\d{1,2})$/.exec(t);
  if (hm) return Number(hm[1]) * 3600 + Number(hm[2]) * 60;
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|secondes?|m|mn|min|mins|minutes?|h|hr|heures?)$/.exec(t);
  if (!m) return null;
  const facteur = m[2].startsWith("s") ? 1 : m[2].startsWith("h") ? 3600 : 60;
  return Math.round(Number(m[1]) * facteur);
}

export function depuis(d: Date | string | null | undefined, maintenant = Date.now()): string {
  return d ? duree(maintenant - new Date(d).getTime()) : "?";
}

/** « 14:05 », « demain 14:05 » ou « 20/10 14:05 » (spec §4.8). */
export function quand(d: Date | string, maintenant = new Date()): string {
  const x = new Date(d);
  const j = jourCle(x), aujourdhui = jourCle(maintenant);
  const demain = jourCle(new Date(maintenant.getTime() + 86400000));
  const hier = jourCle(new Date(maintenant.getTime() - 86400000));
  if (j === aujourdhui) return heure(x);
  if (j === demain) return `demain ${heure(x)}`;
  if (j === hier) return `hier ${heure(x)}`;
  return jourHeure(x);
}

export function avecUnite(v: number, def?: { unite?: string; decimales?: number; type?: string; etats?: Record<string, string> } | null): string {
  if (def?.type === "etat") return String(def.etats?.[String(Number(v))] ?? v);
  const n = nombre(v, def?.decimales ?? 1);
  const u = def?.unite || "";
  return u ? `${n} ${u}` : n;
}

/** Réception dite en mots (spec §4.5). */
export function reception(rssi: number | null, snr: number | null): "bonne" | "moyenne" | "faible" | null {
  if (rssi === null || rssi === undefined) return null;
  if ((snr ?? 0) >= 0 && rssi >= -105) return "bonne";
  if ((snr !== null && snr < -10) || rssi < -118) return "faible";
  return "moyenne";
}

/** Prénom pour les salutations : premier mot du nom affiché. */
export function prenom(nom: string | null | undefined): string {
  return String(nom || "").trim().split(/\s+/)[0] || "";
}

/** Nom affiché tiré du profil Telegram. */
export function nomTelegram(u: { first_name?: string; last_name?: string; username?: string } | undefined): string {
  if (!u) return "?";
  const n = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return (n || u.username || "?").slice(0, 80);
}

/** Login Grafana tiré du profil : « jean.dupont », sans accents (spec §6.3). */
export function loginDepuisNom(nom: string): string {
  const base = nom.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 40);
  return base || "mobilab.client";
}

export function taille(octets: number): string {
  if (octets < 1024) return `${octets} o`;
  if (octets < 1048576) return `${nombre(octets / 1024, 0)} ko`;
  return `${nombre(octets / 1048576, 1)} Mo`;
}
