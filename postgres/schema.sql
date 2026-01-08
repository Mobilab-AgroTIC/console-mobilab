
CREATE TABLE lht52 (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT,
    rssi INTEGER,
    snr DOUBLE PRECISION,
    battery INTEGER,
    humidity DOUBLE PRECISION,
    temperature DOUBLE PRECISION,
    temperature_probe DOUBLE PRECISION
);

SELECT create_hypertable('lht52', 'time');

CREATE TABLE pilowtech (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT,
    rssi INTEGER,
    snr DOUBLE PRECISION,
    battery INTEGER,
    value INTEGER,
    value2 INTEGER,
    value3 INTEGER
);

SELECT create_hypertable('pilowtech', 'time');

CREATE TABLE latex (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT,
    rssi INTEGER,
    snr DOUBLE PRECISION,
    battery INTEGER,
    min INTEGER,
    max INTEGER,
    mean DOUBLE PRECISION,
    sd DOUBLE PRECISION,
    median INTEGER,
    valid_count INTEGER
);

SELECT create_hypertable('latex', 'time');

CREATE TABLE pslb (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT,
    rssi INTEGER,
    snr DOUBLE PRECISION,
    battery INTEGER,
    probe_model INTEGER,
    idc_in INTEGER,
    vdc_in INTEGER
);

SELECT create_hypertable('pslb', 'time');