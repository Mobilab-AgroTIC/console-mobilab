---------- LHT52 (Dragino) : température et humidité ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.lht52 (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS rssi              INTEGER;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS snr               DOUBLE PRECISION;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS battery           INTEGER;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS humidity          DOUBLE PRECISION;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS temperature       DOUBLE PRECISION;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS temperature_probe DOUBLE PRECISION;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.lht52', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS lht52_tenant_time_idx      ON public.lht52 (tenant, time DESC);
CREATE INDEX IF NOT EXISTS lht52_tenant_name_time_idx ON public.lht52 (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.lht52 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lht52 FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lht52_tenant_insert ON public.lht52;
DROP POLICY IF EXISTS lht52_tenant_update ON public.lht52;
DROP POLICY IF EXISTS lht52_tenant_delete ON public.lht52;
DROP POLICY IF EXISTS lht52_tenant_select ON public.lht52;
CREATE POLICY lht52_tenant_select ON public.lht52
    FOR SELECT USING (tenant = current_user);
