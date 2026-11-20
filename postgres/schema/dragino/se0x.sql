---------- SE01 à SE04 (Dragino) : sondes de sol ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.
-- mode 0 = valeurs calibrées (seules enregistrées) ; soilN : humidité %, température °C, EC µS/cm.

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.se0x (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS rssi           INTEGER;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS snr            DOUBLE PRECISION;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS battery        INTEGER;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS mode           SMALLINT;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS temperature    DOUBLE PRECISION;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil1_moisture DOUBLE PRECISION;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil1_temp     DOUBLE PRECISION;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil1_ec       INTEGER;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil2_moisture DOUBLE PRECISION;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil2_temp     DOUBLE PRECISION;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil2_ec       INTEGER;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil3_moisture DOUBLE PRECISION;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil3_temp     DOUBLE PRECISION;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil3_ec       INTEGER;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil4_moisture DOUBLE PRECISION;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil4_temp     DOUBLE PRECISION;
ALTER TABLE public.se0x ADD COLUMN IF NOT EXISTS soil4_ec       INTEGER;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.se0x', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS se0x_tenant_time_idx      ON public.se0x (tenant, time DESC);
CREATE INDEX IF NOT EXISTS se0x_tenant_name_time_idx ON public.se0x (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.se0x ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.se0x FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS se0x_tenant_insert ON public.se0x;
DROP POLICY IF EXISTS se0x_tenant_update ON public.se0x;
DROP POLICY IF EXISTS se0x_tenant_delete ON public.se0x;
DROP POLICY IF EXISTS se0x_tenant_select ON public.se0x;
CREATE POLICY se0x_tenant_select ON public.se0x
    FOR SELECT USING (tenant = current_user);
