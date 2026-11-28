/* B3 structural H0/H1 transition only; cannot establish a human approval. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./review-source.js'));
  else if (!root.KPReviewTransition) root.KPReviewTransition = factory(root.KPReviewSource);
})(typeof window !== 'undefined' ? window : globalThis, function (source) {
  'use strict';
  if (!source?.sourceRecord || !source?.sourceHash) throw new Error('KPReviewSource is required');

  async function validateTransition(basis, basisHashes, applies, appliesHashes, transform) {
    const before = source.sourceRecord(basis, basisHashes);
    const after = source.sourceRecord(applies, appliesHashes);
    if (!transform || typeof transform !== 'object' || Array.isArray(transform) ||
        Object.keys(transform).length !== 3 ||
        !['schemaVersion', 'adoptedCategory', 'addedEvidence'].every(key => Object.hasOwn(transform, key)) ||
        transform.schemaVersion !== 1 || !Array.isArray(transform.addedEvidence) ||
        transform.addedEvidence.length > 20) {
      throw new TypeError('sourceTransform must be a closed v1 object');
    }
    if (before.id !== after.id) throw new TypeError('item id must not change');
    for (const field of ['text', 'observed', 'expected', 'reproduction']) {
      if (before[field] !== after[field]) throw new TypeError('original feedback cannot change: ' + field);
    }
    if (before.category === after.category) {
      if (transform.adoptedCategory !== null) throw new TypeError('category adoption must describe an actual change');
    } else if (after.category === null || transform.adoptedCategory !== after.category) {
      throw new TypeError('category changes require a declared adoption');
    }
    if (before.shot !== null && before.shot !== after.shot) {
      throw new TypeError('original screenshot cannot be replaced or removed');
    }
    if (after.refs.slice(0, before.refs.length).some((path, i) => path !== before.refs[i]) ||
        after.refs.length < before.refs.length) {
      throw new TypeError('original references cannot be removed or reordered');
    }
    const previous = new Map(before.images.map(image => [image.path, image.sha256]));
    const current = new Map(after.images.map(image => [image.path, image.sha256]));
    for (const [path, sha] of previous) {
      if (current.get(path) !== sha) throw new TypeError('existing evidence bytes cannot change');
    }
    const additions = (before.shot === null && after.shot !== null ? [after.shot] : [])
      .concat(after.refs.slice(before.refs.length));
    const expected = additions.map(path => ({path, sha256: current.get(path)}));
    if (transform.addedEvidence.length !== expected.length ||
        transform.addedEvidence.some((value, index) => !value || typeof value !== 'object' ||
          Array.isArray(value) || Object.keys(value).length !== 2 ||
          !Object.hasOwn(value, 'path') || !Object.hasOwn(value, 'sha256') ||
          value.path !== expected[index].path || value.sha256 !== expected[index].sha256)) {
      throw new TypeError('new evidence must be declared in append order with exact hashes');
    }
    return {basisSourceHash: await source.sourceHash(basis, basisHashes),
      appliesToSourceHash: await source.sourceHash(applies, appliesHashes)};
  }

  return {validateTransition};
});
