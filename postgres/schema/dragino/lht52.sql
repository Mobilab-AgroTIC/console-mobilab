---------- LHT 52 ----------

-- 1) table minimale
CREATE TABLE IF NOT EXISTS public.lht52 (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    tenant TEXT NOT NULL
);

-- 2) ajout des colonnes si absentes
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS rssi INTEGER;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS snr DOUBLE PRECISION;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS humidity DOUBLE PRECISION;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS temperature DOUBLE PRECISION;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS temperature_probe DOUBLE PRECISION;

-- 3) Timescale hypertable
SELECT create_hypertable('public.lht52', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) index utiles
CREATE INDEX IF NOT EXISTS lht52_tenant_time_idx
ON public.lht52 (tenant, time DESC);

CREATE INDEX IF NOT EXISTS lht52_tenant_name_time_idx
ON public.lht52 (tenant, name, time DESC);

-- 5) RLS ON + FORCE
ALTER TABLE public.lht52 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lht52 FORCE ROW LEVEL SECURITY;

-- 6) policies idempotentes

DROP POLICY IF EXISTS lht52_tenant_select ON public.lht52;
CREATE POLICY lht52_tenant_select
ON public.lht52
FOR SELECT
USING (
    tenant = current_setting('app.tenant', true)
);

DROP POLICY IF EXISTS lht52_tenant_insert ON public.lht52;
CREATE POLICY lht52_tenant_insert
ON public.lht52
FOR INSERT
WITH CHECK (
    tenant = current_setting('app.tenant', true)
);

DROP POLICY IF EXISTS lht52_tenant_update ON public.lht52;
CREATE POLICY lht52_tenant_update
ON public.lht52
FOR UPDATE
USING (
    tenant = current_setting('app.tenant', true)
)
WITH CHECK (
    tenant = current_setting('app.tenant', true)
);

DROP POLICY IF EXISTS lht52_tenant_delete ON public.lht52;
CREATE POLICY lht52_tenant_delete
ON public.lht52
FOR DELETE
USING (
    tenant = current_setting('app.tenant', true)
);
