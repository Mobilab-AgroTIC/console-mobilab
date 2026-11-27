-- =============================================================================
-- 003 : intervalle d'envoi réglé (27/11/2026, version 3.1.0).
-- =============================================================================

-- Intervalle d'envoi en secondes, posé quand le capteur confirme le downlink « 01 » + secondes (bouton
-- « Intervalle d'envoi » du bot). NULL : jamais réglé par la console ; on se fie alors à l'intervalle
-- mesuré (config.detected.intervalle_s, médiane des 10 derniers écarts). Sert à l'alerte « pas de nouvelles ».
ALTER TABLE app.devices ADD COLUMN IF NOT EXISTS intervalle_s integer CHECK (intervalle_s > 0);
COMMENT ON COLUMN app.devices.intervalle_s IS
    'Intervalle d''envoi réglé (s), confirmé par le capteur ; NULL = jamais réglé, voir config.detected.intervalle_s';

-- Node-RED reçoit l'accusé du capteur et pose l'intervalle.
GRANT UPDATE (intervalle_s) ON app.devices TO svc_nodered;
