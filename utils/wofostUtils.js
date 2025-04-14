/**
 * WOFOST 7.2 Model - Utility Functions
 * 
 * This file contains utility functions to work with the WOFOST model,
 * including data processing, parameter creation, and output visualization.
 */

/**
 * WeatherDataCreator - Helper class to create and validate weather data
 */
class WeatherDataCreator {
    /**
     * Create weather data from input arrays
     * @param {Array} dates - Array of date strings (YYYY-MM-DD)
     * @param {Array} Tmin - Array of minimum temperatures (°C)
     * @param {Array} Tmax - Array of maximum temperatures (°C)
     * @param {Array} solarRadiation - Array of solar radiation values (MJ/m²/day)
     * @param {Array} rainfall - Array of rainfall values (mm)
     * @param {Array} ET0 - Array of reference evapotranspiration values (mm/day)
     * @param {Object} options - Additional optional parameters
     * @param {Array} [options.humidity] - Array of humidity values (%)
     * @param {Array} [options.windSpeed] - Array of wind speed values (m/s)
     * @param {Array|number} [options.CO2] - Array of CO2 values or single CO2 value (ppm)
     * @returns {Array} - Array of weather data objects
     */
    static fromArrays(dates, Tmin, Tmax, solarRadiation, rainfall, ET0, options = {}) {
        // Validate array lengths
        const length = dates.length;
        if (
            Tmin.length !== length ||
            Tmax.length !== length ||
            solarRadiation.length !== length ||
            rainfall.length !== length ||
            ET0.length !== length ||
            (options.humidity && options.humidity.length !== length) ||
            (options.windSpeed && options.windSpeed.length !== length) ||
            (Array.isArray(options.CO2) && options.CO2.length !== length)
        ) {
            throw new Error('All input arrays must have the same length');
        }

        // Process CO2 options
        const co2IsArray = Array.isArray(options.CO2);
        const defaultCO2 = 415; // ppm

        // Create weather data objects
        const weatherData = [];
        for (let i = 0; i < length; i++) {
            weatherData.push({
                date: dates[i],
                Tmin: Tmin[i],
                Tmax: Tmax[i],
                solarRadiation: solarRadiation[i],
                rainfall: rainfall[i],
                ET0: ET0[i],
                humidity: options.humidity ? options.humidity[i] : undefined,
                windSpeed: options.windSpeed ? options.windSpeed[i] : undefined,
                CO2: co2IsArray ? options.CO2[i] : (options.CO2 || defaultCO2)
            });
        }

        return weatherData;
    }

    /**
     * Load weather data from CSV string
     * @param {string} csvString - CSV string with weather data
     * @param {Object} options - CSV parsing options
     * @param {string} [options.dateFormat='YYYY-MM-DD'] - Date column format
     * @param {Object} [options.columnMapping] - Mapping of CSV columns to weather properties
     * @returns {Array} - Array of weather data objects
     */
    static fromCSV(csvString, options = {}) {
        // Default column mapping
        const defaultMapping = {
            date: 'date',
            Tmin: 'tmin',
            Tmax: 'tmax',
            solarRadiation: 'radiation',
            rainfall: 'rain',
            ET0: 'et0',
            humidity: 'rh',
            windSpeed: 'wind',
            CO2: 'co2'
        };

        const columnMapping = options.columnMapping || defaultMapping;

        // Split CSV into rows and header
        const rows = csvString.trim().split('\n');
        const header = rows[0].split(',').map(col => col.trim().toLowerCase());

        const weatherData = [];

        // Process each data row
        for (let i = 1; i < rows.length; i++) {
            const values = rows[i].split(',').map(val => val.trim());

            // Skip empty rows
            if (values.length <= 1 && !values[0]) continue;

            // Create data object with mapped columns
            const dataObj = {};

            // Map each column to its corresponding property
            for (const [prop, colName] of Object.entries(columnMapping)) {
                const colIndex = header.indexOf(colName.toLowerCase());
                if (colIndex !== -1) {
                    // Parse date string
                    if (prop === 'date') {
                        dataObj[prop] = values[colIndex];
                    }
                    // Parse numbers
                    else {
                        dataObj[prop] = parseFloat(values[colIndex]);
                    }
                }
            }

            weatherData.push(dataObj);
        }

        return weatherData;
    }

    /**
     * Calculate reference evapotranspiration (ET0) using FAO Penman-Monteith method
     * @param {Object} weatherData - Weather data without ET0
     * @param {number} latitude - Latitude in degrees
     * @param {number} elevation - Elevation in meters
     * @returns {Object} - Weather data with calculated ET0
     */
    static calculateET0(weatherData, latitude, elevation) {
        return weatherData.map(day => {
            const { Tmin, Tmax, solarRadiation, humidity, windSpeed } = day;

            // Mean temperature
            const Tmean = (Tmin + Tmax) / 2;

            // Convert latitude to radians
            const latRad = latitude * Math.PI / 180;

            // Day of year (DOY)
            const dateObj = new Date(day.date);
            const start = new Date(dateObj.getFullYear(), 0, 0);
            const diff = dateObj - start;
            const doy = Math.floor(diff / 86400000);

            // Solar declination
            const solarDeclination = 0.409 * Math.sin(2 * Math.PI / 365 * doy - 1.39);

            // Sunset hour angle
            const sunsetHourAngle = Math.acos(-Math.tan(latRad) * Math.tan(solarDeclination));

            // Extraterrestrial radiation
            const dr = 1 + 0.033 * Math.cos(2 * Math.PI / 365 * doy);
            const Ra = 24 * 60 / Math.PI * 0.082 * dr *
                (sunsetHourAngle * Math.sin(latRad) * Math.sin(solarDeclination) +
                    Math.cos(latRad) * Math.cos(solarDeclination) * Math.sin(sunsetHourAngle));

            // Clear sky solar radiation
            const Rso = (0.75 + 2e-5 * elevation) * Ra;

            // Net shortwave radiation
            const Rns = 0.77 * solarRadiation;

            // Net longwave radiation
            const sigma = 4.903e-9; // Stefan-Boltzmann constant MJ K-4 m-2 day-1
            const TminK = Tmin + 273.16;
            const TmaxK = Tmax + 273.16;

            // Actual vapor pressure
            const ea = humidity / 100 * 0.6108 * Math.exp(17.27 * Tmean / (Tmean + 237.3));

            // Saturated vapor pressure
            const es = (0.6108 * Math.exp(17.27 * Tmax / (Tmax + 237.3)) +
                0.6108 * Math.exp(17.27 * Tmin / (Tmin + 237.3))) / 2;

            // Relative shortwave radiation
            const Rs_Rso = Math.min(1.0, solarRadiation / Rso);

            // Net longwave radiation
            const Rnl = sigma * ((Math.pow(TmaxK, 4) + Math.pow(TminK, 4)) / 2) *
                (0.34 - 0.14 * Math.sqrt(ea)) * (1.35 * Rs_Rso - 0.35);

            // Net radiation
            const Rn = Rns - Rnl;

            // Slope of saturation vapor pressure curve
            const delta = 4098 * (0.6108 * Math.exp(17.27 * Tmean / (Tmean + 237.3))) /
                Math.pow(Tmean + 237.3, 2);

            // Psychrometric constant
            const P = 101.3 * Math.pow((293 - 0.0065 * elevation) / 293, 5.26);
            const gamma = 0.000665 * P;

            // Wind speed at 2m height (if provided at different height, conversion would be needed)
            const u2 = windSpeed || 2; // Use default of 2 m/s if not provided

            // Reference evapotranspiration (ET0)
            const ET0 = (0.408 * delta * Rn + gamma * (900 / (Tmean + 273)) * u2 * (es - ea)) /
                (delta + gamma * (1 + 0.34 * u2));

            return {
                ...day,
                ET0: Math.max(0, ET0) // ET0 cannot be negative
            };
        });
    }
}