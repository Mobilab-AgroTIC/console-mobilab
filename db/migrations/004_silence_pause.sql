-- =============================================================================
-- 004 : « pas de nouvelles » envoyée une fois, puis en pause (27/11/2026, version 3.1.1).
-- =============================================================================

-- Après l'envoi, Node-RED met la règle en pause : enabled = false, params.en_pause_depuis = l'heure de l'alerte.
-- Elle repart avec le bouton « Réactiver cette alerte » du message, ou depuis les réglages du capteur.
GRANT UPDATE (enabled, params) ON app.alert_rules TO svc_nodered;
