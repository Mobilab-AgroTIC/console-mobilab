---------- SN50V3 (Dragino) : nœud générique (DS18B20, ADC, entrée numérique) ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.
-- mode = Work_mode lu dans la trame (AT+MOD = mode + 1). Colonnes de mesure : mode 7 (3ADC+1DS18B20).

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.sn50v3 (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS rssi        INTEGER;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS snr         DOUBLE PRECISION;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS battery     INTEGER;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS mode        SMALLINT;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS temperature DOUBLE PRECISION;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS adc1        BIGINT;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS digital     BIGINT;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS adc2        BIGINT;
ALTER TABLE public.sn50v3 ADD COLUMN IF NOT EXISTS adc3        BIGINT;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.sn50v3', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS sn50v3_tenant_time_idx      ON public.sn50v3 (tenant, time DESC);
CREATE INDEX IF NOT EXISTS sn50v3_tenant_name_time_idx ON public.sn50v3 (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.sn50v3 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sn50v3 FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sn50v3_tenant_insert ON public.sn50v3;
DROP POLICY IF EXISTS sn50v3_tenant_update ON public.sn50v3;
DROP POLICY IF EXISTS sn50v3_tenant_delete ON public.sn50v3;
DROP POLICY IF EXISTS sn50v3_tenant_select ON public.sn50v3;
CREATE POLICY sn50v3_tenant_select ON public.sn50v3
    FOR SELECT USING (tenant = current_user);
