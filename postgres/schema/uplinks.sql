---------- Trames brutes (tous capteurs) ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.
-- Chaque uplink reçu est gardé tel quel (octets, port, compteur). Le jour où un
-- décodeur gagne des colonnes (nouveau mode, nouvelle sonde), on peut redécoder
-- tout l'historique à partir d'ici.

-- 1) Table
CREATE TABLE IF NOT EXISTS public.uplinks (
    time           TIMESTAMPTZ NOT NULL,
    name           TEXT        NOT NULL,
    tenant         TEXT        NOT NULL,
    application_id TEXT,
    f_port         SMALLINT,
    f_cnt          BIGINT,
    frm_payload    BYTEA
);

-- 2) Hypertable TimescaleDB, et une seule ligne par capteur et par instant (trame rejouée ignorée)
SELECT create_hypertable('public.uplinks', 'time', if_not_exists => TRUE, migrate_data => TRUE);
CREATE UNIQUE INDEX IF NOT EXISTS uplinks_name_time_uidx  ON public.uplinks (name, time);
CREATE INDEX        IF NOT EXISTS uplinks_tenant_time_idx ON public.uplinks (tenant, time DESC);

-- 3) Cloisonnement par client (RLS), comme les tables de mesures
ALTER TABLE public.uplinks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uplinks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS uplinks_tenant_select ON public.uplinks;
CREATE POLICY uplinks_tenant_select ON public.uplinks
    FOR SELECT USING (tenant = current_user);
