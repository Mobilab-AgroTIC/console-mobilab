---------- LHT 52 ----------

-- 1) table minimale (juste les colonnes obligatoires)
CREATE TABLE IF NOT EXISTS public.sw3l (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    tenant TEXT NOT NULL
);

-- 2) ajout des colonnes si absentes
ALTER TABLE public.sw3l ADD COLUMN IF NOT EXISTS rssi INTEGER;
ALTER TABLE public.sw3l ADD COLUMN IF NOT EXISTS snr DOUBLE PRECISION;
ALTER TABLE public.sw3l ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.sw3l ADD COLUMN IF NOT EXISTS counter BIGINT;

-- 3) timescale hypertable (si déjà hypertable, ça peut erreur selon version)
SELECT create_hypertable('public.sw3l', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) index utiles ( tenant + name + temps  &  tenant + temps)
CREATE INDEX IF NOT EXISTS sw3l_tenant_time_idx ON public.sw3l (tenant, time DESC);
CREATE INDEX IF NOT EXISTS sw3l_tenant_name_time_idx ON public.sw3l (tenant, name, time DESC);

-- 5) RLS ON + FORCE
ALTER TABLE public.sw3l ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sw3l FORCE ROW LEVEL SECURITY;

-- 6) policies (SELECT/INSERT/UPDATE/DELETE)
DROP POLICY IF EXISTS sw3l_tenant_select ON public.lht52;
DROP POLICY IF EXISTS sw3l_tenant_insert ON public.lht52;
DROP POLICY IF EXISTS sw3l_tenant_update ON public.lht52;
DROP POLICY IF EXISTS sw3l_tenant_delete ON public.lht52;

CREATE POLICY sw3l_tenant_select ON public.sw3l
FOR SELECT
USING (tenant = current_setting('app.tenant', true));
