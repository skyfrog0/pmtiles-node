const fs = require('fs');
const path = require('path');
const log4js = require('log4js');
const { MongoClient } = require('mongodb');
const { PMTile, TILE_TYPE, COMPRESSION } = require('../lib/pmtile');
const { ZxyToID } = require('../lib/tileId');

log4js.configure(path.join(__dirname, '../config/log4js.config.json'));
const logger = log4js.getLogger('pmtiles');

async function exportFromMongo(options) {
  const {
    mongoUri = 'mongodb://localhost:27017',
    dbName = 'tiles',
    collectionName = 'tiles',
    datasetName,
    outputPath,
    batchSize = 1000,
    tileType = TILE_TYPE.MVT,
    tileCompression = COMPRESSION.GZIP
  } = options;

  logger.info(`Starting export from MongoDB: ${mongoUri}/${dbName}.${collectionName}`);
  logger.info(`Dataset: ${datasetName}`);
  logger.info(`Output: ${outputPath}`);

  let client;
  let pmtile;

  try {
    client = await MongoClient.connect(mongoUri);
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    let query = {};
    if (datasetName) {
      query.dataset = datasetName;
    }

    const count = await collection.countDocuments(query);
    logger.info(`Found ${count} tiles`);

    if (count === 0) {
      logger.warn('No tiles found for the specified dataset');
      return;
    }

    pmtile = new PMTile();
    pmtile.setTileType(tileType);
    pmtile.setTileCompression(tileCompression);

    pmtile.setMetadata({
      name: datasetName || 'Exported Tiles',
      description: `Exported from MongoDB collection ${collectionName}`,
      created: new Date().toISOString(),
      tileType: tileType === TILE_TYPE.MVT ? 'vector' : 'raster',
      compression: tileCompression === COMPRESSION.GZIP ? 'gzip' : 'none'
    });

    const cursor = collection.find(query).batchSize(batchSize);
    let processed = 0;
    let batch = [];

    await cursor.forEach((doc) => {
      if (!doc.zoom && doc.zoom !== 0) {
        logger.warn(`Skipping tile without zoom: ${JSON.stringify(doc)}`);
        return;
      }
      if (!doc.x && doc.x !== 0) {
        logger.warn(`Skipping tile without x: ${JSON.stringify(doc)}`);
        return;
      }
      if (!doc.y && doc.y !== 0) {
        logger.warn(`Skipping tile without y: ${JSON.stringify(doc)}`);
        return;
      }
      if (!doc.tile_data) {
        logger.warn(`Skipping tile without data: z=${doc.zoom}, x=${doc.x}, y=${doc.y}`);
        return;
      }

      const tileBuffer = doc.tile_data.buffer ? doc.tile_data : Buffer.from(doc.tile_data);
      
      batch.push({
        z: doc.zoom,
        x: doc.x,
        y: doc.y,
        data: tileBuffer
      });

      if (batch.length >= batchSize) {
        pmtile.addTiles(batch);
        processed += batch.length;
        logger.info(`Processed ${processed}/${count} tiles`);
        batch = [];
      }
    });

    if (batch.length > 0) {
      pmtile.addTiles(batch);
      processed += batch.length;
      logger.info(`Processed ${processed}/${count} tiles`);
    }

    await pmtile.write(outputPath);
    logger.info(`Successfully exported ${processed} tiles to ${outputPath}`);

  } catch (err) {
    logger.error('Export failed:', err);
    throw err;
  } finally {
    if (client) {
      await client.close();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mongo-uri') {
      options.mongoUri = args[++i];
    } else if (args[i] === '--db') {
      options.dbName = args[++i];
    } else if (args[i] === '--collection') {
      options.collectionName = args[++i];
    } else if (args[i] === '--dataset') {
      options.datasetName = args[++i];
    } else if (args[i] === '--output') {
      options.outputPath = args[++i];
    } else if (args[i] === '--batch-size') {
      options.batchSize = parseInt(args[++i]);
    } else if (args[i] === '--tile-type') {
      const type = args[++i].toLowerCase();
      if (type === 'mvt') options.tileType = TILE_TYPE.MVT;
      else if (type === 'png') options.tileType = TILE_TYPE.PNG;
      else if (type === 'jpg') options.tileType = TILE_TYPE.JPEG;
      else if (type === 'webp') options.tileType = TILE_TYPE.WEBP;
    } else if (args[i] === '--compression') {
      const comp = args[++i].toLowerCase();
      if (comp === 'gzip') options.tileCompression = COMPRESSION.GZIP;
      else if (comp === 'none') options.tileCompression = COMPRESSION.NO_COMPRESSION;
    }
  }

  if (!options.outputPath) {
    console.error('Usage: node exportFromMongo.js --output <path> [options]');
    console.error('Options:');
    console.error('  --mongo-uri <uri>      MongoDB connection URI (default: mongodb://localhost:27017)');
    console.error('  --db <name>            Database name (default: tiles)');
    console.error('  --collection <name>    Collection name (default: tiles)');
    console.error('  --dataset <name>       Dataset name filter');
    console.error('  --batch-size <num>     Batch size for reading (default: 1000)');
    console.error('  --tile-type <type>     Tile type: mvt, png, jpg, webp (default: mvt)');
    console.error('  --compression <type>   Compression: gzip, none (default: gzip)');
    process.exit(1);
  }

  await exportFromMongo(options);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

module.exports = {
  exportFromMongo
};