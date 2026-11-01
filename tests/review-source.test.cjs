const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {sourceRecord, sourceJSON, sourceHash} = require('../review-source.js');
const vectors = JSON.parse(readFileSync(join(__dirname, 'fixtures/review-source-v1.json'), 'utf8')).vectors;
const copy = value => JSON.parse(JSON.stringify(value));

test('browser source identity matches frozen Python SHA-256 vectors', async () => {
  for (const {name, annotation, imageHashes, sha256} of vectors) {
    const before = copy(annotation);
    assert.equal(await sourceHash(annotation, imageHashes), sha256, name);
    assert.deepEqual(annotation, before, 'identity helper must not mutate feedback');
    assert.equal(sourceRecord(annotation, imageHashes).id, annotation.id);
  }
});

test('runtime metadata cannot change a source hash; original feedback and evidence can', async () => {
  const {annotation, imageHashes} = vectors[0];
  const original = await sourceHash(annotation, imageHashes);
  const metadata = {...annotation, status: '已完成', updatedAt: 'next', modelCandidate: 'ignore'};
  assert.equal(await sourceHash(metadata, imageHashes), original);
  for (const patch of [{text: '修改原话'}, {category: '文案'}, {expected: '新预期'}]) {
    assert.notEqual(await sourceHash({...annotation, ...patch}, imageHashes), original);
  }
  assert.notEqual(await sourceHash(annotation, {...imageHashes, 'shots/007.png': '0'.repeat(64)}), original);
  assert.equal(sourceJSON(annotation, imageHashes), sourceJSON({...annotation, status: '处理中'}, imageHashes));
});

test('image membership, unsafe paths and unpaired Unicode fail closed', async () => {
  const {annotation, imageHashes} = vectors[1];
  for (const hashes of [{}, {...imageHashes, 'refs/extra.png': 'a'.repeat(64)},
    {...imageHashes, 'refs/设计图.png': 'A'.repeat(64)}]) {
    assert.throws(() => sourceJSON(annotation, hashes), TypeError);
  }
  for (const bad of [
    {...annotation, refs: ['refs/../oops.png']},
    {...annotation, refs: ['refs/设计图.png', 'refs/设计图.png']},
    {...annotation, shot: 'refs/fake.png'},
    {...annotation, text: '\ud800'},
    {...annotation, refs: ['refs/\udc00.png']},
    {...annotation, category: '后端'},
    {...annotation, id: 2**53},
    {...annotation, id: true},
    {...annotation, text: null},
  ]) {
    assert.throws(() => sourceJSON(bad, imageHashes), TypeError);
  }
});
