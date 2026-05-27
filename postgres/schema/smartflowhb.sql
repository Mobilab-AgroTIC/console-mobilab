---------- SMARTFLOWHB ----------

-- 1) table minimale (juste les colonnes obligatoires)
CREATE TABLE IF NOT EXISTS public.smartflowhb (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    tenant TEXT NOT NULL
);

-- 2) ajout des colonnes si absentes
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS rssi INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS snr DOUBLE PRECISION;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS min INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS max INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS mean DOUBLE PRECISION;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS sd DOUBLE PRECISION;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS median INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS valid_count INTEGER ;

-- 3) timescale hypertable (si déjà hypertable, ça peut erreur selon version)
SELECT create_hypertable('public.smartflowhb', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) index utiles ( tenant + name + temps  &  tenant + temps)
CREATE INDEX IF NOT EXISTS smartflowhb_tenant_time_idx ON public.smartflowhb (tenant, time DESC);
CREATE INDEX IF NOT EXISTS smartflowhb_tenant_name_time_idx ON public.smartflowhb (tenant, name, time DESC);

-- 5) RLS ON + FORCE
ALTER TABLE public.smartflowhb ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smartflowhb FORCE ROW LEVEL SECURITY;

-- 6) policies (SELECT/INSERT/UPDATE/DELETE)
DROP POLICY IF EXISTS smartflowhb_tenant_select ON public.smartflowhb;
DROP POLICY IF EXISTS smartflowhb_tenant_insert ON public.smartflowhb;
DROP POLICY IF EXISTS smartflowhb_tenant_update ON public.smartflowhb;
DROP POLICY IF EXISTS smartflowhb_tenant_delete ON public.smartflowhb;

CREATE POLICY smartflowhb_tenant_select ON public.smartflowhb
FOR SELECT
USING (tenant = current_setting('app.tenant', true));
