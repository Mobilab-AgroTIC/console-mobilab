// Moteur des jobs (spec V3 §6.1) : étapes rejouables, un job à la fois par ferme (verrou consultatif),
// relances après 10 s, 1 min et 5 min sur erreur réseau ou 5xx, aucune relance sur 4xx.
import type pg from "pg";
import { db, q, un, json, notifier } from "../db.js";
import { ErreurApi } from "../ttn.js";
import { log } from "../log.js";
import { chiffrer, dechiffrer } from "../crypto.js";
import type { Services } from "../services.js";

export interface Job {
  id: number; kind: string; tenant_slug: string | null; dev_eui: string | null; status: string; step: string | null;
  params: any; result: any; secret: Buffer | null; attempts: number; requested_by: number | null;
  chat_id: number | null; message_id: number | null; created_at: Date;
}

export class ErreurMetier extends Error {
  constructor(public code: string, message: string, public temporaire = false) { super(message); }
}

export interface Ctx {
  job: Job;
  s: Services;
  c: pg.PoolClient;
  /** Exécute une étape si elle n'est pas déjà faite. `memoire` : étape dont le résultat ne vit qu'en mémoire. */
  etape(nom: string, fn: () => Promise<void>, o?: { memoire?: string }): Promise<void>;
  /** Fusionne dans app.jobs.result (jamais de secret). */
  noter(patch: Record<string, unknown>): Promise<void>;
  memoire: Record<string, unknown>;
  secret(): string | null;
  ecrireSecret(v: string | null): Promise<void>;
}

export interface Definition {
  etapes: string[];
  verrou?: boolean;
  executer(ctx: Ctx): Promise<void>;
  /** Après l'échec définitif : retour en arrière, messages. */
  echec?(ctx: Ctx, e: Error): Promise<void>;
  /** Bouton [Annuler] : défaire ce qui peut l'être. */
  annuler?(job: Job, s: Services): Promise<void>;
  silencieux?: boolean;
}

const definitions = new Map<string, Definition>();
export function definir(kind: string, d: Definition) { definitions.set(kind, d); }

const DELAIS = [10, 60, 300];

/** Crée un job (dans la transaction du bot quand c'est possible). */
export async function creerJob(c: pg.PoolClient | pg.Pool, j: { kind: string; tenant?: string | null; dev_eui?: string | null;
  params?: unknown; secret?: Buffer | null; requested_by?: number | null; chat_id?: number | null; message_id?: number | null;
  run_after?: Date | null }): Promise<number> {
  const r = await c.query(
    `INSERT INTO app.jobs (kind, tenant_slug, dev_eui, params, secret, requested_by, chat_id, message_id, run_after)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, coalesce($9, now())) RETURNING id`,
    [j.kind, j.tenant ?? null, j.dev_eui ?? null, json(j.params ?? {}), j.secret ?? null, j.requested_by ?? null,
     j.chat_id ?? null, j.message_id ?? null, j.run_after ?? null]);
  await c.query(`SELECT pg_notify('jobs', $1)`, [String(r.rows[0].id)]);
  return Number(r.rows[0].id);
}

export function chiffrerSecret(s: Services, clair: string): Buffer {
  if (!s.cfg.secretsKey) throw new ErreurMetier("SECRETS_KEY", "SECRETS_KEY manquant");
  return chiffrer(s.cfg.secretsKey, clair);
}

export function lireSecret(s: Services, b: Buffer | null): string | null {
  if (!b || !s.cfg.secretsKey) return null;
  return dechiffrer(s.cfg.secretsKey, b);
}

function estTemporaire(e: unknown): boolean {
  if (e instanceof ErreurApi) return e.temporaire;
  if (e instanceof ErreurMetier) return e.temporaire;
  const code = (e as any)?.code;
  return ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P01", "57P03", "53300", "40001", "40P01"].includes(code);
}

export function messageErreur(e: unknown): string {
  if (e instanceof ErreurApi) return e.code;
  if (e instanceof ErreurMetier) return e.code;
  return String((e as any)?.message || e).slice(0, 120);
}

export class Moteur {
  private actifs = 0;
  private arret = false;
  private minuterie: NodeJS.Timeout | null = null;
  private ecoute: pg.PoolClient | null = null;

  constructor(private s: Services, private max = 3) {}

  async demarrer() {
    await q(`UPDATE app.jobs SET status = 'en_attente', updated_at = now() WHERE status = 'en_cours'`);
    this.ecoute = await db().connect();
    this.ecoute.on("notification", () => void this.tourner());
    await this.ecoute.query("LISTEN jobs");
    this.minuterie = setInterval(() => void this.tourner(), 2000);
    void this.tourner();
  }

  async arreter() {
    this.arret = true;
    if (this.minuterie) clearInterval(this.minuterie);
    if (this.ecoute) { await this.ecoute.query("UNLISTEN jobs").catch(() => undefined); this.ecoute.release(); }
    for (let i = 0; i < 100 && this.actifs > 0; i++) await new Promise(r => setTimeout(r, 100));
  }

  /** Prend les jobs prêts tant qu'il reste de la place. */
  async tourner() {
    while (!this.arret && this.actifs < this.max) {
      const job = await un<Job>(
        `UPDATE app.jobs SET status = 'en_cours', updated_at = now()
         WHERE id = (SELECT id FROM app.jobs WHERE status = 'en_attente' AND run_after <= now()
                     ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING *`);
      if (!job) return;
      this.actifs++;
      void this.executer(job).finally(() => { this.actifs--; void this.tourner(); });
    }
  }

  /** Exécute un job tout de suite (tests, ou appel direct). */
  async executer(job: Job) {
    // Postgres rend les bigint en texte : on les remet en nombres (identifiants Telegram, personnes).
    for (const k of ["id", "chat_id", "message_id", "requested_by"] as const) {
      if (job[k] !== null && job[k] !== undefined) (job as any)[k] = Number(job[k]);
    }
    const def = definitions.get(job.kind);
    if (!def) {
      await q(`UPDATE app.jobs SET status = 'echec', error = 'kind inconnu', updated_at = now() WHERE id = $1`, [job.id]);
      return;
    }
    const c = await db().connect();
    let verrou = false;
    try {
      if (def.verrou !== false && job.tenant_slug) {
        const r = await c.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`ferme:${job.tenant_slug}`]);
        verrou = r.rows[0].ok;
        if (!verrou) {
          await c.query(`UPDATE app.jobs SET status = 'en_attente', run_after = now() + interval '5 seconds', updated_at = now() WHERE id = $1`, [job.id]);
          return;
        }
      }
      const etapes = def.etapes;
      const memoire = this.s.memoire.get(job.id) || {};
      this.s.memoire.set(job.id, memoire);
      let secret = job.secret;
      const ctx: Ctx = {
        job, s: this.s, c, memoire,
        etape: async (nom, fn, o = {}) => {
          const i = etapes.indexOf(nom);
          if (i < 0) throw new Error(`étape inconnue ${nom}`);
          const fait = job.step ? etapes.indexOf(job.step) : -1;
          if (o.memoire) {
            if (memoire[o.memoire] !== undefined) return;     // déjà fait dans ce processus
          } else if (i <= fait) return;
          await fn();
          if (!o.memoire && i > fait) {
            job.step = nom;
            await c.query(`UPDATE app.jobs SET step = $2, updated_at = now() WHERE id = $1`, [job.id, nom]);
          }
        },
        noter: async patch => {
          job.result = { ...(job.result || {}), ...patch };
          await c.query(`UPDATE app.jobs SET result = result || $2::jsonb, updated_at = now() WHERE id = $1`, [job.id, json(patch)]);
        },
        secret: () => lireSecret(this.s, secret),
        ecrireSecret: async v => {
          secret = v === null ? null : chiffrerSecret(this.s, v);
          await c.query(`UPDATE app.jobs SET secret = $2, updated_at = now() WHERE id = $1`, [job.id, secret]);
        },
      };
      try {
        await def.executer(ctx);
        await c.query(`UPDATE app.jobs SET status = 'ok', secret = NULL, error = NULL, updated_at = now() WHERE id = $1 AND status = 'en_cours'`, [job.id]);
        this.s.memoire.delete(job.id);
      } catch (e) {
        const tentative = job.attempts + 1;
        const msg = messageErreur(e);
        if (estTemporaire(e) && tentative <= DELAIS.length) {
          await c.query(`UPDATE app.jobs SET status = 'en_attente', attempts = $2, error = $3,
                         run_after = now() + make_interval(secs => $4), updated_at = now() WHERE id = $1`,
            [job.id, tentative, msg, DELAIS[tentative - 1]]);
          log.warn(`job ${job.id} ${job.kind} : ${msg}, nouvelle tentative dans ${DELAIS[tentative - 1]} s`);
          return;
        }
        await c.query(`UPDATE app.jobs SET status = 'echec', attempts = $2, error = $3, updated_at = now() WHERE id = $1`, [job.id, tentative, msg]);
        log.error(`job ${job.id} ${job.kind} en échec à l'étape après « ${job.step ?? "début"} » : ${msg}`);
        try { if (def.echec) await def.echec(ctx, e as Error); } catch (e2) { log.error(`job ${job.id} : retour en arrière raté : ${messageErreur(e2)}`); }
        await notifier(c, { audience: "admin", kind: "tache_echec", tenant: job.tenant_slug, dev_eui: job.dev_eui,
          details: { job_id: job.id, job_kind: job.kind, etape: etapeSuivante(etapes, job.step), erreur: msg,
                     requested_by: job.requested_by, silencieux: Boolean(def.silencieux) } }).catch(() => undefined);
      }
    } finally {
      if (verrou) await c.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`ferme:${job.tenant_slug}`]).catch(() => undefined);
      c.release();
    }
  }
}

export function etapeSuivante(etapes: string[], step: string | null): string {
  const i = step ? etapes.indexOf(step) : -1;
  return etapes[i + 1] || etapes[etapes.length - 1];
}

/** [Relancer] : reprend après la dernière étape réussie (spec §6.1). */
export async function relancer(id: number, depuisEtape?: string | null) {
  await q(`UPDATE app.jobs SET status = 'en_attente', attempts = 0, run_after = now(), error = NULL,
           step = CASE WHEN $2::text IS NULL THEN step ELSE $2 END, updated_at = now()
           WHERE id = $1 AND status IN ('echec', 'annule')`, [id, depuisEtape ?? null]);
  await q(`SELECT pg_notify('jobs', $1)`, [String(id)]);
}

/** [Annuler] : défait ce qui peut l'être, passe le job en annule et efface le secret. */
export async function annuler(id: number, s: Services) {
  const job = await un<Job>(`SELECT * FROM app.jobs WHERE id = $1`, [id]);
  if (!job || !["echec", "en_attente"].includes(job.status)) return false;
  const def = definitions.get(job.kind);
  if (def?.annuler) await def.annuler(job, s);
  await q(`UPDATE app.jobs SET status = 'annule', secret = NULL, updated_at = now() WHERE id = $1`, [id]);
  return true;
}

/** Les AppKey ne restent pas plus de 7 jours après un échec (spec §0, point 1). */
export async function purgerSecrets() {
  await q(`UPDATE app.jobs SET secret = NULL WHERE secret IS NOT NULL AND status IN ('echec', 'annule', 'ok') AND updated_at < now() - interval '7 days'`);
  await q(`DELETE FROM app.jobs WHERE status IN ('ok', 'annule') AND updated_at < now() - interval '90 days'`);
}
