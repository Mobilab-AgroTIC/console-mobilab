---------- LWL02 (Dragino) : fuite d'eau ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.
-- leak : 1 = fuite. leak_count : cumul des fuites. last_leak_min : durée de la dernière.

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.lwl02 (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.lwl02 ADD COLUMN IF NOT EXISTS rssi          INTEGER;
ALTER TABLE public.lwl02 ADD COLUMN IF NOT EXISTS snr           DOUBLE PRECISION;
ALTER TABLE public.lwl02 ADD COLUMN IF NOT EXISTS battery       INTEGER;
ALTER TABLE public.lwl02 ADD COLUMN IF NOT EXISTS mode          SMALLINT;
ALTER TABLE public.lwl02 ADD COLUMN IF NOT EXISTS leak          SMALLINT;
ALTER TABLE public.lwl02 ADD COLUMN IF NOT EXISTS leak_count    INTEGER;
ALTER TABLE public.lwl02 ADD COLUMN IF NOT EXISTS last_leak_min INTEGER;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.lwl02', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS lwl02_tenant_time_idx      ON public.lwl02 (tenant, time DESC);
CREATE INDEX IF NOT EXISTS lwl02_tenant_name_time_idx ON public.lwl02 (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.lwl02 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lwl02 FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lwl02_tenant_insert ON public.lwl02;
DROP POLICY IF EXISTS lwl02_tenant_update ON public.lwl02;
DROP POLICY IF EXISTS lwl02_tenant_delete ON public.lwl02;
DROP POLICY IF EXISTS lwl02_tenant_select ON public.lwl02;
CREATE POLICY lwl02_tenant_select ON public.lwl02
    FOR SELECT USING (tenant = current_user);
