"use strict";
// Test d'intégration du chemin d'une trame (spec V3 §7.3) et des alertes (§8), sur une base JETABLE.
// Ne tourne que si PGDATABASE vaut « mobilab_test » : jamais sur la base de production.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { Pool } = require("pg");
const { creer } = require("..");

const actif = process.env.PGDATABASE === "mobilab_test";
const DEV = "a84041000181b2c3";
const APP = "mobilab-f9001";

function uplink(hex, received_at, f_port = 2, extra = {}) {
    return {
        end_device_ids: { device_id: DEV, dev_eui: DEV.toUpperCase(), application_ids: { application_id: extra.app || APP } },
        received_at,
        uplink_message: { f_port, f_cnt: 12, frm_payload: Buffer.from(hex, "hex").toString("base64"), received_at,
            rx_metadata: [{ gateway_ids: { gateway_id: "gw-nord" }, rssi: -97, snr: 7.5 }, { gateway_ids: { gateway_id: "gw-sud" }, rssi: -110, snr: -3 }],
            ...(extra.version_ids ? { version_ids: extra.version_ids } : {}) },
    };
}

test("chemin complet d'une trame et alertes", { skip: !actif && "base de test mobilab_test absente" }, async t => {
    const pool = new Pool({ max: 4 });
    const envois = [];
    const fauxFetch = async (url, opts) => {
        const corps = JSON.parse(opts.body);
        envois.push({ methode: url.split("/").pop(), corps });
        return { status: 200, json: async () => ({ ok: true, result: { message_id: 100 + envois.length } }) };
    };
    const spool = fs.mkdtempSync(path.join(os.tmpdir(), "spool-"));
    const env = { TTN_WEBHOOK_SECRET: "s3cret", TELEGRAM_CLIENT_BOT_TOKEN: "123:abc" };
    const ing = creer({ pool, catalogueDir: path.join(__dirname, "..", "..", "catalogue"), spoolDir: spool, env, fetch: fauxFetch,
        log: { info() {}, warn() {}, error: m => console.error(m) } });
    const H = { "x-mobilab-secret": "s3cret" };
    const q = (s, p) => pool.query(s, p);

    await q(`TRUNCATE app.notifications, app.anomalies, app.alert_state, app.alert_rules, app.commands, app.devices,
             app.memberships, app.invitations, app.jobs, app.audit, app.tenants, app.people CASCADE`);
    await q(`TRUNCATE public.measures, public.uplinks`);
    const p = await q(`INSERT INTO app.people (telegram_user_id, display_name) VALUES (5001, 'Jean Dupont') RETURNING id`);
    await q(`INSERT INTO app.tenants (slug, display_name, ttn_app_id, pg_role, status) VALUES ('f9001', 'Ferme des Prés', $1, 'f9001', 'actif')`, [APP]);
    await q(`INSERT INTO app.memberships (person_id, tenant_slug, role, grafana_role, receives_alerts) VALUES ($1, 'f9001', 'proprietaire', 'Admin', true)`, [p.rows[0].id]);
    await q(`INSERT INTO app.devices (dev_eui, tenant_slug, name, model_key, ttn_status, created_by) VALUES ($1, 'f9001', 'Serre nord', 'dragino-lht52', 'enregistre', $2)`, [DEV, p.rows[0].id]);

    await t.test("sans en-tête secret : 401", async () => {
        const r = await ing.recevoirUplink(uplink("04fd03e8059d016afccdf9", "2026-11-17T10:00:00Z"), {});
        assert.equal(r.statut, 401);
    });

    await t.test("DevEUI inconnu : 200 et quarantaine", async () => {
        const x = uplink("04fd03e8059d016afccdf9", "2026-11-17T10:00:00Z");
        x.end_device_ids.dev_eui = "A84041FF00005A1B";
        const r = await ing.recevoirUplink(x, H);
        assert.equal(r.statut, 200);
        const a = await q(`SELECT raison, count, notified_at IS NOT NULL AS avertie FROM app.anomalies WHERE dev_eui = 'a84041ff00005a1b'`);
        assert.deepEqual(a.rows[0], { raison: "deveui_inconnu", count: 1, avertie: true });
    });

    await t.test("première trame : mesures, état du capteur, première mesure", async () => {
        const r = await ing.recevoirUplink(uplink("04fd03e8059d016afccdf9", "2026-11-17T10:00:00Z"), H);
        assert.equal(r.statut, 200);
        await r.suite();
        const m = await q(`SELECT metric, value FROM public.measures WHERE dev_eui = $1 ORDER BY metric`, [DEV]);
        assert.deepEqual(m.rows.map(x => x.metric), ["humidity", "temperature", "temperature_probe"]);
        const d = await q(`SELECT ttn_status, last_rssi, last_values->>'resume' AS resume, last_seen FROM app.devices WHERE dev_eui = $1`, [DEV]);
        assert.equal(d.rows[0].ttn_status, "connecte");
        assert.equal(d.rows[0].last_rssi, -97);
        assert.equal(d.rows[0].resume, "12,8 °C · 100 %");
        const n = await q(`SELECT kind, expediteur FROM app.notifications WHERE kind = 'premiere_mesure'`);
        assert.equal(n.rowCount, 1);
        const u = await q(`SELECT decoded->>'Node_type' AS t, gateways FROM public.uplinks WHERE dev_eui = $1`, [DEV]);
        assert.equal(u.rows[0].t, "LHT52");
        assert.equal(u.rows[0].gateways.length, 2);
    });

    await t.test("trame rejouée : rien de plus", async () => {
        const r = await ing.recevoirUplink(uplink("04fd03e8059d016afccdf9", "2026-11-17T10:00:00Z"), H);
        assert.equal(r.statut, 200);
        assert.equal(r.suite, undefined);
        const m = await q(`SELECT count(*)::int AS n FROM public.measures WHERE dev_eui = $1`, [DEV]);
        assert.equal(m.rows[0].n, 3);
    });

    await t.test("seuil haut : une alerte, pas deux, puis un retour qui répond", async () => {
        const regle = await q(`INSERT INTO app.alert_rules (dev_eui, kind, metric, max) VALUES ($1, 'threshold', 'temperature', 20) RETURNING id`, [DEV]);
        await q(`INSERT INTO app.alert_state (rule_id) VALUES ($1)`, [regle.rows[0].id]);
        let r = await ing.recevoirUplink(uplink("09cc02497fff016afccc77", "2026-11-17T10:20:00Z"), H);
        await r.suite();
        const a = await q(`SELECT id, transition, statut, destinataires FROM app.notifications WHERE kind = 'alerte' ORDER BY id`);
        assert.equal(a.rowCount, 1);
        assert.equal(a.rows[0].statut, "envoye");
        const premier = envois.find(e => e.methode === "sendMessage");
        assert.match(premier.corps.text, /<b>Serre nord<\/b> : 25,1 °C \(max 20,0 °C\)\./);
        assert.equal(premier.corps.reply_markup.inline_keyboard[0][0].callback_data, `ct:${a.rows[0].id}`);
        r = await ing.recevoirUplink(uplink("09cc02497fff016afccc77", "2026-11-17T10:40:00Z"), H);
        await r.suite();
        assert.equal((await q(`SELECT count(*)::int AS n FROM app.notifications WHERE kind = 'alerte'`)).rows[0].n, 1);
        // 19,7 °C : dans la marge de retour (0,5) → toujours en alarme
        r = await ing.recevoirUplink(uplink("07b402497fff016afccc77", "2026-11-17T11:00:00Z"), H);
        await r.suite();
        assert.equal((await q(`SELECT count(*)::int AS n FROM app.notifications WHERE kind = 'alerte'`)).rows[0].n, 1);
        // 12,77 °C : retour
        r = await ing.recevoirUplink(uplink("04fd03e8059d016afccdf9", "2026-11-17T11:20:00Z"), H);
        await r.suite();
        const b = await q(`SELECT transition, statut FROM app.notifications WHERE kind = 'alerte' ORDER BY id`);
        assert.deepEqual(b.rows.map(x => x.transition), ["alarme", "retour"]);
        const retour = envois.filter(e => e.methode === "sendMessage").pop();
        assert.match(retour.corps.text, /✅ <b>Serre nord<\/b> : revenue à 12,8 °C\./);
        assert.equal(retour.corps.reply_parameters.message_id, 101);
        assert.ok(envois.some(e => e.methode === "editMessageReplyMarkup"));
    });

    await t.test("capteur muet : alarme envoyée 5 min plus tard", async () => {
        const s = await q(`INSERT INTO app.alert_rules (dev_eui, kind) VALUES ($1, 'silence') RETURNING id`, [DEV]);
        await q(`INSERT INTO app.alert_state (rule_id) VALUES ($1)`, [s.rows[0].id]);
        await q(`UPDATE app.devices SET last_seen = now() - interval '4 hours' WHERE dev_eui = $1`, [DEV]);
        assert.equal(await ing.chercherMuets(), 1);
        assert.equal(await ing.chercherMuets(), 0);
        const n = await q(`SELECT envoyer_apres > now() AS differe FROM app.notifications WHERE rule_ids = ARRAY[$1]::bigint[]`, [s.rows[0].id]);
        assert.equal(n.rows[0].differe, true);
    });

    await t.test("join : connecté ; downlink : commande suivie", async () => {
        await q(`UPDATE app.devices SET ttn_status = 'enregistre' WHERE dev_eui = $1`, [DEV]);
        const j = await ing.recevoirJoin({ end_device_ids: { dev_eui: DEV, application_ids: { application_id: APP } }, join_accept: { received_at: "2026-11-17T12:00:00Z" } }, H);
        assert.equal(j.statut, 200);
        assert.equal((await q(`SELECT ttn_status FROM app.devices WHERE dev_eui = $1`, [DEV])).rows[0].ttn_status, "connecte");
        const c = await q(`INSERT INTO app.commands (dev_eui, action, f_port, payload_hex, expires_at, correlation_id) VALUES ($1, 'ouvrir', 15, '01', now() + interval '1 hour', 'x') RETURNING id`, [DEV]);
        await ing.recevoirDownlink({ end_device_ids: { dev_eui: DEV, application_ids: { application_id: APP } },
            correlation_ids: [`mobilab:cmd:${c.rows[0].id}`], downlink_ack: { f_port: 15 } }, H);
        assert.equal((await q(`SELECT status FROM app.commands WHERE id = $1`, [c.rows[0].id])).rows[0].status, "confirmee");
    });

    await t.test("modèle inconnu puis identifié par les version_ids", async () => {
        await q(`UPDATE app.devices SET model_key = NULL, last_seen = NULL, config = '{}' WHERE dev_eui = $1`, [DEV]);
        let r = await ing.recevoirUplink(uplink("04fd03e8059d016afccdf9", "2026-11-17T13:00:00Z"), H);
        await r.suite();
        assert.equal((await q(`SELECT count(*)::int AS n FROM app.notifications WHERE kind = 'modele_a_choisir'`)).rows[0].n, 1);
        r = await ing.recevoirUplink(uplink("04fd03e8059d016afccdf9", "2026-11-17T13:20:00Z", 2, { version_ids: { brand_id: "dragino", model_id: "lht52" } }), H);
        await r.suite();
        assert.equal((await q(`SELECT config->'detected'->>'modele_lu' AS m FROM app.devices WHERE dev_eui = $1`, [DEV])).rows[0].m, "dragino-lht52");
        assert.equal((await q(`SELECT count(*)::int AS n FROM app.notifications WHERE kind = 'modele_identifie'`)).rows[0].n, 1);
    });

    await t.test("redécodage : rien en double", async () => {
        await q(`UPDATE app.devices SET model_key = 'dragino-lht52' WHERE dev_eui = $1`, [DEV]);
        const n = await ing.redecoder(DEV, "2026-11-17T00:00:00Z");
        assert.ok(n >= 5);
        const apres = (await q(`SELECT count(*)::int AS n FROM public.measures WHERE dev_eui = $1`, [DEV])).rows[0].n;
        await ing.redecoder(DEV, "2026-11-17T00:00:00Z");
        assert.equal((await q(`SELECT count(*)::int AS n FROM public.measures WHERE dev_eui = $1`, [DEV])).rows[0].n, apres);
    });

    await t.test("base injoignable : fichier de secours, puis rejeu", async () => {
        const cassee = creer({ pool: { connect: async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); } },
            catalogueDir: path.join(__dirname, "..", "..", "catalogue"), spoolDir: spool, env, log: { info() {}, warn() {}, error() {} } });
        const r = await cassee.recevoirUplink(uplink("04fd03e8059d016afccdf9", "2026-11-17T14:00:00Z"), H);
        assert.equal(r.statut, 200);
        assert.ok(cassee.sante().spool_octets > 0);
        assert.equal(await ing.rejouerSpool(), 1);
        assert.equal(ing.sante().spool_octets, 0);
        assert.equal((await q(`SELECT count(*)::int AS n FROM public.uplinks WHERE dev_eui = $1 AND time = '2026-11-17T14:00:00Z'`, [DEV])).rows[0].n, 1);
    });

    await t.test("étapes une par une, comme la page Node-RED (message copié entre deux blocs)", async () => {
        const NR = require("../noeud-red");
        const copie = m => ({ ...structuredClone({ ...m, req: undefined }), req: m.req });   // comme RED.util.cloneMessage
        let msg = { payload: uplink("04fd03e8059d016afccdf9", "2026-11-17T15:00:00Z"), req: { headers: H } };
        const statuts = [];
        for (const etape of ["recevoir_uplink", "identifier", "decoder", "normaliser", "enregistrer", "alertes"]) {
            const r = await NR.executer(ing, etape, msg, { env });
            statuts.push(r.statut.fill);
            msg = copie(msg);
        }
        assert.equal(msg.statusCode, 200);
        assert.deepEqual(statuts, ["green", "green", "green", "green", "green", "green"]);
        assert.equal(msg.trame.modele, "dragino-lht52");
        assert.equal(msg.trame.last_values.resume, "12,8 °C · 100 %");
        const m = await q(`SELECT count(*)::int AS n FROM public.measures WHERE dev_eui = $1 AND time = '2026-11-17T15:00:00Z'`, [DEV]);
        assert.equal(m.rows[0].n, 3);
        // Trame rejouée par TTN : la réception s'arrête, avec sa raison
        const rejouee = { payload: uplink("04fd03e8059d016afccdf9", "2026-11-17T15:00:00Z"), req: { headers: H } };
        await NR.executer(ing, "recevoir_uplink", rejouee, { env });
        assert.equal(rejouee.trame.suite, false);
        assert.match(rejouee.trame.raison, /déjà reçue/);
        // Erreur de décodage : la branche dédiée note l'erreur
        const casse = { payload: uplink("04fd03e8059d016afccdf9", "2026-11-17T15:20:00Z", 7), req: { headers: H } };
        for (const etape of ["recevoir_uplink", "identifier", "decoder"]) await NR.executer(ing, etape, casse, { env });
        assert.ok(casse.trame.erreur_decodage);
        await NR.executer(ing, "erreur_decodage", casse, { env });
        const d = await q(`SELECT decoded->>'erreur' AS e FROM public.uplinks WHERE dev_eui = $1 AND time = '2026-11-17T15:20:00Z'`, [DEV]);
        assert.ok(d.rows[0].e);
        // Sans le bon secret : 401, rien n'est écrit
        const intrus = { payload: uplink("04fd03e8059d016afccdf9", "2026-11-17T15:40:00Z"), req: { headers: {} } };
        await NR.executer(ing, "recevoir_uplink", intrus, { env });
        assert.equal(intrus.statusCode, 401);
    });

    await pool.end();
});
