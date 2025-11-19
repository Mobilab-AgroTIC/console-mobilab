CREATE TABLE sensor_data (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT,
    rssi DOUBLE PRECISION,
    snr DOUBLE PRECISION,
    humidity DOUBLE PRECISION,
    temperature DOUBLE PRECISION,
    temperature_sonde DOUBLE PRECISION
);

SELECT create_hypertable('sensor_data', 'time');