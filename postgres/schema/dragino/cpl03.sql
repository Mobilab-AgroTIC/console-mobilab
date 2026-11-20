---------- CPL01 / CPL03 (Dragino) : contact et compteurs d'impulsions ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.
-- mode 1 = CPL01 (contact, pulse_total, last_duration_min) ; mode 3 = CPL03 (pulse_pa8/pa4/pb15).

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.cpl03 (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.cpl03 ADD COLUMN IF NOT EXISTS rssi              INTEGER;
ALTER TABLE public.cpl03 ADD COLUMN IF NOT EXISTS snr               DOUBLE PRECISION;
ALTER TABLE public.cpl03 ADD COLUMN IF NOT EXISTS battery           INTEGER;
ALTER TABLE public.cpl03 ADD COLUMN IF NOT EXISTS mode              SMALLINT;
ALTER TABLE public.cpl03 ADD COLUMN IF NOT EXISTS contact_open      SMALLINT;
ALTER TABLE public.cpl03 ADD COLUMN IF NOT EXISTS pulse_total       BIGINT;
ALTER TABLE public.cpl03 ADD COLUMN IF NOT EXISTS last_duration_min INTEGER;
ALTER TABLE public.cpl03 ADD COLUMN IF NOT EXISTS pulse_pa8         BIGINT;
ALTER TABLE public.cpl03 ADD COLUMN IF NOT EXISTS pulse_pa4         BIGINT;
ALTER TABLE public.cpl03 ADD COLUMN IF NOT EXISTS pulse_pb15        BIGINT;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.cpl03', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS cpl03_tenant_time_idx      ON public.cpl03 (tenant, time DESC);
CREATE INDEX IF NOT EXISTS cpl03_tenant_name_time_idx ON public.cpl03 (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.cpl03 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cpl03 FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cpl03_tenant_insert ON public.cpl03;
DROP POLICY IF EXISTS cpl03_tenant_update ON public.cpl03;
DROP POLICY IF EXISTS cpl03_tenant_delete ON public.cpl03;
DROP POLICY IF EXISTS cpl03_tenant_select ON public.cpl03;
CREATE POLICY cpl03_tenant_select ON public.cpl03
    FOR SELECT USING (tenant = current_user);
