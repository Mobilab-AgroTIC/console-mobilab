---------- D20, D22, D23 (Dragino) : une à trois sondes de température ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.
-- Types REAL repris de l'ancienne table d23. Sonde unique du D20 : temp_red.

-- 0) Ancienne table d23 (un seul modèle) renommée en d2x (D20, D22, D23) : les mesures sont gardées.
DO $do$
BEGIN
    IF to_regclass('public.d23') IS NOT NULL AND to_regclass('public.d2x') IS NULL THEN
        ALTER TABLE public.d23 RENAME TO d2x;
        ALTER INDEX IF EXISTS public.d23_tenant_time_idx      RENAME TO d2x_tenant_time_idx;
        ALTER INDEX IF EXISTS public.d23_tenant_name_time_idx RENAME TO d2x_tenant_name_time_idx;
        ALTER INDEX IF EXISTS public.d23_name_time_idx        RENAME TO d2x_name_time_idx;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'd2x'
               AND policyname = 'd23_tenant_select') THEN
        ALTER POLICY d23_tenant_select ON public.d2x RENAME TO d2x_tenant_select;
    END IF;
END
$do$;

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.d2x (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.d2x ADD COLUMN IF NOT EXISTS rssi       REAL;
ALTER TABLE public.d2x ADD COLUMN IF NOT EXISTS snr        REAL;
ALTER TABLE public.d2x ADD COLUMN IF NOT EXISTS battery    INTEGER;
ALTER TABLE public.d2x ADD COLUMN IF NOT EXISTS mode       SMALLINT;
ALTER TABLE public.d2x ADD COLUMN IF NOT EXISTS temp_white REAL;
ALTER TABLE public.d2x ADD COLUMN IF NOT EXISTS temp_red   REAL;
ALTER TABLE public.d2x ADD COLUMN IF NOT EXISTS temp_black REAL;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.d2x', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS d2x_tenant_time_idx      ON public.d2x (tenant, time DESC);
CREATE INDEX IF NOT EXISTS d2x_tenant_name_time_idx ON public.d2x (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.d2x ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.d2x FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS d2x_tenant_insert ON public.d2x;
DROP POLICY IF EXISTS d2x_tenant_update ON public.d2x;
DROP POLICY IF EXISTS d2x_tenant_delete ON public.d2x;
DROP POLICY IF EXISTS d2x_tenant_select ON public.d2x;
CREATE POLICY d2x_tenant_select ON public.d2x
    FOR SELECT USING (tenant = current_user);
