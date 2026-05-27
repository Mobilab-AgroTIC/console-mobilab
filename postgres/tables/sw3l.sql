-- 10_lht52.sql

CREATE TABLE IF NOT EXISTS public.sw3l (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant TEXT NOT NULL,
    name TEXT NOT NULL,
    rssi INTEGER,
    snr DOUBLE PRECISION,
    battery INTEGER,
    value BIGINT,
    mod INTEGER
);

CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable(
    'public.sw3l',
    'time',
    if_not_exists => TRUE,
    migrate_data => TRUE
);

CREATE INDEX IF NOT EXISTS idx_sw3l_tenant_time
ON public.sw3l (tenant, time DESC);

CREATE INDEX IF NOT EXISTS idx_sw3l_tenant_name_time
ON public.sw3l (tenant, name, time DESC);

ALTER TABLE public.sw3l ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sw3l FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sw3l_select_policy ON public.sw3l;
DROP POLICY IF EXISTS sw3l_insert_policy ON public.sw3l;
DROP POLICY IF EXISTS lht52_update_policy ON public.sw3l;
DROP POLICY IF EXISTS lht52_delete_policy ON public.sw3l;

CREATE POLICY sw3l_select_policy
ON public.sw3l
FOR SELECT
USING (
    tenant = current_setting('app.tenant', true)
);

CREATE POLICY sw3l_insert_policy
ON public.sw3l
FOR INSERT
WITH CHECK (
    tenant = current_setting('app.tenant', true)
);

CREATE POLICY sw3l_update_policy
ON public.sw3l
FOR UPDATE
USING (
    tenant = current_setting('app.tenant', true)
)
WITH CHECK (
    tenant = current_setting('app.tenant', true)
);

CREATE POLICY sw3l_delete_policy
ON public.sw3l
FOR DELETE
USING (
    tenant = current_setting('app.tenant', true)
);
