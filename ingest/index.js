"use strict";
// Module d'ingestion de la console Mobilab V3, chargé par Node-RED (functionGlobalContext).
// Spec §7 (réception, décodage, catalogue) et §8 (alertes). Toutes les requêtes sont paramétrées.
//
// Node-RED n'envoie que les alertes clients (alarme, retour, rappel) ; tout autre message est
// signalé au service console par une ligne app.notifications (expediteur = 'service') + pg_notify.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const catalogueLib = require("./catalogue");
const { decoder, decoderSource } = require("./decodeur");
const trameLib = require("./trame");
const { typeFiche } = trameLib;
const N = require("./normaliser");
const A = require("./alertes");
const F = require("./format");

const STATUTS_ALERTES = new Set(["en_attente_activation", "actif"]);
const ID_TTN = /^[a-z0-9](?:-?[a-z0-9]){2,35}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

class ErreurTrame extends Error {}

// ------------------------------------------------------------------ outils purs

function secretValide(entetes, attendus) {
    const recu = Buffer.from(String((entetes || {})["x-mobilab-secret"] || ""));
    return attendus.filter(Boolean).some(a => {
        const b = Buffer.from(String(a));
        return b.length === recu.length && crypto.timingSafeEqual(b, recu);
    });
}

/** Lecture minimale d'un message TTS (spec §7.3, étape 2). Lève ErreurTrame si un champ est faux. */
function lireMessage(p) {
    p = p || {};
    const ids = p.end_device_ids || {};
    const devEui = String(ids.dev_eui || "").toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(devEui)) throw new ErreurTrame("dev_eui");
    const appId = String((ids.application_ids || {}).application_id || "");
    if (!ID_TTN.test(appId)) throw new ErreurTrame("application_id");
    return { p, ids, devEui, appId, deviceId: String(ids.device_id || "") };
}

function lireUplink(p) {
    const m = lireMessage(p);
    const up = p.uplink_message || {};
    const recu = up.received_at || p.received_at;
    if (!DATE.test(String(recu || ""))) throw new ErreurTrame("received_at");
    if (up.f_port !== undefined && !Number.isInteger(up.f_port)) throw new ErreurTrame("f_port");
    if (up.f_cnt !== undefined && !Number.isInteger(up.f_cnt)) throw new ErreurTrame("f_cnt");
    const brut = up.frm_payload ? Buffer.from(String(up.frm_payload), "base64") : null;
    const passerelles = (up.rx_metadata || []).map(r => ({
        id: String((r.gateway_ids && (r.gateway_ids.gateway_id || r.gateway_ids.eui)) || "?").slice(0, 64),
        rssi: Number.isFinite(r.rssi) ? r.rssi : (Number.isFinite(r.channel_rssi) ? r.channel_rssi : null),
        snr: Number.isFinite(r.snr) ? r.snr : null,
    }));
    let meilleure = null;
    for (const g of passerelles) if (g.rssi !== null && (!meilleure || g.rssi > meilleure.rssi)) meilleure = g;
    return {
        ...m, time: new Date(recu).toISOString(), fPort: up.f_port ?? null, fCnt: up.f_cnt ?? null, octets: brut,
        rssi: meilleure ? meilleure.rssi : null, snr: meilleure ? meilleure.snr : null, passerelles,
        versionIds: up.version_ids || null,
    };
}

function choisirDecodeur(modele, firmware) {
    const versNum = v => String(v || "").replace(/[^0-9.]/g, "").split(".").map(Number);
    const plusPetit = (a, b) => { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); } return false; };
    if (firmware) {
        for (const d of modele.sources) {
            if (!d.firmware_min || !plusPetit(versNum(firmware), versNum(d.firmware_min))) return d;
        }
    }
    return modele.sources[modele.sources.length - 1];
}

function jsonb(v) { return JSON.stringify(v === undefined ? null : v); }


// ------------------------------------------------------------------ module

/**
 * options : { pool (pg.Pool), catalogueDir, spoolDir, env, log, fetch }
 */
function creer(options) {
    const env = options.env || process.env;
    const log = options.log || { info() {}, warn: console.warn, error: console.error };
    const pool = options.pool;
    const fetchFn = options.fetch || globalThis.fetch;
    const spoolDir = options.spoolDir || "/data/spool";
    const T = options.textes || JSON.parse(fs.readFileSync(path.join(__dirname, "textes-alertes.json"), "utf8"));
    const etat = { derniereTrame: null, rejets: 0, recues: 0, erreurs: 0, catalogueErreur: null, derniereErreur: null };
    let cat = catalogueLib.charger(options.catalogueDir);

    function rechargerCatalogue() {
        let version = null;
        try { version = fs.readFileSync(path.join(options.catalogueDir, "VERSION"), "utf8").trim(); } catch { return false; }
        if (version === cat.version) return false;
        try {
            cat = catalogueLib.charger(options.catalogueDir);
            etat.catalogueErreur = null;
            log.info(`catalogue ${cat.version} chargé`);
            return true;
        } catch (e) {
            if (etat.catalogueErreur !== e.message) {
                etat.catalogueErreur = e.message;
                signalerHorsTransaction("admin", "catalogue_refuse", null, null, { erreur: e.message }).catch(() => {});
            }
            return false;
        }
    }

    async function tx(fn) {
        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            const r = await fn(c);
            await c.query("COMMIT");
            return r;
        } catch (e) {
            await c.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            c.release();
        }
    }

    /** Message pour le service : ligne app.notifications + pg_notify (spec §2.1). */
    async function signaler(c, audience, kind, tenant, devEui, details, transition = audience === "admin" ? "admin" : "info") {
        const r = await c.query(
            `INSERT INTO app.notifications (audience, expediteur, kind, tenant_slug, dev_eui, transition, details)
             VALUES ($1, 'service', $2, $3, $4, $5, $6::jsonb) RETURNING id`,
            [audience, kind, tenant, devEui, transition, jsonb(details || {})]);
        await c.query("SELECT pg_notify('console', $1)", [String(r.rows[0].id)]);
        return r.rows[0].id;
    }
    async function signalerHorsTransaction(...args) {
        const c = await pool.connect();
        try { return await signaler(c, ...args); } finally { c.release(); }
    }

    async function anomalie(c, raison, { tenant = null, devEui = null, appId = null, details = {}, trame = null, avertir = "jour" }) {
        const r = await c.query(
            `INSERT INTO app.anomalies (raison, tenant_slug, dev_eui, application_id, details, trames)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
             ON CONFLICT (raison, coalesce(tenant_slug, ''), coalesce(dev_eui, ''), coalesce(gateway_id, ''))
                WHERE resolved_at IS NULL
             DO UPDATE SET count = app.anomalies.count + 1, last_seen = now(),
                details = app.anomalies.details || EXCLUDED.details,
                application_id = coalesce(EXCLUDED.application_id, app.anomalies.application_id),
                trames = (SELECT coalesce(jsonb_agg(x ORDER BY i), '[]'::jsonb) FROM (
                    SELECT x, i FROM jsonb_array_elements(app.anomalies.trames || EXCLUDED.trames) WITH ORDINALITY e(x, i)
                    ORDER BY i DESC LIMIT 20) s)
             RETURNING id, count`,
            [raison, tenant, devEui, appId, jsonb(details), jsonb(trame ? [trame] : [])]);
        const id = r.rows[0].id;
        const cond = avertir === "premiere" ? "notified_at IS NULL" : "(notified_at IS NULL OR notified_at < now() - interval '1 day')";
        const n = await c.query(`UPDATE app.anomalies SET notified_at = now() WHERE id = $1 AND ${cond} RETURNING id`, [id]);
        if (n.rowCount) {
            await signaler(c, "admin", "anomalie", tenant, devEui, { anomalie_id: id, raison, application_id: appId, count: r.rows[0].count, ...details });
        }
        return id;
    }

    function trameCourte(u) {
        return { time: u.time, f_port: u.fPort, f_cnt: u.fCnt, hex: u.octets ? u.octets.toString("hex") : null, rssi: u.rssi, snr: u.snr };
    }

    // ---------------------------------------------------------------- fichier de secours

    function ecrireSpool(type, payload) {
        try {
            fs.mkdirSync(spoolDir, { recursive: true });
            const f = path.join(spoolDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
            fs.appendFileSync(f, JSON.stringify({ type, payload }) + "\n");
        } catch (e) {
            log.error(`fichier de secours : ${e.message}`);
        }
    }

    function tailleSpool() {
        try {
            return fs.readdirSync(spoolDir).filter(f => f.endsWith(".jsonl"))
                .reduce((s, f) => s + fs.statSync(path.join(spoolDir, f)).size, 0);
        } catch { return 0; }
    }

    async function rejouerSpool() {
        let fichiers = [];
        try { fichiers = fs.readdirSync(spoolDir).filter(f => f.endsWith(".jsonl")).sort(); } catch { return 0; }
        let n = 0;
        for (const f of fichiers) {
            const chemin = path.join(spoolDir, f);
            const encours = chemin + ".rejeu";
            fs.renameSync(chemin, encours);
            const lignes = fs.readFileSync(encours, "utf8").split("\n").filter(Boolean);
            for (let i = 0; i < lignes.length; i++) {
                const { type, payload } = JSON.parse(lignes[i]);
                const r = await (type === "join" ? recevoirJoin(payload, null, true) : recevoirUplink(payload, null, true));
                if (r.spool) {   // base encore absente : on remet le reste et on s'arrête
                    fs.appendFileSync(chemin, lignes.slice(i + 1).join("\n") + (i + 1 < lignes.length ? "\n" : ""));
                    fs.unlinkSync(encours);
                    return n;
                }
                if (r.suite) await r.suite();
                n++;
            }
            fs.unlinkSync(encours);
        }
        return n;
    }

    // ---------------------------------------------------------------- uplink (spec §7.3)

    async function chercherCapteur(c, devEui) {
        const r = await c.query(
            `SELECT d.dev_eui, d.tenant_slug, d.name, d.model_key, d.probes, d.mode_override, d.config, d.last_values,
                    d.ttn_status, d.last_seen, d.created_by, d.intervalle_s, t.status AS tenant_status, t.ttn_app_id, t.migration
             FROM app.devices d JOIN app.tenants t ON t.slug = d.tenant_slug WHERE d.dev_eui = $1`, [devEui]);
        return r.rows[0] || null;
    }

    function appAcceptee(dev, appId) {
        if (appId === dev.ttn_app_id) return true;
        const mig = dev.migration || {};
        return Boolean(mig.v1_app_id && appId === mig.v1_app_id);
    }

    /**
     * Partie avant la réponse à TTS (< 5 s) : contrôle, recherche, trame brute.
     * Renvoie { statut, suite? } ; suite() fait le décodage, l'écriture et les alertes.
     */
    async function recevoirUplink(payload, entetes, dejaControle = false) {
        if (!dejaControle && !secretValide(entetes, [env.TTN_WEBHOOK_SECRET, env.TTN_WEBHOOK_SECRET_PREVIOUS])) {
            etat.rejets++;
            return { statut: 401 };
        }
        let u;
        try { u = lireUplink(payload); } catch (e) {
            etat.rejets++;
            log.warn(`uplink refusé (400) : ${e.message}`);
            return { statut: 400 };
        }
        etat.recues++;
        let dev;
        try {
            const res = await tx(async c => {
                const d = await chercherCapteur(c, u.devEui);
                const trame = trameCourte(u);
                if (!d) {
                    await anomalie(c, "deveui_inconnu", { devEui: u.devEui, appId: u.appId, trame });
                    return { fin: true };
                }
                if (!appAcceptee(d, u.appId)) {
                    await anomalie(c, "mauvaise_application", { tenant: d.tenant_slug, devEui: u.devEui, appId: u.appId, trame });
                    return { fin: true };
                }
                if (d.ttn_status === "supprime") {
                    await anomalie(c, "capteur_supprime", { tenant: d.tenant_slug, devEui: u.devEui, appId: u.appId, trame });
                    return { fin: true };
                }
                const ins = await c.query(
                    `INSERT INTO public.uplinks (time, tenant, name, dev_eui, application_id, f_port, f_cnt, frm_payload, rssi, snr, gateways)
                     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
                     ON CONFLICT (dev_eui, time) DO NOTHING RETURNING time`,
                    [u.time, d.tenant_slug, u.devEui, u.appId, u.fPort, u.fCnt, u.octets, u.rssi, u.snr, jsonb(u.passerelles)]);
                if (!ins.rowCount) return { fin: true, rejouee: true };
                return { fin: false, dev: d };
            });
            etat.derniereTrame = new Date().toISOString();
            if (res.fin) return { statut: 200 };
            dev = res.dev;
        } catch (e) {
            // Postgres injoignable : fichier de secours, réponse 200 quand même (spec §7.3, étape 4).
            log.error(`uplink ${u.devEui} : base injoignable, fichier de secours (${e.code || e.message})`);
            if (!dejaControle) ecrireSpool("uplink", payload);
            return { statut: 200, spool: true };
        }
        if (dev.tenant_status === "en_creation" || !u.octets || u.fPort === null || u.fPort === 0) return { statut: 200 };
        return { statut: 200, suite: () => traiterUplink(u, dev).catch(e => { etat.erreurs++; etat.derniereErreur = e.message; log.error(`uplink ${u.devEui} : ${e.stack || e.message}`); }) };
    }

    const identifier = (dev, u) => catalogueLib.identifierModele(cat, dev, u);

    async function traiterUplink(u, dev) {
        const det = (dev.config && dev.config.detected) || {};
        const patch = { f_cnt: u.fCnt };
        const { modele, lu } = identifier(dev, u);
        const signaux = [];

        if (lu && lu.cle !== det.modele_lu) {
            patch.modele_lu = lu.cle;
            patch.modele_par = lu.par;
            if (!dev.model_key) signaux.push(["client", "modele_identifie", { model_key: lu.cle, par: lu.par }]);
            else if (lu.cle !== dev.model_key) {
                signaux.push(["anomalie", "modele_inconnu", { contredit: true, model_key: dev.model_key, lu: lu.cle, par: lu.par }]);
            }
        } else if (dev.model_key && !lu && typeFiche(u.fPort, u.octets) !== null) {
            // Fiche Mobilab d'un type absent du catalogue : le capteur n'est pas celui déclaré.
            const t = typeFiche(u.fPort, u.octets);
            const attendu = ((cat.modeles.get(dev.model_key) || {}).trame || {}).type;
            if (attendu !== t) {
                signaux.push(["anomalie", "modele_inconnu", { contredit: true, model_key: dev.model_key, fiche_mobilab: t }]);
            }
        } else if (dev.model_key && u.fPort === 5 && u.octets.length && !lu && cat.parPort5.size) {
            const code = u.octets[0];
            const attendu = (cat.modeles.get(dev.model_key) || {}).port5;
            if (attendu && Number(attendu.code) !== code) {
                signaux.push(["anomalie", "modele_inconnu", { contredit: true, model_key: dev.model_key, port5_code: `0x${code.toString(16).toUpperCase()}` }]);
            }
        }

        if (!modele) {
            await tx(async c => {
                await c.query(`UPDATE public.uplinks SET decoded = $3::jsonb WHERE dev_eui = $1 AND time = $2`,
                    [u.devEui, u.time, jsonb({ erreur: "modèle inconnu" })]);
                const nouveau = !det.modele_a_choisir_at;
                if (nouveau) patch.modele_a_choisir_at = new Date().toISOString();
                await majDetected(c, u.devEui, patch);
                if (nouveau) {
                    const p5 = u.fPort === 5 && u.octets.length ? `0x${u.octets[0].toString(16).toUpperCase()}` : null;
                    const fiche = typeFiche(u.fPort, u.octets);
                    await signaler(c, "client", "modele_a_choisir", dev.tenant_slug, u.devEui, { created_by: dev.created_by });
                    await anomalie(c, "modele_inconnu", { tenant: dev.tenant_slug, devEui: u.devEui, appId: u.appId,
                        details: { port5_code: p5, ...(fiche !== null ? { fiche_mobilab: fiche } : {}) }, trame: trameCourte(u), avertir: "premiere" });
                }
                for (const s of signaux) await envoyerSignal(c, s, dev, u);
            });
            return;
        }

        // Décodage, avec le mode forcé réécrit dans une copie de la trame (spec §7.6).
        const octets = N.forcerMode(modele, u.octets, dev.mode_override);
        const fichier = choisirDecodeur(modele, det.firmware);
        let decode;
        try {
            decode = decoderSource(fichier, octets, u.fPort);
        } catch (e) {
            await tx(async c => {
                await c.query(`UPDATE public.uplinks SET decoded = $3::jsonb WHERE dev_eui = $1 AND time = $2`,
                    [u.devEui, u.time, jsonb({ erreur: String(e.message).slice(0, 200) })]);
                const role = (modele.ports || {})[u.fPort] || (modele.ports || {}).defaut;
                if (role === "mesures" || role === "statut") {
                    await anomalie(c, "decodage", { tenant: dev.tenant_slug, devEui: u.devEui, appId: u.appId,
                        details: { erreur: String(e.message).slice(0, 200), model_key: modele.cle }, trame: trameCourte(u) });
                }
                await majDetected(c, u.devEui, patch);
                for (const s of signaux) await envoyerSignal(c, s, dev, u);
            });
            return;
        }

        const norm = N.normaliser(cat, modele, decode, {
            fPort: u.fPort, octets: u.octets, probes: dev.probes || {}, modeForce: dev.mode_override || null,
            detected: det, time: u.time,
        });
        Object.assign(patch, norm.detected);
        if (norm.port5) {
            if (norm.port5.firmware !== null) patch.firmware = String(norm.port5.firmware);
            if (norm.port5.bande !== null) patch.bande = String(norm.port5.bande);
            if (norm.port5.bande && !/^EU/i.test(String(norm.port5.bande)) && String(norm.port5.bande) !== "1") {
                signaux.push(["admin", "bande", { bande: String(norm.port5.bande) }]);
            }
        }
        if (norm.modeLu !== null && det.mode_lu !== undefined && det.mode_lu !== null && norm.modeLu !== det.mode_lu) {
            signaux.push(["admin", "mode_change", { avant: det.mode_lu, apres: norm.modeLu }]);
        }
        if (norm.modeNonDecrit && det.mode_non_decrit !== norm.modeEffectif) {
            patch.mode_non_decrit = norm.modeEffectif;
            signaux.push(["admin", "mode_non_decrit", { mode: norm.modeEffectif, model_key: modele.cle }]);
        }
        if (norm.voiesSansSonde.length && det.sondes_demandees_mode !== norm.modeEffectif) {
            patch.sondes_demandees_mode = norm.modeEffectif;
            signaux.push(["client", "sondes_a_preciser", { voies: norm.voiesSansSonde, mode: norm.modeEffectif, created_by: dev.created_by }]);
        }

        const noms = Object.keys(norm.mesures);
        const valeurs = noms.map(k => norm.mesures[k]);
        const estMesure = norm.role === "mesures" && noms.length > 0;
        let lastValues = null;
        if (estMesure) {
            Object.assign(patch, N.intervalle(det, modele, u.time, dev.intervalle_s));
            lastValues = {};
            for (const k of noms) lastValues[k] = { v: norm.mesures[k], t: u.time };
            const fusion = { ...(dev.last_values || {}), ...lastValues };
            lastValues.resume = N.resume(cat, modele, fusion);
        }

        const premiere = await tx(async c => {
            await c.query(`UPDATE public.uplinks SET decoded = $3::jsonb WHERE dev_eui = $1 AND time = $2`,
                [u.devEui, u.time, jsonb(decode)]);
            if (noms.length) {
                await c.query(
                    `INSERT INTO public.measures (time, tenant, dev_eui, metric, value)
                     SELECT $1, $2, $3, m, v FROM unnest($4::text[], $5::float8[]) AS x(m, v)
                     ON CONFLICT (dev_eui, metric, time) DO NOTHING`,
                    [u.time, dev.tenant_slug, u.devEui, noms, valeurs]);
            }
            let premiere = false;
            if (estMesure) {
                const p = await c.query(`UPDATE app.devices SET last_seen = $2 WHERE dev_eui = $1 AND last_seen IS NULL RETURNING dev_eui`,
                    [u.devEui, u.time]);
                premiere = p.rowCount > 0;
                await c.query(
                    `UPDATE app.devices SET last_seen = greatest(last_seen, $2::timestamptz), last_rssi = $3, last_snr = $4,
                        battery_mv = coalesce($5, battery_mv), last_values = last_values || $6::jsonb,
                        config = jsonb_set(config, '{detected}', coalesce(config->'detected', '{}'::jsonb) || $7::jsonb),
                        ttn_status = CASE WHEN ttn_status IN ('enregistre', 'en_creation') THEN 'connecte' ELSE ttn_status END
                     WHERE dev_eui = $1`,
                    [u.devEui, u.time, u.rssi, u.snr, norm.batterieMv, jsonb(lastValues), jsonb(patch)]);
            } else {
                await c.query(
                    `UPDATE app.devices SET battery_mv = coalesce($2, battery_mv),
                        config = jsonb_set(config, '{detected}', coalesce(config->'detected', '{}'::jsonb) || $3::jsonb),
                        ttn_status = CASE WHEN ttn_status IN ('enregistre', 'en_creation') THEN 'connecte' ELSE ttn_status END
                     WHERE dev_eui = $1`,
                    [u.devEui, norm.batterieMv, jsonb(patch)]);
            }
            if (premiere) {
                const attente = norm.voiesSansSonde.length > 0;
                await signaler(c, "client", "premiere_mesure", dev.tenant_slug, u.devEui,
                    { resume: lastValues.resume, created_by: dev.created_by, attente_sondes: attente });
            }
            for (const s of signaux) await envoyerSignal(c, s, dev, u);
            return premiere;
        });

        if (STATUTS_ALERTES.has(dev.tenant_status) && (estMesure || norm.batterieMv !== null)) {
            const nb = await evaluerAlertes(dev, modele, norm.mesures, u.time);
            if (nb) await expedier().catch(e => log.error(`expéditeur : ${e.message}`));
        }
        return premiere;
    }

    async function envoyerSignal(c, [type, kind, details], dev, u) {
        if (type === "anomalie") {
            await anomalie(c, kind, { tenant: dev.tenant_slug, devEui: u.devEui, appId: u.appId, details, trame: trameCourte(u), avertir: "premiere" });
        } else {
            await signaler(c, type, kind, dev.tenant_slug, u.devEui, details);
        }
    }

    async function majDetected(c, devEui, patch) {
        await c.query(
            `UPDATE app.devices SET config = jsonb_set(config, '{detected}', coalesce(config->'detected', '{}'::jsonb) || $2::jsonb)
             WHERE dev_eui = $1`, [devEui, jsonb(patch)]);
    }

    // ---------------------------------------------------------------- alertes (spec §8)

    function hysteresisDe(modele) {
        return metric => {
            const def = N.definitionMesure(cat, modele, metric);
            return def ? def.hysteresis || 0 : 0;
        };
    }

    async function lireRegles(c, devEui) {
        const r = await c.query(
            `SELECT r.id, r.kind, r.metric, r.min, r.max, r.for_minutes, r.params, r.enabled,
                    coalesce(s.state, 'ok') AS state, s.since, s.pending_since, s.last_notified_at, s.muted_until,
                    s.rule_id IS NULL AS sans_etat
             FROM app.alert_rules r LEFT JOIN app.alert_state s ON s.rule_id = r.id
             WHERE r.dev_eui = $1 AND (r.enabled OR (r.kind = 'silence' AND s.state = 'alarm'))`, [devEui]);
        for (const x of r.rows.filter(x => x.sans_etat)) {
            await c.query(`INSERT INTO app.alert_state (rule_id) VALUES ($1) ON CONFLICT DO NOTHING`, [x.id]);
        }
        return r.rows;
    }

    /** Évalue les règles d'un capteur pour une trame et écrit les notifications. Renvoie leur nombre. */
    async function evaluerAlertes(dev, modele, mesures, time) {
        return tx(async c => {
            const regles = await lireRegles(c, dev.dev_eui);
            if (!regles.length) return 0;
            const decisions = A.evaluerTrame(regles, mesures, time, hysteresisDe(modele), modele && modele.batterie && modele.batterie.faible_mv);
            const alarmes = [], retours = [], piles = [], retoursSilence = [], pilesRetour = [];
            for (const d of decisions) {
                const r = d.regle;
                if (d.action === "attente") {
                    await c.query(`UPDATE app.alert_state SET pending_since = $2 WHERE rule_id = $1 AND state = 'ok' AND pending_since IS NULL`, [r.id, time]);
                    continue;
                }
                if (d.action === "efface_attente") {
                    await c.query(`UPDATE app.alert_state SET pending_since = NULL WHERE rule_id = $1 AND state = 'ok'`, [r.id]);
                    continue;
                }
                const def = r.metric ? N.definitionMesure(cat, modele, r.metric) : null;
                const item = { rule_id: r.id, kind: r.kind, metric: r.metric, min: r.min, max: r.max,
                    for_minutes: r.for_minutes, valeur: d.valeur, debit: Boolean(def && def.alerte === "debit") };
                if (d.action === "alarme") {
                    const x = await c.query(
                        `UPDATE app.alert_state SET state = 'alarm', since = $2, last_value = $3, pending_since = NULL, reminded_at = NULL
                         WHERE rule_id = $1 AND state = 'ok' RETURNING muted_until`, [r.id, time, d.valeur]);
                    if (!x.rowCount) continue;
                    const coupee = x.rows[0].muted_until && new Date(x.rows[0].muted_until) > new Date();
                    if (coupee) continue;
                    if (r.kind === "state") {
                        const n = await c.query(
                            `SELECT count(*)::int AS n FROM app.notifications
                             WHERE $1 = ANY(rule_ids) AND transition = 'alarme' AND created_at > now() - interval '24 hours'
                               AND statut <> 'ecarte'`, [r.id]);
                        if (n.rows[0].n >= 5) {
                            item.coupure_auto = true;
                            await c.query(`UPDATE app.alert_state SET muted_until = now() + interval '24 hours', muted_by = NULL WHERE rule_id = $1`, [r.id]);
                            await signaler(c, "admin", "coupure_auto", dev.tenant_slug, dev.dev_eui, { rule_id: r.id, alertes_24h: n.rows[0].n + 1 });
                        }
                    }
                    (r.kind === "battery" ? piles : alarmes).push(item);
                } else if (d.action === "retour") {
                    const x = await c.query(
                        `UPDATE app.alert_state s SET state = 'ok', since = $2, last_value = $3, pending_since = NULL,
                                muted_until = CASE WHEN s.muted_until = 'infinity' THEN NULL ELSE s.muted_until END
                         FROM (SELECT since AS ancien, last_notified_at FROM app.alert_state WHERE rule_id = $1 FOR UPDATE) o
                         WHERE s.rule_id = $1 AND s.state = 'alarm'
                         RETURNING (o.last_notified_at IS NOT NULL AND o.last_notified_at >= o.ancien) AS notifie`,
                        [r.id, time, d.valeur]);
                    if (!x.rowCount || !x.rows[0].notifie) continue;
                    if (r.kind === "silence") { if (r.enabled) retoursSilence.push(item); }   // en pause : pas de message
                    else if (r.kind === "battery") pilesRetour.push(item);
                    else retours.push(item);
                }
            }
            let n = 0;
            const ecrire = async (items, transition, kindEnvoi) => {
                if (!items.length) return;
                await c.query(
                    `INSERT INTO app.notifications (audience, expediteur, kind, tenant_slug, dev_eui, rule_ids, transition, valeur, details, envoyer_apres)
                     VALUES ('client', 'nodered', 'alerte', $1, $2, $3::bigint[], $4, $5, $6::jsonb, $7)`,
                    [dev.tenant_slug, dev.dev_eui, items.map(i => i.rule_id), transition,
                        items[0].valeur ?? null, jsonb({ items, event_at: time }), A.envoyerApres(kindEnvoi, transition)]);
                n++;
            };
            await ecrire(alarmes, "alarme", "immediat");
            await ecrire(piles, "alarme", "battery");
            await ecrire(retours, "retour", "immediat");
            await ecrire(pilesRetour, "retour", "battery");
            await ecrire(retoursSilence, "retour", "silence");
            return n;
        });
    }

    /** Toutes les 5 min : capteurs devenus muets (spec §8.8), panne réseau probable (§8.11).
     *  Muet = deux messages manqués d'affilée, jamais avant 10 min (A.SILENCE, même calcul que A.delaiSilence). */
    async function chercherMuets() {
        return tx(async c => {
            const r = await c.query(
                `SELECT d.dev_eui, d.tenant_slug, d.last_seen, r.id AS rule_id
                 FROM app.devices d
                 JOIN app.tenants t ON t.slug = d.tenant_slug
                 JOIN app.alert_rules r ON r.dev_eui = d.dev_eui AND r.kind = 'silence' AND r.enabled
                 JOIN app.alert_state s ON s.rule_id = r.id AND s.state = 'ok'
                 WHERE d.last_seen IS NOT NULL AND d.ttn_status <> 'supprime'
                   AND t.status IN ('en_attente_activation', 'actif')
                   AND d.last_seen < now() - make_interval(secs => coalesce((r.params->>'delai_min')::int * 60,
                         greatest($1::float8 * greatest(coalesce(d.intervalle_s, 0), coalesce((d.config->'detected'->>'intervalle_s')::int, 1200)), $2::int)))`,
                [A.SILENCE.intervalles, A.SILENCE.plancher_s]);
            const muets = [];
            for (const x of r.rows) {
                const u = await c.query(`UPDATE app.alert_state SET state = 'alarm', since = now(), pending_since = NULL, reminded_at = NULL
                                         WHERE rule_id = $1 AND state = 'ok' RETURNING muted_until`, [x.rule_id]);
                if (!u.rowCount) continue;
                muets.push(x);
                if (u.rows[0].muted_until && new Date(u.rows[0].muted_until) > new Date()) continue;
                await c.query(
                    `INSERT INTO app.notifications (audience, expediteur, kind, tenant_slug, dev_eui, rule_ids, transition, details, envoyer_apres)
                     VALUES ('client', 'nodered', 'alerte', $1, $2, ARRAY[$3]::bigint[], 'alarme', $4::jsonb, now() + interval '5 minutes')`,
                    [x.tenant_slug, x.dev_eui, x.rule_id, jsonb({ items: [{ rule_id: x.rule_id, kind: "silence" }], event_at: new Date().toISOString(),
                        last_seen: x.last_seen })]);
            }
            const fermes = new Set(muets.map(x => x.tenant_slug));
            if (muets.length >= 5 && fermes.size >= 2) {
                const g = await c.query(
                    `SELECT DISTINCT ON (dev_eui) dev_eui, gateways FROM public.uplinks
                     WHERE dev_eui = ANY($1::text[]) AND time > now() - interval '7 days' ORDER BY dev_eui, time DESC`,
                    [muets.map(x => x.dev_eui)]);
                const passerelles = [...new Set(g.rows.flatMap(x => (x.gateways || []).map(p => p.id)))];
                await signaler(c, "admin", "panne_reseau", null, null, { capteurs: muets.length, fermes: fermes.size, passerelles });
            }
            return muets.length;
        });
    }

    /** Toutes les 5 min : fins de coupure, un rappel si l'alerte dure (spec §8.4, §8.8). */
    async function finsDeCoupure() {
        return tx(async c => {
            const r = await c.query(
                `UPDATE app.alert_state s SET muted_until = NULL, muted_by = NULL,
                        reminded_at = CASE WHEN s.state = 'alarm' THEN now() ELSE s.reminded_at END
                 FROM app.alert_rules r, app.devices d, app.tenants t
                 WHERE r.id = s.rule_id AND d.dev_eui = r.dev_eui AND t.slug = d.tenant_slug
                   AND s.muted_until IS NOT NULL AND s.muted_until <= now()
                 RETURNING s.rule_id, s.state, s.last_value, r.kind, r.metric, r.min, r.max, r.for_minutes, r.dev_eui,
                           d.tenant_slug, d.ttn_status, d.last_seen, t.status AS tenant_status`);
            const parCapteur = new Map();
            for (const x of r.rows) {
                if (x.state !== "alarm" || x.ttn_status === "supprime" || !STATUTS_ALERTES.has(x.tenant_status)) continue;
                const l = parCapteur.get(x.dev_eui) || [];
                l.push(x);
                parCapteur.set(x.dev_eui, l);
            }
            for (const [devEui, l] of parCapteur) {
                const items = l.map(x => ({ rule_id: x.rule_id, kind: x.kind, metric: x.metric, min: x.min, max: x.max,
                    for_minutes: x.for_minutes, valeur: x.last_value }));
                const silence = l.find(x => x.kind === "silence");
                await c.query(
                    `INSERT INTO app.notifications (audience, expediteur, kind, tenant_slug, dev_eui, rule_ids, transition, details)
                     VALUES ('client', 'nodered', 'alerte', $1, $2, $3::bigint[], 'rappel', $4::jsonb)`,
                    [l[0].tenant_slug, devEui, items.map(i => i.rule_id), jsonb({ items, event_at: new Date().toISOString(),
                        last_seen: silence ? silence.last_seen : undefined })]);
            }
            return parCapteur.size;
        });
    }

    /** Chaque jour à 8 h : relance des capteurs muets depuis 7 jours (spec §8.8) et rappel hebdomadaire des piles. */
    async function relances7Jours() {
        return tx(async c => {
            const piles = await c.query(
                `UPDATE app.alert_state s SET reminded_at = now()
                 FROM app.alert_rules r, app.devices d, app.tenants t
                 WHERE r.id = s.rule_id AND r.kind = 'battery' AND r.enabled AND d.dev_eui = r.dev_eui AND t.slug = d.tenant_slug
                   AND t.status IN ('en_attente_activation', 'actif') AND d.ttn_status <> 'supprime'
                   AND s.state = 'alarm' AND s.since < now() - interval '6 days 20 hours'
                   AND coalesce(s.reminded_at, s.since) < now() - interval '6 days 20 hours'
                   AND (s.muted_until IS NULL OR s.muted_until < now())
                 RETURNING s.rule_id, r.dev_eui, d.tenant_slug, d.battery_mv, d.model_key`);
            for (const x of piles.rows) {
                // Pile remontée au-dessus du seuil (courbe du catalogue changée, redoux) : pas de rappel.
                const m = cat && x.model_key ? cat.modeles.get(x.model_key) : null;
                const faible = m && m.batterie && m.batterie.faible_mv;
                if (faible && x.battery_mv !== null && x.battery_mv >= faible) continue;
                await c.query(
                    `INSERT INTO app.notifications (audience, expediteur, kind, tenant_slug, dev_eui, rule_ids, transition, details)
                     VALUES ('client', 'nodered', 'alerte', $1, $2, ARRAY[$3]::bigint[], 'rappel', $4::jsonb)`,
                    [x.tenant_slug, x.dev_eui, x.rule_id, jsonb({ items: [{ rule_id: x.rule_id, kind: "battery", valeur: x.battery_mv }],
                        event_at: new Date().toISOString() })]);
            }
            const r = await c.query(
                `UPDATE app.alert_state s SET reminded_at = now()
                 FROM app.alert_rules r, app.devices d, app.tenants t
                 WHERE r.id = s.rule_id AND r.kind = 'silence' AND r.enabled AND d.dev_eui = r.dev_eui AND t.slug = d.tenant_slug
                   AND t.status IN ('en_attente_activation', 'actif') AND d.ttn_status <> 'supprime'
                   AND s.state = 'alarm' AND s.since < now() - interval '7 days'
                   AND (s.reminded_at IS NULL OR s.reminded_at < s.since + interval '7 days')
                   AND (s.muted_until IS NULL OR s.muted_until < now())
                 RETURNING s.rule_id, r.dev_eui, d.tenant_slug`);
            for (const x of r.rows) {
                await c.query(
                    `INSERT INTO app.notifications (audience, expediteur, kind, tenant_slug, dev_eui, rule_ids, transition, details)
                     VALUES ('client', 'nodered', 'alerte', $1, $2, ARRAY[$3]::bigint[], 'rappel', $4::jsonb)`,
                    [x.tenant_slug, x.dev_eui, x.rule_id, jsonb({ items: [{ rule_id: x.rule_id, kind: "silence", relance: true }],
                        event_at: new Date().toISOString() })]);
            }
            return r.rowCount;
        });
    }

    async function purgeNocturne() {
        const r = await pool.query(`DELETE FROM app.notifications WHERE created_at < now() - interval '1 year'`);
        return r.rowCount;
    }

    // ---------------------------------------------------------------- expéditeur (spec §8.10)

    let fileTelegram = Promise.resolve();
    let dernierEnvoi = 0;
    /** Appel de l'API Telegram, 1 message par seconde tous chats confondus (spec §8.7, point 6). */
    function telegram(methode, corps) {
        const tache = fileTelegram.then(async () => {
            const attente = dernierEnvoi + 1000 - Date.now();
            if (attente > 0) await new Promise(r => setTimeout(r, attente));
            for (let essai = 0; essai < 2; essai++) {
                dernierEnvoi = Date.now();
                // L'adresse contient le jeton : elle n'est jamais journalisée (spec §8.10, point 3).
                const rep = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_CLIENT_BOT_TOKEN}/${methode}`, {
                    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corps),
                    signal: AbortSignal.timeout(15000),
                });
                const json = await rep.json().catch(() => ({}));
                if (rep.status === 429 && essai === 0) {
                    const s = Math.min(60, Number((json.parameters || {}).retry_after) || 5);
                    await new Promise(r => setTimeout(r, s * 1000));
                    continue;
                }
                return { status: rep.status, json };
            }
            return { status: 429, json: {} };
        });
        fileTelegram = tache.catch(() => {});
        return tache;
    }

    async function destinataires(c, tenant) {
        const t = await c.query(`SELECT slug, display_name, status, alert_chat_id, alert_chat_unreachable_since FROM app.tenants WHERE slug = $1`, [tenant]);
        const ferme = t.rows[0];
        const m = await c.query(
            `SELECT p.id, p.telegram_user_id, p.display_name, m.role, m.receives_alerts,
                    (SELECT count(*) FROM app.memberships m2 JOIN app.tenants t2 ON t2.slug = m2.tenant_slug
                     WHERE m2.person_id = p.id AND m2.status = 'actif' AND t2.status IN ('en_attente_activation', 'actif', 'suspendu'))::int AS nb_fermes
             FROM app.memberships m JOIN app.people p ON p.id = m.person_id
             WHERE m.tenant_slug = $1 AND m.status = 'actif' AND p.telegram_user_id IS NOT NULL AND p.unreachable_since IS NULL`, [tenant]);
        const groupePerdu = ferme.alert_chat_id && ferme.alert_chat_unreachable_since;
        const liste = [];
        const vus = new Set();
        if (ferme.alert_chat_id && !groupePerdu) {
            liste.push({ chat_id: Number(ferme.alert_chat_id), groupe: true });
            vus.add(String(ferme.alert_chat_id));
        }
        for (const p of m.rows) {
            const recoit = p.receives_alerts || (groupePerdu && p.role === "proprietaire");
            if (!recoit || vus.has(String(p.telegram_user_id))) continue;
            vus.add(String(p.telegram_user_id));
            liste.push({ chat_id: Number(p.telegram_user_id), person_id: p.id, conseiller: p.role === "conseiller", plusieurs: p.nb_fermes > 1 });
        }
        return { ferme, liste };
    }

    /** « Pas de nouvelles » dont le capteur a reparlé pendant l'envoi différé : écartée, et pas de « de nouveau en ligne ». */
    async function revenuAvantEnvoi(c, notif) {
        const items = (notif.details || {}).items || [];
        if (notif.transition !== "alarme" || !items.length || !items.every(i => i.kind === "silence")) return false;
        const s = await c.query(`SELECT coalesce(bool_or(state = 'alarm'), false) AS alarme FROM app.alert_state WHERE rule_id = ANY($1::bigint[])`,
            [notif.rule_ids || []]);
        if (s.rows[0].alarme) return false;
        await c.query(`UPDATE app.notifications SET statut = 'ecarte', erreur = 'revenu avant l''envoi' WHERE id = $1`, [notif.id]);
        return true;
    }

    async function rassemblerSilences(c, lignes) {
        const garder = [];
        const groupes = new Map();
        for (const n of lignes) {
            const items = (n.details || {}).items || [];
            const silence = items.length && items.every(i => i.kind === "silence") && (n.transition === "alarme" || n.transition === "retour");
            if (!silence) { garder.push(n); continue; }
            const cle = `${n.tenant_slug}|${n.transition}`;
            const g = groupes.get(cle) || [];
            g.push(n);
            groupes.set(cle, g);
        }
        for (const g of groupes.values()) {
            const tete = g[0];
            if (g.length > 1) {
                tete.details = { ...tete.details, groupe: g.map(x => x.dev_eui), items: g.flatMap(x => x.details.items) };
                tete.rule_ids = g.flatMap(x => x.rule_ids);
                await c.query(`UPDATE app.notifications SET rule_ids = $2::bigint[], details = $3::jsonb WHERE id = $1`,
                    [tete.id, tete.rule_ids, jsonb(tete.details)]);
                for (const x of g.slice(1)) {
                    await c.query(`UPDATE app.notifications SET statut = 'ecarte', erreur = $2 WHERE id = $1`, [x.id, `groupé dans ${tete.id}`]);
                }
            }
            garder.push(tete);
        }
        return garder.sort((a, b) => Number(a.id) - Number(b.id));
    }

    /** Envoie les alertes prêtes (lancé après chaque trame et chaque minute). */
    async function expedier() {
        if (!env.TELEGRAM_CLIENT_BOT_TOKEN) return 0;
        await pool.query(`UPDATE app.notifications SET statut = 'a_envoyer'
                          WHERE expediteur = 'nodered' AND statut = 'en_cours' AND envoyer_apres < now() - interval '10 minutes'`);
        const r = await pool.query(
            `UPDATE app.notifications SET statut = 'en_cours'
             WHERE id IN (SELECT id FROM app.notifications WHERE expediteur = 'nodered' AND statut = 'a_envoyer'
                          AND envoyer_apres <= now() ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED)
             RETURNING *`);
        if (!r.rowCount) return 0;
        const c = await pool.connect();
        let n = 0;
        try {
            const aEnvoyer = [];
            for (const notif of r.rows) if (!(await revenuAvantEnvoi(c, notif))) aEnvoyer.push(notif);
            const lignes = await rassemblerSilences(c, aEnvoyer);
            for (const notif of lignes) { await envoyerUne(c, notif); n++; }
        } finally {
            c.release();
        }
        return n;
    }

    async function envoyerUne(c, notif) {
        const { ferme, liste } = await destinataires(c, notif.tenant_slug);
        if (!ferme || !STATUTS_ALERTES.has(ferme.status)) {
            await c.query(`UPDATE app.notifications SET statut = 'ecarte', erreur = 'ferme sans alertes' WHERE id = $1`, [notif.id]);
            return;
        }
        if (!liste.length) {
            await c.query(`UPDATE app.notifications SET statut = 'sans_destinataire' WHERE id = $1`, [notif.id]);
            return;
        }
        const devs = [notif.dev_eui, ...(((notif.details || {}).groupe) || [])];
        const capteurs = await c.query(`SELECT dev_eui, name, model_key, last_seen FROM app.devices WHERE dev_eui = ANY($1::text[])`, [devs]);
        const parDev = new Map(capteurs.rows.map(x => [x.dev_eui, x]));
        const d = notif.details || {};
        if ((d.items || []).some(i => i.kind === "silence")) {
            const vus = capteurs.rows.map(x => x.last_seen).filter(Boolean).map(x => new Date(x).getTime());
            if (vus.length) d.duree = F.duree(Date.now() - Math.max(...vus));
        }
        const texte = A.rediger(T, cat, { ...notif, details: d }, {
            nomCapteur: dev => (parDev.get(dev) || {}).name || dev,
            modele: dev => cat.modeles.get((parDev.get(dev) || {}).model_key) || null,
        });
        let suffixe = "";
        if (d.event_at && Date.now() - new Date(d.event_at).getTime() > 15 * 60000 && notif.transition !== "rappel") {
            suffixe = F.gabarit(T.en_retard, { heure: F.heure(d.event_at) });
        }
        // Retour : on répond au message d'alerte et on retire ses boutons (spec §4.8, §8.6).
        let precedents = new Map();
        if (notif.transition === "retour") {
            const p = await c.query(
                `SELECT destinataires FROM app.notifications WHERE expediteur = 'nodered' AND transition IN ('alarme', 'rappel')
                   AND rule_ids && $1::bigint[] AND statut = 'envoye' AND id < $2 ORDER BY id DESC LIMIT 1`, [notif.rule_ids, notif.id]);
            for (const x of (p.rows[0] && p.rows[0].destinataires) || []) if (x.message_id) precedents.set(String(x.chat_id), x.message_id);
        }
        const resultats = [];
        let unOk = false;
        for (const dest of liste) {
            const prefixe = dest.plusieurs ? F.gabarit(T.prefixe_ferme, { ferme: F.echapper(ferme.display_name) }) : "";
            const corps = { chat_id: dest.chat_id, text: prefixe + texte + suffixe, parse_mode: "HTML" };
            const clavier = A.boutons(T, notif, { conseiller: dest.conseiller });
            if (clavier) corps.reply_markup = { inline_keyboard: clavier };
            const ancien = precedents.get(String(dest.chat_id));
            if (ancien) corps.reply_parameters = { message_id: ancien, allow_sending_without_reply: true };
            let res;
            try { res = await telegram("sendMessage", corps); } catch (e) { res = { status: 0, json: { description: e.name } }; }
            const ok = res.status === 200 && res.json.ok;
            const ligne = { chat_id: dest.chat_id, resultat: ok ? "ok" : `erreur ${res.status}` };
            if (ok) { ligne.message_id = res.json.result.message_id; unOk = true; }
            if (ok && ancien) await telegram("editMessageReplyMarkup", { chat_id: dest.chat_id, message_id: ancien, reply_markup: { inline_keyboard: [] } }).catch(() => {});
            if (!ok && (res.status === 403 || (res.status === 400 && /chat not found|kicked|blocked/i.test(res.json.description || "")))) {
                if (dest.groupe) {
                    const mig = (res.json.parameters || {}).migrate_to_chat_id;
                    if (mig) {
                        await c.query(`UPDATE app.tenants SET alert_chat_id = $2 WHERE slug = $1`, [notif.tenant_slug, mig]).catch(() => {});
                    } else {
                        const g = await c.query(`UPDATE app.tenants SET alert_chat_unreachable_since = now()
                                                 WHERE slug = $1 AND alert_chat_unreachable_since IS NULL RETURNING slug`, [notif.tenant_slug]);
                        if (g.rowCount) await signaler(c, "admin", "groupe_perdu", notif.tenant_slug, null, { chat_id: dest.chat_id });
                    }
                    ligne.resultat = "groupe perdu";
                } else {
                    const p = await c.query(`UPDATE app.people SET unreachable_since = now() WHERE id = $1 AND unreachable_since IS NULL RETURNING id`, [dest.person_id]);
                    if (p.rowCount) await signaler(c, "admin", "bot_bloque", notif.tenant_slug, null, { person_id: dest.person_id });
                    ligne.resultat = "bot bloqué";
                }
            }
            resultats.push(ligne);
        }
        await c.query(`UPDATE app.notifications SET statut = $2, destinataires = $3::jsonb, erreur = $4, details = $5::jsonb WHERE id = $1`,
            [notif.id, unOk ? "envoye" : "echec", jsonb(resultats), unOk ? null : "aucun envoi réussi", jsonb(d)]);
        if (unOk && notif.rule_ids && notif.rule_ids.length) {
            await c.query(`UPDATE app.alert_state SET last_notified_at = now() WHERE rule_id = ANY($1::bigint[])`, [notif.rule_ids]);
        }
        // « Pas de nouvelles » : une seule alerte, puis en pause jusqu'au bouton « Réactiver » (choix du 27/11).
        const silences = (d.items || []).filter(i => i.kind === "silence").map(i => i.rule_id);
        if (unOk && notif.transition !== "retour" && silences.length) {
            await c.query(`UPDATE app.alert_rules SET enabled = false, params = params || jsonb_build_object('en_pause_depuis', now())
                           WHERE id = ANY($1::bigint[]) AND kind = 'silence' AND enabled`, [silences]);
        }
    }

    // ---------------------------------------------------------------- join et downlink (spec §7.2)

    async function recevoirJoin(payload, entetes, dejaControle = false) {
        if (!dejaControle && !secretValide(entetes, [env.TTN_WEBHOOK_SECRET, env.TTN_WEBHOOK_SECRET_PREVIOUS])) {
            etat.rejets++;
            return { statut: 401 };
        }
        let m;
        try { m = lireMessage(payload); } catch { etat.rejets++; return { statut: 400 }; }
        const quand = (payload.join_accept && payload.join_accept.received_at) || payload.received_at || new Date().toISOString();
        try {
            await tx(async c => {
                const d = await chercherCapteur(c, m.devEui);
                if (!d || !appAcceptee(d, m.appId) || d.ttn_status === "supprime") {
                    const raison = !d ? "deveui_inconnu" : d.ttn_status === "supprime" ? "capteur_supprime" : "mauvaise_application";
                    await anomalie(c, raison, { tenant: d ? d.tenant_slug : null, devEui: m.devEui, appId: m.appId, details: { join: true } });
                    return;
                }
                await c.query(
                    `UPDATE app.devices SET ttn_status = CASE WHEN ttn_status IN ('enregistre', 'en_creation') THEN 'connecte' ELSE ttn_status END,
                        config = jsonb_set(config, '{detected}', coalesce(config->'detected', '{}'::jsonb) || jsonb_build_object('joined_at', $2::text))
                     WHERE dev_eui = $1`, [m.devEui, DATE.test(String(quand)) ? quand : new Date().toISOString()]);
            });
        } catch (e) {
            log.error(`join ${m.devEui} : base injoignable (${e.code || e.message})`);
            if (!dejaControle) ecrireSpool("join", payload);
            return { statut: 200, spool: true };
        }
        return { statut: 200 };
    }

    const EVENEMENTS = {
        downlink_queued: null, downlink_sent: "envoyee", downlink_ack: "confirmee", downlink_nack: "echec", downlink_failed: "echec",
    };

    async function recevoirDownlink(payload, entetes) {
        if (!secretValide(entetes, [env.TTN_WEBHOOK_SECRET, env.TTN_WEBHOOK_SECRET_PREVIOUS])) { etat.rejets++; return { statut: 401 }; }
        let m;
        try { m = lireMessage(payload); } catch { etat.rejets++; return { statut: 400 }; }
        const evt = Object.keys(EVENEMENTS).find(k => payload[k]);
        if (!evt) return { statut: 200 };
        const corps = payload[evt] || {};
        const dl = corps.downlink || corps;
        const correl = [...(payload.correlation_ids || []), ...(dl.correlation_ids || [])].map(String);
        const ref = correl.map(x => /^mobilab:cmd:(\d+)$/.exec(x)).find(Boolean);
        await tx(async c => {
            let cmd = null;
            if (ref) {
                const r = await c.query(`SELECT id, status FROM app.commands WHERE id = $1 AND dev_eui = $2`, [ref[1], m.devEui]);
                cmd = r.rows[0] || null;
            }
            if (!cmd) {
                const hex = dl.frm_payload ? Buffer.from(String(dl.frm_payload), "base64").toString("hex") : null;
                const r = await c.query(
                    `SELECT id, status FROM app.commands WHERE dev_eui = $1 AND status IN ('demandee', 'envoyee')
                       AND ($2::int IS NULL OR f_port = $2) AND ($3::text IS NULL OR lower(payload_hex) = $3)
                     ORDER BY id DESC LIMIT 1`, [m.devEui, Number.isInteger(dl.f_port) ? dl.f_port : null, hex]);
                cmd = r.rows[0] || null;
            }
            if (!cmd) {
                const d = await chercherCapteur(c, m.devEui);
                if (!d) await anomalie(c, "deveui_inconnu", { devEui: m.devEui, appId: m.appId, details: { downlink: evt } });
                return;
            }
            const statut = EVENEMENTS[evt];
            if (!statut) return;
            const erreur = statut === "echec" ? String((corps.error && (corps.error.message_format || corps.error.name)) || evt).slice(0, 200) : null;
            const u = await c.query(
                `UPDATE app.commands SET status = $2,
                    sent_at = CASE WHEN $2 = 'envoyee' THEN now() ELSE sent_at END,
                    confirmed_at = CASE WHEN $2 = 'confirmee' THEN now() ELSE confirmed_at END,
                    error = coalesce($3, error)
                 WHERE id = $1 AND status IN ('demandee', 'envoyee') RETURNING id, dev_eui, action`, [cmd.id, statut, erreur]);
            // Intervalle d'envoi confirmé par le capteur : on le garde (app.devices.intervalle_s) et les écarts
            // mesurés repartent de zéro, pour que l'alerte « pas de nouvelles » suive le nouveau rythme tout de suite.
            const iv = u.rowCount && statut === "confirmee" ? /^intervalle:(\d+)$/.exec(u.rows[0].action) : null;
            if (iv) {
                await c.query(
                    `UPDATE app.devices SET intervalle_s = $2,
                        config = jsonb_set(config, '{detected}', coalesce(config->'detected', '{}'::jsonb) || $3::jsonb)
                     WHERE dev_eui = $1`, [m.devEui, Number(iv[1]), jsonb({ intervalle_s: Number(iv[1]), ecarts_s: [] })]);
            }
            if (u.rowCount) {
                const d = await c.query(`SELECT tenant_slug FROM app.devices WHERE dev_eui = $1`, [m.devEui]);
                await signaler(c, "client", "commande", d.rows[0] && d.rows[0].tenant_slug, m.devEui, { command_id: Number(cmd.id), evenement: evt, statut });
            }
        });
        return { statut: 200 };
    }

    // ---------------------------------------------------------------- redécodage (spec §7.6, §5.13)

    async function redecoder(devEui, depuis) {
        if (!/^[0-9a-f]{16}$/.test(String(devEui))) throw new Error("dev_eui");
        const debut = depuis ? new Date(depuis) : new Date(0);
        if (Number.isNaN(debut.getTime())) throw new Error("depuis");
        return tx(async c => {
            const d = await chercherCapteur(c, devEui);
            if (!d) throw new Error("capteur inconnu");
            const det = (d.config && d.config.detected) || {};
            const modele = cat.modeles.get(d.model_key || det.modele_lu);
            if (!modele) throw new Error("modèle inconnu");
            const r = await c.query(
                `SELECT time, tenant, f_port, frm_payload FROM public.uplinks
                 WHERE dev_eui = $1 AND time >= $2 AND frm_payload IS NOT NULL ORDER BY time`, [devEui, debut]);
            await c.query(`DELETE FROM public.measures WHERE dev_eui = $1 AND time >= $2`, [devEui, debut]);
            let compteur = null, n = 0;
            for (const x of r.rows) {
                const time = new Date(x.time).toISOString();
                const octets = N.forcerMode(modele, x.frm_payload, d.mode_override);
                let decode;
                try { decode = decoderSource(choisirDecodeur(modele, det.firmware), octets, x.f_port); } catch (e) {
                    await c.query(`UPDATE public.uplinks SET decoded = $3::jsonb WHERE dev_eui = $1 AND time = $2`, [devEui, x.time, jsonb({ erreur: e.message })]);
                    continue;
                }
                const norm = N.normaliser(cat, modele, decode, { fPort: x.f_port, octets: x.frm_payload, probes: d.probes || {},
                    modeForce: d.mode_override || null, detected: { compteur }, time });
                if (norm.detected.compteur) compteur = norm.detected.compteur;
                await c.query(`UPDATE public.uplinks SET decoded = $3::jsonb WHERE dev_eui = $1 AND time = $2`, [devEui, x.time, jsonb(decode)]);
                const noms = Object.keys(norm.mesures);
                if (noms.length) {
                    await c.query(
                        `INSERT INTO public.measures (time, tenant, dev_eui, metric, value)
                         SELECT $1, $2, $3, m, v FROM unnest($4::text[], $5::float8[]) AS y(m, v)
                         ON CONFLICT (dev_eui, metric, time) DO NOTHING`,
                        [x.time, x.tenant, devEui, noms, noms.map(k => norm.mesures[k])]);
                }
                n++;
            }
            return n;
        });
    }

    // ---------------------------------------------------------------- santé (spec §5.12)

    function sante() {
        let flows = null;
        try {
            const f = env.FLOWS || "/mobilab/flows.json";
            flows = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 12);
        } catch { /* absent */ }
        return {
            ok: !etat.catalogueErreur,
            derniere_trame: etat.derniereTrame,
            recues: etat.recues,
            rejets: etat.rejets,
            erreurs: etat.erreurs,
            spool_octets: tailleSpool(),
            catalogue: cat.version,
            catalogue_erreur: etat.catalogueErreur,
            flows_sha: flows,
        };
    }

    return {
        get catalogue() { return cat; },
        rechargerCatalogue, recevoirUplink, recevoirJoin, recevoirDownlink, redecoder, sante,
        chercherMuets, finsDeCoupure, relances7Jours, purgeNocturne, expedier, rejouerSpool,
        _interne: { evaluerAlertes, traiterUplink, lireUplink, telegram },
    };
}

module.exports = { creer, secretValide, lireUplink, lireMessage, choisirDecodeur, ErreurTrame,
    catalogue: catalogueLib, normaliser: N, alertes: A, format: F, decoder, decoderSource, trame: trameLib };
