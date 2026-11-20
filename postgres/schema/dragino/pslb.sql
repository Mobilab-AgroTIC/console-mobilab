---------- PS-LB (Dragino) : capteur de pression ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.pslb (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS rssi    INTEGER;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS snr     DOUBLE PRECISION;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS model   DOUBLE PRECISION;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS idc     DOUBLE PRECISION;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS vdc     DOUBLE PRECISION;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.pslb', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS pslb_tenant_time_idx      ON public.pslb (tenant, time DESC);
CREATE INDEX IF NOT EXISTS pslb_tenant_name_time_idx ON public.pslb (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.pslb ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pslb FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pslb_tenant_insert ON public.pslb;
DROP POLICY IF EXISTS pslb_tenant_update ON public.pslb;
DROP POLICY IF EXISTS pslb_tenant_delete ON public.pslb;
DROP POLICY IF EXISTS pslb_tenant_select ON public.pslb;
CREATE POLICY pslb_tenant_select ON public.pslb
    FOR SELECT USING (tenant = current_user);
