const axios = require('axios');
const turf = require('@turf/turf');
const winston = require('winston');
const AgriculturalLandAnalyzer = require('./elevation-analysis');

// Configure Winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        //new winston.transports.Console(),
        new winston.transports.File({ filename: 'borehole-site-service.log' })
    ]
});

class GeospatialAccessibilityAssessment {
    constructor(lat, long) {
        this.lat = lat;
        this.long = long;
        this.countryCode = null;
        this.apiConfig = {
            openRouteService: {
                key: '5b3ce3597851110001cf6248c65c44903454416681192a7bd3bda3da',
                baseURL: 'https://api.openrouteservice.org/v2'
            },
            overpass: {
                baseURL: 'https://overpass-api.de/api/interpreter'
            },
            nominatim: {
                baseURL: 'https://nominatim.openstreetmap.org',
                email: 'pitcher-doer0f@icloud.com'
            }
        };
    }

    /**
     * Makes an HTTP GET request to the specified URL with the provided parameters, retrying up to the specified number of times on failure.
     *
     * @param {string} url - The URL to make the request to.
     * @param {Object} [params={}] - The request parameters.
     * @param {number} [retries=3] - The number of times to retry the request on failure.
     * @returns {Promise<Object>} - The response data.
     * @throws {Error} - If the request fails after the specified number of retries.
     */
    async _makeRequest(url, params = {}, retries = 3) {
        try {
            console.log('Making API request to:', url);
            const response = await axios.get(url, {
                params,
                timeout: 30000
            });
            console.log('API response:', response.data);
            return response.data;
        } catch (error) {
            if (retries > 0) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                return this._makeRequest(url, params, retries - 1);
            }
            logger.error('API request failed:', error.message);
            throw new Error(`API request failed: ${error.message}`);
        }
    }

    /**
     * Retrieves the country code for the current location based on the latitude and longitude.
     * If the country code has already been retrieved, it is returned from the cached value.
     * Otherwise, a reverse geocoding request is made to the Nominatim API to obtain the country code.
     *
     * @returns {Promise<string>} The country code in uppercase.
     */
    async _getCountryCode() {
        if (!this.countryCode) {
            const data = await this._makeRequest(
                `${this.apiConfig.nominatim.baseURL}/reverse`,
                {
                    lat: this.lat,
                    lon: this.long,
                    format: 'json',
                    addressdetails: 1
                }
            );
            this.countryCode = data.address.country_code.toUpperCase();
        }
        return this.countryCode;
    }

    /**
     * Classifies a road type as 'major', 'minor', or 'other' based on the provided highway type and country.
     * This function can be expanded to include more country-specific road type classifications.
     *
     * @param {string} highwayType - The highway type tag from the Overpass API response.
     * @param {string} country - The ISO 3166-1 alpha-2 country code.
     * @returns {string} The road type classification ('major', 'minor', or 'other').
     */
    _classifyRoad(highwayType, country) {
        // Country-specific classification can be expanded
        const majorTypes = new Set(['motorway', 'trunk', 'primary']);
        const minorTypes = new Set(['secondary', 'tertiary', 'unclassified']);
        return majorTypes.has(highwayType) ? 'major' :
            minorTypes.has(highwayType) ? 'minor' : 'other';
    }

    /**
     * Finds nearby settlements within a specified radius.
     *
     * @param {number} [radiusKm=2] - The radius in kilometers to search for nearby settlements.
     * @returns {Promise<Array<{ name: string, type: string, coords: [number, number], distance: number }>>} - An array of nearby settlements with their name, type, coordinates, and distance from the current location.
     */
    async findNearbySettlements(radiusKm = 2) {
        const buffer = turf.buffer(turf.point([this.long, this.lat]), radiusKm, { units: 'kilometers' });
        const bbox = turf.bbox(buffer);
        const query = `[out:json][timeout:30];
      node[place~"town|village|hamlet|cities"](${bbox});
      out body;`;

        logger.info('making request to overpass api');
        const data = await this._makeRequest(this.apiConfig.overpass.baseURL, { data: query });

        return data.elements
            .map(el => ({
                name: el.tags.name,
                type: el.tags.place,
                coords: [el.lon, el.lat],
                distance: turf.distance(
                    turf.point([this.long, this.lat]),
                    turf.point([el.lon, el.lat])
                )
            }))
            .filter(s => s.distance <= radiusKm)
            .sort((a, b) => a.distance - b.distance);
    }

    /**
     * Analyzes the transport route from the current location to a nearby settlement of the specified type.
     *
     * @param {string} [targetType='city'] - The type of settlement to find and analyze the route to ('city', 'town', 'village', etc.).
     * @returns {Promise<{ distance: number, elevationProfile: { distance: number, elevation: number }[], waypoints: [number, number][] } | null>} - An object containing the distance, elevation profile, and waypoints of the route, or null if no suitable target settlement is found.
     */
    async analyzeTransportRoute(targetType = 'city') {
        const settlements = await this.findNearbySettlements();
        const target = settlements.find(s => s.type === targetType);

        if (!target) return null;

        logger.info('making request to openrouteservice api');
        const route = await this._makeRequest(
            `${this.apiConfig.openRouteService.baseURL}/directions/foot-walking`,
            {
                api_key: this.apiConfig.openRouteService.key,
                start: `${this.long},${this.lat}`,
                end: `${target.coords[0]},${target.coords[1]}`
            }
        );

        return {
            distance: route.features[0].properties.segments[0].distance,
            elevationProfile: route.features[0].properties.segments[0].steps.map(step => ({
                distance: step.distance,
                elevation: step.elevation
            })),
            waypoints: route.features[0].geometry.coordinates
        };
    }

    /**
     * Assesses the flood risk for the current location based on the elevation and proximity to water bodies.
     *
     * @returns {Promise<{ elevation: number, waterDistance: number, riskLevel: number }>} - An object containing the elevation, distance to the nearest water body, and the calculated flood risk level.
     */
    async assessFloodRisk() {
        const [elevation, waterBodies] = await Promise.all([
            AgriculturalLandAnalyzer.fetchSinglePointElevation(this.lat, this.long),
            this._findWaterBodies()
        ]);

        return {
            elevation: elevation.elevation,
            waterDistance: waterBodies.distance,
            riskLevel: this._calculateFloodRisk(elevation.elevation, waterBodies.distance)
        };
    }

    /**
     * Retrieves the elevation data for the current location.
     *
     * @returns {Promise<number>} - The elevation at the current location.
     */
    async _getElevationData() {
        logger.info('making request to openrouteservice api');
        const data = await this._makeRequest(
            `${this.apiConfig.openRouteService.baseURL}/elevation/point`,
            {
                api_key: this.apiConfig.openRouteService.key,
                geometry: `${this.long},${this.lat}`
            }
        );
        return data.geometry.coordinates[2];
    }




    /**
     * Finds the nearest water bodies within a 5km radius of the current location.
     *
     * @returns {Promise<{ count: number, distance: number }>} - An object containing the number of water bodies found and the distance to the nearest one.
     */
    async _findWaterBodies() {
        try {
            const buffer = turf.point([this.long, this.lat]).buffer(5);
            const bbox = turf.bbox(buffer);

            // Optimized Overpass query
            const query = `[out:json][timeout:15];
            (
              way["natural"="water"]["water"!="pond"]["water"!="pool"](${bbox});
              relation["natural"="water"]["water"!="pond"]["water"!="pool"](${bbox});
            );
            out body 50;
            >;
            out skel qt;`;

            const data = await Promise.race([
                this._makeRequest(this.apiConfig.overpass.baseURL, { data: query }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Overpass timeout')), 20000))
            ]);

            // Fallback to local water body data if available
            return this._processWaterBodies(data);
        } catch (error) {
            console.warn('Water body detection failed, using fallback:', error.message);
            return this._fallbackWaterBodyDetection();
        }
    }

    async _fallbackWaterBodyDetection() {
        // Implement alternative detection method using OpenStreetMap Nominatim
        try {
            const response = await this._makeRequest(
                `${this.apiConfig.nominatim.baseURL}/search`,
                {
                    q: 'water',
                    format: 'json',
                    viewbox: [this.long - 0.5, this.lat - 0.5, this.long + 0.5, this.lat + 0.5].join(','),
                    bounded: 1
                }
            );

            return {
                count: response.length,
                distance: response.length > 0
                    ? Math.min(...response.map(f => turf.distance(
                        turf.point([this.long, this.lat]),
                        turf.point([f.lon, f.lat])
                    )))
                    : Infinity
            };
        } catch (fallbackError) {
            return { count: 0, distance: Infinity };
        }
    }

    /**
     * Calculates the flood risk score based on the given elevation and distance to water bodies.
     *
     * @param {number} elevation - The elevation of the location in meters.
     * @param {number} waterDistance - The distance to the nearest water body in kilometers.
     * @returns {number} The flood risk score, ranging from 0 (low risk) to 1 (high risk).
     */
    _calculateFloodRisk(elevation, waterDistance) {
        const elevationWeight = elevation < 10 ? 0.9 : elevation < 50 ? 0.6 : 0.3;
        const waterWeight = waterDistance < 1 ? 0.9 : waterDistance < 5 ? 0.6 : 0.3;
        return elevationWeight * 0.7 + waterWeight * 0.3;
    }

    /**
     * Calculates the overall accessibility score based on various factors, including roads, settlements, flood risk, and transportation route.
     *
     * @returns {Object} An object containing the overall accessibility score, the individual component scores, and the details of the underlying factors.
     */
    async calculateAccessibility() {
        const [roads, settlements, floodRisk, transportRoute] = await Promise.all([
            this.findNearestRoads(),
            this.findNearbySettlements(),
            this.assessFloodRisk(),
            this.analyzeTransportRoute()
        ]);

        // Calculate accessibility components
        const roadScore = this._calculateRoadScore(roads);
        const settlementScore = this._calculateSettlementScore(settlements);
        const floodScore = 1 - floodRisk.riskLevel;
        const transportScore = this._calculateTransportScore(transportRoute);

        // Weighted final score
        return {
            score: (roadScore * 0.3) + (settlementScore * 0.2) +
                (floodScore * 0.2) + (transportScore * 0.3),
            components: { roadScore, settlementScore, floodScore, transportScore },
            details: { roads, settlements, floodRisk, transportRoute }
        };
    }

    /**
   * Enhanced road detection with fallback
   */
    async findNearestRoads() {
        try {
            // Original implementation
            const roads = await this._findRoadsOverpass();
            if (roads.minor < Infinity && roads.major < Infinity) return roads;

            // Fallback to OpenRouteService
            return await this._findRoadsOpenRouteService();
        } catch (error) {
            console.error('Road detection failed:', error.message);
            return { minor: Infinity, major: Infinity };
        }
    }

    async _findRoadsOpenRouteService() {
        const response = await this._makeRequest(
            `${this.apiConfig.openRouteService.baseURL}/pois`,
            {
                api_key: this.apiConfig.openRouteService.key,
                request: 'pois',
                geometry: `{"type":"Point","coordinates":[${this.long},${this.lat}]}`,
                geometry_buffer: 1000,
                filters: 'category:roads'
            }
        );

        return this._processRoadsFromGeoJSON(response);
    }

    /**
     * Robust score calculation with validation
     */
    _calculateRoadScore(roads) {
        const validate = (value, fallback = 20) =>
            Number.isFinite(value) ? Math.min(value, 20) : fallback;

        try {
            const minor = validate(roads.minor);
            const major = validate(roads.major);
            return 1 - (minor * 0.7 + major * 0.3) / 20;
        } catch (error) {
            return 0.5; // Fallback neutral score
        }
    }

    async calculateAccessibility() {
        try {
            const [roads, settlements, floodRisk, transportRoute] = await Promise.allSettled([
                this.findNearestRoads(),
                this.findNearbySettlements(),
                this.assessFloodRisk(),
                this.analyzeTransportRoute()
            ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : {
                error: r.reason?.message || 'Unknown error'
            }));

            // Validate results
            const validated = {
                roads: roads.error ? { minor: Infinity, major: Infinity } : roads,
                settlements: settlements.error ? [] : settlements,
                floodRisk: floodRisk.error ? this._defaultFloodRisk() : floodRisk,
                transportRoute: transportRoute.error ? null : transportRoute
            };

            // Calculate scores with fallbacks
            const components = {
                roadScore: this._calculateRoadScore(validated.roads),
                settlementScore: validated.settlements.length > 0
                    ? this._calculateSettlementScore(validated.settlements).score
                    : 0.2, // Default rural score
                floodScore: validated.floodRisk.riskLevel !== undefined
                    ? 1 - validated.floodRisk.riskLevel
                    : 0.7,
                transportScore: validated.transportRoute
                    ? this._calculateTransportScore(validated.transportRoute)
                    : 0.1
            };

            return {
                score: Math.min(Math.max(
                    (components.roadScore * 0.3) +
                    (components.settlementScore * 0.2) +
                    (components.floodScore * 0.2) +
                    (components.transportScore * 0.3),
                    0
                ), 1),
                components,
                details: validated,
                warnings: [roads, settlements, floodRisk, transportRoute]
                    .filter(r => r.error)
                    .map(r => r.error)
            };
        } catch (error) {
            return {
                score: 0.5,
                components: {
                    roadScore: 0.5,
                    settlementScore: 0.5,
                    floodScore: 0.5,
                    transportScore: 0.5
                },
                details: null,
                error: error.message
            };
        }
    }
    _calculateTransportScore(route) {
        if (!route) return 0;
        const distanceScore = 1 - Math.min(route.distance / 100000, 1); // Normalize to 100km
        const elevationScore = route.elevationProfile.reduce(
            (acc, step) => acc + (step.elevation < 100 ? 0 : 1),
            0
        ) / route.elevationProfile.length;
        return distanceScore * 0.7 + elevationScore * 0.3;
    }

    /**
 * Calculates settlement accessibility score considering multiple factors
 * @param {Array} settlements - Array of settlement objects from findNearbySettlements()
 * @returns {Object} Score and detailed breakdown
 */
    _calculateSettlementScore(settlements) {
        // Validate input
        if (!Array.isArray(settlements)) {
            throw new Error('Invalid settlements input: must be an array');
        }

        // Configuration parameters (could be moved to class constants)
        const SETTLEMENT_HIERARCHY = {
            city: {
                maxDistance: 100,    // Maximum considered distance in km
                weight: 0.4,        // Weight in final score
                osmTypes: ['city']
            },
            town: {
                maxDistance: 50,
                weight: 0.3,
                osmTypes: ['town']
            },
            village: {
                maxDistance: 20,
                weight: 0.2,
                osmTypes: ['village', 'municipality']
            },
            hamlet: {
                maxDistance: 10,
                weight: 0.1,
                osmTypes: ['hamlet', 'suburb', 'neighbourhood']
            }
        };

        const LABOR_RADIUS = 2; // Kilometers for workforce accessibility
        const DENSITY_WEIGHT = 0.2; // Weight for settlement density score

        // Normalize settlements data
        const normalized = settlements.map(settlement => {
            // Validate settlement structure
            if (typeof settlement !== 'object' ||
                !settlement.type ||
                typeof settlement.distance !== 'number') {
                console.warn('Invalid settlement structure:', settlement);
                return null;
            }

            // Map OSM place types to our hierarchy
            const category = Object.entries(SETTLEMENT_HIERARCHY).find(([key, cfg]) =>
                cfg.osmTypes.includes(settlement.type)
            )?.[0] || 'other';

            return {
                ...settlement,
                category,
                isLaborArea: settlement.distance <= LABOR_RADIUS
            };
        }).filter(s => s !== null && s.category !== 'other');

        // Calculate proximity scores
        const proximityScores = {};
        let totalProximityScore = 0;

        Object.entries(SETTLEMENT_HIERARCHY).forEach(([category, cfg]) => {
            const relevant = normalized.filter(s => s.category === category);
            const nearest = relevant.length > 0
                ? Math.min(...relevant.map(s => s.distance))
                : Infinity;

            // Calculate normalized proximity score
            const clampedDistance = Math.min(nearest, cfg.maxDistance);
            const distanceScore = 1 - (clampedDistance / cfg.maxDistance);
            const categoryScore = distanceScore * cfg.weight;

            proximityScores[category] = {
                nearest: nearest !== Infinity ? nearest : null,
                score: categoryScore,
                weight: cfg.weight
            };

            totalProximityScore += categoryScore;
        });

        // Calculate labor density score
        const laborSettlements = normalized.filter(s => s.isLaborArea);
        const densityScore = Math.min(
            Math.log1p(laborSettlements.length) / Math.log1p(10), // Log scale for diminishing returns
            1
        ) * DENSITY_WEIGHT;

        // Calculate total score with bounds
        const totalScore = Math.min(
            Math.max(totalProximityScore + densityScore, 0),
            1
        );

        return {
            score: totalScore,
            breakdown: {
                proximity: proximityScores,
                density: {
                    score: densityScore,
                    settlementsInRadius: laborSettlements.length,
                    radius: LABOR_RADIUS
                }
            },
            metadata: {
                totalSettlements: normalized.length,
                settlementTypes: [...new Set(normalized.map(s => s.type))]
            }
        };
    }

    /**
   * Default flood risk assessment using country-level statistics
   */
    _defaultFloodRisk() {
        // Country-based flood risk statistics (expand as needed)
        const COUNTRY_FLOOD_DATA = new Map([
            ['ZA', { avgElevation: 1034, floodRisk: 0.3, waterDistance: 12.4 }],
            ['EG', { avgElevation: 321, floodRisk: 0.4, waterDistance: 8.5 }],
            ['NG', { avgElevation: 380, floodRisk: 0.5, waterDistance: 7.2 }],
            ['KE', { avgElevation: 762, floodRisk: 0.3, waterDistance: 11.8 }],
            ['ET', { avgElevation: 1330, floodRisk: 0.4, waterDistance: 9.6 }],
            ['TZ', { avgElevation: 1018, floodRisk: 0.3, waterDistance: 10.2 }],
            ['MA', { avgElevation: 909, floodRisk: 0.2, waterDistance: 13.5 }],
            ['GH', { avgElevation: 190, floodRisk: 0.5, waterDistance: 6.8 }]
        ]);

        const countryCode = this.countryCode || 'GLOBAL';
        const globalAverage = { elevation: 840, riskLevel: 0.3, waterDistance: 10 };

        try {
            const data = COUNTRY_FLOOD_DATA.get(countryCode) || globalAverage;
            return {
                elevation: data.avgElevation,
                waterDistance: data.waterDistance,
                riskLevel: data.floodRisk,
                isEstimated: true
            };
        } catch (error) {
            return {
                elevation: globalAverage.elevation,
                waterDistance: globalAverage.waterDistance,
                riskLevel: globalAverage.riskLevel,
                isEstimated: true
            };
        }
    }

    /**
     * Process water body data from Overpass API response
     */
    _processWaterBodies(data) {
        const targetPoint = turf.point([this.long, this.lat]);
        let minDistance = Infinity;

        try {
            const waterFeatures = data.elements
                .filter(el => ['way', 'relation'].includes(el.type))
                .map(el => {
                    try {
                        if (!el.geometry) return null;

                        // Convert OSM geometry to GeoJSON
                        const coords = el.geometry.map(p => [p.lon, p.lat]);

                        // Handle different geometry types
                        if (el.type === 'relation' || coords[0] === coords[coords.length - 1]) {
                            return turf.polygon([coords]);
                        }
                        return turf.lineString(coords);
                    } catch (error) {
                        console.warn('Invalid water feature geometry:', el);
                        return null;
                    }
                })
                .filter(f => f !== null);

            // Calculate distances efficiently
            waterFeatures.forEach(feature => {
                try {
                    const distance = feature.geometry.type === 'Polygon'
                        ? turf.pointToPolygonDistance(targetPoint, feature)
                        : turf.pointToLineDistance(targetPoint, feature);

                    minDistance = Math.min(minDistance, distance);
                } catch (error) {
                    console.warn('Distance calculation failed for water feature:', error);
                }
            });

            return {
                count: waterFeatures.length,
                distance: Number.isFinite(minDistance) ? minDistance : Infinity,
                source: 'overpass'
            };
        } catch (error) {
            console.error('Water body processing failed:', error);
            return {
                count: 0,
                distance: Infinity,
                source: 'error'
            };
        }
    }

    /**
     * Find roads using Overpass API with optimized query
     */
    async _findRoadsOverpass() {
        const buffer = turf.point([this.long, this.lat]).buffer(10); // 10km buffer
        const bbox = turf.bbox(buffer);

        try {
            const query = `[out:json][timeout:25];
        (
          way[highway~"motorway|trunk|primary|secondary|tertiary|unclassified"]
            (${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
          node[highway~"motorway|trunk|primary|secondary|tertiary|unclassified"]
            (${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
        );
        out body 100;
        >;
        out skel qt;`;

            const data = await this._makeRequest(
                this.apiConfig.overpass.baseURL,
                { data: query },
                2 // Retries
            );

            return this._processRoadData(data);
        } catch (error) {
            console.error('Overpass road detection failed:', error);
            throw error; // Trigger fallback to other methods
        }
    }

    /**
     * Process GeoJSON road data from OpenRouteService
     */
    _processRoadsFromGeoJSON(geoJson) {
        try {
            const targetPoint = turf.point([this.long, this.lat]);
            const roads = [];

            geoJson.features.forEach(feature => {
                try {
                    const roadType = this._classifyRoad(
                        feature.properties?.category || 'unknown',
                        this.countryCode
                    );

                    const line = turf.lineString(feature.geometry.coordinates);
                    const distance = turf.nearestPointOnLine(line, targetPoint).properties.location;

                    roads.push({
                        type: roadType,
                        distance: turf.distance(targetPoint, distance)
                    });
                } catch (error) {
                    console.warn('Invalid road feature:', error);
                }
            });

            const nearestMinor = Math.min(
                ...roads.filter(r => r.type === 'minor').map(r => r.distance),
                Infinity
            );

            const nearestMajor = Math.min(
                ...roads.filter(r => r.type === 'major').map(r => r.distance),
                Infinity
            );

            return {
                minor: nearestMinor,
                major: nearestMajor,
                source: 'openrouteservice'
            };
        } catch (error) {
            console.error('GeoJSON road processing failed:', error);
            return { minor: Infinity, major: Infinity };
        }
    }

    /**
     * Helper method to process raw Overpass road data
     */
    _processRoadData(data) {
        const targetPoint = turf.point([this.long, this.lat]);
        const roads = [];

        data.elements.forEach(element => {
            try {
                if (element.type === 'way') {
                    const coords = element.geometry.map(p => [p.lon, p.lat]);
                    const line = turf.lineString(coords);
                    const distance = turf.nearestPointOnLine(line, targetPoint).properties.location;

                    roads.push({
                        type: this._classifyRoad(element.tags.highway, this.countryCode),
                        distance: turf.distance(targetPoint, distance)
                    });
                }
            } catch (error) {
                console.warn('Invalid road element processing:', error);
            }
        });

        const nearestMinor = roads.reduce((min, r) =>
            r.type === 'minor' ? Math.min(min, r.distance) : min, Infinity);

        const nearestMajor = roads.reduce((min, r) =>
            r.type === 'major' ? Math.min(min, r.distance) : min, Infinity);

        return {
            minor: nearestMinor,
            major: nearestMajor,
            source: 'overpass'
        };
    }

}

module.exports = GeospatialAccessibilityAssessment;