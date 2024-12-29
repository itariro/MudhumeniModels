const ee = require('@google/earthengine');

const initializeEarthEngine = () => {
    return new Promise((resolve, reject) => {
        const privateKey = process.env.GEE_PRIVATE_KEY.split(String.raw`\n`).join('\n');
        const clientEmail = process.env.GEE_CLIENT_EMAIL;

        ee.data.authenticateViaPrivateKey(
            { private_key: privateKey, client_email: clientEmail },
            () => {
                ee.initialize(
                    null,
                    null,
                    () => resolve(),
                    (err) => reject(err)
                );
            },
            (err) => reject(err)
        );
    });
};

module.exports = { initializeEarthEngine };