const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {validateTransition} = require('../review-transition.js');
const vectors = JSON.parse(readFileSync(join(__dirname, 'fixtures/review-transition-v1.json'), 'utf8')).vectors;
const clone = value => JSON.parse(JSON.stringify(value));

test('B3 source transition equals frozen Python H0/H1 hashes without modifying feedback', async () => {
  for (const vector of vectors) {
    const before = clone(vector);
    const result = await validateTransition(vector.basis, vector.basisHashes, vector.applies,
      vector.appliesHashes, vector.transform);
    assert.deepEqual(result, {basisSourceHash: vector.basisSourceHash,
      appliesToSourceHash: vector.appliesToSourceHash}, vector.name);
    assert.deepEqual(vector, before, 'transition validation must not rewrite original feedback');
  }
});

test('B3 permits a declared append, not replacement, deletion, or arbitrary editing', async () => {
  const v = vectors[2];
  const ok = () => validateTransition(v.basis, v.basisHashes, v.applies, v.appliesHashes, v.transform);
  await ok();
  const invalid = [
    {applies: {...v.applies, text: 'AI changed raw words'}},
    {applies: {...v.applies, observed: '伪造观察'}},
    {applies: {...v.applies, id: 10}},
    {applies: {...v.applies, shot: null}, appliesHashes: {'refs/设计A.png': v.basisHashes['refs/设计A.png'], 'refs/📐图B.png': v.appliesHashes['refs/📐图B.png']}},
    {applies: {...v.applies, refs: ['refs/📐图B.png', 'refs/设计A.png']}},
    {appliesHashes: {...v.appliesHashes, 'shots/ui.png': '0'.repeat(64)}},
    {transform: {...v.transform, addedEvidence: []}},
    {transform: {...v.transform, addedEvidence: [{path: 'refs/📐图B.png', sha256: '0'.repeat(64)}]}},
    {transform: {...v.transform, addedEvidence: [{path: 'refs/📐图B.png', sha256: v.appliesHashes['refs/📐图B.png'], approved: true}]}},
    {transform: {...v.transform, runCommand: 'echo no'}},
    {transform: {...v.transform, schemaVersion: true}},
    {transform: {...v.transform, schemaVersion: 2}},
    {transform: {...v.transform, adoptedCategory: '视觉'}},
  ];
  for (const patch of invalid) {
    await assert.rejects(() => validateTransition(patch.basis ?? v.basis, patch.basisHashes ?? v.basisHashes,
      patch.applies ?? v.applies, patch.appliesHashes ?? v.appliesHashes, patch.transform ?? v.transform),
    /error|change|evidence|object|invalid|category|original|screenshot|references|source|id|append|declared|hash/i);
  }
});

test('B3 category changes require an explicit matching action; no claim can approve unchanged data', async () => {
  const v = vectors[1];
  await assert.rejects(() => validateTransition(v.basis, v.basisHashes, v.applies,
    v.appliesHashes, {...v.transform, adoptedCategory: null}), TypeError);
  await assert.rejects(() => validateTransition(v.basis, v.basisHashes, v.applies,
    v.appliesHashes, {...v.transform, adoptedCategory: '文案'}), TypeError);
  await assert.rejects(() => validateTransition(v.basis, v.basisHashes, v.basis,
    v.basisHashes, {...v.transform, adoptedCategory: '交互'}), TypeError);
  assert.deepEqual(await validateTransition(v.basis, v.basisHashes, v.applies, v.appliesHashes,
    {...v.transform, addedEvidence: []}),
    {basisSourceHash: v.basisSourceHash, appliesToSourceHash: v.appliesToSourceHash});
});
