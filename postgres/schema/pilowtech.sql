---------- Pilowtech ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.pilowtech (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS rssi    INTEGER;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS snr     DOUBLE PRECISION;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS value1  DOUBLE PRECISION;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS value2  DOUBLE PRECISION;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS value3  DOUBLE PRECISION;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.pilowtech', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS pilowtech_tenant_time_idx      ON public.pilowtech (tenant, time DESC);
CREATE INDEX IF NOT EXISTS pilowtech_tenant_name_time_idx ON public.pilowtech (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.pilowtech ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pilowtech FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pilowtech_tenant_insert ON public.pilowtech;
DROP POLICY IF EXISTS pilowtech_tenant_update ON public.pilowtech;
DROP POLICY IF EXISTS pilowtech_tenant_delete ON public.pilowtech;
DROP POLICY IF EXISTS pilowtech_tenant_select ON public.pilowtech;
CREATE POLICY pilowtech_tenant_select ON public.pilowtech
    FOR SELECT USING (tenant = current_user);
