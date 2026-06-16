const { MVTLayer, MVTTile } = require('../lib/mvt');

function testSimpleMVT() {
  console.log('Testing simple MVT encoding...');
  
  const tile = new MVTTile();
  
  const layer = new MVTLayer('buildings', 2, 4096);
  
  layer.addFeature({
    id: 1,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [100, 100],
        [200, 100],
        [200, 200],
        [100, 200],
        [100, 100]
      ]]
    },
    properties: {
      name: 'Building A',
      height: 50
    }
  });
  
  tile.addLayer(layer);
  
  const buffer = tile.toBuffer();
  console.log(`Encoded MVT tile: ${buffer.length} bytes`);
  
  const decoded = MVTTile.fromBuffer(buffer);
  console.log(`Decoded tile has ${decoded.getLayers().length} layer(s)`);
  
  if (decoded.getLayers().length === 0) {
    console.log('✗ No layers decoded');
    process.exit(1);
  }
  
  const decodedLayer = decoded.getLayers()[0];
  console.log(`Layer name: "${decodedLayer.name}"`);
  console.log(`Layer has ${decodedLayer.features.length} feature(s)`);
  
  if (decodedLayer.name !== 'buildings') {
    console.log(`✗ Layer name mismatch: expected "buildings", got "${decodedLayer.name}"`);
    process.exit(1);
  }
  
  if (decodedLayer.features.length !== 1) {
    console.log(`✗ Feature count mismatch: expected 1, got ${decodedLayer.features.length}`);
    process.exit(1);
  }
  
  const feature = decodedLayer.features[0];
  console.log(`Feature ID: ${feature.id}`);
  console.log(`Feature type: ${feature.type}`);
  console.log(`Keys: ${decodedLayer.keys.join(', ')}`);
  console.log(`Values count: ${decodedLayer.values.length}`);
  
  console.log('✓ Simple MVT test passed');
}

function main() {
  try {
    testSimpleMVT();
    console.log('\n✓ All MVT tests passed!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

main();