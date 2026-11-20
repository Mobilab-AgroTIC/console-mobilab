"use strict";
// Mise en forme à la française (spec V3 §4.1, point 10) : « 14,2 °C », heure de Paris.

const TZ = "Europe/Paris";

function nombre(v, decimales = 1) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "?";
    const d = Math.max(0, Math.min(6, Number(decimales) || 0));
    let s = Number(v).toFixed(d);
    if (s.startsWith("-") && Number(s) === 0) s = s.slice(1);   // « -0,0 » → « 0,0 »
    const [ent, dec] = s.split(".");
    const signe = ent.startsWith("-") ? "-" : "";
    const corps = signe ? ent.slice(1) : ent;
    const milliers = corps.length > 4 ? corps.replace(/\B(?=(\d{3})+(?!\d))/g, " ") : corps;
    return signe + milliers + (dec ? "," + dec : "");
}

function avecUnite(v, def) {
    if (def && def.type === "etat") {
        const etats = def.etats || {};
        return String(etats[Number(v)] ?? etats[String(v)] ?? v);
    }
    const n = nombre(v, def ? def.decimales ?? 1 : 1);
    const u = def && def.unite ? def.unite : "";
    if (!u) return n;
    return u === "%" ? `${n} %` : `${n} ${u}`;
}

const fmtHeure = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtJour = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
const fmtHeureNum = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });

function heure(d) { return fmtHeure.format(new Date(d)); }
function jour(d) { return fmtJour.format(new Date(d)); }
function heureParis(d) { return Number(fmtHeureNum.format(new Date(d))); }

/** Durée lisible : « 12 min », « 3 h », « 2 j ». */
function duree(ms) {
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 60) return `${min} min`;
    const h = Math.round(min / 60);
    if (h < 48) return `${h} h`;
    return `${Math.round(h / 24)} j`;
}

function echapper(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function gabarit(texte, valeurs) {
    return String(texte).replace(/\{(\w+)\}/g, (_, k) => (valeurs[k] === undefined ? `{${k}}` : String(valeurs[k])));
}

module.exports = { nombre, avecUnite, heure, jour, heureParis, duree, echapper, gabarit, TZ };
