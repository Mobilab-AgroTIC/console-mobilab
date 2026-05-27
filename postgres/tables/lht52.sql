-- 10_lht52.sql

CREATE TABLE IF NOT EXISTS public.lht52 (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant TEXT NOT NULL,
    name TEXT NOT NULL,
    rssi INTEGER,
    snr DOUBLE PRECISION,
    battery INTEGER,
    humidity DOUBLE PRECISION,
    temperature DOUBLE PRECISION,
    temperature_probe DOUBLE PRECISION
);

CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable(
    'public.lht52',
    'time',
    if_not_exists => TRUE,
    migrate_data => TRUE
);

CREATE INDEX IF NOT EXISTS idx_lht52_tenant_time
ON public.lht52 (tenant, time DESC);

CREATE INDEX IF NOT EXISTS idx_lht52_tenant_name_time
ON public.lht52 (tenant, name, time DESC);

ALTER TABLE public.lht52 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lht52 FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lht52_select_policy ON public.lht52;
DROP POLICY IF EXISTS lht52_insert_policy ON public.lht52;
DROP POLICY IF EXISTS lht52_update_policy ON public.lht52;
DROP POLICY IF EXISTS lht52_delete_policy ON public.lht52;

CREATE POLICY lht52_select_policy
ON public.lht52
FOR SELECT
USING (
    tenant = current_setting('app.tenant', true)
);

CREATE POLICY lht52_insert_policy
ON public.lht52
FOR INSERT
WITH CHECK (
    tenant = current_setting('app.tenant', true)
);

CREATE POLICY lht52_update_policy
ON public.lht52
FOR UPDATE
USING (
    tenant = current_setting('app.tenant', true)
)
WITH CHECK (
    tenant = current_setting('app.tenant', true)
);

CREATE POLICY lht52_delete_policy
ON public.lht52
FOR DELETE
USING (
    tenant = current_setting('app.tenant', true)
);
