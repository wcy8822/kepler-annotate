/* Experimental V1.5 source identity only; never an approval or execution gate. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (!root.KPReviewSource) root.KPReviewSource = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const CATEGORIES = new Set(['视觉', '文案', '交互', '产品逻辑', '反馈/建议']);
  const HASH = /^[a-f0-9]{64}$/;
  const IMAGE = /^(?:shots|refs)\/(?:[^\\/\x00-\x1f\x7f]+\/)*[^\\/\x00-\x1f\x7f]+\.(?:png|jpg|jpeg|webp)$/;
  const encoder = new TextEncoder();

  function checkedString(value, name, nullable = false) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string') throw new TypeError(name + ' must be text or null');
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        if (++i >= value.length || value.charCodeAt(i) < 0xDC00 || value.charCodeAt(i) > 0xDFFF) {
          throw new TypeError(name + ' contains an invalid Unicode surrogate');
        }
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        throw new TypeError(name + ' contains an invalid Unicode surrogate');
      }
    }
    return value;
  }

  function checkedPath(path) {
    checkedString(path, 'image path');
    if (!IMAGE.test(path) || path.split('/').some(part => part === '.' || part === '..')) {
      throw new TypeError('image path is invalid');
    }
    return path;
  }

  function byteCompare(a, b) {
    const aa = encoder.encode(a), bb = encoder.encode(b);
    for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
      if (aa[i] !== bb[i]) return aa[i] - bb[i];
    }
    return aa.length - bb.length;
  }

  function sourceRecord(annotation, imageHashes) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation) ||
        !Number.isSafeInteger(annotation.id) || annotation.id < 1) {
      throw new TypeError('source item id must be a safe positive integer');
    }
    if (!imageHashes || typeof imageHashes !== 'object' || Array.isArray(imageHashes)) {
      throw new TypeError('imageHashes must be a map');
    }
    const category = checkedString(annotation.category ?? null, 'category', true);
    if (category !== null && !CATEGORIES.has(category)) throw new TypeError('unknown source category');
    const shot = annotation.shot ?? null;
    if (shot !== null && (!checkedPath(shot).startsWith('shots/'))) {
      throw new TypeError('screenshot must be under shots/');
    }
    const refs = annotation.refs === undefined ? [] : annotation.refs;
    if (!Array.isArray(refs)) throw new TypeError('refs must be a list');
    for (const ref of refs) {
      if (!checkedPath(ref).startsWith('refs/')) throw new TypeError('reference must be under refs/');
    }
    const paths = (shot === null ? [] : [shot]).concat(refs);
    const hashes = Object.keys(imageHashes);
    if (new Set(paths).size !== paths.length || hashes.length !== paths.length ||
        paths.some(path => !Object.hasOwn(imageHashes, path))) {
      throw new TypeError('image hashes must exactly match unique source references');
    }
    for (const path of hashes) {
      checkedPath(path);
      if (typeof imageHashes[path] !== 'string' || !HASH.test(imageHashes[path])) {
        throw new TypeError('image SHA-256 must be lowercase hexadecimal');
      }
    }
    const images = paths.slice().sort(byteCompare).map(path => ({path, sha256: imageHashes[path]}));
    return {
      schemaVersion: 1,
      id: annotation.id,
      text: checkedString(annotation.text === undefined ? '' : annotation.text, 'text'),
      category,
      observed: checkedString(annotation.observed ?? null, 'observed', true),
      expected: checkedString(annotation.expected ?? null, 'expected', true),
      reproduction: checkedString(annotation.reproduction ?? null, 'reproduction', true),
      shot,
      refs: refs.slice(),
      images
    };
  }

  function sourceJSON(annotation, imageHashes) {
    return JSON.stringify(sourceRecord(annotation, imageHashes));
  }

  async function sourceHash(annotation, imageHashes) {
    const bytes = encoder.encode(sourceJSON(annotation, imageHashes));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
  }

  return {sourceRecord, sourceJSON, sourceHash};
});
