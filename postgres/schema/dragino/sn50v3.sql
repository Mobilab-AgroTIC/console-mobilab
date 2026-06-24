----------- SN50V3 ----------

-- 1) table minimale
CREATE TABLE IF NOT EXISTS public.sn50v3 (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    tenant TEXT NOT NULL
);

-- 2) ajout des colonnes si absentes
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS rssi INTEGER;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS snr DOUBLE PRECISION;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS temperature BIGINT;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS adc1 BIGINT;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS digital BIGINT;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS adc2 BIGINT;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS adc3 BIGINT;

-- 3) Timescale hypertable
SELECT create_hypertable('public.sn50v3', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) index utiles
CREATE INDEX IF NOT EXISTS sn50v3_tenant_time_idx
ON public.sn50v3 (tenant, time DESC);

CREATE INDEX IF NOT EXISTS sn50v3_tenant_name_time_idx
ON public.sn50v3 (tenant, name, time DESC);

-- 5) RLS ON + FORCE
ALTER TABLE public.sn50v3 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sn50v3 FORCE ROW LEVEL SECURITY;

-- 6) policies idempotentes
DROP POLICY IF EXISTS sn50v3_tenant_select ON public.sn50v3;
CREATE POLICY sn50v3_tenant_select
ON public.sn50v3
FOR SELECT
USING (
    tenant = current_setting('app.tenant', true)
);

DROP POLICY IF EXISTS sn50v3_tenant_insert ON public.sn50v3;
CREATE POLICY sn50v3_tenant_insert
ON public.sn50v3
FOR INSERT
WITH CHECK (
    tenant = current_setting('app.tenant', true)
);

DROP POLICY IF EXISTS sn50v3_tenant_update ON public.sn50v3;
CREATE POLICY sn50v3_tenant_update
ON public.sn50v3
FOR UPDATE
USING (
    tenant = current_setting('app.tenant', true)
)
WITH CHECK (
    tenant = current_setting('app.tenant', true)
);

DROP POLICY IF EXISTS sn50v3_tenant_delete ON public.sn50v3;
CREATE POLICY sn50v3_tenant_delete
ON public.sn50v3
FOR DELETE
USING (
    tenant = current_setting('app.tenant', true)
);
