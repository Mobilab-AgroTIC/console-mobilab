---------- SW3L (Dragino) : débitmètre à impulsions ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.
-- mode = octet MOD de la trame.

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.sw3l (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.sw3l ADD COLUMN IF NOT EXISTS rssi    INTEGER;
ALTER TABLE public.sw3l ADD COLUMN IF NOT EXISTS snr     DOUBLE PRECISION;
ALTER TABLE public.sw3l ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.sw3l ADD COLUMN IF NOT EXISTS mode    SMALLINT;
ALTER TABLE public.sw3l ADD COLUMN IF NOT EXISTS pulse   BIGINT;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.sw3l', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS sw3l_tenant_time_idx      ON public.sw3l (tenant, time DESC);
CREATE INDEX IF NOT EXISTS sw3l_tenant_name_time_idx ON public.sw3l (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.sw3l ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sw3l FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sw3l_tenant_insert ON public.sw3l;
DROP POLICY IF EXISTS sw3l_tenant_update ON public.sw3l;
DROP POLICY IF EXISTS sw3l_tenant_delete ON public.sw3l;
DROP POLICY IF EXISTS sw3l_tenant_select ON public.sw3l;
CREATE POLICY sw3l_tenant_select ON public.sw3l
    FOR SELECT USING (tenant = current_user);
