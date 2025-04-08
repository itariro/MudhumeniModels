const { parentPort, workerData } = require('worker_threads');
const turf = require('@turf/turf');
const { TDigest } = require('tdigest');
const AgriculturalLandAnalyzer = require('../utils/elevation-analysis');

// Configure performance monitoring
const { performance } = require('perf_hooks');

// Helper function to ensure arrays are properly handled
function ensureRegularArray(possibleArray) {
  if (!possibleArray) return null;
  if (Array.isArray(possibleArray)) return possibleArray;
  if (ArrayBuffer.isView(possibleArray)) return Array.from(possibleArray);
  return null;
}

// Helper function to reconstruct proper GeoJSON structure with validation
function reconstructElevationSurface(serialized) {
  if (!serialized?.features) {
    throw new Error('Invalid serialized data structure');
  }

  return {
    type: 'FeatureCollection',
    features: serialized.features.map(f => {
      if (!f?.geometry?.coordinates) {
        throw new Error('Invalid feature structure');
      }
      return {
        type: 'Feature',
        properties: { ...f.properties },
        geometry: {
          type: 'Polygon',
          coordinates: [f.geometry.coordinates]
        }
      };
    })
  };
}

// Process chunks of data
// In your processDataChunk function
async function processDataChunk(chunk, config) {
  const startTime = performance.now();

  // Ensure AgriculturalLandAnalyzer is properly configured
  if (typeof AgriculturalLandAnalyzer.POLYGON_AREA === 'undefined' &&
    data.POLYGON_AREA !== undefined) {
    AgriculturalLandAnalyzer.POLYGON_AREA = data.POLYGON_AREA;
  }

  const elevationSurface = reconstructElevationSurface(chunk);
  const slopeStats = AgriculturalLandAnalyzer.calculateSlopeStatistics(elevationSurface);
  const terrainAnalysis = AgriculturalLandAnalyzer.analyzeTerrainCharacteristics(
    elevationSurface,
    slopeStats
  );

  return {
    slopeStats,
    terrainAnalysis,
    performance: {
      chunkProcessingTime: performance.now() - startTime
    }
  };
}

// Main worker process
parentPort.on('message', async (data) => {
  try {
    const startTime = performance.now();
    const memoryBefore = process.memoryUsage();

    // Process chunks in parallel
    const chunkPromises = data.chunks.map(chunk =>
      processDataChunk(chunk, data.config)
    );

    // Add timeout protection
    const chunkResults = await Promise.all(chunkPromises.map(p =>
      Promise.race([
        p,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Chunk processing timeout')), data.config?.timeout || 30000)
        )
      ])
    ));

    // Merge results
    const mergedResults = chunkResults.reduce((acc, result, idx) => {
      if (idx === 0) return result;
      return {
        slopeStats: combineStats(acc.slopeStats, result.slopeStats),
        terrainAnalysis: combineTerrainAnalysis(acc.terrainAnalysis, result.terrainAnalysis),
        performance: {
          chunkTimes: [...(acc.performance?.chunkTimes || []), ...(result.performance?.chunkTimes || [])]
        }
      };
    }, null);

    const memoryAfter = process.memoryUsage();

    parentPort.postMessage({
      success: true,
      ...mergedResults,
      performance: {
        ...mergedResults.performance,
        totalTime: performance.now() - startTime,
        memory: {
          before: memoryBefore,
          after: memoryAfter,
          diff: {
            heapUsed: memoryAfter.heapUsed - memoryBefore.heapUsed
          }
        }
      }
    });
  } catch (error) {
    parentPort.postMessage({
      success: false,
      error: {
        message: error.message,
        stack: error.stack,
        type: error.constructor.name
      }
    });
  }
});

// Rest of your helper functions remain unchanged
// function combineStats(stats1, stats2) {
//   if (!stats1) return stats2;
//   if (!stats2) return stats1;

//   // Ensure slopes are regular arrays
//   const slopes1 = ensureRegularArray(stats1.slopes || []);
//   const slopes2 = ensureRegularArray(stats2.slopes || []);
//   const combinedSlopes = [...slopes1, ...slopes2];

//   return {
//     mean: (stats1.mean + stats2.mean) / 2,
//     median: calculateMedian(combinedSlopes),
//     stdDev: calculateStdDev(combinedSlopes),
//     confidence: combineConfidenceIntervals(stats1.confidence, stats2.confidence),
//     distribution: combineDistributions(stats1.distribution, stats2.distribution),
//     aspectAnalysis: combineAspects(stats1.aspectAnalysis, stats2.aspectAnalysis)
//   };
// }


class StreamingStats {
  constructor() {
    this.tdigest = new TDigest();
    this.sum = 0;
    this.count = 0;
    this.squareSum = 0;
  }

  update(value) {
    this.tdigest.push(value);
    this.sum += value;
    this.count++;
    this.squareSum += value * value;
  }

  get median() {
    return this.tdigest.percentile(50);
  }

  get mean() {
    return this.sum / this.count;
  }

  get stdDev() {
    return Math.sqrt((this.squareSum / this.count) - Math.pow(this.mean, 2));
  }
}

// Modified combineStats
function combineStats(stats1, stats2) {
  const combined = new StreamingStats();
  [stats1, stats2].forEach(s => {
    if (s?.tdigest) {
      combined.tdigest.push(s.tdigest);
      combined.sum += s.sum;
      combined.count += s.count;
      combined.squareSum += s.squareSum;
    }
  });
  return {
    mean: combined.mean,
    median: combined.median,
    stdDev: combined.stdDev,
    confidence: combineConfidenceIntervals(stats1.confidence, stats2.confidence),
    distribution: combineDistributions(stats1.distribution, stats2.distribution),
    aspectAnalysis: combineAspects(stats1.aspectAnalysis, stats2.aspectAnalysis)
  };
}

function combineTerrainAnalysis(analysis1, analysis2) {
  if (!analysis1) return analysis2;
  if (!analysis2) return analysis1;

  return {
    drainage: combineDrainage(analysis1.drainage, analysis2.drainage),
    erosionRisk: combineErosionRisk(analysis1.erosionRisk, analysis2.erosionRisk),
    waterRetention: combineWaterRetention(analysis1.waterRetention, analysis2.waterRetention),
    solarExposure: combineSolarExposure(analysis1.solarExposure, analysis2.solarExposure),
    terrainComplexity: combineTerrainComplexity(analysis1.terrainComplexity, analysis2.terrainComplexity)
  };
}

// Add helper functions for statistical combinations
function calculateMedian(values) {
  const sorted = values.sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function calculateStdDev(values) {
  const mean = values.reduce((a, b) => a + b) / values.length;
  const squareDiffs = values.map(value => Math.pow(value - mean, 2));
  return Math.sqrt(squareDiffs.reduce((a, b) => a + b) / values.length);
}

/**
 * Combine confidence intervals using weighted averaging
 */
function combineConfidenceIntervals(ci1, ci2) {
  if (!ci1) return ci2;
  if (!ci2) return ci1;

  const weight1 = 1 / (ci1.marginOfError || 1);
  const weight2 = 1 / (ci2.marginOfError || 1);
  const totalWeight = weight1 + weight2;

  return {
    mean: (ci1.mean * weight1 + ci2.mean * weight2) / totalWeight,
    lower: Math.min(ci1.lower, ci2.lower),
    upper: Math.max(ci1.upper, ci2.upper),
    confidence: Math.min(ci1.confidence, ci2.confidence),
    marginOfError: 1 / totalWeight
  };
}

/**
 * Combine slope distributions
 */
function combineDistributions(dist1, dist2) {
  if (!dist1) return dist2;
  if (!dist2) return dist1;

  const combined = {};
  const classes = ['OPTIMAL', 'MODERATE', 'STEEP', 'VERY_STEEP', 'EXTREME'];

  for (const className of classes) {
    if (dist1[className] && dist2[className]) {
      const totalArea = (dist1[className].area || 0) + (dist2[className].area || 0);
      const totalPercentage = (dist1[className].percentage + dist2[className].percentage) / 2;

      combined[className] = {
        percentage: totalPercentage,
        area: totalArea,
        description: dist1[className].description // Descriptions should be the same
      };
    } else if (dist1[className]) {
      combined[className] = { ...dist1[className] };
    } else if (dist2[className]) {
      combined[className] = { ...dist2[className] };
    }
  }

  return combined;
}

/**
 * Combine aspect analyses using weighted averaging
 */
function combineAspects(aspects1, aspects2) {
  if (!aspects1) return aspects2;
  if (!aspects2) return aspects1;

  return {
    northFacing: (aspects1.northFacing + aspects2.northFacing) / 2,
    eastFacing: (aspects1.eastFacing + aspects2.eastFacing) / 2,
    southFacing: (aspects1.southFacing + aspects2.southFacing) / 2,
    westFacing: (aspects1.westFacing + aspects2.westFacing) / 2
  };
}

/**
 * Combine drainage analyses
 */
function combineDrainage(drainage1, drainage2) {
  if (!drainage1) return drainage2;
  if (!drainage2) return drainage1;

  return {
    drainagePattern: combinePatterns(drainage1.drainagePattern, drainage2.drainagePattern),
    drainageDensity: (drainage1.drainageDensity + drainage2.drainageDensity) / 2,
    waterloggingRisk: Math.max(drainage1.waterloggingRisk, drainage2.waterloggingRisk)
  };
}

/**
 * Helper function to combine drainage patterns
 */
function combinePatterns(pattern1, pattern2) {
  const patterns = [pattern1, pattern2].filter(Boolean);
  if (patterns.length === 0) return null;
  if (patterns.length === 1) return patterns[0];

  // If patterns differ, use the more concerning one
  const patternPriority = {
    'Poor': 3,
    'Moderate': 2,
    'Good': 1
  };

  return patterns.reduce((a, b) =>
    patternPriority[a] >= patternPriority[b] ? a : b
  );
}

/**
 * Combine erosion risk analyses
 */
function combineErosionRisk(risk1, risk2) {
  if (!risk1) return risk2;
  if (!risk2) return risk1;

  const combinedScore = Math.max(risk1.score, risk2.score);

  return {
    score: combinedScore,
    category: risk1.score > risk2.score ? risk1.category : risk2.category,
    factors: {
      slopeFactor: Math.max(risk1.factors.slopeFactor, risk2.factors.slopeFactor),
      variabilityFactor: Math.max(risk1.factors.variabilityFactor, risk2.factors.variabilityFactor)
    }
  };
}

/**
 * Combine water retention analyses
 */
function combineWaterRetention(retention1, retention2) {
  if (!retention1) return retention2;
  if (!retention2) return retention1;

  return {
    capacity: (retention1.capacity + retention2.capacity) / 2,
    efficiency: Math.min(retention1.efficiency, retention2.efficiency),
    factors: {
      slopeFactor: (retention1.factors.slopeFactor + retention2.factors.slopeFactor) / 2,
      distributionFactor: (retention1.factors.distributionFactor + retention2.factors.distributionFactor) / 2
    }
  };
}

/**
 * Combine solar exposure analyses
 */
function combineSolarExposure(exposure1, exposure2) {
  if (!exposure1) return exposure2;
  if (!exposure2) return exposure1;

  const combinedScore = (exposure1.score + exposure2.score) / 2;

  return {
    score: combinedScore,
    category: exposure1.score > exposure2.score ? exposure1.category : exposure2.category,
    aspects: combineAspects(exposure1.aspects, exposure2.aspects)
  };
}

/**
 * Combine terrain complexity analyses
 */
function combineTerrainComplexity(complexity1, complexity2) {
  if (!complexity1) return complexity2;
  if (!complexity2) return complexity1;

  return {
    score: Math.max(complexity1.score, complexity2.score),
    variability: (complexity1.variability + complexity2.variability) / 2
  };
}

// Error handling wrapper for combine functions
function safeCombine(fn, a, b) {
  try {
    return fn(a, b);
  } catch (error) {
    console.error(`Error combining results in ${fn.name}:`, error);
    return a || b || null;
  }
}

// In analysisWorker.js
const memoryMonitor = {
  threshold: 0.8 * 1024 * 1024 * 1024, // 80% of 1GB
  check() {
    const used = process.memoryUsage().heapUsed;
    if (used > this.threshold) {
      if (global.gc) {
        global.gc();
        logger.info('Forced garbage collection');
      }
      return true;
    }
    return false;
  }
};

// Add to main processing loop
setInterval(() => {
  if (memoryMonitor.check()) {
    parentPort.postMessage({
      type: 'MEMORY_WARNING',
      memory: process.memoryUsage()
    });
  }
}, 1000);


// Cleanup on exit
process.on('exit', () => {
  // Perform any necessary cleanup
  if (global.gc) global.gc();
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  parentPort.postMessage({
    success: false,
    error: {
      message: error.message,
      stack: error.stack,
      type: 'UncaughtException'
    }
  });
  process.exit(1);
});