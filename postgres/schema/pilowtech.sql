---------- PILOWTECH ----------

-- 1) table minimale (juste les colonnes obligatoires)
CREATE TABLE IF NOT EXISTS public.pilowtech (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    tenant TEXT NOT NULL
);

-- 2) ajout des colonnes si absentes
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS rssi INTEGER;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS snr DOUBLE PRECISION;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS value1 DOUBLE PRECISION;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS value2 DOUBLE PRECISION;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS value3 DOUBLE PRECISION;

-- 3) timescale hypertable (si déjà hypertable, ça peut erreur selon version)
SELECT create_hypertable('public.pilowtech', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) index utiles ( tenant + name + temps  &  tenant + temps)
CREATE INDEX IF NOT EXISTS pilowtech_tenant_time_idx ON public.pilowtech (tenant, time DESC);
CREATE INDEX IF NOT EXISTS pilowtech_tenant_name_time_idx ON public.pilowtech (tenant, name, time DESC);

-- 5) RLS ON + FORCE
ALTER TABLE public.pilowtech ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pilowtech FORCE ROW LEVEL SECURITY;

-- 6) policies (SELECT/INSERT/UPDATE/DELETE)
DROP POLICY IF EXISTS pilowtech_tenant_select ON public.pilowtech;
DROP POLICY IF EXISTS pilowtech_tenant_insert ON public.pilowtech;
DROP POLICY IF EXISTS pilowtech_tenant_update ON public.pilowtech;
DROP POLICY IF EXISTS pilowtech_tenant_delete ON public.pilowtech;

CREATE POLICY pilowtech_tenant_select ON public.pilowtech
FOR SELECT
USING (tenant = current_setting('app.tenant', true));

