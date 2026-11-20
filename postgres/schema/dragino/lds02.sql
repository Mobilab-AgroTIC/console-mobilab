---------- LDS02 (Dragino) : ouverture de porte ----------
-- Rejouable sans risque : n'ajoute que ce qui manque, ne supprime aucune donnée.
-- door_open : 1 = ouverte. open_count : cumul des ouvertures. last_open_min : durée de la dernière.

-- 1) Table minimale
CREATE TABLE IF NOT EXISTS public.lds02 (
    time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    name   TEXT        NOT NULL,
    tenant TEXT        NOT NULL
);

-- 2) Colonnes de mesure
ALTER TABLE public.lds02 ADD COLUMN IF NOT EXISTS rssi          INTEGER;
ALTER TABLE public.lds02 ADD COLUMN IF NOT EXISTS snr           DOUBLE PRECISION;
ALTER TABLE public.lds02 ADD COLUMN IF NOT EXISTS battery       INTEGER;
ALTER TABLE public.lds02 ADD COLUMN IF NOT EXISTS mode          SMALLINT;
ALTER TABLE public.lds02 ADD COLUMN IF NOT EXISTS door_open     SMALLINT;
ALTER TABLE public.lds02 ADD COLUMN IF NOT EXISTS open_count    INTEGER;
ALTER TABLE public.lds02 ADD COLUMN IF NOT EXISTS last_open_min INTEGER;

-- 3) Hypertable TimescaleDB
SELECT create_hypertable('public.lds02', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) Index
CREATE INDEX IF NOT EXISTS lds02_tenant_time_idx      ON public.lds02 (tenant, time DESC);
CREATE INDEX IF NOT EXISTS lds02_tenant_name_time_idx ON public.lds02 (tenant, name, time DESC);

-- 5) Cloisonnement par client (RLS)
--    Chaque client lit avec un rôle Postgres du même nom que son tenant : il ne voit
--    que ses lignes et ne peut pas changer ce filtre. Node-RED écrit en superutilisateur.
ALTER TABLE public.lds02 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lds02 FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lds02_tenant_insert ON public.lds02;
DROP POLICY IF EXISTS lds02_tenant_update ON public.lds02;
DROP POLICY IF EXISTS lds02_tenant_delete ON public.lds02;
DROP POLICY IF EXISTS lds02_tenant_select ON public.lds02;
CREATE POLICY lds02_tenant_select ON public.lds02
    FOR SELECT USING (tenant = current_user);
