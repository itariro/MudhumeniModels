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
                timeout: 10000
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
     * Finds the nearest roads to the current location, categorizing them as major or minor based on the road type.
     *
     * @returns {Promise<{ minor: number, major: number }>} An object containing the distance to the nearest minor and major roads, or Infinity if no roads of that type were found.
     */
    async findNearestRoads() {
        const country = await this._getCountryCode();
        const bbox = turf.bbox(turf.buffer(turf.point([this.long, this.lat]), 10, { units: 'kilometers' }));

        // Overpass query for roads in bounding box
        const query = `[out:json][timeout:30];
      way[highway][highway!~"footway|path|cycleway|pedestrian"](${bbox});
      (._;>;);
      out body;`;

        logger.info('making request to overpass api');
        const data = await this._makeRequest(this.apiConfig.overpass.baseURL, { data: query });

        // Categorize roads and find nearest
        const roads = data.elements
            .filter(el => el.type === 'way')
            .map(way => ({
                type: this._classifyRoad(way.tags.highway, country),
                geometry: way.geometry || []
            }))
            .filter(road => road.geometry.length > 0);

        // Find nearest using Turf.js
        const targetPoint = turf.point([this.long, this.lat]);
        const nearestRoads = roads.map(road => ({
            type: road.type,
            distance: Math.min(...road.geometry.map(coord =>
                turf.distance(targetPoint, turf.point(coord))
            ))
        })).sort((a, b) => a.distance - b.distance);

        return {
            minor: nearestRoads.find(r => r.type === 'minor')?.distance || Infinity,
            major: nearestRoads.find(r => r.type === 'major')?.distance || Infinity
        };
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
            elevation: elevation,
            waterDistance: waterBodies.distance,
            riskLevel: this._calculateFloodRisk(elevation, waterBodies.distance)
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
            // Create a 5km buffer and get bounding box
            const point = turf.point([this.long, this.lat]);
            const buffer = turf.buffer(point, 5, { units: 'kilometers' });
            const bbox = turf.bbox(buffer); // [minX, minY, maxX, maxY]

            // Proper Overpass QL syntax for water features (corrected bbox order)
            const query = `[out:json][timeout:30];
          (
            way["natural"="water"](${bbox[1]},${bbox[0]},${bbox[2]},${bbox[3]});
            way["waterway"](${bbox[1]},${bbox[0]},${bbox[2]},${bbox[3]});
            relation["natural"="water"](${bbox[1]},${bbox[0]},${bbox[2]},${bbox[3]});
          );
          (._;>;);
          out body;`;

            // Make API request safely
            let data;
            try {
                logger.info('making request to overpass api');
                data = await this._makeRequest(this.apiConfig.overpass.baseURL, { data: query });
            } catch (error) {
                console.error('Error fetching water body data:', error);
                return { count: 0, distance: Infinity };
            }

            // Process water features
            const waterFeatures = data.elements
                .filter(el => (el.type === 'way' || el.type === 'relation') && el.geometry)
                .map(feature => {
                    const coords = feature.geometry.map(coord => [coord.lon, coord.lat]);
                    if (coords.length > 1) {
                        // Check if the way is closed (first and last coordinates are the same)
                        const isClosed = turf.booleanEqual(
                            turf.point(coords[0]),
                            turf.point(coords[coords.length - 1])
                        );
                        return isClosed ? turf.polygon([coords]) : turf.lineString(coords);
                    }
                    return null;
                })
                .filter(f => f !== null);

            // Calculate distances
            const targetPoint = turf.point([this.long, this.lat]);
            const distances = waterFeatures.map(feature => {
                try {
                    return turf.distance(targetPoint, feature, { units: 'kilometers' });
                } catch (error) {
                    console.error('Distance calculation error:', error);
                    return Infinity;
                }
            });

            return {
                count: waterFeatures.length,
                distance: distances.length > 0 ? Math.min(...distances) : Infinity
            };
        } catch (error) {
            console.error('Unexpected error in _findWaterBodies:', error);
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
     * Calculates the road score based on the distance to minor and major roads.
     *
     * @param {Object} roads - An object containing the distance to minor and major roads.
     * @param {number} roads.minor - The distance to the nearest minor road in kilometers.
     * @param {number} roads.major - The distance to the nearest major road in kilometers.
     * @returns {number} The road score, ranging from 0 (poor accessibility) to 1 (good accessibility).
     */
    _calculateRoadScore(roads) {
        const maxDistance = 20; // 20km maximum considered
        return 1 - Math.min(roads.minor, maxDistance) / maxDistance * 0.5 +
            1 - Math.min(roads.major, maxDistance) / maxDistance * 0.5;
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
}

module.exports = GeospatialAccessibilityAssessment;