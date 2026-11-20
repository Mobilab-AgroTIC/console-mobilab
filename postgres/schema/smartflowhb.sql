---------- SmartFlow HB ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.smartflowhb (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS rssi        INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS snr         DOUBLE PRECISION;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS battery     INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS min         INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS max         INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS mean        DOUBLE PRECISION;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS sd          DOUBLE PRECISION;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS median      INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS valid_count INTEGER;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.smartflowhb', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS smartflowhb_tenant_time_idx      ON public.smartflowhb (tenant, time DESC);
CREATE INDEX IF NOT EXISTS smartflowhb_tenant_name_time_idx ON public.smartflowhb (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.smartflowhb ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smartflowhb FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS smartflowhb_tenant_insert ON public.smartflowhb;
DROP POLICY IF EXISTS smartflowhb_tenant_update ON public.smartflowhb;
DROP POLICY IF EXISTS smartflowhb_tenant_delete ON public.smartflowhb;
DROP POLICY IF EXISTS smartflowhb_tenant_select ON public.smartflowhb;
CREATE POLICY smartflowhb_tenant_select ON public.smartflowhb
    FOR SELECT USING (tenant = current_user);
