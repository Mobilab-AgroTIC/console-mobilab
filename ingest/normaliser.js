"use strict";
// Des clés du décodeur aux mesures (spec V3 §7.5, §7.6). Fonctions pures, testées par catalogue/tests.
const { avecUnite } = require("./format");

const NUMERIQUE = /^\s*-?\d+(\.\d+)?\s*$/;

/** Valeur numérique d'une sortie de décodeur, ou null (« NULL », texte, sentinelle). */
function versNombre(v, def = {}) {
    if (def.valeurs && typeof v === "string" && Object.prototype.hasOwnProperty.call(def.valeurs, v)) {
        v = def.valeurs[v];
    }
    if (typeof v === "boolean") v = v ? 1 : 0;
    if (typeof v === "string") {
        if (!NUMERIQUE.test(v)) return null;
        v = Number(v);
    }
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    for (const x of def.ignorer || []) if (Math.abs(v - Number(x)) < 1e-9) return null;
    // Arrondi après le facteur : 600 × 0,1 donne 60.00000000000001 en JavaScript.
    return def.facteur === undefined ? v : Math.round(v * def.facteur * 1e9) / 1e9;
}

/** Mode lu dans la trame : clé du décodeur, ou bits d'un octet. Toujours une chaîne. */
function lireMode(modele, decode, octets) {
    const m = modele.mode;
    if (!m) return null;
    if (m.fixe !== undefined) return String(m.fixe);   // montage à entrées sans mode dans la trame
    if (m.cle) {
        const v = decode[m.cle];
        return v === undefined || v === null ? null : String(v);
    }
    if (m.octet !== undefined && octets.length > m.octet) {
        return String((octets[m.octet] & (m.masque ?? 0xff)) >> (m.decalage ?? 0));
    }
    return null;
}

/**
 * Forçage du mode (spec §7.6) : réécrit les octets du mode dans une COPIE de la trame,
 * avant d'appeler le décodeur, qui reste intact. Renvoie la trame telle quelle si impossible.
 */
function forcerMode(modele, octets, modeForce) {
    const m = modele.mode;
    if (!m || modeForce === null || modeForce === undefined || modeForce === "") return octets;
    const copie = Buffer.from(octets);
    if (m.octet !== undefined && /^\d+$/.test(String(modeForce))) {
        if (copie.length <= m.octet) return octets;
        const masque = m.masque ?? 0xff;
        const dec = m.decalage ?? 0;
        copie[m.octet] = (copie[m.octet] & ~masque) | ((Number(modeForce) << dec) & masque);
        return copie;
    }
    if (Array.isArray(m.octets) && /^([0-9a-fA-F]{2})+$/.test(String(modeForce))) {
        const val = Buffer.from(String(modeForce), "hex");
        if (val.length !== m.octets.length || copie.length <= Math.max(...m.octets)) return octets;
        m.octets.forEach((o, i) => { copie[o] = val[i]; });
        return copie;
    }
    return octets;
}

/** Conversion d'une sonde : lineaire, log ou table (spec §7.8). null hors domaine. */
function convertir(sonde, x, parametres = {}) {
    const c = sonde.conversion || {};
    const p = { ...(sonde.parametres_a_regler || {}), ...(parametres || {}) };
    const lire = v => (typeof v === "string" ? Number(p[v]) : Number(v));
    let y = null;
    if (c.type === "lineaire") {
        y = lire(c.a ?? 1) * x + lire(c.b ?? 0);
    } else if (c.type === "log") {
        const bas = lire(c.bas), haut = lire(c.haut), k = lire(c.k);
        const r = (x - bas) / (haut - bas);
        if (r > 0 && k) y = -(1 / k) * Math.log(r);
    } else if (c.type === "table") {
        const pts = (c.points || []).slice().sort((a, b) => a[0] - b[0]);
        for (let i = 0; i + 1 < pts.length; i++) {
            const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
            if (x >= x0 && x <= x1) { y = x1 === x0 ? y0 : y0 + (y1 - y0) * (x - x0) / (x1 - x0); break; }
        }
    }
    return Number.isFinite(y) ? y : null;
}

/**
 * Normalise une sortie de décodeur.
 * ctx : { fPort, octets, probes, modeForce, detected, time (Date ou ISO) }
 * Renvoie { role, mesures, modeLu, modeEffectif, modeNonDecrit, batterieMv, detected, voiesSansSonde,
 *           port5: {code, firmware, bande} | null }
 */
function normaliser(cat, modele, decode, ctx) {
    const sortie = {
        role: null, mesures: {}, modeLu: null, modeEffectif: null, modeNonDecrit: false,
        batterieMv: null, detected: {}, voiesSansSonde: [], port5: null,
    };
    const role = (modele.ports || {})[ctx.fPort] || (modele.ports || {}).defaut || null;
    sortie.role = role;
    if (!role || role === "config") return sortie;
    const bat = modele.batterie || {};
    const t = new Date(ctx.time).getTime();

    if (role === "statut") {
        const p5 = modele.port5 || {};
        sortie.port5 = {
            code: ctx.octets.length ? ctx.octets[0] : null,
            firmware: p5.cle_firmware ? decode[p5.cle_firmware] ?? null : null,
            bande: p5.cle_bande ? decode[p5.cle_bande] ?? null : null,
        };
        if (bat.cle_statut && decode[bat.cle_statut] !== undefined) {
            const v = versNombre(decode[bat.cle_statut]);
            if (v !== null) sortie.batterieMv = Math.round(v * (bat.facteur_mv_statut ?? bat.facteur_mv ?? 1));
        }
        if (sortie.batterieMv !== null) sortie.mesures.battery_mv = sortie.batterieMv;
        return sortie;
    }

    // Port de mesures
    sortie.modeLu = lireMode(modele, decode, ctx.octets);
    sortie.modeEffectif = ctx.modeForce || sortie.modeLu;
    let listeBlanche = null;
    let mode = null;
    if (modele.modes) {
        mode = modele.modes[sortie.modeEffectif];
        if (!mode) sortie.modeNonDecrit = true;
        listeBlanche = new Set(mode ? mode.mesures || [] : []);
    }
    for (const [cle, def] of Object.entries(modele.mesures)) {
        if (!Object.prototype.hasOwnProperty.call(decode, cle)) continue;
        if (listeBlanche && !listeBlanche.has(def.nom)) continue;
        const v = versNombre(decode[cle], def);
        if (v !== null) sortie.mesures[def.nom] = v;
    }
    if (bat.cle && decode[bat.cle] !== undefined) {
        const v = versNombre(decode[bat.cle]);
        if (v !== null && v > 0) sortie.batterieMv = Math.round(v * (bat.facteur_mv ?? 1));
    }
    if (sortie.batterieMv !== null) sortie.mesures.battery_mv = sortie.batterieMv;

    // Voies : valeur brute toujours gardée, valeur convertie si la sonde est connue (spec §7.5, point 6).
    for (const [voie, cle] of Object.entries((mode && mode.voies) || {})) {
        const v = versNombre(decode[cle]);
        if (v === null) continue;
        const probe = (ctx.probes || {})[voie];
        if (!probe) {
            if (mode.demander_sondes) {
                sortie.mesures[`brut_${voie}`] = v;
                sortie.voiesSansSonde.push(voie);
            }
            continue;
        }
        if (probe.sonde === "rien") continue;
        sortie.mesures[`brut_${voie}`] = v;
        const sonde = cat.sondes[probe.sonde];
        if (sonde && !sonde.brut_seulement) {
            const y = convertir(sonde, v, probe.parametres);
            if (y !== null) sortie.mesures[`${sonde.mesure}_${voie}`] = y;
        }
    }

    // Mesures dérivées : débit et volume d'un compteur d'impulsions (spec §7.5, point 7).
    for (const d of modele.derivees || []) {
        if (d.type !== "compteur_impulsions") continue;
        const brutPrec = (ctx.detected || {}).compteur || null;
        const precedent = brutPrec ? { imp: Number(brutPrec.imp), t: typeof brutPrec.t === "number" ? brutPrec.t : Date.parse(brutPrec.t) } : null;
        const calibre = decode[d.cle_calibre] ?? 0;
        const ppl = Number((d.impulsions_par_litre || {})[calibre] ?? (d.impulsions_par_litre || {})[0] ?? 1);
        let imp = null, delta = null;
        const cumul = versNombre(decode[d.cle_cumul]);
        const intervalle = versNombre(decode[d.cle_intervalle]);
        if (cumul !== null) {
            imp = cumul;
            if (precedent && precedent.t < t && cumul >= precedent.imp) delta = cumul - precedent.imp;
        } else if (intervalle !== null) {
            imp = (precedent ? precedent.imp : 0) + intervalle;
            if (precedent && precedent.t < t) delta = intervalle;
        }
        if (imp === null) continue;
        if (d.volume) sortie.mesures[d.volume] = imp / ppl;
        if (d.debit && delta !== null) {
            const heures = (t - precedent.t) / 3600000;
            if (heures > 0) sortie.mesures[d.debit] = delta / ppl / heures;
        }
        sortie.detected.compteur = { imp, t };
    }
    if (sortie.modeLu !== null) sortie.detected.mode_lu = sortie.modeLu;
    return sortie;
}

/** Définition d'une mesure (libellé, unité, décimales) par son nom, catalogue ou sonde. */
function definitionMesure(cat, modele, nom) {
    for (const def of Object.values((modele && modele.mesures) || {})) if (def.nom === nom) return def;
    if (nom === "battery_mv") return { nom, libelle: "Pile", unite: "mV", decimales: 0 };
    const voie = /^(.+)_([a-z0-9]{1,6})$/.exec(nom);
    if (/^brut_/.test(nom)) return { nom, libelle: `Entrée ${nom.slice(5)}`, unite: "V", decimales: 2 };
    if (voie) {
        for (const s of Object.values(cat.sondes || {})) {
            if (s.mesure === voie[1]) {
                return { nom, libelle: s.libelle_mesure || s.libelle, unite: s.unite || "", decimales: s.decimales ?? 1,
                         alerte: s.alerte, hysteresis: s.hysteresis, seuils_proposes: s.seuils_proposes, sonde: true };
            }
        }
    }
    return null;
}

/** Texte « 14,8 °C · 60 % » des mesures principales (2 au plus), lu par le bot et Grafana. */
function resume(cat, modele, valeurs) {
    const morceaux = [];
    const principales = Object.values((modele && modele.mesures) || {}).filter(d => d.principale);
    for (const def of principales) {
        const v = valeurs[def.nom];
        if (!v || v.v === undefined || v.v === null) continue;
        morceaux.push(avecUnite(v.v, def));
        if (morceaux.length === 2) break;
    }
    if (morceaux.length < 2) {
        for (const [nom, v] of Object.entries(valeurs)) {
            if (morceaux.length === 2 || nom === "resume" || nom === "battery_mv" || /^brut_/.test(nom)) continue;
            const def = definitionMesure(cat, modele, nom);
            if (!def || !def.sonde || !v || v.v === undefined) continue;   // mesure convertie d'une sonde
            morceaux.push(avecUnite(v.v, def));
        }
    }
    return morceaux.join(" · ");
}

/** Intervalle d'envoi : médiane des 10 derniers écarts ; avant 3 écarts, celui réglé par downlink
 *  (app.devices.intervalle_s), sinon celui du catalogue (§7.5). */
function intervalle(detected, modele, t, regle_s = null) {
    const ecarts = Array.isArray(detected.ecarts_s) ? detected.ecarts_s.slice(-9) : [];
    const prec = detected.derniere_mesure ? new Date(detected.derniere_mesure).getTime() : null;
    const tt = new Date(t).getTime();
    if (prec && tt > prec) ecarts.push(Math.round((tt - prec) / 1000));
    let intervalle_s = Number(regle_s) || Number(modele && modele.intervalle_defaut_s) || 1200;
    if (ecarts.length >= 3) {
        const tri = ecarts.slice().sort((a, b) => a - b);
        intervalle_s = tri[Math.floor(tri.length / 2)];
    }
    return { ecarts_s: ecarts, intervalle_s, derniere_mesure: new Date(tt).toISOString() };
}

module.exports = { normaliser, versNombre, lireMode, forcerMode, convertir, resume, definitionMesure, intervalle };
