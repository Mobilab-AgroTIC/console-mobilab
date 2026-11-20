---------- LDDS45 / DDS45 (Dragino) : distance ultrason ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.ldds45 (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.ldds45 ADD COLUMN IF NOT EXISTS rssi        INTEGER;
ALTER TABLE public.ldds45 ADD COLUMN IF NOT EXISTS snr         DOUBLE PRECISION;
ALTER TABLE public.ldds45 ADD COLUMN IF NOT EXISTS battery     INTEGER;
ALTER TABLE public.ldds45 ADD COLUMN IF NOT EXISTS distance    INTEGER;
ALTER TABLE public.ldds45 ADD COLUMN IF NOT EXISTS temperature DOUBLE PRECISION;
ALTER TABLE public.ldds45 ADD COLUMN IF NOT EXISTS interrupt   INTEGER;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.ldds45', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS ldds45_tenant_time_idx      ON public.ldds45 (tenant, time DESC);
CREATE INDEX IF NOT EXISTS ldds45_tenant_name_time_idx ON public.ldds45 (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.ldds45 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ldds45 FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ldds45_tenant_insert ON public.ldds45;
DROP POLICY IF EXISTS ldds45_tenant_update ON public.ldds45;
DROP POLICY IF EXISTS ldds45_tenant_delete ON public.ldds45;
DROP POLICY IF EXISTS ldds45_tenant_select ON public.ldds45;
CREATE POLICY ldds45_tenant_select ON public.ldds45
    FOR SELECT USING (tenant = current_user);
