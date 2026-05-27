
---------- PS-LB ----------

-- 1) table minimale (juste les colonnes obligatoires)
CREATE TABLE IF NOT EXISTS public.pslb (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    tenant TEXT NOT NULL
);

-- 2) ajout des colonnes si absentes
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS rssi INTEGER;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS snr DOUBLE PRECISION;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS model DOUBLE PRECISION;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS idc DOUBLE PRECISION;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS vdc DOUBLE PRECISION;

-- 3) timescale hypertable (si déjà hypertable, ça peut erreur selon version)
SELECT create_hypertable('public.pslb', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) index utiles ( tenant + name + temps  &  tenant + temps)
CREATE INDEX IF NOT EXISTS pslb_tenant_time_idx ON public.pslb (tenant, time DESC);
CREATE INDEX IF NOT EXISTS pslb_tenant_name_time_idx ON public.pslb (tenant, name, time DESC);

-- 5) RLS ON + FORCE
ALTER TABLE public.pslb ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pslb FORCE ROW LEVEL SECURITY;

-- 6) policies (SELECT/INSERT/UPDATE/DELETE)
DROP POLICY IF EXISTS pslb_tenant_select ON public.pslb;
DROP POLICY IF EXISTS pslb_tenant_insert ON public.pslb;
DROP POLICY IF EXISTS pslb_tenant_update ON public.pslb;
DROP POLICY IF EXISTS pslb_tenant_delete ON public.pslb;

CREATE POLICY pslb_tenant_select ON public.pslb
FOR SELECT
USING (tenant = current_setting('app.tenant', true));
