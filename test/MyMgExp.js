const {exportFromMongo} = require("../scripts/exportFromMongo");
const {COMPRESSION} = require("../lib/pmtile");

async function main() {
    const options = {
        outputPath: 'C:\\Users\\skyfr\\Desktop\\TEMP\\pmt-exp\\s3857gwt.pmtiles',
        mongoUri: 'mongodb://localhost:27017',
        dbName: 'vt4_tiles',
        collectionName: 's3857gw',
        datasetName: 's3857',
        concurrency: 10,
        tileType: 'gvt',
        tileCompression:  COMPRESSION.NO_COMPRESSION,
        minZoom: 2,
        maxZoom: 9
    };


    if (!options.outputPath) {
        console.error("参数不对");
        process.exit(1);
    }

    await exportFromMongo(options);
}

main().catch((err) => {
    console.error('执行出错了。 Error:', err);
    process.exit(1);
});