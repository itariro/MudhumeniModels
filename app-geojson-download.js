const express = require('express');
const fs = require('fs');
const https = require('https');
const path = require('path');

const app = express();
const port = 3000;

const geojsonFiles = [
  {"name": "l1_ZW_7858601"},
  {"name": "l1_ZW_5556614"},
  {"name": "l1_ZW_5596168"},
  {"name": "l1_ZW_7878255"},
  {"name": "l1_ZW_7878253"},
  {"name": "l1_ZW_4056296"},
  {"name": "l1_ZW_13877661"},
  {"name": "l1_ZW_7858600"},
  {"name": "l1_ZW_7857099"},
  {"name": "l1_ZW_5581942"},
  {"name": "l1_ZW_4056297"},
  {"name": "l1_ZW_4056298"},
  {"name": "l1_ZW_5556615"},
  {"name": "l1_ZW_5554777"},
  {"name": "l1_ZW_5556616"},
  {"name": "l1_ZW_5554778"},
  {"name": "l1_ZW_5554779"},
  {"name": "l1_ZW_5581943"},
  {"name": "l1_ZW_5596170"},
  {"name": "l1_ZW_5556618"},
  {"name": "l1_ZW_7858599"},
  {"name": "l1_ZW_5554780"},
  {"name": "l1_ZW_13877660"},
  {"name": "l1_ZW_7857103"},
  {"name": "l1_ZW_7878257"},
  {"name": "l1_ZW_12310531"},
  {"name": "l1_ZW_7857105"},
  {"name": "l1_ZW_7857104"},
  {"name": "l1_ZW_5554781"},
  {"name": "l1_ZW_7878256"},
  {"name": "l1_ZW_7857102"},
  {"name": "l1_ZW_5555250"},
  {"name": "l1_ZW_5581944"},
  {"name": "l1_ZW_5556619"},
  {"name": "l1_ZW_7858598"},
  {"name": "l1_ZW_5596171"},
  {"name": "l1_ZW_5554782"},
  {"name": "l1_ZW_5596172"},
  {"name": "l1_ZW_5581945"},
  {"name": "l1_ZW_5581946"},
  {"name": "l1_ZW_5555251"},
  {"name": "l1_ZW_5555252"},
  {"name": "l1_ZW_5581947"},
  {"name": "l1_ZW_5596173"},
  {"name": "l1_ZW_5556620"},
  {"name": "l1_ZW_7878254"},
  {"name": "l1_ZW_5555253"},
  {"name": "l1_ZW_5596174"},
  {"name": "l1_ZW_5581948"},
  {"name": "l1_ZW_5596175"},
  {"name": "l1_ZW_5554783"},
  {"name": "l1_ZW_6524796"},
  {"name": "l1_ZW_7878252"},
  {"name": "l1_ZW_7858597"},
  {"name": "l1_ZW_5581949"},
  {"name": "l1_ZW_5581950"},
  {"name": "l1_ZW_13847668"},
  {"name": "l1_ZW_7857100"},
  {"name": "l1_ZW_5554784"}
];

// Create geojson directory if it doesn't exist
const geojsonDir = path.join(__dirname, 'geojson');
if (!fs.existsSync(geojsonDir)){
    fs.mkdirSync(geojsonDir);
}

// Function to download a file
function downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filePath);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(filePath);
            reject(err);
        });
    });
}

// Download all files
async function downloadAllFiles() {
    for (const file of geojsonFiles) {
        const url = `https://gm-stat.s3.us-east-1.amazonaws.com/gj/cntry/zw/${file.name}.geojson`;
        const filePath = path.join(geojsonDir, `${file.name}.geojson`);
        console.log(`Downloading ${file.name}.geojson...`);
        try {
            await downloadFile(url, filePath);
            console.log(`Successfully downloaded ${file.name}.geojson`);
        } catch (err) {
            console.error(`Error downloading ${file.name}.geojson:`, err);
        }
    }
}

app.get('/download', async (req, res) => {
    try {
        await downloadAllFiles();
        res.send('All files downloaded successfully');
    } catch (err) {
        res.status(500).send('Error downloading files');
    }
});

app.get('/files', (req, res) => {
    res.json(geojsonFiles);
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});