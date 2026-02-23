---------- LHT 52 ----------

-- 1) table minimale (juste les colonnes obligatoires)
CREATE TABLE IF NOT EXISTS public.lht52 (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    tenant TEXT NOT NULL
);

-- 2) ajout des colonnes si absentes
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS rssi INTEGER;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS snr DOUBLE PRECISION;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS humidity DOUBLE PRECISION;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS temperature DOUBLE PRECISION;
ALTER TABLE public.lht52 ADD COLUMN IF NOT EXISTS temperature_probe DOUBLE PRECISION;

-- 3) timescale hypertable (si déjà hypertable, ça peut erreur selon version)
SELECT create_hypertable('public.lht52', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) index utiles ( tenant + name + temps  &  tenant + temps)
CREATE INDEX IF NOT EXISTS lht52_tenant_time_idx ON public.lht52 (tenant, time DESC);
CREATE INDEX IF NOT EXISTS lht52_tenant_name_time_idx ON public.lht52 (tenant, name, time DESC);

-- 5) RLS ON + FORCE
ALTER TABLE public.lht52 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lht52 FORCE ROW LEVEL SECURITY;

-- 6) policies (SELECT/INSERT/UPDATE/DELETE)
DROP POLICY IF EXISTS lht52_tenant_select ON public.lht52;
DROP POLICY IF EXISTS lht52_tenant_insert ON public.lht52;
DROP POLICY IF EXISTS lht52_tenant_update ON public.lht52;
DROP POLICY IF EXISTS lht52_tenant_delete ON public.lht52;

CREATE POLICY lht52_tenant_select ON public.lht52
FOR SELECT
USING (tenant = current_setting('app.tenant', true));


---------- SMARTFLOWHB ----------

-- 1) table minimale (juste les colonnes obligatoires)
CREATE TABLE IF NOT EXISTS public.smartflowhb (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    tenant TEXT NOT NULL
);

-- 2) ajout des colonnes si absentes
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS rssi INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS snr DOUBLE PRECISION;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS min INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS max INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS mean DOUBLE PRECISION;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS sd DOUBLE PRECISION;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS median INTEGER;
ALTER TABLE public.smartflowhb ADD COLUMN IF NOT EXISTS valid_count INTEGER ;

-- 3) timescale hypertable (si déjà hypertable, ça peut erreur selon version)
SELECT create_hypertable('public.smartflowhb', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) index utiles ( tenant + name + temps  &  tenant + temps)
CREATE INDEX IF NOT EXISTS smartflowhb_tenant_time_idx ON public.smartflowhb (tenant, time DESC);
CREATE INDEX IF NOT EXISTS smartflowhb_tenant_name_time_idx ON public.smartflowhb (tenant, name, time DESC);

-- 5) RLS ON + FORCE
ALTER TABLE public.smartflowhb ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smartflowhb FORCE ROW LEVEL SECURITY;

-- 6) policies (SELECT/INSERT/UPDATE/DELETE)
DROP POLICY IF EXISTS smartflowhb_tenant_select ON public.smartflowhb;
DROP POLICY IF EXISTS smartflowhb_tenant_insert ON public.smartflowhb;
DROP POLICY IF EXISTS smartflowhb_tenant_update ON public.smartflowhb;
DROP POLICY IF EXISTS smartflowhb_tenant_delete ON public.smartflowhb;

CREATE POLICY smartflowhb_tenant_select ON public.smartflowhb
FOR SELECT
USING (tenant = current_setting('app.tenant', true));

---------- PILOWTECH ----------

-- 1) table minimale (juste les colonnes obligatoires)
CREATE TABLE IF NOT EXISTS public.pilowtech (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    tenant TEXT NOT NULL
);

-- 2) ajout des colonnes si absentes
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS rssi INTEGER;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS snr DOUBLE PRECISION;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS value1 DOUBLE PRECISION;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS value2 DOUBLE PRECISION;
ALTER TABLE public.pilowtech ADD COLUMN IF NOT EXISTS value3 DOUBLE PRECISION;

-- 3) timescale hypertable (si déjà hypertable, ça peut erreur selon version)
SELECT create_hypertable('public.pilowtech', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) index utiles ( tenant + name + temps  &  tenant + temps)
CREATE INDEX IF NOT EXISTS pilowtech_tenant_time_idx ON public.pilowtech (tenant, time DESC);
CREATE INDEX IF NOT EXISTS pilowtech_tenant_name_time_idx ON public.pilowtech (tenant, name, time DESC);

-- 5) RLS ON + FORCE
ALTER TABLE public.pilowtech ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pilowtech FORCE ROW LEVEL SECURITY;

-- 6) policies (SELECT/INSERT/UPDATE/DELETE)
DROP POLICY IF EXISTS pilowtech_tenant_select ON public.pilowtech;
DROP POLICY IF EXISTS pilowtech_tenant_insert ON public.pilowtech;
DROP POLICY IF EXISTS pilowtech_tenant_update ON public.pilowtech;
DROP POLICY IF EXISTS pilowtech_tenant_delete ON public.pilowtech;

CREATE POLICY pilowtech_tenant_select ON public.pilowtech
FOR SELECT
USING (tenant = current_setting('app.tenant', true));


---------- PS-LB ----------

-- 1) table minimale (juste les colonnes obligatoires)
CREATE TABLE IF NOT EXISTS public.pslb (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    tenant TEXT NOT NULL
);

-- 2) ajout des colonnes si absentes
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS rssi INTEGER;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS snr DOUBLE PRECISION;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS battery INTEGER;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS model DOUBLE PRECISION;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS idc DOUBLE PRECISION;
ALTER TABLE public.pslb ADD COLUMN IF NOT EXISTS vdc DOUBLE PRECISION;

-- 3) timescale hypertable (si déjà hypertable, ça peut erreur selon version)
SELECT create_hypertable('public.pslb', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- 4) index utiles ( tenant + name + temps  &  tenant + temps)
CREATE INDEX IF NOT EXISTS pslb_tenant_time_idx ON public.pslb (tenant, time DESC);
CREATE INDEX IF NOT EXISTS pslb_tenant_name_time_idx ON public.pslb (tenant, name, time DESC);

-- 5) RLS ON + FORCE
ALTER TABLE public.pslb ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pslb FORCE ROW LEVEL SECURITY;

-- 6) policies (SELECT/INSERT/UPDATE/DELETE)
DROP POLICY IF EXISTS pslb_tenant_select ON public.pslb;
DROP POLICY IF EXISTS pslb_tenant_insert ON public.pslb;
DROP POLICY IF EXISTS pslb_tenant_update ON public.pslb;
DROP POLICY IF EXISTS pslb_tenant_delete ON public.pslb;

CREATE POLICY pslb_tenant_select ON public.pslb
FOR SELECT
USING (tenant = current_setting('app.tenant', true));
