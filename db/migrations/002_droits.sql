-- =============================================================================
-- 002 : droits complémentaires (19/11/2026).
-- =============================================================================

-- Node-RED regroupe les « pas de nouvelles » d'une ferme (rule_ids) et note la durée affichée (details) :
-- sans ces colonnes, la mise à jour échouait APRÈS l'envoi, et l'alerte repartait toutes les 10 min.
GRANT UPDATE (rule_ids, details) ON app.notifications TO svc_nodered;

-- Reprise d'une ferme V2 (console/src/reprise.ts) : le service lit les anciennes tables par capteur
-- et rattache les trames brutes V2 à leur capteur. Seulement si ces tables existent.
DO $do$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['lht52', 'd2x', 'sn50v3', 'sw3l', 'ldds45', 'lds02', 'lwl02', 'se0x', 'cpl03', 'pslb', 'pilowtech', 'smartflowhb'] LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('GRANT SELECT ON public.%I TO svc_console', t);
        END IF;
    END LOOP;
END
$do$;
GRANT UPDATE (dev_eui, tenant) ON public.uplinks TO svc_console;
