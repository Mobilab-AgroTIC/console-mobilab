"use strict";
// Alertes (spec V3 §8) : machine à états, rédaction des messages, destinataires.
// L'évaluation est pure (testée) ; les écritures sont des UPDATE conditionnels (§8.3).
const { avecUnite, nombre, duree, heure, gabarit, echapper } = require("./format");
const { definitionMesure } = require("./normaliser");
const { pourcentagePile } = require("./catalogue");

const SEUIL_DEBIT = 0.1;          // L/h (spec §8.1)
const RETOUR_PILE_MV = 200;       // remonte de 200 mV au-dessus du seuil

/**
 * Évalue les règles d'un capteur pour une trame. Pur.
 * regles : lignes alert_rules + alert_state ; mesures : {metric: valeur} de la trame ; t : Date.
 * seuilPileMv : seuil « à changer » tiré de la courbe de pile du catalogue ; à défaut, le min de la règle.
 * Renvoie des décisions : {regle, action: 'alarme'|'retour'|'attente'|'efface_attente', valeur}.
 */
function evaluerTrame(regles, mesures, t, hysteresisDe, seuilPileMv) {
    const decisions = [];
    const tms = new Date(t).getTime();
    for (const r of regles) {
        if (r.kind === "silence") {
            if (r.state === "alarm") decisions.push({ regle: r, action: "retour", valeur: null });
            continue;
        }
        const v = mesures[r.metric];
        if (v === undefined || v === null) continue;       // mesure absente : l'état ne change pas (§8.3)
        let hors, revenu;
        if (r.kind === "battery") {
            const seuil = seuilPileMv ?? r.min;
            if (seuil === null || seuil === undefined) continue;
            hors = v < seuil;
            revenu = v >= Number(seuil) + RETOUR_PILE_MV;
        } else if (r.kind === "state") {
            hors = v === 1;
            revenu = v === 0;
        } else if (r.kind === "threshold") {
            const h = r.for_minutes > 0 ? 0 : Number(hysteresisDe(r.metric) || 0);
            if (r.min !== null && r.min !== undefined) { hors = v < r.min; revenu = v >= r.min + h; }
            else { hors = v > r.max; revenu = v <= r.max - h; }
        } else continue;

        if (r.state === "ok") {
            if (hors) {
                const duree_ms = (r.for_minutes || 0) * 60000;
                if (duree_ms === 0) decisions.push({ regle: r, action: "alarme", valeur: v });
                else if (r.pending_since && tms - new Date(r.pending_since).getTime() >= duree_ms) {
                    decisions.push({ regle: r, action: "alarme", valeur: v });
                } else if (!r.pending_since) decisions.push({ regle: r, action: "attente", valeur: v });
            } else if (r.pending_since) decisions.push({ regle: r, action: "efface_attente", valeur: v });
        } else if (r.state === "alarm" && revenu) {
            decisions.push({ regle: r, action: "retour", valeur: v });
        }
    }
    return decisions;
}

/** Envoi différé : pile la nuit → 8 h ; pas de nouvelles et retours → +5 min (spec §8.7). */
function envoyerApres(kind, transition, maintenant = new Date()) {
    const t = new Date(maintenant);
    if (kind === "silence") return new Date(t.getTime() + 5 * 60000);
    if (kind === "battery") {
        const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).format(t));
        if (h >= 8 && h < 20) return t;
        // prochain 8 h à Paris : on avance d'heure en heure (simple et juste aux changements d'heure)
        let x = new Date(t.getTime());
        x.setUTCMinutes(0, 0, 0);
        for (let i = 0; i < 26; i++) {
            x = new Date(x.getTime() + 3600000);
            const hx = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).format(x));
            if (hx === 8) return x;
        }
    }
    return t;
}

// ---------------------------------------------------------------- rédaction (spec §4.8, §8.6)

function libelleEtat(def, v) {
    const etats = (def && def.etats) || {};
    return String(etats[Number(v)] ?? etats[String(v)] ?? v);
}

function borne(T, item, def) {
    const v = item.min !== null && item.min !== undefined ? item.min : item.max;
    const txt = avecUnite(v, def);
    return gabarit(item.min !== null && item.min !== undefined ? T.borne_min : T.borne_max, { valeur: txt });
}

/**
 * Rédige le texte d'une notification d'alerte pour un capteur (ou un groupe de capteurs muets).
 * n : ligne app.notifications ; items : details.items ; cat, modele : catalogue ; nomCapteur(dev) : nom actuel.
 */
function rediger(T, cat, notif, contexte) {
    const d = notif.details || {};
    const items = d.items || [];
    const transition = notif.transition;
    const lignes = [];
    const nomDe = dev => echapper(contexte.nomCapteur(dev));
    const modeleDe = dev => contexte.modele(dev);

    if (d.groupe && d.groupe.length > 1) {
        const liste = d.groupe.map(nomDe).join(", ");
        if (transition === "retour") lignes.push(gabarit(T.silence_retour_groupe, { liste }));
        else lignes.push(gabarit(T.silence_groupe, { n: d.groupe.length, liste, duree: d.duree || "" }));
        return lignes.join("\n");
    }
    const capteur = nomDe(notif.dev_eui);
    const modele = modeleDe(notif.dev_eui);
    const seuils = items.filter(i => i.kind === "threshold" && !i.debit);
    if (seuils.length) {
        const parts = seuils.map((i, k) => {
            const def = definitionMesure(cat, modele, i.metric) || {};
            const valeur = avecUnite(i.valeur, def);
            if (transition === "retour") return k === 0 ? valeur : `${(def.libelle || i.metric).toLowerCase()} ${valeur}`;
            const b = borne(T, i, def);
            return gabarit(k === 0 ? T.seuil_item_premier : T.seuil_item_suivant,
                { valeur, borne: b, libelle: (def.libelle || i.metric).toLowerCase() });
        }).join(", ");
        const g = transition === "retour" ? T.seuil_retour : transition === "rappel" ? T.seuil_rappel : T.seuil_alarme;
        lignes.push(gabarit(g, { capteur, details: parts, valeur: parts }));
    }
    for (const i of items) {
        if (i.kind === "threshold" && i.debit) {
            const arret = i.min !== null && i.min !== undefined;
            const base = arret ? "debit_arret" : "debit_fuite";
            const g = transition === "retour" ? T[`${base}_retour`] : T[`${base}_alarme`];
            lignes.push(gabarit(g, { capteur, duree: `${Math.round((i.for_minutes || 0) / 60)} h` }));
        } else if (i.kind === "state") {
            const def = definitionMesure(cat, modele, i.metric) || {};
            const g = transition === "retour" ? T.etat_retour : transition === "rappel" ? T.etat_rappel : T.etat_alarme;
            lignes.push(gabarit(g, { capteur, etat: libelleEtat(def, transition === "retour" ? 0 : 1) }));
            if (i.coupure_auto) lignes.push(gabarit(T.coupure_auto, { capteur }));
        } else if (i.kind === "battery") {
            const pct = pourcentagePile(modele, i.valeur);
            let g = transition === "rappel" ? T.pile_rappel : T.pile_alarme;
            if (transition === "retour") g = pct !== null && pct < 80 ? T.pile_remontee : T.pile_retour;
            lignes.push(gabarit(g, { capteur, pct, niveau: pct === null ? "" : gabarit(T.pile_niveau, { pct }) }));
        } else if (i.kind === "silence") {
            let g = T.silence_alarme;
            if (transition === "retour") g = T.silence_retour;
            else if (transition === "rappel") g = i.relance ? T.silence_relance : T.silence_rappel;
            lignes.push(gabarit(g, { capteur, duree: d.duree || "" }));
        }
    }
    return lignes.join("\n");
}

/** Boutons sous une alerte (spec §4.8, §4.15). conseiller : seulement [Voir le capteur]. */
function boutons(T, notif, { conseiller = false } = {}) {
    const d = notif.details || {};
    if (notif.transition === "retour") return null;
    const items = d.items || [];
    if (items.some(i => i.coupure_auto)) {
        return conseiller ? null : [[{ text: T.bouton_reactiver, callback_data: `rc:${notif.id}` }]];
    }
    // Pile : pas de coupure 24 h, mais « Ne plus le rappeler » (jusqu'à la pile neuve, choix du 19/11).
    if (items.length && items.every(i => i.kind === "battery")) {
        return conseiller ? null : [[{ text: T.bouton_couper_pile, callback_data: `cp:${notif.id}` }]];
    }
    const voir = d.groupe && d.groupe.length > 1
        ? { text: T.bouton_voir_tous, callback_data: `ag:${notif.id}` }
        : { text: T.bouton_voir, callback_data: `dv:${notif.dev_eui}` };
    if (items.some(i => i.relance)) return [[voir]];
    return conseiller ? [[voir]] : [[{ text: T.bouton_couper, callback_data: `ct:${notif.id}` }, voir]];
}

module.exports = { evaluerTrame, envoyerApres, rediger, boutons, SEUIL_DEBIT, RETOUR_PILE_MV, libelleEtat, nombre, heure, duree };
