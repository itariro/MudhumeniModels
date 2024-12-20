const os = require('os');

class Monitoring {
    constructor() {
        this.startTime = Date.now();
        this.requestStats = {
            total: 0,
            success: 0,
            error: 0,
            endpoints: {}
        };
    }

    recordRequest(method, endpoint, status) {
        this.requestStats.total++;
        if (status >= 200 && status < 400) {
            this.requestStats.success++;
        } else {
            this.requestStats.error++;
        }

        const key = `${method}:${endpoint}`;
        if (!this.requestStats.endpoints[key]) {
            this.requestStats.endpoints[key] = { total: 0, success: 0, error: 0 };
        }

        this.requestStats.endpoints[key].total++;
        if (status >= 200 && status < 400) {
            this.requestStats.endpoints[key].success++;
        } else {
            this.requestStats.endpoints[key].error++;
        }
    }

    getStats() {
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);
        const memoryUsage = process.memoryUsage();

        return {
            status: 'healthy',
            uptime,
            system: {
                cpuLoad: os.loadavg(),
                totalMemory: os.totalmem(),
                freeMemory: os.freemem(),
                uptime: os.uptime()
            },
            process: {
                memory: {
                    heapUsed: memoryUsage.heapUsed,
                    heapTotal: memoryUsage.heapTotal,
                    external: memoryUsage.external,
                    rss: memoryUsage.rss
                },
                pid: process.pid,
                version: process.version
            },
            requests: this.requestStats,
            timestamp: new Date()
        };
    }
}

module.exports = new Monitoring();