/**
 * Test script for parallel chunking logic
 */

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// Test the chunking logic
function testChunking() {
  const urls = Array.from({ length: 150 }, (_, i) => `https://example.com/page${i + 1}`);

  console.log(`Testing with ${urls.length} URLs`);

  // Test different chunk sizes
  const testCases = [
    { urls: urls.length, chunks: 1 },
    { urls: urls.length, chunks: 3 },
    { urls: urls.length, chunks: 5 },
    { urls: urls.length, chunks: 10 },
  ];

  for (const testCase of testCases) {
    const optimalChunkSize = Math.min(50, Math.max(10, Math.ceil(testCase.urls / 10)));
    const actualChunks = testCase.chunks > 1 ? testCase.chunks : Math.min(5, Math.ceil(testCase.urls / optimalChunkSize));

    const urlChunks = chunkArray(urls, Math.ceil(testCase.urls / actualChunks));

    console.log(`\nConfig: ${testCase.chunks} requested chunks`);
    console.log(`Result: ${actualChunks} actual chunks`);
    console.log(`URLs per chunk: ${urlChunks.map(c => c.length).join(', ')}`);
    console.log(`Total URLs: ${urlChunks.flat().length}`);
  }
}

testChunking();
