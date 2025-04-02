class HydrologyUtils {
    static calculateVariabilityCoefficient(values) {
        const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
        const stdDev = Math.sqrt(values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length);
        return stdDev / avg;
    }

    static average(values) {
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    }
}