/**
 * WOFOST 7.2 Crop Growth Simulation Model Implementation
 * 
 * This is a JavaScript implementation of the WOFOST (World Food Studies) model version 7.2.
 * WOFOST is a mechanistic crop growth simulation model that explains crop growth based on
 * underlying processes such as photosynthesis, respiration, and how these processes are
 * influenced by environmental conditions.
 * 
 * @author Claude
 * @version 1.0.0
 */

/**
 * Main module for the WOFOST 7.2 crop growth model
 * @module wofost
 */

/**
 * Weather data structure for WOFOST model
 * @typedef {Object} WeatherData
 * @property {number} Tmin - Minimum daily temperature (°C)
 * @property {number} Tmax - Maximum daily temperature (°C)
 * @property {number} solarRadiation - Solar radiation (MJ/m²/day)
 * @property {number} rainfall - Daily precipitation (mm)
 * @property {number} ET0 - Reference evapotranspiration (mm/day)
 * @property {number} [humidity] - Relative humidity (%) (optional)
 * @property {number} [windSpeed] - Wind speed (m/s) (optional)
 * @property {number} [CO2] - Atmospheric CO2 concentration (ppm) (optional, default 415)
 */

/**
 * Soil parameters for WOFOST model
 * @typedef {Object} SoilParams
 * @property {number} fieldCapacity - Field capacity (mm)
 * @property {number} wiltingPoint - Wilting point (mm)
 * @property {number} saturation - Saturation point (mm)
 * @property {number} [initialWaterContent] - Initial water content (mm) (optional, defaults to fieldCapacity)
 * @property {number} [maxRootingDepth] - Maximum rooting depth (m) (optional)
 * @property {Object} [soilLayers] - Information about soil layers (optional)
 */

/**
 * Management parameters for WOFOST model
 * @typedef {Object} ManagementParams
 * @property {string|Date} plantingDate - Planting date
 * @property {Array} [irrigation] - Irrigation events [{date: Date, amount: number}]
 * @property {Object} [fertilization] - Fertilization information
 */

class Wofost {
    /**
     * Create a new WOFOST model instance
     * @param {Object} cropParams - Crop-specific parameters
     * @param {Object} soilParams - Soil parameters
     * @param {Object} managementParams - Management parameters (e.g., planting date, irrigation)
     */
    constructor(cropParams, soilParams, managementParams) {
        // Initialize model parameters
        this.crop = cropParams;
        this.soil = soilParams;
        this.management = managementParams;

        // Initialize state variables
        this.state = {
            developmentStage: 0, // 0: emergence, 1: flowering, 2: maturity
            leafAreaIndex: 0, // Leaf area index (m²/m²)
            totalAboveGroundBiomass: 0, // Total above ground biomass (kg/ha)
            totalBelowGroundBiomass: 0, // Total below ground biomass (kg/ha)
            stems: 0, // Stem weight (kg/ha)
            leaves: 0, // Leaf weight (kg/ha)
            organs: 0, // Storage organs (kg/ha)
            roots: 0, // Root weight (kg/ha)
            deadLeaves: 0, // Dead leaf weight (kg/ha)
            daysSincePlanting: 0, // Days since planting
            temperature: {
                sum: 0, // Temperature sum (degree-days)
                effectiveSum: 0 // Effective temperature sum (degree-days)
            },
            soilWater: {
                content: 0, // Current soil water content (mm)
                field_capacity: 0, // Field capacity (mm)
                wilting_point: 0, // Wilting point (mm)
                saturation: 0 // Saturation point (mm)
            },
            assimilates: {
                total: 0, // Total assimilates produced (kg/ha/day)
                reserved: 0 // Reserve assimilates (kg/ha)
            }
        };

        // Initialize simulation date and history
        this.simulationDate = null;
        this.history = [];
        this.hasStarted = false;
        this.isFinished = false;

        // Initialize the soil water state
        this._initializeSoilWater();
    }

    /**
     * Initialize soil water state based on soil parameters
     * @private
     */
    _initializeSoilWater() {
        const { fieldCapacity, wiltingPoint, saturation, initialWaterContent } = this.soil;

        this.state.soilWater = {
            content: initialWaterContent || fieldCapacity, // Default to field capacity if not specified
            field_capacity: fieldCapacity,
            wilting_point: wiltingPoint,
            saturation: saturation
        };
    }

    /**
     * Start the simulation on a specific date
     * @param {Date} startDate - Starting date of the simulation
     */
    start(startDate) {
        if (this.hasStarted) {
            throw new Error('Simulation has already been started');
        }

        this.simulationDate = new Date(startDate);
        this.hasStarted = true;

        // Initialize emergence if the simulation starts at or after planting date
        const plantingDate = new Date(this.management.plantingDate);
        if (this.simulationDate >= plantingDate) {
            this._initializeEmergence();
        }

        // Save initial state to history
        this._saveCurrentState();

        return this.state;
    }

    /**
     * Initialize the crop after emergence
     * @private
     */
    _initializeEmergence() {
        const { initialLeafAreaIndex, initialBiomass } = this.crop;

        // Set initial values after emergence
        this.state.developmentStage = 0;
        this.state.leafAreaIndex = initialLeafAreaIndex || 0.01;

        // Distribute initial biomass
        const totalInitialBiomass = initialBiomass || 100; // Default 100 kg/ha if not specified
        this.state.leaves = totalInitialBiomass * 0.5;
        this.state.stems = totalInitialBiomass * 0.2;
        this.state.roots = totalInitialBiomass * 0.3;
        this.state.totalAboveGroundBiomass = this.state.leaves + this.state.stems;
        this.state.totalBelowGroundBiomass = this.state.roots;
    }

    /**
     * Run the model for a specified number of days
     * @param {number} days - Number of days to run the simulation
     * @param {Array} weatherData - Array of daily weather data
     * @returns {Array} - History of states for the simulation period
     */
    run(days, weatherData) {
        if (!this.hasStarted) {
            throw new Error('Simulation has not been started. Call start() first.');
        }

        if (this.isFinished) {
            throw new Error('Simulation has already finished.');
        }

        for (let i = 0; i < days; i++) {
            // Check if we have weather data for the current day
            if (i >= weatherData.length) {
                throw new Error('Insufficient weather data for the simulation period');
            }

            // Run a single day simulation
            this._simulateDay(weatherData[i]);

            // Advance to the next day
            this.simulationDate.setDate(this.simulationDate.getDate() + 1);
            this.state.daysSincePlanting++;

            // Save the state to history
            this._saveCurrentState();

            // Check if the crop has reached maturity
            if (this.state.developmentStage >= 2) {
                this.isFinished = true;
                break;
            }
        }

        return this.history;
    }

    /**
     * Simulate a single day
     * @param {Object} weather - Weather data for the day
     * @private
     */
    _simulateDay(weather) {
        // Update temperature sum
        this._updateTemperatureSum(weather);

        // Update development stage based on temperature sum
        this._updateDevelopmentStage();

        // Update soil water balance
        this._updateSoilWaterBalance(weather);

        // Calculate potential photosynthesis
        const potentialAssimilates = this._calculatePotentialPhotosynthesis(weather);

        // Adjust for water stress
        const waterStressFactor = this._calculateWaterStress();
        const actualAssimilates = potentialAssimilates * waterStressFactor;

        // Calculate maintenance respiration
        const maintenanceRespiration = this._calculateMaintenanceRespiration(weather);

        // Net assimilates available for growth
        const netAssimilates = Math.max(0, actualAssimilates - maintenanceRespiration);

        // Update the biomass components
        this._updateBiomassComponents(netAssimilates);

        // Update leaf area index
        this._updateLeafAreaIndex();

        // Update total biomass
        this._updateTotalBiomass();

        // Store daily assimilates info
        this.state.assimilates.total = actualAssimilates;
    }

    /**
     * Update temperature sum based on daily temperature
     * @param {Object} weather - Weather data for the day
     * @private
     */
    _updateTemperatureSum(weather) {
        const { Tmin, Tmax } = weather;
        const Tavg = (Tmin + Tmax) / 2;

        // Base temperature for development
        const Tbase = this.crop.baseTemperature || 0;

        // Daily effective temperature (above base temperature)
        const effectiveTemp = Math.max(0, Tavg - Tbase);

        // Update temperature sums
        this.state.temperature.sum += Tavg;
        this.state.temperature.effectiveSum += effectiveTemp;
    }

    /**
     * Update development stage based on accumulated temperature sum
     * @private
     */
    _updateDevelopmentStage() {
        const { emergenceTSum, floweringTSum, maturityTSum } = this.crop;
        const tSum = this.state.temperature.effectiveSum;

        if (tSum < emergenceTSum) {
            this.state.developmentStage = 0; // Pre-emergence
        } else if (tSum < floweringTSum) {
            // Linear interpolation between emergence and flowering
            this.state.developmentStage =
                (tSum - emergenceTSum) / (floweringTSum - emergenceTSum);
        } else if (tSum < maturityTSum) {
            // Linear interpolation between flowering and maturity
            this.state.developmentStage =
                1 + (tSum - floweringTSum) / (maturityTSum - floweringTSum);
        } else {
            this.state.developmentStage = 2; // Maturity reached
        }
    }

    /**
     * Update soil water balance
     * @param {Object} weather - Weather data for the day
     * @private
     */
    _updateSoilWaterBalance(weather) {
        const { rainfall, ET0 } = weather; // Reference evapotranspiration
        const { soilWater } = this.state;

        // Calculate crop coefficient based on development stage and LAI
        const kc = this._calculateCropCoefficient();

        // Calculate actual evapotranspiration
        const potentialET = ET0 * kc;

        // Actual ET depends on soil water content
        const waterAvailabilityFactor = this._calculateWaterStress();
        const actualET = potentialET * waterAvailabilityFactor;

        // Irrigation (if scheduled for today)
        const irrigation = this._getIrrigationAmount() || 0;

        // Calculate drainage (excess water above field capacity)
        let newWaterContent = soilWater.content + rainfall + irrigation - actualET;
        let drainage = 0;

        if (newWaterContent > soilWater.saturation) {
            drainage = newWaterContent - soilWater.saturation;
            newWaterContent = soilWater.saturation;
        }

        // Update soil water content
        soilWater.content = newWaterContent;
    }

    /**
     * Calculate crop coefficient based on development stage and LAI
     * @returns {number} - Crop coefficient (kc)
     * @private
     */
    _calculateCropCoefficient() {
        const { leafAreaIndex, developmentStage } = this.state;
        const { kcMin, kcMax } = this.crop;

        // Simplified approach: kc increases with LAI up to a maximum
        const kcFromLAI = kcMin + (kcMax - kcMin) * (1 - Math.exp(-0.65 * leafAreaIndex));

        // Additionally, kc is reduced during senescence
        let kcFinal = kcFromLAI;
        if (developmentStage > 1) {
            // Linear reduction during maturation (after flowering)
            const senescenceFactor = Math.max(0, 1 - (developmentStage - 1) * 2);
            kcFinal = kcFinal * senescenceFactor;
        }

        return kcFinal;
    }

    /**
     * Calculate water stress factor (0-1)
     * @returns {number} - Water stress factor
     * @private
     */
    _calculateWaterStress() {
        const { soilWater } = this.state;
        const { p } = this.crop; // Soil water depletion fraction for no stress

        // Calculate readily available water
        const totalAvailableWater = soilWater.field_capacity - soilWater.wilting_point;
        const readilyAvailableWater = totalAvailableWater * p;

        // Calculate critical point where stress begins
        const criticalPoint = soilWater.field_capacity - readilyAvailableWater;

        if (soilWater.content >= criticalPoint) {
            return 1.0; // No water stress
        } else if (soilWater.content <= soilWater.wilting_point) {
            return 0.0; // Maximum water stress
        } else {
            // Linear reduction between critical point and wilting point
            return (soilWater.content - soilWater.wilting_point) /
                (criticalPoint - soilWater.wilting_point);
        }
    }

    /**
     * Get scheduled irrigation amount for the current day
     * @returns {number} - Irrigation amount (mm)
     * @private
     */
    _getIrrigationAmount() {
        if (!this.management.irrigation) {
            return 0;
        }

        // Check if there's an irrigation event scheduled for today
        const currentDateStr = this.simulationDate.toISOString().split('T')[0];

        for (const event of this.management.irrigation) {
            const eventDateStr = new Date(event.date).toISOString().split('T')[0];
            if (eventDateStr === currentDateStr) {
                return event.amount;
            }
        }

        return 0;
    }

    /**
     * Calculate potential photosynthesis
     * @param {Object} weather - Weather data for the day
     * @returns {number} - Potential daily assimilates (kg/ha/day)
     * @private
     */
    _calculatePotentialPhotosynthesis(weather) {
        const { solarRadiation, Tmin, Tmax, CO2 = 415 } = weather; // Default CO2 to 415 ppm if not specified
        const { leafAreaIndex } = this.state;

        // Radiation use efficiency parameters
        const { RUE, k } = this.crop; // Radiation use efficiency and light extinction coefficient

        // Calculate intercepted radiation
        const fractionIntercepted = 1 - Math.exp(-k * leafAreaIndex);
        const interceptedRadiation = solarRadiation * fractionIntercepted;

        // Base calculation: RUE * intercepted radiation
        let potentialAssimilates = RUE * interceptedRadiation;

        // Adjust for temperature effects
        const temperatureFactor = this._calculateTemperatureFactor(Tmin, Tmax);

        // Adjust for CO2 effect
        const CO2Factor = this._calculateCO2Factor(CO2);

        // Apply modifiers
        potentialAssimilates *= temperatureFactor * CO2Factor;

        return potentialAssimilates;
    }

    /**
     * Calculate temperature factor for photosynthesis (0-1)
     * @param {number} Tmin - Minimum daily temperature
     * @param {number} Tmax - Maximum daily temperature
     * @returns {number} - Temperature factor
     * @private
     */
    _calculateTemperatureFactor(Tmin, Tmax) {
        const Tavg = (Tmin + Tmax) / 2;

        const { Topt, Tmin: TminThreshold, Tmax: TmaxThreshold } = this.crop;

        if (Tavg <= TminThreshold || Tavg >= TmaxThreshold) {
            return 0; // No photosynthesis outside temperature range
        } else if (Tavg <= Topt) {
            // Linear increase from min to optimum
            return (Tavg - TminThreshold) / (Topt - TminThreshold);
        } else {
            // Linear decrease from optimum to max
            return (TmaxThreshold - Tavg) / (TmaxThreshold - Topt);
        }
    }

    /**
     * Calculate CO2 factor for photosynthesis
     * @param {number} CO2 - Atmospheric CO2 concentration (ppm)
     * @returns {number} - CO2 factor
     * @private
     */
    _calculateCO2Factor(CO2) {
        // Reference CO2 concentration (usually 380-400 ppm)
        const CO2ref = 400;

        // Simplified version of the CO2 response function
        if (CO2 <= CO2ref) {
            return 1.0;
        } else {
            // Logarithmic response to elevated CO2, based on C3 vs C4 pathway
            const beta = this.crop.photosynthesisPathway === 'C4' ? 0.4 : 0.8;
            return 1 + beta * Math.log(CO2 / CO2ref);
        }
    }

    /**
     * Calculate maintenance respiration
     * @param {Object} weather - Weather data for the day
     * @returns {number} - Maintenance respiration (kg/ha/day)
     * @private
     */
    _calculateMaintenanceRespiration(weather) {
        const { Tmin, Tmax } = weather;
        const Tavg = (Tmin + Tmax) / 2;

        // Maintenance coefficients (kg/kg/day)
        const { maintenanceCoef } = this.crop;
        const { leaves, stems, roots, organs } = this.state;

        // Base maintenance respiration at reference temperature (usually 25°C)
        const baseMaintenance =
            maintenanceCoef.leaves * leaves +
            maintenanceCoef.stems * stems +
            maintenanceCoef.roots * roots +
            maintenanceCoef.organs * organs;

        // Temperature correction using Q10 approach
        const Q10 = 2.0; // Typical value
        const Tref = 25; // Reference temperature
        const temperatureFactor = Math.pow(Q10, (Tavg - Tref) / 10);

        // Reduced maintenance during senescence
        let maintenanceFactor = 1.0;
        if (this.state.developmentStage > 1) {
            maintenanceFactor = Math.max(0.5, 1.5 - this.state.developmentStage);
        }

        return baseMaintenance * temperatureFactor * maintenanceFactor;
    }

    /**
     * Update biomass components based on assimilate availability
     * @param {number} netAssimilates - Net assimilates available for growth (kg/ha/day)
     * @private
     */
    _updateBiomassComponents(netAssimilates) {
        // Get partitioning coefficients based on development stage
        const partitioning = this._calculatePartitioning();

        // Growth conversion efficiency (kg biomass / kg assimilate)
        const { conversionEfficiency } = this.crop;

        // Calculate potential growth for each component
        const potentialGrowth = {
            leaves: netAssimilates * partitioning.leaves * conversionEfficiency.leaves,
            stems: netAssimilates * partitioning.stems * conversionEfficiency.stems,
            roots: netAssimilates * partitioning.roots * conversionEfficiency.roots,
            organs: netAssimilates * partitioning.organs * conversionEfficiency.organs
        };

        // Add new growth to each component
        this.state.leaves += potentialGrowth.leaves;
        this.state.stems += potentialGrowth.stems;
        this.state.roots += potentialGrowth.roots;
        this.state.organs += potentialGrowth.organs;

        // Handle leaf senescence
        this._handleLeafSenescence();
    }

    /**
     * Calculate partitioning coefficients based on development stage
     * @returns {Object} - Partitioning coefficients for different organs
     * @private
     */
    _calculatePartitioning() {
        const { developmentStage } = this.state;
        const { partitioning } = this.crop;

        // Check if we're using a table or function-based approach
        if (Array.isArray(partitioning)) {
            // Interpolate between values in the table
            for (let i = 0; i < partitioning.length - 1; i++) {
                const current = partitioning[i];
                const next = partitioning[i + 1];

                if (developmentStage >= current.stage && developmentStage <= next.stage) {
                    const fraction = (developmentStage - current.stage) / (next.stage - current.stage);

                    return {
                        leaves: current.leaves + fraction * (next.leaves - current.leaves),
                        stems: current.stems + fraction * (next.stems - current.stems),
                        roots: current.roots + fraction * (next.roots - current.roots),
                        organs: current.organs + fraction * (next.organs - current.organs)
                    };
                }
            }

            // If development stage is beyond the last entry, use the last entry
            const last = partitioning[partitioning.length - 1];
            return {
                leaves: last.leaves,
                stems: last.stems,
                roots: last.roots,
                organs: last.organs
            };
        } else {
            // Use the provided functions directly
            return {
                leaves: partitioning.leaves(developmentStage),
                stems: partitioning.stems(developmentStage),
                roots: partitioning.roots(developmentStage),
                organs: partitioning.organs(developmentStage)
            };
        }
    }

    /**
     * Handle leaf senescence
     * @private
     */
    _handleLeafSenescence() {
        // Physiological aging (development dependent)
        let senescenceRate = 0;

        if (this.state.developmentStage > 1) {
            // Increasing senescence after flowering
            senescenceRate = 0.05 * (this.state.developmentStage - 1);
        } else if (this.state.developmentStage > 0.8) {
            // Start of senescence just before flowering
            senescenceRate = 0.01 * (this.state.developmentStage - 0.8) / 0.2;
        }

        // Calculate leaf weight loss due to senescence
        const senescedLeaves = this.state.leaves * senescenceRate;

        // Update leaf and dead leaf pools
        this.state.leaves -= senescedLeaves;
        this.state.deadLeaves += senescedLeaves;
    }

    /**
     * Update leaf area index based on leaf biomass changes
     * @private
     */
    _updateLeafAreaIndex() {
        const { leaves, developmentStage } = this.state;

        // Specific leaf area (m²/kg) depends on development stage
        let specificLeafArea;

        if (developmentStage < 1) {
            // Vegetative phase: constant or increasing SLA
            specificLeafArea = this.crop.specificLeafArea;
        } else {
            // Reproductive phase: decreasing SLA
            const maturityFactor = Math.min(1, 2 - developmentStage);
            specificLeafArea = this.crop.specificLeafArea * maturityFactor;
        }

        // Calculate new LAI
        this.state.leafAreaIndex = leaves * specificLeafArea / 10000; // Convert to m²/m²
    }

    /**
     * Update total biomass calculations
     * @private
     */
    _updateTotalBiomass() {
        const { leaves, stems, organs, roots, deadLeaves } = this.state;

        this.state.totalAboveGroundBiomass = leaves + stems + organs + deadLeaves;
        this.state.totalBelowGroundBiomass = roots;
    }

    /**
     * Save current state to history
     * @private
     */
    _saveCurrentState() {
        // Create a deep copy of the current state
        const stateCopy = JSON.parse(JSON.stringify(this.state));

        // Add the simulation date
        const historyEntry = {
            date: new Date(this.simulationDate),
            ...stateCopy
        };

        this.history.push(historyEntry);
    }

    /**
     * Get model results at the current point
     * @returns {Object} - Current model state
     */
    getResults() {
        return {
            date: new Date(this.simulationDate),
            developmentStage: this.state.developmentStage,
            leafAreaIndex: this.state.leafAreaIndex,
            biomass: {
                total: this.state.totalAboveGroundBiomass + this.state.totalBelowGroundBiomass,
                aboveGround: this.state.totalAboveGroundBiomass,
                belowGround: this.state.totalBelowGroundBiomass,
                components: {
                    leaves: this.state.leaves,
                    stems: this.state.stems,
                    organs: this.state.organs,
                    roots: this.state.roots,
                    deadLeaves: this.state.deadLeaves
                }
            },
            soil: {
                waterContent: this.state.soilWater.content
            },
            isFinished: this.isFinished
        };
    }

    /**
     * Get the complete simulation history
     * @returns {Array} - Array of daily states
     */
    getHistory() {
        return this.history;
    }

    /**
     * Reset the simulation to initial state
     */
    reset() {
        // Reset state variables
        this.state = {
            developmentStage: 0,
            leafAreaIndex: 0,
            totalAboveGroundBiomass: 0,
            totalBelowGroundBiomass: 0,
            stems: 0,
            leaves: 0,
            organs: 0,
            roots: 0,
            deadLeaves: 0,
            daysSincePlanting: 0,
            temperature: {
                sum: 0,
                effectiveSum: 0
            },
            soilWater: {
                content: 0,
                field_capacity: 0,
                wilting_point: 0,
                saturation: 0
            },
            assimilates: {
                total: 0,
                reserved: 0
            }
        };

        // Reset simulation status
        this.simulationDate = null;
        this.history = [];
        this.hasStarted = false;
        this.isFinished = false;

        // Re-initialize soil water
        this._initializeSoilWater();
    }
}

/**
 * CropParameterBuilder - Helper class to create crop parameter objects
 */
class CropParameterBuilder {
    constructor() {
        this.params = {
            // Crop identification
            cropName: '',
            varietyName: '',
            cropGroup: '', // e.g., 'cereals', 'legumes', etc.

            // Phenology parameters
            baseTemperature: 0, // Base temperature for development (°C)
            emergenceTSum: 100, // Temperature sum required for emergence (°Cd)
            floweringTSum: 1000, // Temperature sum required for flowering (°Cd)
            maturityTSum: 2000, // Temperature sum required for maturity (°Cd)

            // Initial state
            initialLeafAreaIndex: 0.01, // Initial leaf area index after emergence (m²/m²)
            initialBiomass: 100, // Initial biomass after emergence (kg/ha)

            // Photosynthesis parameters
            RUE: 3.0, // Radiation use efficiency (g/MJ)
            k: 0.5, // Light extinction coefficient
            photosynthesisPathway: 'C3', // 'C3' or 'C4'

            // Temperature response parameters
            Tmin: 5, // Minimum temperature for growth (°C)
            Topt: 25, // Optimum temperature for growth (°C)
            Tmax: 35, // Maximum temperature for growth (°C)

            // Maintenance respiration parameters
            maintenanceCoef: {
                leaves: 0.03, // kg/kg/day
                stems: 0.015,
                roots: 0.01,
                organs: 0.01
            },

            // Conversion efficiency (kg biomass / kg assimilate)
            conversionEfficiency: {
                leaves: 0.7,
                stems: 0.7,
                roots: 0.7,
                organs: 0.8
            },

            // Leaf parameters
            specificLeafArea: 20, // Specific leaf area (m²/kg)

            // Water use parameters
            kcMin: 0.4, // Minimum crop coefficient
            kcMax: 1.2, // Maximum crop coefficient
            p: 0.55, // Soil water depletion fraction for no stress

            // Partitioning parameters (example with table approach)
            partitioning: [
                { stage: 0, leaves: 0.6, stems: 0.2, roots: 0.2, organs: 0 },
                { stage: 0.5, leaves: 0.6, stems: 0.25, roots: 0.15, organs: 0 },
                { stage: 1, leaves: 0.3, stems: 0.2, roots: 0.1, organs: 0.4 },
                { stage: 1.5, leaves: 0.1, stems: 0.1, roots: 0.05, organs: 0.75 },
                { stage: 2, leaves: 0, stems: 0, roots: 0, organs: 1 }
            ]
        };
    }

    // Setters for various parameters
    setCropIdentity(cropName, varietyName, cropGroup) {
        this.params.cropName = cropName;
        this.params.varietyName = varietyName;
        this.params.cropGroup = cropGroup;
        return this;
    }

    setPhenology(baseTemp, emergenceTSum, floweringTSum, maturityTSum) {
        this.params.baseTemperature = baseTemp;
        this.params.emergenceTSum = emergenceTSum;
        this.params.floweringTSum = floweringTSum;
        this.params.maturityTSum = maturityTSum;
        return this;
    }

    setInitialState(initialLAI, initialBiomass) {
        this.params.initialLeafAreaIndex = initialLAI;
        this.params.initialBiomass = initialBiomass;
        return this;
    }

    setPhotosynthesis(rue, k, pathway) {
        this.params.RUE = rue;
        this.params.k = k;
        this.params.photosynthesisPathway = pathway;
        return this;
    }

    setTemperatureResponse(min, opt, max) {
        this.params.Tmin = min;
        this.params.Topt = opt;
        this.params.Tmax = max;
        return this;
    }

    setMaintenanceRespiration(leaves, stems, roots, organs) {
        this.params.maintenanceCoef = {
            leaves,
            stems,
            roots,
            organs
        };
        return this;
    }

    setConversionEfficiency(leaves, stems, roots, organs) {
        this.params.conversionEfficiency = {
            leaves,
            stems,
            roots,
            organs
        };
        return this;
    }

    setLeafParameters(specificLeafArea) {
        this.params.specificLeafArea = specificLeafArea;
        return this;
    }

    setWaterUseParameters(kcMin, kcMax, p) {
        this.params.kcMin = kcMin;
        this.params.kcMax = kcMax;
        this.params.p = p;
        return this;
    }

    /**
     * Set partitioning parameters using table approach
     * @param {Array} partitioningTable - Array of objects with stage and organ partitioning values
     */
    setPartitioningTable(partitioningTable) {
        this.params.partitioning = partitioningTable;
        return this;
    }

    /**
     * Set partitioning parameters using function approach
     * @param {Function} leavesFn - Function that returns leaves partitioning for a given development stage
     * @param {Function} stemsFn - Function that returns stems partitioning for a given development stage
     * @param {Function} rootsFn - Function that returns roots partitioning for a given development stage
     * @param {Function} organsFn - Function that returns organs partitioning for a given development stage
     */
    setPartitioningFunctions(leavesFn, stemsFn, rootsFn, organsFn) {
        this.params.partitioning = {
            leaves: leavesFn,
            stems: stemsFn,
            roots: rootsFn,
            organs: organsFn
        };
        return this;
    }

    build() {
        return this.params;
    }
}